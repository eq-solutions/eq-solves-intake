import { useState, useEffect, type JSX } from "react";
import { computeHealthScores, runLicenceExpiryCheck, runOrphanCheck } from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface IntakeHealthHomeProps {
  supabase?: SupabaseLikeClient | null;
  tenantId?: string;
  onEntityClick?: (entity: string) => void;
}

// ---------------------------------------------------------------------------
// Local types — inline shapes matching the engine APIs
// ---------------------------------------------------------------------------

interface HealthScore {
  entity: string;
  total: number;
  complete: number;
  score: number;
  gaps: string[];
}

interface LicenceExpiryAlertSummary {
  total: number;
  critical: number;
  warning: number;
  info: number;
}

interface OrphanSummary {
  assets_no_site_count: number;
  contacts_no_parent_count: number;
  licences_no_staff_count: number;
  sites_no_customer_count: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTITY_LABELS: Record<string, string> = {
  staff: "Staff",
  sites: "Sites",
  assets: "Assets",
  customers: "Customers",
  contacts: "Contacts",
};

function scoreColourClass(score: number): string {
  if (score >= 0.9) return "eq-health-bar__fill--ok";
  if (score >= 0.7) return "eq-health-bar__fill--warn";
  return "eq-health-bar__fill--err";
}

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HealthCard({
  hs,
  onClick,
}: {
  hs: HealthScore;
  onClick?: (entity: string) => void;
}): JSX.Element {
  const label = ENTITY_LABELS[hs.entity] ?? hs.entity;
  const percentage = pct(hs.score);
  const fillClass = scoreColourClass(hs.score);
  const hasGaps = hs.gaps.length > 0;

  return (
    <button
      type="button"
      className="eq-health-card"
      onClick={onClick ? () => onClick(hs.entity) : undefined}
      aria-label={`${label} — ${percentage} complete`}
    >
      <div className="eq-health-card__header">
        <span className="eq-health-card__name">{label}</span>
        <span className="eq-health-card__count">
          {hs.total.toLocaleString()} record{hs.total === 1 ? "" : "s"}
        </span>
      </div>

      <div className="eq-health-bar">
        <div className="eq-health-bar__track">
          <span
            className={`eq-health-bar__fill ${fillClass}`}
            style={{ width: percentage } as React.CSSProperties}
          />
        </div>
        <span className="eq-health-bar__label">{percentage}</span>
      </div>

      {hasGaps && (
        <p className="eq-health-card__gaps">
          Missing: {hs.gaps.join(", ")}
        </p>
      )}
    </button>
  );
}

function OrphanStrip({
  summary,
  onEntityClick,
}: {
  summary: OrphanSummary;
  onEntityClick?: (entity: string) => void;
}): JSX.Element {
  if (summary.total === 0) {
    return (
      <div className="eq-health-orphan eq-health-orphan--ok">
        <span className="eq-health-licence__badge eq-health-licence__badge--ok">
          No broken links
        </span>
      </div>
    );
  }

  function OrphanBadge({
    count,
    entity,
    label,
  }: {
    count: number;
    entity: string;
    label: string;
  }): JSX.Element | null {
    if (count === 0) return null;
    const text = `${count} ${label}`;
    return onEntityClick ? (
      <button
        type="button"
        className="eq-health-licence__badge eq-health-licence__badge--warning eq-health-orphan__btn"
        onClick={() => onEntityClick(entity)}
        title={`Open ${entity} drill-down`}
      >
        {text}
      </button>
    ) : (
      <span className="eq-health-licence__badge eq-health-licence__badge--warning">
        {text}
      </span>
    );
  }

  return (
    <div className="eq-health-orphan">
      <OrphanBadge
        count={summary.assets_no_site_count}
        entity="assets"
        label={`asset${summary.assets_no_site_count !== 1 ? "s" : ""} missing site`}
      />
      <OrphanBadge
        count={summary.contacts_no_parent_count}
        entity="contacts"
        label={`contact${summary.contacts_no_parent_count !== 1 ? "s" : ""} unlinked`}
      />
      <OrphanBadge
        count={summary.licences_no_staff_count}
        entity="licences"
        label={`licence${summary.licences_no_staff_count !== 1 ? "s" : ""} missing staff`}
      />
      <OrphanBadge
        count={summary.sites_no_customer_count}
        entity="sites"
        label={`site${summary.sites_no_customer_count !== 1 ? "s" : ""} missing customer`}
      />
    </div>
  );
}

function LicenceStrip({
  summary,
}: {
  summary: LicenceExpiryAlertSummary;
}): JSX.Element {
  if (summary.total === 0) {
    return (
      <div className="eq-health-licence eq-health-licence--ok">
        <span className="eq-health-licence__badge eq-health-licence__badge--ok">
          All licences OK
        </span>
      </div>
    );
  }

  return (
    <div className="eq-health-licence">
      {summary.critical > 0 && (
        <span className="eq-health-licence__badge eq-health-licence__badge--critical">
          {summary.critical} critical
        </span>
      )}
      {summary.warning > 0 && (
        <span className="eq-health-licence__badge eq-health-licence__badge--warning">
          {summary.warning} expiring soon
        </span>
      )}
      {summary.info > 0 && (
        <span className="eq-health-licence__badge eq-health-licence__badge--info">
          {summary.info} within 60 days
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function IntakeHealthHome({
  supabase,
  tenantId = "00000000-0000-4000-8000-000000000001",
  onEntityClick,
}: IntakeHealthHomeProps): JSX.Element {
  const [scores, setScores] = useState<HealthScore[] | null>(null);
  const [licences, setLicences] = useState<LicenceExpiryAlertSummary | null>(null);
  const [orphans, setOrphans] = useState<OrphanSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.allSettled([
      computeHealthScores(supabase),
      runLicenceExpiryCheck(supabase, tenantId),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runOrphanCheck({ supabase: supabase as any, tenantId }),
    ])
      .then(([healthResult, licenceResult, orphanResult]) => {
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
        }

        if (orphanResult.status === "fulfilled") {
          setOrphans(orphanResult.value.summary);
        }
        // Orphan check failure is silent — the rest of the UI still shows.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [supabase, tenantId]);

  // No connection
  if (!supabase) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-notice eq-health-notice--disconnected">
          Connect EQ to see your data health
        </div>
      </section>
    );
  }

  // Loading
  if (loading) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-loading">
          <span className="eq-health-spinner" aria-hidden="true" />
          <span>Checking your data…</span>
        </div>
      </section>
    );
  }

  // Error
  if (error) {
    return (
      <section className="eq-health-home">
        <div className="eq-health-notice eq-health-notice--err" role="alert">
          {error}
        </div>
      </section>
    );
  }

  // Data ready
  return (
    <section className="eq-health-home">
      <div className="eq-health-header">
        <h2 className="eq-health-title">Data health</h2>
        <p className="eq-health-subtitle">
          Completion scores across your core records.
        </p>
      </div>

      <div className="eq-health-grid">
        {(scores ?? []).map((hs) => (
          <HealthCard key={hs.entity} hs={hs} onClick={onEntityClick} />
        ))}
      </div>

      {licences && (
        <div className="eq-health-licence-section">
          <span className="eq-health-licence-label">Licences</span>
          <LicenceStrip summary={licences} />
        </div>
      )}

      {orphans && (
        <div className="eq-health-licence-section">
          <span className="eq-health-licence-label">Broken links</span>
          <OrphanStrip summary={orphans} onEntityClick={onEntityClick} />
        </div>
      )}
    </section>
  );
}
