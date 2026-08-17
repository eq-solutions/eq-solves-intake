/**
 * DownloadResultView — the export-path "done" screen (state C3 of the
 * 2026-08-17 build spec). Replaces the near-duplicate ExportView /
 * TemplateExportView pair that each hand-rolled the same download +
 * success-message logic — this is that logic once, fed by a DownloadSpec
 * adapter (see quickExportSpec below; join-template exports have their own
 * home in RollupDropZone, not this screen — see DestinationPicker's header
 * comment). No preview table, per the build spec's component map ("drop
 * their preview table for v1 per the one-screen anatomy — no preview
 * state in spec §4") — same CSV bytes as before (encodeCsv, unchanged),
 * just without showing the first 5 rows before download.
 */

import { useState, type JSX } from "react";
import { encodeCsv, type QuickDestination } from "../quick-export/destinations.js";
import { roleLabel, type IntakeBundle } from "./intake-bundle.js";

export interface DownloadSpec {
  label: string;
  filename: string;
  /** Builds the CSV's headers + rows, or null when a required file hasn't been dropped yet. */
  resolve: () => { headers: string[]; rows: Record<string, unknown>[] } | null;
  missingMessage: string;
}

export function quickExportSpec(dest: QuickDestination, bundle: IntakeBundle): DownloadSpec {
  return {
    label: dest.label,
    filename: dest.filename,
    resolve: () => {
      const matched = bundle.slotForRole(dest.needsRole);
      if (!matched?.sheet) return null;
      const rows = matched.sheet.rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const col of dest.columns) out[col.name] = col.value(r as Record<string, unknown>);
        return out;
      });
      return { headers: dest.columns.map((c) => c.name), rows };
    },
    missingMessage: `This needs a ${roleLabel(dest.needsRole)} file. Drop one above first.`,
  };
}

export function DownloadResultView({
  spec,
  onReset,
}: {
  spec: DownloadSpec;
  /** "Start over" resets the whole bundle — the export path doesn't offer "add another" (see build spec's copy deck note). */
  onReset: () => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<{ filename: string; rowCount: number } | null>(null);

  const download = () => {
    setError(null);
    const built = spec.resolve();
    if (!built) {
      setError(spec.missingMessage);
      return;
    }
    const csv = encodeCsv(built.headers, built.rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = spec.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded({ filename: spec.filename, rowCount: built.rows.length });
  };

  if (downloaded) {
    return (
      <div className="eq-result">
        <div className="eq-result__head">
          <span className="eq-result__icon">✓</span>
          Your {spec.label} file is ready
        </div>
        <p className="eq-result__sub">
          {downloaded.rowCount.toLocaleString()} row{downloaded.rowCount === 1 ? "" : "s"}, shaped for{" "}
          {spec.label}. Downloaded as <b>{downloaded.filename}</b> — ready to import.
        </p>
        <div className="eq-result__actions">
          <button type="button" className="eq-intake-btn-primary" onClick={download}>
            Download again
          </button>
          <button type="button" className="eq-intake-btn-ghost" onClick={onReset}>
            Start over
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div role="alert" className="eq-intake-alert">
          {error}
        </div>
      )}
      <button type="button" onClick={download} className="eq-intake-btn-primary">
        Download for {spec.label}
      </button>
    </div>
  );
}
