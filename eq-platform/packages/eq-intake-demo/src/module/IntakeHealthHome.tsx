import { useState, useEffect, useCallback, type JSX } from "react";
import {
  computeHealthScores,
  runLicenceExpiryCheck,
  runOrphanCheck,
  computeComplianceMetrics,
  detectAllDuplicates,
  readSiteAdvisory,
  adjudicateSiteAdvisory,
  decayCheck,
} from "@eq/intake";
import type {
  HealthScore,
  LicenceExpiryAlertSummary,
  ComplianceMetrics,
  DuplicateReport,
  SiteAdvisorySummary,
  SiteVerdict,
  DecaySummary,
} from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";
import { entityLabel } from "../shared/entity-label.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface IntakeHealthHomeProps {
  supabase?: SupabaseLikeClient | null;
  tenantId?: string;
  onEntityClick?: (entity: string) => void;
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface OrphanSummary {
  assets_no_site_count:     number;
  contacts_no_parent_count: number;
  licences_no_staff_count:  number;
  sites_no_customer_count:  number;
  total:                    number;
}

interface DimensionResult {
  completeness:   number; // 0–1 — can we reach people (staff email + contacts on file)
  compliance:     number; // 0–1 — SKS-specific: licence coverage + emergency contacts
  serviceability: number; // 0–1 — SKS-specific: trade classification + sites on file
  validity:       number; // 0–1 — DAMA "Validity": do populated fields pass format checks (ABN, phone, state, postcode)
  consistency:    number; // 0–1 — DAMA "Consistency": referential integrity (no broken FK links)
  timeliness:     number; // 0–1 — DAMA "Timeliness": records touched within the last year
  composite:      number; // 0–100
}

