/**
 * CanonicalCommitSection — sibling of RollupDropZone inside IntakeModule.
 *
 * The reshape-out flow (RollupDropZone) produces destination-shaped CSVs
 * (Xero, MYOB, SharePoint, etc.) — those don't land in canonical.
 *
 * This component is the parallel commit-to-canonical path: drop the SimPRO
 * bundle here, see what would be committed, hit Commit. The bookkeeper sees
 * per-entity counts (committed / flagged / rejected) and the intake_ids for
 * the audit trail.
 *
 * UI is intentionally minimal — Plus Jakarta Sans + EQ palette (Sky/Deep/
 * Ice/Ink). No gradients, no shadows. Linear/Notion aesthetic per Royce's
 * brand notes.
 */

import { useState, useRef, type DragEvent, type JSX } from "react";
import { parseFile, classifySheet, type ParsedSheet } from "@eq/intake";
import {
  CUSTOMER_SCHEMA,
  CONTACT_SCHEMA,
  SITE_SCHEMA,
  STAFF_SCHEMA,
} from "../simpro-schemas.js";
import type { RoleName } from "../rollup/roles.js";
import {
  commitBundleToCanonical,
  type SupabaseLikeClient,
  type CommitResult,
  type EntityCommitResult,
} from "./commit-canonical.js";
import { entityLabel } from "../shared/entity-label.js";
import { RowsDisclosure } from "../shared/RowsDisclosure.js";
import { MappingPreviewPanel } from "../shared/MappingPreviewPanel.js";

const ROLE_REGISTRY: Record<RoleName, Record<string, unknown>> = {
  customer: CUSTOMER_SCHEMA,
  contact: CONTACT_SCHEMA,
  site: SITE_SCHEMA,
  staff: STAFF_SCHEMA,
};

export interface CanonicalCommitSectionProps {
  /**
   * Authenticated Supabase client. When null/undefined, the section renders
   * in disabled state with a "Configure Supabase to enable" hint. The shell
   * passes `getSupabase()` here; the standalone playground passes nothing.
   */
  supabase?: SupabaseLikeClient | null;
  /**
   * Tenant ID for the commit. In the single-tenant-per-Supabase model this
   * is fixed per deployment — the shell reads VITE_TENANT_ID and passes it
   * down. Default keeps the demo working in isolation.
   */
  tenantId?: string;
}

const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";

interface FileSlot {
  file: File;
  role: RoleName | "unknown";
  sheet?: ParsedSheet;
  confidence?: number;
  error?: string;
}

