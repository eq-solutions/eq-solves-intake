import { useState, useEffect, useCallback, type JSX } from "react";
import {
  readContactAdvisory,
  adjudicateContactAdvisory,
  adjudicateContactDuplicateWithAI,
  makeEdgeFnCaller,
  previewContactMerge,
  executeContactMerge,
} from "@eq/intake";
import type {
  ContactAdvisorySummary,
  ContactAdvisoryItem,
  ContactVerdict,
  AiContactVerdict,
  ContactMergePreview,
} from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";

// ---------------------------------------------------------------------------
// The write-time contact resolver's adjudication console (eq-shell 0233/0234)
// — same pattern as DuplicateMergePanel (Sites), extracted the same way so it
// lives in To Do. Self-contained: owns its own readContactAdvisory load/
// refresh, independent of RemediationQueue's eq_queue_list load (the queue's
// own "duplicate" category for contacts is the OLDER, pre-resolver batch-
// detected path — Archive-only, no structured match. This panel is the NEW
// write-time-caught path with a real merge, going forward. Both stay live;
// they cover different rows.)
// ---------------------------------------------------------------------------

export interface ContactDuplicateMergePanelProps {
  supabase?: SupabaseLikeClient | null;
  /** Host-computed, manager-only by default — same posture as canMergeSites. */
  canMergeContacts?: boolean;
  /** Called after a merge actually moves canonical data — see RemediationQueueProps.onDataChanged. */
  onDataChanged?: () => void;
}

const VERDICT_LABEL: Record<ContactVerdict, string> = {
  same: "Same person",
  different: "Different",
  unsure: "Unsure",
};