interface ActionItem {
  id:          string;
  title:       string;
  description: string;
  pts:         number;
  severity:    "danger" | "warning" | "info";
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";

// Below this many rows, a 100% (or 0%) score is a coin flip, not a trend —
// flag it so a nearly-empty entity doesn't read as confidently as a big one.
const LOW_SAMPLE_THRESHOLD = 5;

// Averages only the components that have data behind them. An entity with
// zero rows is "not started", not "fully complete" — it must not silently
// inflate a dimension to 100% before anyone has entered a single record.
function averageStarted(...components: Array<{ value: number; started: boolean } | null>): number {
  const live = components.filter((c): c is { value: number; started: boolean } => c !== null && c.started);
  if (live.length === 0) return 0;
  return live.reduce((sum, c) => sum + c.value, 0) / live.length;
}

// Weights reflect SKS's consumption context (Soda's phrase for it): licence
// coverage and dispatch-readiness carry real compliance/safety consequences,
// so they outweigh general data hygiene. Validity and Timeliness were
// computed by the underlying modules all along but never fed the composite
// — see health-score.ts's module comment for the DAMA-UK framing.
const WEIGHTS = {
  compliance:     30,
  serviceability: 25,
  completeness:   15,
  validity:       12,
  consistency:    10,
  timeliness:      8,
} as const;

function computeDimensions(
  scores:    HealthScore[] | null,
  licences:  LicenceExpiryAlertSummary | null,
  orphans:   OrphanSummary | null,
  cm:        ComplianceMetrics | null,
): DimensionResult {
  const st = cm?.staff.total ?? 0;
  const contactsHs = scores?.find((s) => s.entity === "contacts") ?? null;
  const sitesHs    = scores?.find((s) => s.entity === "sites") ?? null;

  // Completeness: staff email + contacts completeness (can we reach people)
  const staffEmailRate = st > 0 ? (cm!.staff.has_email / st) : 0;
  const completeness    = averageStarted(
    { value: staffEmailRate, started: st > 0 },
    contactsHs ? { value: contactsHs.score, started: contactsHs.started } : null,
  );

  // Compliance: licence coverage (≥1 record per staff) + emergency contacts
  const licenceRecords  = licences?.records_total ?? 0;
  const licenceCoverage = st > 0 ? Math.min(1, licenceRecords / st) : 0;
  const emergencyRate   = st > 0 ? (cm!.staff.has_emergency_contact / st) : 0;
  const compliance      = averageStarted(
    { value: licenceCoverage, started: st > 0 },
    { value: emergencyRate, started: st > 0 },
  );

  // Serviceability: trade classification + sites completeness
  const tradeRate      = st > 0 ? (cm!.staff.has_trade / st) : 0;
  const serviceability = averageStarted(
    { value: tradeRate, started: st > 0 },
    sitesHs ? { value: sitesHs.score, started: sitesHs.started } : null,
  );

  // Validity: average format-correctness across every entity that has data
  const validity = averageStarted(
    ...(scores ?? []).map((s) => ({ value: s.validity, started: s.started })),
  );

  // Timeliness: average freshness across every entity that has data
  const timeliness = averageStarted(
    ...(scores ?? []).map((s) => ({ value: s.freshness, started: s.started })),
  );

  // Consistency: orphan-free (referential integrity)
  const orphanTotal = orphans?.total ?? 0;
  const consistency  = orphanTotal === 0 ? 1 : Math.max(0, 1 - orphanTotal / 100);

  const composite = Math.round(
    compliance * WEIGHTS.compliance +
    serviceability * WEIGHTS.serviceability +
    completeness * WEIGHTS.completeness +
    validity * WEIGHTS.validity +
    consistency * WEIGHTS.consistency +
    timeliness * WEIGHTS.timeliness,
  );

  return { completeness, compliance, serviceability, validity, consistency, timeliness, composite };
}

function deriveActions(
  licences: LicenceExpiryAlertSummary | null,
  cm:       ComplianceMetrics | null,
): ActionItem[] {
  const actions: ActionItem[] = [];
  const st = cm?.staff.total ?? 0;

  if (st > 0 && (licences?.records_total ?? 0) === 0) {
    actions.push({
      id:          "no_licences",
      title:       `${st} active staff — no licence records on file`,
      description: "White cards, yellow cards, electrical licences are all untracked. Adds ~25 pts to compliance.",
      pts:         25,
      severity:    "danger",
    });
  }

  const missingTrade = st - (cm?.staff.has_trade ?? 0);
  if (st > 0 && missingTrade > 0) {
    actions.push({
      id:          "no_trade",
      title:       `${missingTrade} of ${st} staff have no trade classification`,
      description: "Skill-based dispatch and PPM assignment require this field. Adds ~12 pts to serviceability.",
      pts:         12,
      severity:    "warning",
    });
  }

  const missingEmergency = st - (cm?.staff.has_emergency_contact ?? 0);
  if (st > 0 && missingEmergency > Math.floor(st * 0.1)) {
    actions.push({
      id:          "no_emergency",
      title:       `${missingEmergency} of ${st} staff missing emergency contact`,
      description: "Required for field dispatch under H&S compliance. Adds ~8 pts to compliance.",
      pts:         8,
      severity:    "warning",
    });
  }

  if ((licences?.total ?? 0) > 0) {
    actions.push({
      id:          "expiring",
      title:       `${licences!.total} licence${licences!.total === 1 ? "" : "s"} expiring within 60 days`,
      description: `${licences!.critical > 0 ? `${licences!.critical} expired or critical. ` : ""}Renewal required before deployment.`,
      pts:         4,
      severity:    licences!.critical > 0 ? "danger" : "warning",
    });
  }

  const missingEmail = st - (cm?.staff.has_email ?? 0);
  if (missingEmail > 0) {
    actions.push({
      id:          "no_email",
      title:       `${missingEmail} staff ${missingEmail === 1 ? "has" : "have"} no email address`,
      description: "They won't receive roster notifications or shift confirmations. Adds ~3 pts to reachability.",
      pts:         3,
      severity:    "info",
    });
  }

  return actions.sort((a, b) => b.pts - a.pts).slice(0, 4);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function dimFill(score: number): string {
  if (score >= 0.8) return "eq-health-dim-fill--ok";
  if (score >= 0.5) return "eq-health-dim-fill--warn";
  return "eq-health-dim-fill--err";
}

function statusLabel(composite: number): string {
  if (composite >= 85) return "Good";
  if (composite >= 60) return "Fair";
  if (composite >= 40) return "Needs attention";
  return "Gaps present";
}

function ringColour(composite: number): string {
  if (composite >= 85) return "var(--eq-ok)";
  if (composite >= 60) return "var(--eq-sky)";
  if (composite >= 40) return "var(--eq-warn)";
  return "var(--eq-err)";
}


// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScoreRing({ composite }: { composite: number }): JSX.Element {
  const r = 40;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - composite / 100);
  const colour = ringColour(composite);
  const label  = statusLabel(composite);

