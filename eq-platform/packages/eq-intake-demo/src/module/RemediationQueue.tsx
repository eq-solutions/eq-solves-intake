/**
 * RemediationQueue — the door on the steward's review queue.
 *
 * Lists pending app_data.eq_remediation_queue rows (via eq_queue_list RPC),
 * grouped by category. Per item:
 *   - Approve with a value -> intake event opened, fix committed via
 *     eq_tidy_commit_fixes (whitelisted, intake-stamped), event closed,
 *     queue row marked 'committed'. Full lineage, same as any import.
 *   - Dismiss -> queue row marked 'dismissed'.
 *
 * Category behaviours:
 *   trade              select from the canonical vocabulary
 *   email / format     text input, prefilled with the steward's suggestion
 *   link               select from the tenant's customers
 *   emergency_contact  dismiss only — collected from the worker, not typed here
 *   duplicate          a different signal from the write-time resolvers' merge
 *                       tools (DuplicateMergePanel for sites, ContactDuplicate
 *                       MergePanel for contacts — both rendered above these
 *                       groups) — these rows never auto-merge. Staff/contacts
 *                       rows get an Archive action (eq_archive_duplicate_record);
 *                       rows needing a field fixed elsewhere first (e.g. a
 *                       mangled linked record) still fall back to
 *                       dismiss-after-manual-fix. Contacts rows also get an
 *                       "Ask Claude" sanity-check before archiving (Staff
 *                       intentionally not wired yet — a real staff merge
 *                       touches Field-owned tables, that's a separate scoped
 *                       build, see eq-context pending.md). Unlike Sites/the
 *                       new Contacts resolver (eq-shell 0233), there's no
 *                       structured matched-record here — eq_remediation_queue's
 *                       duplicate rows carry only the flagged record's own
 *                       fields + a free-text `reason` naming the suspected
 *                       match, so the AI call sanity-checks the detector's own
 *                       reasoning rather than comparing two records. This
 *                       queue category covers the OLDER, pre-resolver
 *                       batch-detected contacts duplicates; new ones are
 *                       caught at the write by ContactDuplicateMergePanel.
 */

import { useState, useEffect, useCallback, useMemo, type JSX } from "react";
import {
  archiveDuplicateRecord,
  isArchivableDuplicate,
  getFieldSuggestedValues,
  adjudicateQueueDuplicateWithAI,
  makeEdgeFnCaller,
} from "@eq/intake";
import type { AiQueueDuplicateVerdict } from "@eq/intake";
import type { SupabaseLikeClient } from "../canonical/commit-canonical.js";
import { DuplicateMergePanel } from "./DuplicateMergePanel.js";
import { ContactDuplicateMergePanel } from "./ContactDuplicateMergePanel.js";

// Entities the "Ask Claude" sanity-check is wired for. Staff intentionally
// excluded — see the module doc comment above.
const AI_DUPLICATE_ENTITIES = new Set(["contacts"]);

export interface RemediationQueueProps {
  supabase?: SupabaseLikeClient | null;
  /** See IntakeModuleProps.canMergeSites — host-computed, manager-only by default. */
  canMergeSites?: boolean;
  /**
   * Tenant-added trades (from app_data.tenant_trades, via the Trades
   * settings screen) — merged on top of the EQ default vocabulary for the
   * trade dropdown below. Omit or pass an empty array to use defaults only.
   */
  tenantTrades?: string[];
}

interface QueueItem {
  queue_id: string;
  entity: string;          // 'staff' | 'contacts' | ...
  record_id: string;
  record_label: string;
  field: string;
  category: string;        // 'trade' | 'emergency_contact' | 'email' | 'format' | 'link' | 'duplicate'
  current_value: string | null;
  suggested_value: string | null;
  confidence: string;
  reason: string;
  evidence: string | null;
}

interface CustomerOption {
  customer_id: string;
  company_name: string;
}

