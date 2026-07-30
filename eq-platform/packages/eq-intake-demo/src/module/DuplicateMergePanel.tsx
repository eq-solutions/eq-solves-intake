import { useState, useEffect, useCallback, type JSX } from "react";
import {
  readSiteAdvisory,
  adjudicateSiteAdvisory,
  adjudicateDuplicateWithAI,
  makeEdgeFnCaller,
  previewSiteMerge,
  executeSiteMerge,
} from "@eq/intake";
import type {
  SiteAdvisorySummary,
  SiteAdvisoryItem,
  SiteVerdict,
  AiSiteVerdict,
  SiteMergePreview,
} from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";

// ---------------------------------------------------------------------------
// The write-time resolver's adjudication console — extracted out of
// IntakeHealthHome so it lives in To Do (a decision) instead of Overview (a
// diagnostic). Self-contained: owns its own readSiteAdvisory load/refresh,
// independent of RemediationQueue's eq_queue_list load and of Overview's
// other health checks.
// ---------------------------------------------------------------------------

export interface DuplicateMergePanelProps {
  supabase?: SupabaseLikeClient | null;
  /** See IntakeModuleProps.canMergeSites — host-computed, manager-only by default. */
  canMergeSites?: boolean;
}

const VERDICT_LABEL: Record<SiteVerdict, string> = {
  same: "Same site",
  different: "Different",
  unsure: "Unsure",
};

function MergePanel({
  item, canMerge, preview, previewBusy, mergeBusy, mergeErr, merged,
  onPreview, onCancelPreview, onConfirm,
}: {
  item: SiteAdvisoryItem;
  canMerge: boolean;
  preview?: SiteMergePreview;
  previewBusy: boolean;
  mergeBusy: boolean;
  mergeErr?: string;
  merged?: { survivor_site_id: string; movedTotal: number };
  onPreview: () => void;
  onCancelPreview: () => void;
  onConfirm: () => void;
}): JSX.Element | null {
  // Merge only makes sense once a human/AI has said "same" — matches the
  // server-side gate (eq_site_merge_execute requires a recorded 'same' verdict).
  if (item.verdict !== "same") return null;

  if (!canMerge) {
    return <span className="eq-merge-panel__hint">Ask a manager to merge these</span>;
  }

  if (merged) {
    return (
      <span className="eq-merge-panel__done">
        ✓ Merged — {merged.movedTotal} row{merged.movedTotal === 1 ? "" : "s"} moved
      </span>
    );
  }

  if (preview) {
    return (
      <span className="eq-merge-panel__preview">
        <span className="eq-merge-panel__preview-text">
          {preview.total_rows} row{preview.total_rows === 1 ? "" : "s"} across{" "}
          {preview.tables.filter((t) => t.count > 0).length} table{preview.tables.filter((t) => t.count > 0).length === 1 ? "" : "s"}{" "}
          will move into {preview.survivor_name ?? "the survivor site"}. The other row is retired, not deleted.
        </span>
        <button
          type="button"
          disabled={mergeBusy}
          onClick={onConfirm}
          className="eq-merge-panel__confirm-btn"
        >
          {mergeBusy ? "Merging…" : "Confirm merge"}
        </button>
        <button
          type="button"
          disabled={mergeBusy}
          onClick={onCancelPreview}
          className="eq-merge-panel__cancel-btn"
        >
          Cancel
        </button>
        {mergeErr && <span className="eq-merge-panel__err" role="alert">{mergeErr}</span>}
      </span>
    );
  }

  return (
    <span className="eq-merge-panel__actions">
      <button
        type="button"
        disabled={previewBusy}
        onClick={onPreview}
        title="See exactly what will move before merging"
        className="eq-merge-panel__preview-btn"
      >
        {previewBusy ? "Checking…" : "Preview merge"}
      </button>
      {mergeErr && <span className="eq-merge-panel__err">{mergeErr}</span>}
    </span>
  );
}