export function CanonicalCommitSection(props: CanonicalCommitSectionProps): JSX.Element {
  const enabled = !!props.supabase;
  const tenantId = props.tenantId ?? DEFAULT_TENANT_ID;
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [slots, setSlots] = useState<FileSlot[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);

  const ingestFiles = async (files: File[]) => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const next: FileSlot[] = [];
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        try {
          const parsed = await parseFile({ bytes, fileName: file.name });
          if (!parsed.sheets.length) {
            next.push({ file, role: "unknown", error: "Parser returned no sheets" });
            continue;
          }
          // Classify every sheet — one slot per sheet so multi-tab exports work.
          for (const sheet of parsed.sheets) {
            const classification = await classifySheet({
              schemas: ROLE_REGISTRY,
              sheet,
            });
            const role =
              classification.entity === "customer" ||
              classification.entity === "contact" ||
              classification.entity === "site" ||
              classification.entity === "staff"
                ? (classification.entity as RoleName)
                : "unknown";
            next.push({ file, role, sheet, confidence: classification.confidence });
          }
        } catch (e) {
          next.push({
            file,
            role: "unknown",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      setSlots((prev) => [...prev, ...next]);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) void ingestFiles(files);
  };

  const commit = async () => {
    if (!props.supabase) return;
    setError(null);
    setResult(null);
    const bundle: { customer?: ParsedSheet; site?: ParsedSheet; contact?: ParsedSheet; staff?: ParsedSheet; licence?: ParsedSheet } = {};
    for (const slot of slots) {
      if (slot.role === "unknown" || !slot.sheet) continue;
      const key = slot.role as keyof typeof bundle;
      if (bundle[key]) {
        setError(
          `Two files look like ${slot.role}s. Remove one before saving.`,
        );
        return;
      }
      bundle[key] = slot.sheet;
    }
    if (!bundle.customer && !bundle.site && !bundle.contact && !bundle.staff && !bundle.licence) {
      setError(
        "Drop at least one file first — a customer, site, contact, staff, or licence list.",
      );
      return;
    }
    setBusy(true);
    setProgressMsg(null);
    try {
      const commitResult = await commitBundleToCanonical({
        supabase: props.supabase,
        bundle,
        tenantId,
        sourceFilename: slots
          .filter((s) => s.role !== "unknown")
          .map((s) => s.file.name)
          .join("+"),
        onProgress: (msg) => setProgressMsg(msg),
      });
      setResult(commitResult);
      setProgressMsg(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeSlot = (idx: number) => {
    setSlots((prev) => prev.filter((_, i) => i !== idx));
  };

  const reset = () => {
    setSlots([]);
    setResult(null);
    setError(null);
    setProgressMsg(null);
  };

  return (
    <section
      aria-labelledby="canonical-commit-heading"
      style={{
        borderTop: "1px solid #EAF5FB",
        padding: "24px 0",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        color: "#1A1A2E",
      }}
    >
      <h2
        id="canonical-commit-heading"
        style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}
      >
        Save into EQ
      </h2>
      <p style={{ fontSize: 14, color: "#1A1A2E", opacity: 0.7, marginBottom: 16 }}>
        Drop your SimPRO files here — the customer list, the sites list, the
        contacts list. They land in EQ so you don't have to retype them
        anywhere else. We keep a record of every file you bring in, so
        you can always trace where a row came from.
      </p>

      {!enabled && (
        <div
          style={{
            padding: 12,
            background: "#EAF5FB",
            border: "1px solid #2986B4",
            borderRadius: 4,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          EQ isn't connected yet — ask whoever set this up to fill in the
          connection details. The drop zone below stays inactive until then.
        </div>
      )}

      <div
        onDrop={enabled ? onDrop : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          if (enabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => enabled && inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? "#3DA8D8" : "#EAF5FB"}`,
          background: enabled ? (dragOver ? "#EAF5FB" : "white") : "#F4F4F8",
          padding: 24,
          borderRadius: 4,
          textAlign: "center",
          cursor: enabled ? "pointer" : "not-allowed",
          opacity: enabled ? 1 : 0.5,
          marginBottom: 12,
        }}
      >
        {busy && slots.length === 0 ? (
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span className="eq-spinner__dot" />
            Reading file…
          </span>
        ) : slots.length === 0
          ? "Drop files here, or click to pick them"
          : `${slots.length} file${slots.length === 1 ? "" : "s"} ready — drop more or click Save`}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) void ingestFiles(files);
            e.target.value = "";
          }}
        />
      </div>

      {slots.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, marginBottom: 16 }}>
          {slots.map((slot, i) => (
            <li
              key={i}
              style={{
                padding: "6px 8px",
                borderBottom: "1px solid #F4F4F8",
                fontSize: 13,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 8,
              }}
            >
              <span style={{ flex: 1 }}>
                <strong>{slot.file.name}</strong>
                {slot.sheet?.name && slot.sheet.name !== "Sheet1" && (
                  <span style={{ color: "#2986B4", fontSize: 11, marginLeft: 6 }}>
                    [{slot.sheet.name}]
                  </span>
                )}
                {" "}
                <span style={{ color: "#1A1A2E", opacity: 0.6 }}>
                  {slot.role === "unknown"
                    ? "— couldn't tell what this is"
                    : `— looks like ${entityLabel(slot.role as EntityCommitResult["entity"]).toLowerCase()}`}
                  {slot.confidence != null && slot.role !== "unknown"
                    ? ` (${Math.round(slot.confidence * 100)}% sure)`
                    : ""}
                </span>
                {slot.confidence != null && slot.confidence < 0.7 && slot.role !== "unknown" && (
                  <span style={{ display: "block", color: "#d97706", fontSize: 11, marginTop: 2, fontWeight: 500 }}>
                    Low confidence — is this really {entityLabel(slot.role as EntityCommitResult["entity"]).toLowerCase()}? Check and remove if wrong.
                  </span>
                )}
                {slot.error && (
                  <span style={{ display: "block", color: "#B33A3A", fontSize: 12, marginTop: 2 }}>{slot.error}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => removeSlot(i)}
                disabled={busy}
                aria-label={`Remove ${slot.file.name}`}
                style={{
                  padding: "2px 8px",
                  fontSize: 12,
                  flexShrink: 0,
                  background: "white",
                  color: "#1A1A2E",
                  border: "1px solid #EAF5FB",
                  borderRadius: 4,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {slots.some((s) => s.role !== "unknown" && s.sheet) && (
        <MappingPreviewPanel slots={slots} registry={ROLE_REGISTRY} />
      )}

      {progressMsg && (
        <div
          style={{
            padding: "8px 12px",
            background: "#EAF5FB",
            borderRadius: 4,
            fontSize: 13,
            color: "#2986B4",
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span className="eq-spinner__dot" style={{ width: 10, height: 10, flexShrink: 0 }} />
          {progressMsg}
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            padding: 12,
            background: "#FBEAEA",
            border: "1px solid #B33A3A",
            borderRadius: 4,
            color: "#B33A3A",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={commit}
          disabled={!enabled || busy || slots.length === 0}
          style={{
            padding: "10px 18px",
            background: enabled && !busy ? "#3DA8D8" : "#BFD4DF",
            color: "white",
            border: "none",
            borderRadius: 4,
            fontWeight: 500,
            cursor: enabled && !busy ? "pointer" : "not-allowed",
            fontSize: 14,
          }}
        >
          {busy ? (
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="eq-spinner__dot" style={{ width: 10, height: 10 }} />
              Saving…
            </span>
          ) : "Save into EQ"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          style={{
            padding: "10px 18px",
            background: "white",
            color: "#1A1A2E",
            border: "1px solid #EAF5FB",
            borderRadius: 4,
            cursor: busy ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          Start over
        </button>
      </div>

      {result && <ImportSummaryBadge result={result} />}

      {result && (
        <div style={{ marginTop: 24 }}>
          <h3
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 8,
              color: result.bundleSuccess ? "#2986B4" : "#B33A3A",
            }}
          >
            {result.bundleSuccess ? "Saved" : "Something went wrong"}
          </h3>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#EAF5FB" }}>
                <th style={{ padding: 6, textAlign: "left" }}>Type</th>
                <th style={{ padding: 6, textAlign: "right" }}>Saved</th>
                <th style={{ padding: 6, textAlign: "right" }}>Need checking</th>
                <th style={{ padding: 6, textAlign: "right" }}>Couldn't save</th>
                <th style={{ padding: 6, textAlign: "left" }}>Reference</th>
              </tr>
            </thead>
            <tbody>
              {result.perEntity.map((r) => (
                <EntityResultRow key={r.entity} r={r} />
              ))}
            </tbody>
          </table>

          {result.perEntity.some((r) => r.flaggedRows.length > 0) && (
            <RowsDisclosure
              label="Show rows that saved but need checking"
              hint="These rows are in EQ, but something caught our eye. Review each one before relying on it."
              accentColor="#d97706"
              hintColor="#78350f"
              perEntity={result.perEntity.map((r) => ({
                entity: r.entity,
                rows: r.flaggedRows,
              }))}
            />
          )}

          {result.perEntity.some((r) => r.rejectedRows.length > 0) && (
            <RowsDisclosure
              label="Show rows that couldn't save — and why"
              accentColor="#1A1A2E"
              showDownload
              downloadFilename="eq-rejected-rows.csv"
              perEntity={result.perEntity.map((r) => ({
                entity: r.entity,
                rows: r.rejectedRows,
              }))}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** H3 — Prominent summary badge shown immediately after a successful save. */
function ImportSummaryBadge({ result }: { result: CommitResult }): JSX.Element {
  const totalSaved = result.perEntity.reduce((n, r) => n + r.committedCount, 0);
  const totalFlagged = result.perEntity.reduce((n, r) => n + r.flaggedCount, 0);
  const totalRejected = result.perEntity.reduce((n, r) => n + r.rejectedCount, 0);
  const hasFatal = result.perEntity.some((r) => r.fatalError);

  const bg   = hasFatal ? "#FBEAEA" : totalRejected > 0 ? "#FFF8EC" : "#EAF5FB";
  const border = hasFatal ? "#B33A3A" : totalRejected > 0 ? "#d97706" : "#2986B4";
  const icon = hasFatal ? "✗" : totalRejected > 0 ? "⚠" : "✓";
  const iconColor = hasFatal ? "#B33A3A" : totalRejected > 0 ? "#d97706" : "#2986B4";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        marginTop: 16,
        padding: "12px 16px",
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        gap: 16,
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      }}
    >
      <span style={{ fontSize: 20, color: iconColor, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: "#1A1A2E" }}>
          {totalSaved.toLocaleString()} record{totalSaved === 1 ? "" : "s"} saved
        </span>
        {totalFlagged > 0 && (
          <span style={{ marginLeft: 12, fontSize: 13, color: "#d97706" }}>
            {totalFlagged.toLocaleString()} need{totalFlagged === 1 ? "s" : ""} checking
          </span>
        )}
        {totalRejected > 0 && (
          <span style={{ marginLeft: 12, fontSize: 13, color: "#B33A3A" }}>
            {totalRejected.toLocaleString()} couldn't save
          </span>
        )}
      </div>
      {result.perEntity.filter((r) => r.committedCount > 0).map((r) => (
        <span
          key={r.entity}
          style={{
            padding: "2px 8px",
            borderRadius: 100,
            background: "#2986B4",
            color: "white",
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: "nowrap",
          }}
        >
          {r.committedCount} {entityLabel(r.entity).toLowerCase()}
        </span>
      ))}
    </div>
  );
}

function EntityResultRow({ r }: { r: EntityCommitResult }): JSX.Element {
  // Show first 8 chars of the UUID as a reference. Operators don't need the
  // whole thing — engineering can pull the full ID from the DB if needed.
  const shortRef = r.intakeId ? r.intakeId.slice(0, 8) : "—";
  return (
    <tr style={{ borderBottom: "1px solid #F4F4F8" }}>
      <td style={{ padding: 6 }}>
        <strong>{entityLabel(r.entity)}</strong>
      </td>
      <td style={{ padding: 6, textAlign: "right" }}>{r.committedCount}</td>
      <td style={{ padding: 6, textAlign: "right" }}>{r.flaggedCount}</td>
      <td style={{ padding: 6, textAlign: "right" }}>{r.rejectedCount}</td>
      <td
        style={{ padding: 6, fontFamily: "monospace", fontSize: 11 }}
        title={r.intakeId ?? ""}
      >
        {shortRef}
        {r.fatalError && (
          <div style={{ color: "#B33A3A", marginTop: 4, fontFamily: "inherit" }}>
            {r.fatalError}
          </div>
        )}
      </td>
    </tr>
  );
}