  return (
    <div className="eq-health-ring-wrap">
      <div className="eq-health-ring-svg">
        <svg width="96" height="96" viewBox="0 0 96 96" fill="none">
          <circle cx="48" cy="48" r={r} stroke="var(--eq-line)" strokeWidth="7" />
          <circle
            cx="48" cy="48" r={r}
            stroke={colour}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            transform="rotate(-90 48 48)"
          />
        </svg>
        <div className="eq-health-ring-inner">
          <span className="eq-health-ring-num">{composite}</span>
          <span className="eq-health-ring-sub">/100</span>
        </div>
      </div>
      <span className="eq-health-ring-status" style={{ color: colour }}>{label}</span>
    </div>
  );
}

function DimensionBar({
  label, score, weight,
}: { label: string; score: number; weight: string }): JSX.Element {
  return (
    <div className="eq-health-dim">
      <span className="eq-health-dim-name">
        {label}
        <span className="eq-health-dim-weight">{weight}</span>
      </span>
      <div className="eq-health-dim-track">
        <div
          className={`eq-health-dim-fill ${dimFill(score)}`}
          style={{ width: pct(score) } as React.CSSProperties}
        />
      </div>
      <span className="eq-health-dim-pct">{pct(score)}</span>
    </div>
  );
}

function ActionCard({
  action, onEntityClick,
}: { action: ActionItem; onEntityClick?: (entity: string) => void }): JSX.Element {
  const entityMap: Record<string, string> = {
    no_licences:   "licences",
    no_trade:      "staff",
    no_emergency:  "staff",
    no_email:      "staff",
    expiring:      "licences",
  };

  return (
    <button
      type="button"
      className={`eq-health-action eq-health-action--${action.severity}`}
      onClick={
        onEntityClick && entityMap[action.id]
          ? () => onEntityClick(entityMap[action.id])
          : undefined
      }
    >
      <div className={`eq-health-action-icon eq-health-action-icon--${action.severity}`} aria-hidden="true">
        {action.severity === "danger" ? "!" : "→"}
      </div>
      <div className="eq-health-action-body">
        <p className="eq-health-action-title">{action.title}</p>
        <p className="eq-health-action-sub">{action.description}</p>
      </div>
      <span className={`eq-health-action-badge eq-health-action-badge--${action.severity}`}>
        +{action.pts} pts
      </span>
    </button>
  );
}

