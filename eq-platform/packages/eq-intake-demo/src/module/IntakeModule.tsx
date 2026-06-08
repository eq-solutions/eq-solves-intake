/**
 * IntakeModule — the production-mount entry-point for EQ Intake.
 *
 * Host app (the EQ Shell) imports this and mounts it at /intake.
 *
 * One screen, two questions:
 *   1. Drop a file — parsed + classified once by the shared useIntakeBundle
 *      hook ("looks like customers — 92% sure").
 *   2. Pick where it goes — Into EQ (canonical commit) or out to Xero / MYOB /
 *      Outlook / SharePoint / Equinix (reshape-out CSV). The same dropped
 *      files feed every destination, so nobody drops twice.
 *
 * Routes log to `eq-intake:routes` in localStorage by default. Host can
 * override via the onDestinationChange prop.
 */

import { useMemo, useState, type CSSProperties, type JSX } from "react";
import { type ParsedSheet } from "@eq/intake";
import { useIntakeBundle, roleLabel, ROLE_REGISTRY, type IntakeBundle } from "../shared/intake-bundle.js";
import { IntakeDropZone } from "../shared/IntakeDropZone.js";
import { MappingPreviewPanel } from "../shared/MappingPreviewPanel.js";
import { RowsDisclosure } from "../shared/RowsDisclosure.js";
import { entityLabel } from "../shared/entity-label.js";
import { QUICK_DESTINATIONS, encodeCsv, type QuickDestination } from "../quick-export/destinations.js";
import {
  commitBundleToCanonical,
  type SupabaseLikeClient,
  type CommitResult,
} from "../canonical/commit-canonical.js";
import type { RoleName } from "../rollup/roles.js";
import { BUILTIN_TEMPLATES } from "../rollup/templates.js";
import {
  renderTemplate,
  renderToCsv,
  type DestinationTemplate,
} from "../rollup/template.js";

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const SKY  = "#3DA8D8";
const DEEP = "#2986B4";
const ICE  = "#EAF5FB";
const INK  = "#1A1A2E";

const spinnerStyle: CSSProperties = {
  width: 14, height: 14, borderRadius: 999,
  border: `2px solid rgba(255,255,255,0.4)`,
  borderTopColor: "white",
  animation: "eq-spin 0.7s linear infinite",
  flexShrink: 0,
  display: "inline-block",
};

// ---------------------------------------------------------------------------
// Props / constants
// ---------------------------------------------------------------------------
export interface IntakeModuleProps {
  supabase?: SupabaseLikeClient | null;
  tenantId?: string;
  onDestinationChange?: (value: string | undefined, source: "suggested" | "free_text") => void;
}

const INTO_EQ_ID      = "into-eq";
const QUICK_PREFIX    = "quick:";
const TEMPLATE_PREFIX = "tpl:";
const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";
const ROUTE_LOG_KEY   = "eq-intake:routes";