function MergePanel({
  item, canMerge, preview, previewBusy, mergeBusy, mergeErr, merged,
  onPreview, onCancelPreview, onConfirm,
}: {
  item: ContactAdvisoryItem;
  canMerge: boolean;
  preview?: ContactMergePreview;
  previewBusy: boolean;
  mergeBusy: boolean;
  mergeErr?: string;
  merged?: { survivor_contact_id: string; movedTotal: number; alreadyMerged?: boolean };
  onPreview: () => void;
  onCancelPreview: () => void;
  onConfirm: () => void;
}): JSX.Element | null {
  // Merge only makes sense once a human/AI has said "same" — matches the
  // server-side gate (eq_contact_merge_execute requires a recorded 'same' verdict).
  if (item.verdict !== "same") return null;

  if (merged) {
    return (
      <span className="eq-merge-panel__done">
        {merged.alreadyMerged
          ? "✓ Already merged elsewhere — nothing left to move"
          : `✓ Merged — ${merged.movedTotal} row${merged.movedTotal === 1 ? "" : "s"} moved`}
      </span>
    );
  }

  // Preview (eq_contact_merge_preview) carries no role gate server-side —
  // only eq_contact_merge_execute does (manager-only, eq-shell 0234). Same
  // posture as Sites.
  if (preview) {
    return (
      <span className="eq-merge-panel__preview">
        <span className="eq-merge-panel__preview-text">
          {preview.total_rows} row{preview.total_rows === 1 ? "" : "s"} across{" "}
          {preview.tables.filter((t) => t.count > 0).length} table{preview.tables.filter((t) => t.count > 0).length === 1 ? "" : "s"}{" "}
          will move into {preview.survivor_name ?? "the survivor contact"}. The other record is retired, not deleted.
        </span>
        {canMerge ? (
          <button
            type="button"
            disabled={mergeBusy}
            onClick={onConfirm}
            className="eq-merge-panel__confirm-btn"
          >
            {mergeBusy ? "Merging…" : "Confirm merge"}
          </button>
        ) : (
          <span className="eq-merge-panel__hint">Ask a manager to confirm this merge</span>
        )}
        <button
          type="button"
          disabled={mergeBusy}
          onClick={onCancelPreview}
          className="eq-merge-panel__cancel-btn"
        >
          {canMerge ? "Cancel" : "Close"}
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

function ContactAdvisoryPanel({
  summary, onAdjudicate, saving, errors, onAskAi, aiSuggest, aiBusy, aiErr,
  canMergeContacts, mergePreviews, mergePreviewBusy, mergeBusy, mergeErrors, merged,
  onPreviewMerge, onCancelPreviewMerge, onConfirmMerge,
}: {
  summary: ContactAdvisorySummary;
  onAdjudicate: (advisoryId: string, verdict: ContactVerdict, note?: string) => void;
  saving: Record<string, boolean>;
  errors: Record<string, boolean>;
  onAskAi: (item: ContactAdvisoryItem) => void;
  aiSuggest: Record<string, AiContactVerdict>;
  aiBusy: Record<string, boolean>;
  aiErr: Record<string, boolean>;
  canMergeContacts?: boolean;
  mergePreviews: Record<string, ContactMergePreview>;
  mergePreviewBusy: Record<string, boolean>;
  mergeBusy: Record<string, boolean>;
  mergeErrors: Record<string, string>;
  merged: Record<string, { survivor_contact_id: string; movedTotal: number; alreadyMerged?: boolean }>;
  onPreviewMerge: (item: ContactAdvisoryItem) => void;
  onCancelPreviewMerge: (advisoryId: string) => void;
  onConfirmMerge: (item: ContactAdvisoryItem) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [notingId, setNotingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // A decided row that's re-opened via "Change answer" — re-shows the verdict
  // buttons for that one row instead of the locked-in "you said" text. The
  // adjudicate RPC records the latest verdict, so re-firing it just overwrites.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Resolved rows (a final verdict with nothing left to do) collapse out of
  // the main queue by default so the list actually shrinks as you work
  // through it — expand to review or change one.
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [resolvedExpanded, setResolvedExpanded] = useState(false);

  if (summary.total === 0) {
    return (
      <div className="eq-health-licence-strip">
        <span className="eq-health-badge eq-health-badge--ok">Watching — nothing flagged yet</span>
      </div>
    );
  }

  // A "same" verdict still needs a merge — keep it in the working queue.
  // "different"/"unsure" (or a "same" that's already merged) have nothing
  // left to do, so they're resolved and free to leave the main list.
  const isResolved = (it: ContactAdvisoryItem) =>
    it.verdict != null && (it.verdict !== "same" || !!merged[it.id]);

  const actionableItems = summary.items.filter((it) => !isResolved(it));
  const resolvedItems = summary.items.filter(isResolved);

  const VISIBLE_CAP = 8;
  const visibleActionable = expanded ? actionableItems : actionableItems.slice(0, VISIBLE_CAP);
  const hiddenCount = actionableItems.length - VISIBLE_CAP;

  const renderRow = (it: ContactAdvisoryItem) => {
    const canChangeAnswer = it.verdict != null && !merged[it.id];
    const showButtons = it.verdict == null || editingId === it.id;
    return (
      <li key={it.id} className="eq-advisory-item">
        <div className="eq-advisory-item__row">
          <span className="eq-advisory-item__name">{it.candidate_name || it.candidate_email || "New contact"}</span>
          <span aria-hidden="true" className="eq-advisory-item__arrow">→</span>
          <span className="eq-advisory-item__matched">
            {it.matched_name || "existing contact"}{it.matched_active === false ? " (retired)" : ""}
          </span>
          <span className={`eq-health-badge eq-health-badge--${it.outcome === "match" ? "warning" : "info"}`}>
            {it.outcome === "match" ? "likely same" : "unsure"}
          </span>
          {it.verdict && editingId !== it.id && (
            <span className="eq-advisory-item__verdict-note">
              · you said: {VERDICT_LABEL[it.verdict]}
              {it.verdict_note ? <> — &ldquo;{it.verdict_note}&rdquo;</> : null}
              {canChangeAnswer && (
                <button
                  type="button"
                  className="eq-advisory-item__change-btn"
                  onClick={() => setEditingId(it.id)}
                >
                  Change answer
                </button>
              )}
            </span>
          )}
        </div>
        <div className="eq-advisory-item__controls">
          {!showButtons && (
            <MergePanel
              item={it}
              canMerge={!!canMergeContacts}
              preview={mergePreviews[it.id]}
              previewBusy={!!mergePreviewBusy[it.id]}
              mergeBusy={!!mergeBusy[it.id]}
              mergeErr={mergeErrors[it.id]}
              merged={merged[it.id]}
              onPreview={() => onPreviewMerge(it)}
              onCancelPreview={() => onCancelPreviewMerge(it.id)}
              onConfirm={() => onConfirmMerge(it)}
            />
          )}
          {showButtons && (
            <>
              <span className="eq-advisory-item__verdict-btns">
                {(["same", "different", "unsure"] as ContactVerdict[]).map((v) => {
                  const suggested = aiSuggest[it.id]?.verdict === v;
                  const current = it.verdict === v;
                  return (
                    <button
                      key={v}
                      type="button"
                      disabled={!!saving[it.id]}
                      onClick={() => {
                        if (v === "unsure") { setNotingId(it.id); setNoteDraft(it.verdict_note ?? ""); }
                        else { onAdjudicate(it.id, v); setEditingId(null); }
                      }}
                      title={
                        current ? "This is your current answer"
                        : suggested ? `Claude suggests: ${VERDICT_LABEL[v]}`
                        : `Record: ${VERDICT_LABEL[v]}`
                      }
                      className={`eq-advisory-item__verdict-btn${suggested ? " eq-advisory-item__verdict-btn--suggested" : ""}${current ? " eq-advisory-item__verdict-btn--current" : ""}`}
                    >
                      {VERDICT_LABEL[v]}
                    </button>
                  );
                })}
                {editingId === it.id && (
                  <button
                    type="button"
                    className="eq-intake-btn-ghost eq-queue__btn"
                    onClick={() => { setEditingId(null); setNotingId(null); setNoteDraft(""); }}
                  >
                    Cancel
                  </button>
                )}
              </span>
              {notingId === it.id && (
                <span className="eq-advisory-item__note-row">
                  <input
                    type="text"
                    className="eq-queue__input"
                    placeholder="What's unclear? (optional — helps whoever looks next)"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    disabled={!!saving[it.id]}
                    aria-label={`Note for ${it.candidate_name || "this row"}`}
                  />
                  <button
                    type="button"
                    className="eq-intake-btn-primary eq-queue__btn"
                    disabled={!!saving[it.id]}
                    onClick={() => {
                      onAdjudicate(it.id, "unsure", noteDraft.trim() || undefined);
                      setNotingId(null);
                      setNoteDraft("");
                      setEditingId(null);
                    }}
                  >
                    {saving[it.id] ? "Saving…" : "Record: Unsure"}
                  </button>
                  <button
                    type="button"
                    className="eq-intake-btn-ghost eq-queue__btn"
                    disabled={!!saving[it.id]}
                    onClick={() => { setNotingId(null); setNoteDraft(""); }}
                  >
                    Cancel
                  </button>
                </span>
              )}
              {it.verdict == null && (
                aiSuggest[it.id] ? (
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
                )
              )}
              {aiErr[it.id] && <span className="eq-advisory-item__err">AI unavailable</span>}
            </>
          )}
          {errors[it.id] && <span className="eq-advisory-item__err">couldn&rsquo;t save — try again</span>}
        </div>
      </li>
    );
  };

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
      {actionableItems.length > 0 ? (
        <>
          <ul className="eq-advisory-list">
            {visibleActionable.map(renderRow)}
          </ul>
          {hiddenCount > 0 && (
            <button
              type="button"
              className="eq-intake-btn-ghost"
              style={{ marginTop: 8 }}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? "Show fewer" : `Show all ${actionableItems.length}`}
            </button>
          )}
        </>
      ) : (
        <p className="eq-queue__section-hint">Nothing needs your input right now.</p>
      )}
      {resolvedItems.length > 0 && (
        <div className="eq-advisory-resolved">
          <button
            type="button"
            className="eq-intake-btn-ghost"
            onClick={() => setResolvedOpen((o) => !o)}
          >
            {resolvedOpen ? "Hide" : "Show"} {resolvedItems.length} resolved
          </button>
          {resolvedOpen && (
            <>
              <ul className="eq-advisory-list" style={{ marginTop: 8 }}>
                {(resolvedExpanded ? resolvedItems : resolvedItems.slice(0, VISIBLE_CAP)).map(renderRow)}
              </ul>
              {resolvedItems.length > VISIBLE_CAP && (
                <button
                  type="button"
                  className="eq-intake-btn-ghost"
                  style={{ marginTop: 8 }}
                  onClick={() => setResolvedExpanded((e) => !e)}
                >
                  {resolvedExpanded ? "Show fewer" : `Show all ${resolvedItems.length}`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ContactDuplicateMergePanel({ supabase, canMergeContacts, onDataChanged }: ContactDuplicateMergePanelProps): JSX.Element | null {
  const [advisory,   setAdvisory]   = useState<ContactAdvisorySummary | null>(null);
  const [adjSaving,  setAdjSaving]  = useState<Record<string, boolean>>({});
  const [adjErrors,  setAdjErrors]  = useState<Record<string, boolean>>({});
  const [aiSuggest,  setAiSuggest]  = useState<Record<string, AiContactVerdict>>({});
  const [aiBusy,     setAiBusy]     = useState<Record<string, boolean>>({});
  const [aiErr,      setAiErr]      = useState<Record<string, boolean>>({});
  const [mergePreviews,     setMergePreviews]     = useState<Record<string, ContactMergePreview>>({});
  const [mergePreviewBusy,  setMergePreviewBusy]  = useState<Record<string, boolean>>({});
  const [mergeBusy,         setMergeBusy]         = useState<Record<string, boolean>>({});
  const [mergeErrors,       setMergeErrors]       = useState<Record<string, string>>({});
  const [merged,            setMerged]            = useState<Record<string, { survivor_contact_id: string; movedTotal: number; alreadyMerged?: boolean }>>({});
  const [loading,    setLoading]    = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    setLoading(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;

    readContactAdvisory(sb)
      .then((result) => { if (!cancelled) setAdvisory(result); })
      .catch((err) => {
        // Non-fatal — a tenant not yet on migration 0233 has no summary RPC.
        // eslint-disable-next-line no-console
        console.warn(
          "[ContactDuplicateMergePanel] Contact advisory read failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [supabase, refreshTick]);

  const handleAdjudicate = useCallback(
    async (advisoryId: string, verdict: ContactVerdict, note?: string) => {
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
        await adjudicateContactAdvisory(sb, { advisoryId, verdict, note });
        setAdvisory((prev) => {
          if (!prev) return prev;
          let wasPending = false;
          const items = prev.items.map((it) => {
            if (it.id !== advisoryId) return it;
            wasPending = it.verdict == null;
            // Don't carry the old note forward onto a changed verdict — an
            // "unsure" note re-attached to a subsequent "same"/"different"
            // reads as if it justified the new answer. Mirrors what the RPC
            // itself does server-side (p_note ?? null clears it).
            return { ...it, verdict, verdict_note: note ?? null, decided_at: new Date().toISOString() };
          });
          return {
            ...prev,
            items,
            decided: wasPending ? prev.decided + 1 : prev.decided,
            pending: wasPending ? Math.max(0, prev.pending - 1) : prev.pending,
          };
        });
        // A changed verdict invalidates any merge preview/error fetched
        // under the previous one — clear so "Change answer" back to "same"
        // starts clean instead of showing a stale "N rows will move".
        setMergePreviews((p) => {
          if (!(advisoryId in p)) return p;
          const next = { ...p }; delete next[advisoryId]; return next;
        });
        setMergeErrors((e) => {
          if (!e[advisoryId]) return e;
          const next = { ...e }; delete next[advisoryId]; return next;
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[ContactDuplicateMergePanel] adjudicate failed:",
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

  const handleAskAi = useCallback(
    async (item: ContactAdvisoryItem) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callEdgeFn = makeEdgeFnCaller(supabase as any);
      setAiErr((e) => {
        if (!e[item.id]) return e;
        const next = { ...e }; delete next[item.id]; return next;
      });
      setAiBusy((b) => ({ ...b, [item.id]: true }));
      try {
        const verdict = await adjudicateContactDuplicateWithAI(
          { first_name: item.candidate_name?.split(" ")[0] ?? null, email: item.candidate_email },
          { first_name: item.matched_name?.split(" ")[0] ?? null, active: item.matched_active },
          callEdgeFn,
        );
        setAiSuggest((s) => ({ ...s, [item.id]: verdict }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[ContactDuplicateMergePanel] AI adjudication failed:", err instanceof Error ? err.message : err);
        setAiErr((e) => ({ ...e, [item.id]: true }));
      } finally {
        setAiBusy((b) => {
          const next = { ...b }; delete next[item.id]; return next;
        });
      }
    },
    [supabase],
  );

  const handlePreviewMerge = useCallback(
    async (item: ContactAdvisoryItem) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      setMergeErrors((e) => {
        if (!e[item.id]) return e;
        const next = { ...e }; delete next[item.id]; return next;
      });
      setMergePreviewBusy((b) => ({ ...b, [item.id]: true }));
      try {
        const preview = await previewContactMerge(sb, item.id);
        if (preview.already_merged) {
          // Someone else (or an earlier click) already executed this merge —
          // the server still answers the preview, just with nothing left to
          // move. Land straight on the "done" state instead of showing a
          // Confirm button that would only 500 on a re-execute.
          setMerged((m) => ({ ...m, [item.id]: { survivor_contact_id: preview.survivor_contact_id, movedTotal: 0, alreadyMerged: true } }));
        } else {
          setMergePreviews((p) => ({ ...p, [item.id]: preview }));
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[ContactDuplicateMergePanel] merge preview failed:", err instanceof Error ? err.message : err);
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

  const handleConfirmMerge = useCallback(
    async (item: ContactAdvisoryItem) => {
      if (!supabase) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      setMergeErrors((e) => {
        if (!e[item.id]) return e;
        const next = { ...e }; delete next[item.id]; return next;
      });
      setMergeBusy((b) => ({ ...b, [item.id]: true }));
      try {
        const result = await executeContactMerge(sb, { advisoryId: item.id });
        const movedTotal = Object.values(result.moved).reduce((sum, n) => sum + n, 0);
        setMerged((m) => ({ ...m, [item.id]: { survivor_contact_id: result.survivor_contact_id, movedTotal } }));
        onDataChanged?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[ContactDuplicateMergePanel] merge execute failed:", err instanceof Error ? err.message : err);
        setMergeErrors((e) => ({ ...e, [item.id]: err instanceof Error ? err.message : "merge failed" }));
      } finally {
        setMergeBusy((b) => {
          const next = { ...b }; delete next[item.id]; return next;
        });
      }
    },
    [supabase, onDataChanged],
  );

  if (!supabase || advisory === null) return null;

  return (
    <div className="eq-queue__section">
      <div className="eq-queue__section-header">
        <h3>Possible duplicate contacts</h3>
        <span className="eq-queue__section-count">{advisory.total}</span>
      </div>
      <p className="eq-queue__section-hint">
        Caught automatically as data was written. Say same or different, then merge if you have access —
        the other record is retired, not deleted.
      </p>
      <ContactAdvisoryPanel
        summary={advisory}
        onAdjudicate={handleAdjudicate}
        saving={adjSaving}
        errors={adjErrors}
        onAskAi={handleAskAi}
        aiSuggest={aiSuggest}
        aiBusy={aiBusy}
        aiErr={aiErr}
        canMergeContacts={canMergeContacts}
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