type Rpc = (name: string, params?: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;

// EQ's default trade vocabulary — staff.schema.json's x-eq-suggested-values
// for the trade field, read directly rather than re-hardcoded here so it
// can't drift from the schema. Tenant additions (tenantTrades prop) merge
// on top in the component below.
const DEFAULT_TRADE_VOCAB = getFieldSuggestedValues("staff", "trade") ?? [];

const CATEGORY_ORDER = ["trade", "email", "link", "format", "duplicate", "emergency_contact"];

const CATEGORY_LABEL: Record<string, string> = {
  trade:             "Trade unknown",
  email:             "Missing email",
  link:              "Unlinked contacts",
  format:            "Format flags",
  duplicate:         "Other duplicate flags",
  emergency_contact: "Missing emergency contact",
};

const CATEGORY_HINT: Record<string, string> = {
  trade:             "Pick the trade and approve — saves straight onto the staff record.",
  email:             "Check the suggested mailbox actually exists before approving.",
  link:              "Pick the right customer — this drives invoicing and reporting.",
  format:            "Confirm the corrected value, or dismiss if the original is right.",
  duplicate:         "A separate signal from the merge tool above — not site pairs, and never auto-merged. Archive the flagged record directly, or read the reason first if it says to fix something elsewhere before archiving.",
  emergency_contact: "These come from the workers themselves — an EQ Cards prompt is the plan. Dismiss any that no longer apply.",
};

const COMMITTABLE = new Set(["trade", "email", "link", "format"]);

function entityToEventLabel(entity: string): string {
  return entity === "contacts" ? "contact" : entity === "staff" ? "staff" : entity.replace(/s$/, "");
}

export function RemediationQueue({ supabase, canMergeSites, tenantTrades }: RemediationQueueProps): JSX.Element {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null);
  const [contactRecords, setContactRecords] = useState<Record<string, Record<string, unknown>> | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState(0);
  const [aiSuggest, setAiSuggest] = useState<Record<string, AiQueueDuplicateVerdict>>({});
  const [aiBusy,    setAiBusy]    = useState<Record<string, boolean>>({});
  const [aiErr,     setAiErr]     = useState<Record<string, boolean>>({});

  const tradeOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const t of [...DEFAULT_TRADE_VOCAB, ...(tenantTrades ?? [])]) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(t);
    }
    return list;
  }, [tenantTrades]);

  const rpc: Rpc | null = supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (name, params) => (supabase as any).rpc(name, params ?? {})
    : null;

  const load = useCallback(async () => {
    if (!rpc) return;
    setError(null);
    const { data, error: err } = await rpc("eq_queue_list");
    if (err) { setError(err.message); return; }
    const rows = (data as QueueItem[] | null) ?? [];
    setItems(rows);
    // Prefill editable values from the steward's suggestions
    const prefill: Record<string, string> = {};
    for (const r of rows) {
      if (r.suggested_value && COMMITTABLE.has(r.category) && r.category !== "link") {
        prefill[r.queue_id] = r.suggested_value;
      }
    }
    setValues(prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  // Customers list, fetched lazily the first time a link item exists
  useEffect(() => {
    if (!rpc || customers !== null) return;
    if (!items?.some((i) => i.category === "link")) return;
    void rpc("eq_tidy_read_entity", { p_table: "customers" }).then(({ data }) => {
      const rows = ((data as Record<string, unknown>[] | null) ?? [])
        .filter((r) => r["active"] !== false)
        .map((r) => ({ customer_id: String(r["customer_id"]), company_name: String(r["company_name"] ?? "") }))
        .sort((a, b) => a.company_name.localeCompare(b.company_name));
      setCustomers(rows);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, customers, supabase]);

  // Contact records, fetched lazily the first time an AI-eligible duplicate
  // flag exists — the "Ask Claude" sanity-check needs the flagged record's
  // own fields (eq_remediation_queue carries no structured record snapshot).
  useEffect(() => {
    if (!rpc || contactRecords !== null) return;
    if (!items?.some((i) => i.category === "duplicate" && i.entity === "contacts")) return;
    void rpc("eq_tidy_read_entity", { p_table: "contacts" }).then(({ data }) => {
      const rows = (data as Record<string, unknown>[] | null) ?? [];
      const byId: Record<string, Record<string, unknown>> = {};
      for (const r of rows) byId[String(r["contact_id"])] = r;
      setContactRecords(byId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, contactRecords, supabase]);

  const removeItem = (queueId: string) => {
    setItems((prev) => (prev ?? []).filter((i) => i.queue_id !== queueId));
    setDoneCount((n) => n + 1);
  };

  const approve = async (item: QueueItem) => {
    if (!rpc || busyId) return;
    const value = values[item.queue_id]?.trim();
    if (!value) return;
    setBusyId(item.queue_id);
    setError(null);
    try {
      const opened = await rpc("eq_queue_open_event", { p_entity: entityToEventLabel(item.entity) });
      if (opened.error) throw new Error(opened.error.message);
      const intakeId = String(opened.data);

      const committed = await rpc("eq_tidy_commit_fixes", {
        p_intake_id: intakeId,
        p_fixes: [{ table: item.entity, row_id: item.record_id, field: item.field, new_value: value }],
      });
      if (committed.error) throw new Error(committed.error.message);
      const result = committed.data as { applied?: number; skipped?: number } | null;
      if (!result || (result.applied ?? 0) < 1) {
        throw new Error(`Fix was not applied (skipped: ${result?.skipped ?? "?"}) — field may not be whitelisted or the record has changed.`);
      }

      await rpc("eq_queue_close_event", { p_intake_id: intakeId, p_committed: 1 });
      const resolved = await rpc("eq_queue_resolve", {
        p_queue_id: item.queue_id, p_status: "committed", p_note: `set to "${value}" (intake ${intakeId.slice(0, 8)})`,
      });
      if (resolved.error) throw new Error(resolved.error.message);
      removeItem(item.queue_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (item: QueueItem) => {
    if (!rpc || busyId) return;
    setBusyId(item.queue_id);
    setError(null);
    try {
      const resolved = await rpc("eq_queue_resolve", {
        p_queue_id: item.queue_id, p_status: "dismissed", p_note: null,
      });
      if (resolved.error) throw new Error(resolved.error.message);
      removeItem(item.queue_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Duplicate flags: archive the flagged record directly (active=false, and
  // for staff also on_roster=false — same fields eq-shell's own archive
  // action sets) instead of sending the user to the Staff/Contacts page and
  // back. Same open-event/commit/close-event/resolve lineage as approve().
  const archiveDuplicate = async (item: QueueItem) => {
    if (!rpc || busyId) return;
    setBusyId(item.queue_id);
    setError(null);
    try {
      const opened = await rpc("eq_queue_open_event", { p_entity: entityToEventLabel(item.entity) });
      if (opened.error) throw new Error(opened.error.message);
      const intakeId = String(opened.data);

      const sb = supabase as unknown as Parameters<typeof archiveDuplicateRecord>[0];
      const result = await archiveDuplicateRecord(sb, { table: item.entity, rowId: item.record_id });
      if (result.applied < 1) {
        throw new Error("Archive did not apply — the record may have already changed.");
      }

      await rpc("eq_queue_close_event", { p_intake_id: intakeId, p_committed: 1 });
      const resolved = await rpc("eq_queue_resolve", {
        p_queue_id: item.queue_id, p_status: "committed", p_note: `archived duplicate record (intake ${intakeId.slice(0, 8)})`,
      });
      if (resolved.error) throw new Error(resolved.error.message);
      removeItem(item.queue_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Ask Claude to sanity-check the detector's own reasoning before the human
  // taps Archive. Advisory only — fills aiSuggest so the reason can render
  // next to the Archive button; the human still has to tap it. Fails soft.
  const handleAskAi = useCallback(
    async (item: QueueItem) => {
      if (!supabase) return;
      const record = contactRecords?.[item.record_id];
      if (!record) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callEdgeFn = makeEdgeFnCaller(supabase as any);
      setAiErr((e) => {
        if (!e[item.queue_id]) return e;
        const next = { ...e }; delete next[item.queue_id]; return next;
      });
      setAiBusy((b) => ({ ...b, [item.queue_id]: true }));
      try {
        const verdict = await adjudicateQueueDuplicateWithAI(
          record,
          { reason: item.reason, currentValue: item.current_value },
          callEdgeFn,
        );
        setAiSuggest((s) => ({ ...s, [item.queue_id]: verdict }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[RemediationQueue] AI duplicate sanity-check failed:", err instanceof Error ? err.message : err);
        setAiErr((e) => ({ ...e, [item.queue_id]: true }));
      } finally {
        setAiBusy((b) => {
          const next = { ...b }; delete next[item.queue_id]; return next;
        });
      }
    },
    [supabase, contactRecords],
  );

  if (!supabase) {
    return <section className="eq-queue"><div className="eq-health-notice">Connect EQ to see the review queue</div></section>;
  }
  if (items === null && !error) {
    return <section className="eq-queue"><div className="eq-health-loading">Loading the review queue…</div></section>;
  }

  const grouped = CATEGORY_ORDER
    .map((cat) => ({ cat, rows: (items ?? []).filter((i) => i.category === cat) }))
    .filter((g) => g.rows.length > 0);

  return (
    <section className="eq-queue">
      <div className="eq-queue__header">
        <h2>Review queue</h2>
        <p className="eq-queue__subtitle">
          Everything the data steward could not defensibly fix on its own — each item has its reason and evidence.
          Approvals save straight to the record with a full audit trail.
        </p>
        <div className="eq-queue__counts">
          <span className="eq-health-badge eq-health-badge--warning">{(items ?? []).length} pending</span>
          {doneCount > 0 && (
            <span className="eq-health-badge eq-health-badge--ok">{doneCount} resolved this visit</span>
          )}
        </div>
      </div>

      {error && <div role="alert" className="eq-intake-alert">{error}</div>}

      <DuplicateMergePanel supabase={supabase} canMergeSites={canMergeSites} />
      <ContactDuplicateMergePanel supabase={supabase} canMergeContacts={canMergeSites} />

      {(items ?? []).length === 0 && !error && (
        <div className="eq-queue__empty">Queue is clear. Nothing needs your eyes.</div>
      )}

      {grouped.map(({ cat, rows }) => (
        <div key={cat} className="eq-queue__section">
          <div className="eq-queue__section-header">
            <h3>{CATEGORY_LABEL[cat] ?? cat}</h3>
            <span className="eq-queue__section-count">{rows.length}</span>
          </div>
          <p className="eq-queue__section-hint">{CATEGORY_HINT[cat]}</p>

          {rows.map((item) => {
            const busy = busyId === item.queue_id;
            const committable = COMMITTABLE.has(item.category);
            return (
              <div key={item.queue_id} className="eq-queue__item">
                <div className="eq-queue__item-main">
                  <span className="eq-queue__item-label">{item.record_label}</span>
                  <span className="eq-queue__item-field">{item.field}</span>
                  {item.current_value && (
                    <span className="eq-queue__item-current" title="Current value">{item.current_value}</span>
                  )}
                  <p className="eq-queue__item-reason">{item.reason}</p>
                  {item.evidence && <p className="eq-queue__item-evidence">{item.evidence}</p>}
                </div>
                <div className="eq-queue__item-actions">
                  {committable && item.category === "trade" && (
                    <select
                      className="eq-queue__input"
                      value={values[item.queue_id] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [item.queue_id]: e.target.value }))}
                      disabled={busy}
                      aria-label={`Trade for ${item.record_label}`}
                    >
                      <option value="">Pick a trade…</option>
                      {tradeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  )}
                  {committable && item.category === "link" && (
                    <select
                      className="eq-queue__input"
                      value={values[item.queue_id] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [item.queue_id]: e.target.value }))}
                      disabled={busy || customers === null}
                      aria-label={`Customer for ${item.record_label}`}
                    >
                      <option value="">{customers === null ? "Loading customers…" : "Pick a customer…"}</option>
                      {(customers ?? []).map((c) => (
                        <option key={c.customer_id} value={c.customer_id}>{c.company_name}</option>
                      ))}
                    </select>
                  )}
                  {committable && (item.category === "email" || item.category === "format") && (
                    <input
                      type="text"
                      className="eq-queue__input"
                      value={values[item.queue_id] ?? ""}
                      placeholder={item.suggested_value ?? "New value"}
                      onChange={(e) => setValues((v) => ({ ...v, [item.queue_id]: e.target.value }))}
                      disabled={busy}
                      aria-label={`New ${item.field} for ${item.record_label}`}
                    />
                  )}
                  {committable && (
                    <button
                      type="button"
                      className="eq-intake-btn-primary eq-queue__btn"
                      onClick={() => approve(item)}
                      disabled={busy || !(values[item.queue_id]?.trim())}
                    >
                      {busy ? "Saving…" : "Approve"}
                    </button>
                  )}
                  {item.category === "duplicate" && AI_DUPLICATE_ENTITIES.has(item.entity) && (
                    aiSuggest[item.queue_id] ? (
                      <span className="eq-queue__item-ai-reason">
                        <span className="eq-advisory-item__ai-label">✨ Claude:</span>{" "}
                        {aiSuggest[item.queue_id].reasoning}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="eq-intake-btn-ghost eq-queue__btn"
                        onClick={() => handleAskAi(item)}
                        disabled={!!aiBusy[item.queue_id] || contactRecords === null}
                        title="Ask Claude to sanity-check the detector's reasoning before you archive"
                      >
                        {aiBusy[item.queue_id] ? "Asking Claude…" : contactRecords === null ? "Loading…" : "✨ Ask Claude"}
                      </button>
                    )
                  )}
                  {aiErr[item.queue_id] && <span className="eq-advisory-item__err">AI unavailable</span>}
                  {item.category === "duplicate" && isArchivableDuplicate(item.entity) && (
                    <button
                      type="button"
                      className="eq-intake-btn-primary eq-queue__btn"
                      onClick={() => archiveDuplicate(item)}
                      disabled={busy}
                      title={
                        aiSuggest[item.queue_id]?.verdict === "keep"
                          ? "Claude thinks this may not be a real duplicate — read its reasoning above before archiving"
                          : "Set this record inactive — same action as archiving it on its own page"
                      }
                    >
                      {busy ? "Archiving…" : "Archive"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="eq-intake-btn-ghost eq-queue__btn"
                    onClick={() => dismiss(item)}
                    disabled={busy}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