function HealthCard({
  hs, onClick,
}: { hs: HealthScore; onClick?: (entity: string) => void }): JSX.Element {
  const label = entityLabel(hs.entity);

  if (!hs.started) {
    return (
      <button
        type="button"
        className="eq-health-card"
        onClick={onClick ? () => onClick(hs.entity) : undefined}
        aria-label={`${label} — no records yet`}
      >
        <div className="eq-health-card__header">
          <span className="eq-health-card__name">{label}</span>
          <span className="eq-health-card__count">0 records</span>
        </div>
        <p className="eq-health-card__gaps">No records yet — not counted in the health score.</p>
      </button>
    );
  }

  const percentage = pct(hs.score);
  const fillClass  = hs.score >= 0.9 ? "eq-health-bar--ok" : hs.score >= 0.7 ? "eq-health-bar--warn" : "eq-health-bar--err";
  const lowSample  = hs.total < LOW_SAMPLE_THRESHOLD;

  return (
    <button
      type="button"
      className="eq-health-card"
      onClick={onClick ? () => onClick(hs.entity) : undefined}
      aria-label={`${label} — ${percentage} complete${lowSample ? `, based on only ${hs.total} record${hs.total === 1 ? "" : "s"}` : ""}`}
    >
      <div className="eq-health-card__header">
        <span className="eq-health-card__name">{label}</span>
        <span className="eq-health-card__count">
          {hs.total.toLocaleString()} record{hs.total === 1 ? "" : "s"}
        </span>
      </div>
      <div className="eq-health-bar-wrap">
        <div className={`eq-health-bar ${fillClass}`} style={{ width: percentage } as React.CSSProperties} />
      </div>
      <span className="eq-health-card__pct">{percentage}</span>
      {lowSample && (
        <p className="eq-health-card__low-sample">Based on only {hs.total} record{hs.total === 1 ? "" : "s"} — treat this score as unproven.</p>
      )}
      {hs.gaps.length > 0 && (
        <p className="eq-health-card__gaps">Missing: {hs.gaps.join(", ")}</p>
      )}
    </button>
  );
}

function LicenceStrip({ summary }: { summary: LicenceExpiryAlertSummary }): JSX.Element {
  if (summary.records_total === 0) {
    return (
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--err">No licence data — 0 records</span>
      </div>
    );
  }

  if (summary.total === 0) {
    return (
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--ok">
          All {summary.records_total.toLocaleString()} licences current
        </span>
      </div>
    );
  }

  return (
    <div className="eq-health-licence-strip">
      {summary.critical > 0 && (
        <span className="eq-health-badge eq-health-badge--critical">{summary.critical} expired / critical</span>
      )}
      {summary.warning > 0 && (
        <span className="eq-health-badge eq-health-badge--warning">{summary.warning} expiring soon</span>
      )}
      {summary.info > 0 && (
        <span className="eq-health-badge eq-health-badge--info">{summary.info} within 60 days</span>
      )}
    </div>
  );
}

function DuplicateStrip({
  report, onEntityClick,
}: { report: DuplicateReport[]; onEntityClick?: (entity: string) => void }): JSX.Element {
  const total = report.reduce((n, r) => n + r.clusters.length, 0);

  if (total === 0) {
    return (
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--ok">No duplicates found</span>
      </div>
    );
  }

  return (
    <div className="eq-health-licence-strip">
      {report
        .filter((r) => r.clusters.length > 0)
        .map((r) => {
          // "Needs reconcile" is the actionable subset — a duplicate whose live
          // state disagrees with the survivor pick (the SY9 shape: the correct
          // row retired, or data split across active copies). Lead with that
          // count and colour it danger; fall back to the raw dupe count.
          const needs = r.needs_reconcile ?? 0;
          const danger = needs > 0;
          const text = danger
            ? `${needs} to reconcile in ${r.entity}`
            : `${r.clusters.length} possible duplicate${r.clusters.length !== 1 ? "s" : ""} in ${r.entity}`;
          const cls = danger ? "eq-health-badge--critical" : "eq-health-badge--warning";
          const tip = danger
            ? `${r.clusters.length} duplicate group${r.clusters.length !== 1 ? "s" : ""} · ${needs} need a survivor chosen — open ${r.entity}`
            : `Open ${r.entity} drill-down`;
          return onEntityClick ? (
            <button
              key={r.entity}
              type="button"
              className={`eq-health-badge ${cls} eq-health-orphan__btn`}
              onClick={() => onEntityClick(r.entity)}
              title={tip}
            >
              {text}
            </button>
          ) : (
            <span key={r.entity} className={`eq-health-badge ${cls}`} title={tip}>{text}</span>
          );
        })}
    </div>
  );
}

