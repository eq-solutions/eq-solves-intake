/**
 * @eq/intake — AI sanity-check for Review-Queue duplicate flags (client wrapper)
 *
 * adjudicateQueueDuplicateWithAI() asks Claude to sanity-check an automated
 * duplicate detector's own call, via the `adjudicate_queue_duplicate` action
 * on the eq-ai-assist Edge Function. Used by RemediationQueue's "duplicate"
 * category (contacts today — see eq_remediation_queue) before a human taps
 * Archive.
 *
 * Unlike adjudicateDuplicateWithAI() (Sites), there is no structured second
 * record to compare against here: app_data.eq_remediation_queue's duplicate
 * rows carry only the flagged record's own fields plus a free-text `reason`
 * naming the suspected match (verified live 2026-08-02 — no matched_record_id
 * column exists). So this hands Claude the flagged record and the detector's
 * own reasoning, and asks it to sanity-check the call rather than compare two
 * records. Verdict vocabulary matches the action offered: archive / keep /
 * unsure — not same/different/unsure.
 *
 * This ADVISES only — it never archives anything. The human's tap on the
 * existing Archive button is what acts. The API key stays server-side in the
 * Edge Function; the browser only invokes it (injected EdgeFnCaller, same
 * pattern as adjudicateDuplicateWithAI / suggestGaps / askCanonical).
 */

import type { EdgeFnCaller } from './ai-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The flagged record's own fields. Pass whatever the entity table has. */
export type QueueDuplicateRecord = Record<string, unknown>;

export interface QueueDuplicateContext {
  /** The detector's own plain-English reason for flagging this record. */
  reason: string;
  /** e.g. "inactive duplicate" — the queue row's current_value, if present. */
  currentValue?: string | null;
}

export interface AiQueueDuplicateVerdict {
  verdict:    'archive' | 'keep' | 'unsure';
  confidence: 'high' | 'medium' | 'low';
  reasoning:  string;                          // one plain-English sentence
}

const UNSURE: AiQueueDuplicateVerdict = {
  verdict: 'unsure', confidence: 'low', reasoning: 'No reason returned.',
};

// ---------------------------------------------------------------------------
// Public: adjudicateQueueDuplicateWithAI
//
// Throws on Edge Function error so the caller can surface it inline (e.g. an
// "AI unavailable" state) without taking the queue down. The model's answer
// is coerced to the strict vocabulary; anything unexpected degrades to "unsure".
// ---------------------------------------------------------------------------

export async function adjudicateQueueDuplicateWithAI(
  record: QueueDuplicateRecord,
  context: QueueDuplicateContext,
  callEdgeFn: EdgeFnCaller,
): Promise<AiQueueDuplicateVerdict> {
  const response = await callEdgeFn('adjudicate_queue_duplicate', {
    record,
    reason: context.reason,
    current_value: context.currentValue ?? null,
  });

  if (response.error) {
    throw new Error(`adjudicateQueueDuplicateWithAI: ${response.error.message}`);
  }

  const d = (response.data ?? {}) as Partial<AiQueueDuplicateVerdict>;
  return {
    verdict:    d.verdict === 'archive' || d.verdict === 'keep' ? d.verdict : 'unsure',
    confidence: d.confidence === 'high' || d.confidence === 'medium' ? d.confidence : 'low',
    reasoning:  typeof d.reasoning === 'string' && d.reasoning.trim() ? d.reasoning.trim() : UNSURE.reasoning,
  };
}