function defaultRouteLogger(value: string | undefined, source: "suggested" | "free_text"): void {
  if (!value) return;
  try {
    const existing = localStorage.getItem(ROUTE_LOG_KEY);
    const log: Array<{ at: string; destination: string; source: string }> = existing ? JSON.parse(existing) : [];
    log.push({ at: new Date().toISOString(), destination: value, source });
    localStorage.setItem(ROUTE_LOG_KEY, JSON.stringify(log.slice(-200)));
  } catch { /* localStorage full / disabled */ }
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------
export function IntakeModule(props: IntakeModuleProps): JSX.Element {
  const onDestinationChange = useMemo(
    () => props.onDestinationChange ?? defaultRouteLogger,
    [props.onDestinationChange],
  );

  const bundle  = useIntakeBundle();
  const [destId, setDestId] = useState<string>(INTO_EQ_ID);

  const exportDest  = useMemo(() => QUICK_DESTINATIONS.find((d) => `${QUICK_PREFIX}${d.id}` === destId), [destId]);
  const joinTemplate = useMemo(() => BUILTIN_TEMPLATES.find((t) => `${TEMPLATE_PREFIX}${t.id}` === destId), [destId]);
  const isCanonical  = destId === INTO_EQ_ID;

  const hasRecognisedFiles = bundle.slots.some((s) => s.role !== "unknown" && !s.error);

  return (
    <section
      className="eq-intake-module"
      style={{ padding: "24px 0", fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: INK }}
    >
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4, color: INK }}>
          Bring a file in
        </h2>
        <p style={{ fontSize: 14, color: INK, opacity: 0.55, lineHeight: 1.5 }}>
          Drop a SimPRO export — we'll work out what it is, then you choose where it goes.
          One drop, no retyping.
        </p>
      </div>

      {/* Drop zone */}
      <IntakeDropZone bundle={bundle} />

      {/* Destination + action */}
      {hasRecognisedFiles && (
        <>
          <DestinationPicker
            destId={destId}
            bundle={bundle}
            onChange={(id) => { setDestId(id); onDestinationChange(id, "suggested"); }}
          />

          <div style={{ marginTop: 20 }}>
            {isCanonical ? (
              <CommitView
                bundle={bundle}
                supabase={props.supabase}
                tenantId={props.tenantId ?? DEFAULT_TENANT_ID}
              />
            ) : joinTemplate ? (
              <TemplateExportView bundle={bundle} template={joinTemplate} />
            ) : (
              exportDest && <ExportView bundle={bundle} dest={exportDest} />
            )}
          </div>

          {/* Start over */}
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #EEF2F7" }}>
            <button
              type="button"
              onClick={() => bundle.reset()}
              disabled={bundle.busy}
              style={{
                padding: "8px 14px",
                fontSize: 13, fontWeight: 500,
                background: "transparent",
                color: INK, opacity: 0.4,
                border: "1px solid #E5E7EB",
                borderRadius: 8,
                cursor: bundle.busy ? "not-allowed" : "pointer",
                transition: "opacity 0.15s",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.opacity = "0.8"; }}
              onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.opacity = "0.4"; }}
            >
              Start over
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ============================================================================
// DESTINATION PICKER
// Replaces the <select> with visual destination pills/cards.
// ============================================================================

interface DestOption {
  id: string;
  label: string;
  description: string;
  shortLabel?: string;
  needsRoles: RoleName[];
  group: "eq" | "quick" | "join";
}

const INTO_EQ_OPTION: DestOption = {
  id: INTO_EQ_ID,
  label: "Save into EQ",
  shortLabel: "Into EQ",
  description: "Save these records into EQ — customers, sites and contacts in one place.",
  needsRoles: [],
  group: "eq",
};

const QUICK_OPTIONS: DestOption[] = QUICK_DESTINATIONS.map((d) => ({
  id: `${QUICK_PREFIX}${d.id}`,
  label: d.label,
  description: d.description,
  needsRoles: [d.needsRole],
  group: "quick" as const,
}));

const TEMPLATE_OPTIONS: DestOption[] = BUILTIN_TEMPLATES.map((t) => ({
  id: `${TEMPLATE_PREFIX}${t.id}`,
  label: t.name,
  description: t.description ?? "",
  needsRoles: t.requiredRoles,
  group: "join" as const,
}));

function destAvailable(opt: DestOption, bundle: IntakeBundle): boolean {
  if (opt.needsRoles.length === 0) return bundle.availableRoles.size > 0;
  return opt.needsRoles.every((r) => bundle.availableRoles.has(r));
}

function missingRoles(opt: DestOption, bundle: IntakeBundle): RoleName[] {
  return opt.needsRoles.filter((r) => !bundle.availableRoles.has(r));
}

function DestinationPicker({
  destId,
  bundle,
  onChange,
}: {
  destId: string;
  bundle: IntakeBundle;
  onChange: (id: string) => void;
}): JSX.Element {
  const selected = [...[INTO_EQ_OPTION], ...QUICK_OPTIONS, ...TEMPLATE_OPTIONS].find((o) => o.id === destId) ?? INTO_EQ_OPTION;
  const missing = missingRoles(selected, bundle);

  const quickAvailable = QUICK_OPTIONS.filter((o) => destAvailable(o, bundle));
  const quickUnavailable = QUICK_OPTIONS.filter((o) => !destAvailable(o, bundle));
  const joinAvailable = TEMPLATE_OPTIONS.filter((o) => destAvailable(o, bundle));

  return (
    <div>
      {/* Section label */}
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: INK, opacity: 0.4, marginBottom: 10 }}>
        Where's it going?
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Row 1: Into EQ (primary) + quick exports */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {/* Into EQ — primary pill */}
          <DestPill
            opt={INTO_EQ_OPTION}
            isSelected={destId === INTO_EQ_ID}
            available={destAvailable(INTO_EQ_OPTION, bundle)}
            primary
            onClick={() => onChange(INTO_EQ_ID)}
          />

          {/* Divider */}
          {(quickAvailable.length > 0 || quickUnavailable.length > 0) && (
            <span style={{ fontSize: 11, color: INK, opacity: 0.2, padding: "0 2px" }}>or export as</span>
          )}

          {/* Available quick exports */}
          {quickAvailable.map((o) => (
            <DestPill key={o.id} opt={o} isSelected={destId === o.id} available onClick={() => onChange(o.id)} />
          ))}

          {/* Unavailable quick exports — greyed out with tooltip */}
          {quickUnavailable.map((o) => (
            <DestPill key={o.id} opt={o} isSelected={false} available={false} onClick={() => {}} />
          ))}
        </div>

        {/* Row 2: Join templates (only if any available) */}
        {joinAvailable.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: INK, opacity: 0.2, paddingRight: 2 }}>or join files for</span>
            {joinAvailable.map((o) => (
              <DestPill key={o.id} opt={o} isSelected={destId === o.id} available onClick={() => onChange(o.id)} />
            ))}
          </div>
        )}
      </div>

      {/* Selected destination description + missing-file warning */}
      {selected && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: INK, opacity: 0.6, flex: 1, minWidth: 180 }}>
            {selected.description}
          </span>
          {missing.length > 0 && (
            <span style={{
              fontSize: 12, fontWeight: 600, color: "#B45309",
              background: "#FFFBEB", padding: "2px 10px", borderRadius: 999,
              whiteSpace: "nowrap",
            }}>
              Drop {missing.map(roleLabel).join(" + ")} file{missing.length > 1 ? "s" : ""} first
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function DestPill({
  opt,
  isSelected,
  available,
  primary = false,
  onClick,
}: {
  opt: DestOption;
  isSelected: boolean;
  available: boolean;
  primary?: boolean;
  onClick: () => void;
}): JSX.Element {
  const label = opt.shortLabel ?? opt.label;

  const base: CSSProperties = {
    display: "inline-flex", alignItems: "center",
    padding: primary ? "7px 14px" : "5px 12px",
    borderRadius: 8,
    fontSize: primary ? 14 : 13,
    fontWeight: isSelected ? 600 : 500,
    cursor: available ? "pointer" : "default",
    border: "1px solid transparent",
    transition: "all 0.12s",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    lineHeight: 1,
    opacity: available ? 1 : 0.35,
  };

  if (isSelected && primary) {
    return (
      <button type="button" onClick={onClick} style={{ ...base, background: DEEP, color: "white", borderColor: DEEP }}>
        {label}
      </button>
    );
  }
  if (isSelected) {
    return (
      <button type="button" onClick={onClick} style={{ ...base, background: ICE, color: DEEP, borderColor: SKY }}>
        {label}
      </button>
    );
  }
  if (primary) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={{ ...base, background: "white", color: DEEP, borderColor: "#B8D9EE" }}
        onMouseEnter={(e) => { if (available) { (e.currentTarget as HTMLButtonElement).style.background = ICE; } }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "white"; }}
      >
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={available ? onClick : undefined}
      style={{ ...base, background: "#F8FAFC", color: INK, borderColor: "#E5E7EB" }}
      onMouseEnter={(e) => { if (available) { (e.currentTarget as HTMLButtonElement).style.background = ICE; (e.currentTarget as HTMLButtonElement).style.borderColor = "#B8D9EE"; } }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#F8FAFC"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#E5E7EB"; }}
    >
      {label}
    </button>
  );
}

// ============================================================================
// PREVIEW TABLE — shared between ExportView and TemplateExportView
// ============================================================================
function PreviewTable({
  headers,
  rows,
  totalRows,
  destLabel,
}: {
  headers: string[];
  rows: Record<string, string>[];
  totalRows: number;
  destLabel: string;
}): JSX.Element {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: INK, opacity: 0.5, marginBottom: 6 }}>
        Preview — first {rows.length} of {totalRows.toLocaleString()} rows → {destLabel}
      </div>
      <div style={{ overflowX: "auto", border: "1px solid #EEF2F7", borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#F8FAFC" }}>
              {headers.map((h) => (
                <th key={h} style={{ padding: "6px 10px", textAlign: "left", whiteSpace: "nowrap", fontWeight: 600, color: DEEP, borderBottom: "1px solid #EEF2F7" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={{ borderBottom: i < rows.length - 1 ? "1px solid #F4F6F8" : undefined }}>
                {headers.map((h) => (
                  <td key={h} style={{ padding: "5px 10px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: INK }} title={String(row[h] ?? "")}>
                    {String(row[h] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// EXPORT VIEW — reshape-out preview + download
// ============================================================================
function ExportView({ bundle, dest }: { bundle: IntakeBundle; dest: QuickDestination }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<{ filename: string; rowCount: number } | null>(null);

  const matched = bundle.slotForRole(dest.needsRole);

  const previewRows = useMemo((): Record<string, string>[] | null => {
    if (!matched?.sheet) return null;
    return (matched.sheet.rows as Record<string, unknown>[]).slice(0, 5).map((r) => {
      const out: Record<string, string> = {};
      for (const col of dest.columns) out[col.name] = String(col.value(r) ?? "");
      return out;
    });
  }, [matched, dest]);

  const download = () => {
    setError(null);
    if (!matched?.sheet) {
      setError(`This needs a ${roleLabel(dest.needsRole)} file. Drop one above first.`);
      return;
    }
    const headers = dest.columns.map((c) => c.name);
    const rows = matched.sheet.rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const col of dest.columns) out[col.name] = col.value(r as Record<string, unknown>);
      return out;
    });
    const csv = encodeCsv(headers, rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = dest.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded({ filename: dest.filename, rowCount: rows.length });
  };

  return (
    <div>
      {previewRows && previewRows.length > 0 && !downloaded && (
        <PreviewTable
          headers={dest.columns.map((c) => c.name)}
          rows={previewRows}
          totalRows={matched!.sheet!.rows.length}
          destLabel={dest.label}
        />
      )}

      {error && <ErrorBanner message={error} />}

      {downloaded ? (
        <SuccessBanner>
          Downloaded <strong>{downloaded.filename}</strong> — {downloaded.rowCount} row{downloaded.rowCount === 1 ? "" : "s"}.
        </SuccessBanner>
      ) : (
        <PrimaryButton onClick={download} disabled={!matched}>
          Download {dest.label}
        </PrimaryButton>
      )}
    </div>
  );
}

// ============================================================================
// TEMPLATE EXPORT VIEW — multi-file JOIN templates
// ============================================================================
function TemplateExportView({ bundle, template }: { bundle: IntakeBundle; template: DestinationTemplate }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<{ filename: string; rowCount: number } | null>(null);

  const byRole = useMemo(() => {
    const map: Partial<Record<RoleName, ParsedSheet>> = {};
    for (const slot of bundle.slots) {
      if (slot.role === "unknown" || !slot.sheet) continue;
      if (!map[slot.role]) map[slot.role] = slot.sheet;
    }
    return map;
  }, [bundle.slots]);

  const missing = template.requiredRoles.filter((r) => !byRole[r]);
  const filename = `${template.id}.csv`;

  const result = useMemo(() => {
    if (missing.length > 0) return null;
    return renderTemplate(template, byRole);
  }, [template, byRole, missing.length]);

  const previewRows = result ? result.rows.slice(0, 5) : null;
  const destLabel = template.destinationLabel ?? "CSV";

  const download = () => {
    setError(null);
    if (!result) {
      setError(`This needs ${missing.map(roleLabel).join(" + ")}. Drop the missing file(s) above first.`);
      return;
    }
    const csv = renderToCsv(result);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded({ filename, rowCount: result.rows.length });
  };

  return (
    <div>
      {result && previewRows && previewRows.length > 0 && !downloaded && (
        <PreviewTable
          headers={result.headers}
          rows={previewRows}
          totalRows={result.rows.length}
          destLabel={destLabel}
        />
      )}

      {error && <ErrorBanner message={error} />}

      {downloaded ? (
        <SuccessBanner>
          Downloaded <strong>{downloaded.filename}</strong> — {downloaded.rowCount} row{downloaded.rowCount === 1 ? "" : "s"}.
        </SuccessBanner>
      ) : (
        <PrimaryButton onClick={download} disabled={!result}>
          Download {destLabel}
        </PrimaryButton>
      )}
    </div>
  );
}

// ============================================================================
// COMMIT VIEW — Into EQ (canonical commit)
// ============================================================================
type CommitBundle = {
  customer?: ParsedSheet;
  site?: ParsedSheet;
  contact?: ParsedSheet;
  staff?: ParsedSheet;
  licence?: ParsedSheet;
};

function CommitView({ bundle, supabase, tenantId }: { bundle: IntakeBundle; supabase?: SupabaseLikeClient | null; tenantId: string }): JSX.Element {
  const enabled = !!supabase;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  const commit = async () => {
    if (!supabase) return;
    setError(null); setResult(null);

    const commitBundle: CommitBundle = {};
    for (const slot of bundle.slots) {
      if (slot.role === "unknown" || !slot.sheet) continue;
      const key = slot.role as keyof CommitBundle;
      if (commitBundle[key]) { setError(`Two files look like ${slot.role}s. Remove one before saving.`); return; }
      commitBundle[key] = slot.sheet;
    }
    if (!commitBundle.customer && !commitBundle.site && !commitBundle.contact && !commitBundle.staff && !commitBundle.licence) {
      setError("Drop at least one file we recognise — a customer, site, contact, staff, or licence list.");
      return;
    }

    setBusy(true); setProgressMsg(null);
    try {
      const commitResult = await commitBundleToCanonical({
        supabase, bundle: commitBundle, tenantId,
        sourceFilename: bundle.slots.filter((s) => s.role !== "unknown").map((s) => s.file.name).join("+"),
        onProgress: (msg) => setProgressMsg(msg),
      });
      setResult(commitResult); setProgressMsg(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {!enabled && (
        <div style={{ padding: "10px 14px", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, fontSize: 13, color: "#78350F", marginBottom: 16 }}>
          EQ isn't connected yet — ask whoever set this up to fill in the connection details. Saving stays inactive until then.
        </div>
      )}

      {progressMsg && (
        <div style={{ padding: "10px 14px", background: ICE, borderRadius: 8, fontSize: 13, color: DEEP, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ ...spinnerStyle, borderColor: `${DEEP}33`, borderTopColor: DEEP }} />
          {progressMsg}
        </div>
      )}

      {error && <ErrorBanner message={error} />}

      {/* Pre-commit mapping preview */}
      {!result && bundle.slots.some((s) => s.role !== "unknown" && s.sheet) && (
        <div style={{ marginBottom: 16 }}>
          <MappingPreviewPanel slots={bundle.slots} registry={ROLE_REGISTRY} />
        </div>
      )}

      {!result && (
        <PrimaryButton onClick={commit} disabled={!enabled || busy} loading={busy}>
          {busy ? "Saving…" : "Save into EQ"}
        </PrimaryButton>
      )}

      {result && <CommitSummary result={result} />}

      {result?.perEntity.some((r) => r.flaggedRows.length > 0) && (
        <RowsDisclosure
          label="Show rows that saved but need checking"
          hint="These rows are in EQ, but something caught our eye. Review each one before relying on it."
          accentColor="#d97706"
          hintColor="#78350f"
          perEntity={result.perEntity.map((r) => ({ entity: r.entity, rows: r.flaggedRows }))}
        />
      )}

      {result?.perEntity.some((r) => r.rejectedRows.length > 0) && (
        <RowsDisclosure
          label="Show rows that couldn't save — and why"
          accentColor={INK}
          showDownload
          downloadFilename="eq-rejected-rows.csv"
          perEntity={result.perEntity.map((r) => ({ entity: r.entity, rows: r.rejectedRows }))}
        />
      )}
    </div>
  );
}

function CommitSummary({ result }: { result: CommitResult }): JSX.Element {
  const saved    = result.perEntity.reduce((n, r) => n + r.committedCount, 0);
  const flagged  = result.perEntity.reduce((n, r) => n + r.flaggedCount, 0);
  const rejected = result.perEntity.reduce((n, r) => n + r.rejectedCount, 0);
  const hasFatal = result.perEntity.some((r) => r.fatalError);

  const bg      = hasFatal ? "#FEF2F2" : rejected > 0 ? "#FFFBEB" : "#F0FDF4";
  const border  = hasFatal ? "#FECACA" : rejected > 0 ? "#FDE68A" : "#BBF7D0";
  const icon    = hasFatal ? "✗" : rejected > 0 ? "⚠" : "✓";
  const iconBg  = hasFatal ? "#FEE2E2" : rejected > 0 ? "#FEF3C7" : "#D1FAE5";
  const iconClr = hasFatal ? "#DC2626" : rejected > 0 ? "#D97706" : "#059669";

  return (
    <div role="status" aria-live="polite" style={{ marginTop: 4, padding: "14px 16px", background: bg, border: `1px solid ${border}`, borderRadius: 10, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: iconBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: iconClr, flexShrink: 0, fontWeight: 700 }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 140 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: INK }}>
          {saved.toLocaleString()} record{saved === 1 ? "" : "s"} saved
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 2, flexWrap: "wrap" }}>
          {flagged > 0 && (
            <span style={{ fontSize: 12, color: "#D97706" }}>
              {flagged.toLocaleString()} need{flagged === 1 ? "s" : ""} checking
            </span>
          )}
          {rejected > 0 && (
            <span style={{ fontSize: 12, color: "#DC2626" }}>
              {rejected.toLocaleString()} couldn't save
            </span>
          )}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {result.perEntity
          .filter((r) => r.committedCount > 0)
          .map((r) => (
            <span key={r.entity} style={{ padding: "3px 10px", borderRadius: 999, background: DEEP, color: "white", fontSize: 12, fontWeight: 600 }}>
              {r.committedCount} {entityLabel(r.entity).toLowerCase()}
            </span>
          ))}
      </div>
    </div>
  );
}

// ============================================================================
// SHARED SMALL COMPONENTS
// ============================================================================

function PrimaryButton({
  onClick,
  disabled = false,
  loading = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const active = !disabled && !loading;
  return (
    <button
      type="button"
      onClick={active ? onClick : undefined}
      disabled={disabled || loading}
      style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        padding: "10px 20px",
        background: active ? DEEP : "#B8CFE0",
        color: "white",
        border: "none",
        borderRadius: 8,
        fontWeight: 600,
        fontSize: 14,
        cursor: active ? "pointer" : "not-allowed",
        transition: "background 0.12s",
        fontFamily: "inherit",
      }}
    >
      {loading && <span style={spinnerStyle} />}
      {children}
    </button>
  );
}

function ErrorBanner({ message }: { message: string }): JSX.Element {
  return (
    <div role="alert" style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, color: "#DC2626", fontSize: 13, marginBottom: 16 }}>
      {message}
    </div>
  );
}

function SuccessBanner({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ padding: "10px 14px", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, fontSize: 13, color: "#166534" }}>
      ✓ {children}
    </div>
  );
}