function SiteAdvisoryPanel({
  summary, onAdjudicate, saving, errors, onAskAi, aiSuggest, aiBusy, aiErr,
  canMergeSites, mergePreviews, mergePreviewBusy, mergeBusy, mergeErrors, merged,
  onPreviewMerge, onCancelPreviewMerge, onConfirmMerge,
}: {
  summary: SiteAdvisorySummary;
  onAdjudicate: (advisoryId: string, verdict: SiteVerdict) => void;
  saving: Record<string, boolean>;
  errors: Record<string, boolean>;
  onAskAi: (item: SiteAdvisoryItem) => void;
  aiSuggest: Record<string, AiSiteVerdict>;
  aiBusy: Record<string, boolean>;
  aiErr: Record<string, boolean>;
  canMergeSites?: boolean;
  mergePreviews: Record<string, SiteMergePreview>;
  mergePreviewBusy: Record<string, boolean>;
  mergeBusy: Record<string, boolean>;
  mergeErrors: Record<string, string>;
  merged: Record<string, { survivor_site_id: string; movedTotal: number }>;
  onPreviewMerge: (item: SiteAdvisoryItem) => void;
  onCancelPreviewMerge: (advisoryId: string) => void;
  onConfirmMerge: (item: SiteAdvisoryItem) => void;
}): JSX.Element {
  // Hooks must run unconditionally — this state exists whether or not there's
  // anything to show, so the "Watching — nothing flagged yet" early return
  // below stays a valid early return rather than a Rules-of-Hooks violation.
  const [expanded, setExpanded] = useState(false);

  if (summary.total === 0) {
    return (
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--ok">Watching — nothing flagged yet</span>
      </div>
    );
  }

  const VISIBLE_CAP = 8;
  const visibleItems = expanded ? summary.items : summary.items.slice(0, VISIBLE_CAP);
  const hiddenCount = summary.items.length - VISIBLE_CAP;

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
      <ul className="eq-advisory-list">
        {visibleItems.map((it) => (
          <li key={it.id} className="eq-advisory-item">
            <span className="eq-advisory-item__name">{it.candidate_name ?? it.candidate_code ?? "New site"}</span>
            <span aria-hidden="true" className="eq-advisory-item__arrow">→</span>
            <span className="eq-advisory-item__matched">
              {it.matched_name ?? "existing site"}{it.matched_active === false ? " (retired)" : ""}
            </span>
            <span className={`eq-health-badge eq-health-badge--${it.outcome === "match" ? "warning" : "info"}`}>
              {it.outcome === "match" ? "likely same" : "unsure"}
            </span>
            {it.verdict ? (
              <>
                <span className="eq-advisory-item__verdict-note">
                  · you said: {VERDICT_LABEL[it.verdict]}
                </span>
                <MergePanel
                  item={it}
                  canMerge={!!canMergeSites}
                  preview={mergePreviews[it.id]}
                  previewBusy={!!mergePreviewBusy[it.id]}
                  mergeBusy={!!mergeBusy[it.id]}
                  mergeErr={mergeErrors[it.id]}
                  merged={merged[it.id]}
                  onPreview={() => onPreviewMerge(it)}
                  onCancelPreview={() => onCancelPreviewMerge(it.id)}
                  onConfirm={() => onConfirmMerge(it)}
                />
              </>
            ) : (
              <>
                <span className="eq-advisory-item__verdict-btns">
                  {(["same", "different", "unsure"] as SiteVerdict[]).map((v) => {
                    const suggested = aiSuggest[it.id]?.verdict === v;
                    return (
                      <button
                        key={v}
                        type="button"
                        disabled={!!saving[it.id]}
                        onClick={() => onAdjudicate(it.id, v)}
                        title={suggested ? `Claude suggests: ${VERDICT_LABEL[v]}` : `Record: ${VERDICT_LABEL[v]}`}
                        className={`eq-advisory-item__verdict-btn${suggested ? " eq-advisory-item__verdict-btn--suggested" : ""}`}
                      >
                        {VERDICT_LABEL[v]}
                      </button>
                    );
                  })}
                </span>
                {aiSuggest[it.id] ? (
                  <span className="eq-advisory-item__ai-reason">
                    <span className="eq-advisory-item__ai-label">✨ Claude:</span>{" "}
                    {aiSuggest[it.id].reasoning}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAskAi(it)}
                    disabled={!!aiBusy[it.id]}
                    title="Ask Claude for a suggested answer with a reason"
                    className="eq-advisory-item__ai-btn"
                  >
                    {aiBusy[it.id] ? "Asking Claude…" : "✨ Ask Claude"}
                  </button>
                )}
                {aiErr[it.id] && <span className="eq-advisory-item__err">AI unavailable</span>}
              </>
            )}
            {errors[it.id] && <span className="eq-advisory-item__err">couldn&rsquo;t save — try again</span>}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="eq-intake-btn-ghost"
          style={{ marginTop: 8 }}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Show fewer" : `Show all ${summary.items.length}`}
        </button>
      )}
    </div>
  );
}