const VERDICT_LABEL: Record<SiteVerdict, string> = {
  same: "Same site",
  different: "Different",
  unsure: "Unsure",
};

// The write-time resolver's adjudication console: what got flagged AS IT WAS
// WRITTEN (eq-shell 0179), not an after-the-fact scan. Leads with the count —
// that number is "duplicates the system caught before they were born". Each
// flagged row is adjudicable: the human's verdict (0183) is recorded as a
// label, so the console is a decision surface, not just a report.
function SiteAdvisoryPanel({
  summary, onAdjudicate, saving, errors,
}: {
  summary: SiteAdvisorySummary;
  onAdjudicate: (advisoryId: string, verdict: SiteVerdict) => void;
  saving: Record<string, boolean>;
  errors: Record<string, boolean>;
}): JSX.Element {
  if (summary.total === 0) {
    return (
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--ok">Watching — nothing flagged yet</span>
      </div>
    );
  }

  return (
    <div>
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--critical">
          {summary.total} caught at the write
        </span>
        {summary.recent_count > 0 && (
          <span className="eq-health-badge eq-health-badge--warning">
            {summary.recent_count} in the last {summary.recent_days} days
          </span>
        )}
        {summary.pending > 0 && (
          <span className="eq-health-badge eq-health-badge--info">
            {summary.pending} need a human
          </span>
        )}
        {summary.decided > 0 && (
          <span className="eq-health-badge eq-health-badge--ok">
            {summary.decided} adjudicated
          </span>
        )}
      </div>
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {summary.items.slice(0, 8).map((it) => (
          <li key={it.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
            <span style={{ fontWeight: 500 }}>{it.candidate_name ?? it.candidate_code ?? "New site"}</span>
            <span aria-hidden="true" style={{ opacity: 0.5 }}>→</span>
            <span style={{ color: "var(--eq-ink-soft, #64748b)" }}>
              {it.matched_name ?? "existing site"}{it.matched_active === false ? " (retired)" : ""}
            </span>
            <span className={`eq-health-badge eq-health-badge--${it.outcome === "match" ? "warning" : "info"}`}>
              {it.outcome === "match" ? "likely same" : "unsure"}
            </span>
            {it.verdict ? (
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--eq-ink-soft, #64748b)" }}>
                · you said: {VERDICT_LABEL[it.verdict]}
              </span>
            ) : (
              <span style={{ display: "inline-flex", gap: 4 }}>
                {(["same", "different", "unsure"] as SiteVerdict[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    disabled={!!saving[it.id]}
                    onClick={() => onAdjudicate(it.id, v)}
                    title={`Record: ${VERDICT_LABEL[v]}`}
                    style={{
                      fontSize: 12,
                      padding: "1px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--eq-line, #e2e8f0)",
                      background: "var(--eq-surface, #ffffff)",
                      color: "var(--eq-ink, #1a1a2e)",
                      cursor: saving[it.id] ? "default" : "pointer",
                      opacity: saving[it.id] ? 0.5 : 1,
                    }}
                  >
                    {VERDICT_LABEL[v]}
                  </button>
                ))}
              </span>
            )}
            {errors[it.id] && (
              <span style={{ fontSize: 12, color: "var(--eq-danger, #dc2626)" }}>couldn&rsquo;t save — try again</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OrphanStrip({
  summary, onEntityClick,
}: { summary: OrphanSummary; onEntityClick?: (entity: string) => void }): JSX.Element {
  if (summary.total === 0) {
    return (
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--ok">No broken links</span>
      </div>
    );
  }

  function Badge({ count, entity, label }: { count: number; entity: string; label: string }): JSX.Element | null {
    if (count === 0) return null;
    const text = `${count} ${label}`;
    return onEntityClick ? (
      <button
        type="button"
        className="eq-health-badge eq-health-badge--warning eq-health-orphan__btn"
        onClick={() => onEntityClick(entity)}
        title={`Open ${entity} drill-down`}
      >
        {text}
      </button>
    ) : (
      <span className="eq-health-badge eq-health-badge--warning">{text}</span>
    );
  }

  return (
    <div className="eq-health-licence-strip">
      <Badge count={summary.assets_no_site_count}     entity="assets"   label={`asset${summary.assets_no_site_count !== 1 ? "s" : ""} missing site`} />
      <Badge count={summary.contacts_no_parent_count} entity="contacts" label={`contact${summary.contacts_no_parent_count !== 1 ? "s" : ""} unlinked`} />
      <Badge count={summary.licences_no_staff_count}  entity="licences" label={`licence${summary.licences_no_staff_count !== 1 ? "s" : ""} missing staff`} />
      <Badge count={summary.sites_no_customer_count}  entity="sites"    label={`site${summary.sites_no_customer_count !== 1 ? "s" : ""} missing customer`} />
    </div>
  );
}

function DecayStrip({
  report, onEntityClick,
}: { report: DecaySummary[]; onEntityClick?: (entity: string) => void }): JSX.Element {
  const anyStale = report.some((r) => r.aging + r.stale + r.very_stale > 0);

  if (!anyStale) {
    return (
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--ok">All records current</span>
      </div>
    );
  }

  return (
    <div className="eq-health-licence-strip">
      {report
        .filter((r) => r.aging + r.stale + r.very_stale > 0)
        .map((r) => {
          const label    = entityLabel(r.entity);
          const severity = r.very_stale > 0 ? "err" : r.stale > 0 ? "warning" : "info";
          const worst    = r.very_stale > 0
            ? `${r.very_stale} very stale`
            : r.stale > 0
            ? `${r.stale} stale`
            : `${r.aging} aging`;
          const tip = r.stalest[0]
            ? `Oldest: ${r.stalest[0].label} (${r.stalest[0].days_since}d)`
            : `${r.oldest_days}d since last update`;

          return onEntityClick ? (
            <button
              key={r.entity}
              type="button"
              className={`eq-health-badge eq-health-badge--${severity} eq-health-orphan__btn`}
              onClick={() => onEntityClick(r.entity)}
              title={tip}
            >
              {label}: {worst}, oldest {r.oldest_days}d
            </button>
          ) : (
            <span
              key={r.entity}
              className={`eq-health-badge eq-health-badge--${severity}`}
              title={tip}
            >
              {label}: {worst}, oldest {r.oldest_days}d
            </span>
          );
        })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function IntakeHealthHome({
  supabase,
  tenantId,
  onEntityClick,
}: IntakeHealthHomeProps): JSX.Element {
  const resolvedTenantId = tenantId ?? DEFAULT_TENANT_ID;

  if (!tenantId) {
    // eslint-disable-next-line no-console
    console.warn("[IntakeHealthHome] tenantId prop not provided — health queries will use the fixture tenant.");
  }

  const [scores,     setScores]     = useState<HealthScore[] | null>(null);
  const [licences,   setLicences]   = useState<LicenceExpiryAlertSummary | null>(null);
  const [orphans,    setOrphans]    = useState<OrphanSummary | null>(null);
  const [compliance, setCompliance] = useState<ComplianceMetrics | null>(null);
  const [dupes,      setDupes]      = useState<DuplicateReport[] | null>(null);
  const [dupesBusy,  setDupesBusy]  = useState(false);
  const [advisory,   setAdvisory]   = useState<SiteAdvisorySummary | null>(null);
  const [adjSaving,  setAdjSaving]  = useState<Record<string, boolean>>({});
  const [adjErrors,  setAdjErrors]  = useState<Record<string, boolean>>({});
  const [decay,      setDecay]      = useState<DecaySummary[] | null>(null);
  const [decayBusy,  setDecayBusy]  = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    // The demo's SupabaseLikeClient is narrower than @eq/intake's (no select).
    // At runtime the actual client has select — this cast is safe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;

    Promise.allSettled([
      computeHealthScores(sb),
      runLicenceExpiryCheck(sb, resolvedTenantId),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runOrphanCheck({ supabase: supabase as any, tenantId: resolvedTenantId }),
      computeComplianceMetrics(sb),
      readSiteAdvisory(sb),
    ]).then(([healthResult, licenceResult, orphanResult, complianceResult, advisoryResult]) => {
      if (cancelled) return;

      if (healthResult.status === "fulfilled") {
        setScores(healthResult.value);
      } else {
        setError(
          healthResult.reason instanceof Error
            ? healthResult.reason.message
            : String(healthResult.reason),
        );
      }

      if (licenceResult.status === "fulfilled") {
        setLicences(licenceResult.value);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "[IntakeHealthHome] Licence expiry check failed:",
          licenceResult.reason instanceof Error
            ? licenceResult.reason.message
            : licenceResult.reason,
        );
      }

      if (orphanResult.status === "fulfilled") {
        setOrphans(orphanResult.value.summary);
      }

      if (complianceResult.status === "fulfilled") {
        setCompliance(complianceResult.value);
      }

      if (advisoryResult.status === "fulfilled") {
        setAdvisory(advisoryResult.value);
      } else {
        // Non-fatal — a tenant not yet on migration 0180 has no summary RPC.
        // eslint-disable-next-line no-console
        console.warn(
          "[IntakeHealthHome] Site advisory read failed:",
          advisoryResult.reason instanceof Error
            ? advisoryResult.reason.message
            : advisoryResult.reason,
        );
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [supabase, resolvedTenantId]);

  // Record a human verdict on a flagged row, then reflect it optimistically:
  // the item shows the verdict and the pending/decided counts shift. If the
  // write fails (e.g. a tenant not yet on migration 0183, so the RPC is
  // missing) we flag it inline and leave the buttons — nothing else breaks.
  const handleAdjudicate = useCallback(
    async (advisoryId: string, verdict: SiteVerdict) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      setAdjSaving((s) => ({ ...s, [advisoryId]: true }));
      setAdjErrors((e) => {
        if (!e[advisoryId]) return e;
        const next = { ...e };
        delete next[advisoryId];
        return next;
      });
      try {
        await adjudicateSiteAdvisory(sb, { advisoryId, verdict });
        setAdvisory((prev) => {
          if (!prev) return prev;
          let wasPending = false;
          const items = prev.items.map((it) => {
            if (it.id !== advisoryId) return it;
            wasPending = it.verdict == null;
            return { ...it, verdict, decided_at: new Date().toISOString() };
          });
          return {
            ...prev,
            items,
            decided: wasPending ? prev.decided + 1 : prev.decided,
            pending: wasPending ? Math.max(0, prev.pending - 1) : prev.pending,
          };
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[IntakeHealthHome] adjudicate failed:",
          err instanceof Error ? err.message : err,
        );
        setAdjErrors((e) => ({ ...e, [advisoryId]: true }));
      } finally {
        setAdjSaving((s) => {
          const next = { ...s };
          delete next[advisoryId];
          return next;
        });
      }
    },
    [supabase],
  );

  if (!supabase) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-notice">Connect EQ to see your data health</div>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-loading">Checking your data…</div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-notice eq-health-notice--err" role="alert">{error}</div>
      </section>
    );
  }

  const dims    = computeDimensions(scores, licences, orphans, compliance);
  const actions = deriveActions(licences, compliance);

  const scanDuplicates = async () => {
    if (!supabase || dupesBusy) return;
    setDupesBusy(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await detectAllDuplicates(supabase as any);
      setDupes(report);
    } catch {
      // non-critical — silently skip
    } finally {
      setDupesBusy(false);
    }
  };

  const scanDecay = async () => {
    if (!supabase || decayBusy) return;
    setDecayBusy(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await decayCheck(supabase as any);
      setDecay(report);
    } catch {
      // non-critical — silently skip
    } finally {
      setDecayBusy(false);
    }
  };

  return (
    <section className="eq-health-home">

      {/* Composite score + 6 dimensions */}
      <div className="eq-health-top">
        <ScoreRing composite={dims.composite} />
        <div className="eq-health-dims">
          <DimensionBar label="Compliance"     score={dims.compliance}     weight={`${WEIGHTS.compliance}%`} />
          <DimensionBar label="Serviceability" score={dims.serviceability} weight={`${WEIGHTS.serviceability}%`} />
          <DimensionBar label="Completeness"   score={dims.completeness}   weight={`${WEIGHTS.completeness}%`} />
          <DimensionBar label="Validity"       score={dims.validity}       weight={`${WEIGHTS.validity}%`} />
          <DimensionBar label="Consistency"    score={dims.consistency}    weight={`${WEIGHTS.consistency}%`} />
          <DimensionBar label="Timeliness"     score={dims.timeliness}     weight={`${WEIGHTS.timeliness}%`} />
        </div>
      </div>

      {/* Action queue */}
      {actions.length > 0 && (
        <div className="eq-health-actions">
          <span className="eq-health-section-label">
            Fix these to improve your score
          </span>
          {actions.map((a) => (
            <ActionCard key={a.id} action={a} onEntityClick={onEntityClick} />
          ))}
        </div>
      )}

      {/* Duplicates caught at the write (resolver adjudication console) */}
      {advisory && (
        <div className="eq-health-strip-section">
          <span className="eq-health-section-label">Duplicates caught at the write</span>
          <SiteAdvisoryPanel
            summary={advisory}
            onAdjudicate={handleAdjudicate}
            saving={adjSaving}
            errors={adjErrors}
          />
        </div>
      )}

      {/* Entity cards */}
      <div className="eq-health-grid">
        {(scores ?? []).map((hs) => (
          <HealthCard key={hs.entity} hs={hs} onClick={onEntityClick} />
        ))}
      </div>

      {/* Licence strip */}
      {licences && (
        <div className="eq-health-strip-section">
          <span className="eq-health-section-label">Licences</span>
          <LicenceStrip summary={licences} />
        </div>
      )}

      {/* Orphan strip */}
      {orphans && (
        <div className="eq-health-strip-section">
          <span className="eq-health-section-label">Broken links</span>
          <OrphanStrip summary={orphans} onEntityClick={onEntityClick} />
        </div>
      )}

      {/* Duplicate detection (on-demand) */}
      <div className="eq-health-strip-section">
        <span className="eq-health-section-label">Duplicates</span>
        {dupes === null ? (
          <button
            type="button"
            className="eq-intake-btn-ghost"
            onClick={scanDuplicates}
            disabled={dupesBusy}
          >
            {dupesBusy ? "Scanning…" : "Scan for possible duplicates"}
          </button>
        ) : (
          <DuplicateStrip report={dupes} onEntityClick={onEntityClick} />
        )}
      </div>

      {/* Decay detection (on-demand) */}
      <div className="eq-health-strip-section">
        <span className="eq-health-section-label">Record age</span>
        {decay === null ? (
          <button
            type="button"
            className="eq-intake-btn-ghost"
            onClick={scanDecay}
            disabled={decayBusy}
          >
            {decayBusy ? "Scanning…" : "Check for stale records"}
          </button>
        ) : (
          <DecayStrip report={decay} onEntityClick={onEntityClick} />
        )}
      </div>

    </section>
  );
}