export function DuplicateMergePanel({ supabase, canMergeSites }: DuplicateMergePanelProps): JSX.Element | null {
  const [advisory,   setAdvisory]   = useState<SiteAdvisorySummary | null>(null);
  const [adjSaving,  setAdjSaving]  = useState<Record<string, boolean>>({});
  const [adjErrors,  setAdjErrors]  = useState<Record<string, boolean>>({});
  const [aiSuggest,  setAiSuggest]  = useState<Record<string, AiSiteVerdict>>({});
  const [aiBusy,     setAiBusy]     = useState<Record<string, boolean>>({});
  const [aiErr,      setAiErr]      = useState<Record<string, boolean>>({});
  const [mergePreviews,     setMergePreviews]     = useState<Record<string, SiteMergePreview>>({});
  const [mergePreviewBusy,  setMergePreviewBusy]  = useState<Record<string, boolean>>({});
  const [mergeBusy,         setMergeBusy]         = useState<Record<string, boolean>>({});
  const [mergeErrors,       setMergeErrors]       = useState<Record<string, string>>({});
  const [merged,            setMerged]            = useState<Record<string, { survivor_site_id: string; movedTotal: number }>>({});
  const [loading,    setLoading]    = useState(false);
  // Independent of RemediationQueue's own eq_queue_list load and of
  // Overview's other health checks — this section refreshes on its own.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    setLoading(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;

    readSiteAdvisory(sb)
      .then((result) => { if (!cancelled) setAdvisory(result); })
      .catch((err) => {
        // Non-fatal — a tenant not yet on migration 0180 has no summary RPC.
        // eslint-disable-next-line no-console
        console.warn(
          "[DuplicateMergePanel] Site advisory read failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [supabase, refreshTick]);

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
          "[DuplicateMergePanel] adjudicate failed:",
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

  // Ask Claude for a suggested verdict + a plain-English reason on a flagged row.
  // Advisory only — it fills aiSuggest so the console can show the reason and
  // pre-highlight a button; the human still taps to record. Fails soft (aiErr).
  const handleAskAi = useCallback(
    async (item: SiteAdvisoryItem) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callEdgeFn = makeEdgeFnCaller(supabase as any);
      setAiErr((e) => {
        if (!e[item.id]) return e;
        const next = { ...e }; delete next[item.id]; return next;
      });
      setAiBusy((b) => ({ ...b, [item.id]: true }));
      try {
        const verdict = await adjudicateDuplicateWithAI(
          { name: item.candidate_name, code: item.candidate_code },
          { name: item.matched_name, active: item.matched_active },
          callEdgeFn,
        );
        setAiSuggest((s) => ({ ...s, [item.id]: verdict }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[DuplicateMergePanel] AI adjudication failed:", err instanceof Error ? err.message : err);
        setAiErr((e) => ({ ...e, [item.id]: true }));
      } finally {
        setAiBusy((b) => {
          const next = { ...b }; delete next[item.id]; return next;
        });
      }
    },
    [supabase],
  );

  // Preview: fetch exactly what would move before the human confirms. Pure
  // read (eq_site_merge_preview) — nothing changes until Confirm is tapped.
  const handlePreviewMerge = useCallback(
    async (item: SiteAdvisoryItem) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      setMergeErrors((e) => {
        if (!e[item.id]) return e;
        const next = { ...e }; delete next[item.id]; return next;
      });
      setMergePreviewBusy((b) => ({ ...b, [item.id]: true }));
      try {
        const preview = await previewSiteMerge(sb, item.id);
        setMergePreviews((p) => ({ ...p, [item.id]: preview }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[DuplicateMergePanel] merge preview failed:", err instanceof Error ? err.message : err);
        setMergeErrors((e) => ({ ...e, [item.id]: err instanceof Error ? err.message : "couldn't preview" }));
      } finally {
        setMergePreviewBusy((b) => {
          const next = { ...b }; delete next[item.id]; return next;
        });
      }
    },
    [supabase],
  );

  const handleCancelPreviewMerge = useCallback((advisoryId: string) => {
    setMergePreviews((p) => {
      if (!(advisoryId in p)) return p;
      const next = { ...p }; delete next[advisoryId]; return next;
    });
  }, []);

  // Execute: the write. Requires a preview to already be on screen (the human
  // saw what would move) — mirrors the server-side precondition that a 'same'
  // verdict must already be recorded.
  const handleConfirmMerge = useCallback(
    async (item: SiteAdvisoryItem) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      setMergeErrors((e) => {
        if (!e[item.id]) return e;
        const next = { ...e }; delete next[item.id]; return next;
      });
      setMergeBusy((b) => ({ ...b, [item.id]: true }));
      try {
        const result = await executeSiteMerge(sb, { advisoryId: item.id });
        const movedTotal = Object.values(result.moved).reduce((sum, n) => sum + n, 0);
        setMerged((m) => ({ ...m, [item.id]: { survivor_site_id: result.survivor_site_id, movedTotal } }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[DuplicateMergePanel] merge execute failed:", err instanceof Error ? err.message : err);
        setMergeErrors((e) => ({ ...e, [item.id]: err instanceof Error ? err.message : "merge failed" }));
      } finally {
        setMergeBusy((b) => {
          const next = { ...b }; delete next[item.id]; return next;
        });
      }
    },
    [supabase],
  );

  if (!supabase || advisory === null) return null;

  return (
    <div className="eq-queue__section">
      <div className="eq-queue__section-header">
        <h3>Possible duplicate sites</h3>
        <span className="eq-queue__section-count">{advisory.total}</span>
      </div>
      <p className="eq-queue__section-hint">
        Caught automatically as data was written. Say same or different, then merge if you have access —
        the other record is retired, not deleted.
      </p>
      <SiteAdvisoryPanel
        summary={advisory}
        onAdjudicate={handleAdjudicate}
        saving={adjSaving}
        errors={adjErrors}
        onAskAi={handleAskAi}
        aiSuggest={aiSuggest}
        aiBusy={aiBusy}
        aiErr={aiErr}
        canMergeSites={canMergeSites}
        mergePreviews={mergePreviews}
        mergePreviewBusy={mergePreviewBusy}
        mergeBusy={mergeBusy}
        mergeErrors={mergeErrors}
        merged={merged}
        onPreviewMerge={handlePreviewMerge}
        onCancelPreviewMerge={handleCancelPreviewMerge}
        onConfirmMerge={handleConfirmMerge}
      />
      <button
        type="button"
        className="eq-intake-btn-ghost"
        style={{ marginTop: 8 }}
        onClick={() => setRefreshTick((t) => t + 1)}
        disabled={loading}
      >
        {loading ? "Refreshing…" : "↻ Refresh"}
      </button>
    </div>
  );
}
