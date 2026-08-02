/**
 * @eq/intake — AI contact-duplicate adjudicator (client wrapper)
 *
 * adjudicateContactDuplicateWithAI() asks Claude whether two contact records
 * are the same real-world person, via the `adjudicate_contact_duplicate`
 * action on the eq-ai-assist Edge Function. Mirrors
 * adjudicateDuplicateWithAI() (Sites) exactly — see adjudicate-duplicate-ai.ts
 * for the fuller design notes. This one exists (rather than reusing the
 * queue-duplicate sanity-check added earlier) because the write-time contact
 * resolver (eq-shell 0233) now gives a real structured matched-contact
 * reference, the same shape Sites' resolver always had — so the AI call can
 * genuinely compare two records again, not just sanity-check a detector's
 * own free-text reasoning.
 *
 * This ADVISES only — it never writes a verdict or merges a contact. The
 * human's confirmation is what gets recorded (eq-shell 0233).
 */

import type { EdgeFnCaller } from './ai-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The fields we hand the model about each contact. All optional — pass what you have. */
export interface ContactAdjudicationInput {
  first_name?:   string | null;
  last_name?:    string | null;
  email?:        string | null;
  work_phone?:   string | null;
  mobile_phone?: string | null;
  company_name?: string | null;
  active?:       boolean | null;
}

export interface AiContactVerdict {
  verdict:    'same' | 'different' | 'unsure';
  confidence: 'high' | 'medium' | 'low';
  reasoning:  string;                          // one plain-English sentence
}

const UNSURE: AiContactVerdict = {
  verdict: 'unsure', confidence: 'low', reasoning: 'No reason returned.',
};

// ---------------------------------------------------------------------------
// Public: adjudicateContactDuplicateWithAI
// ---------------------------------------------------------------------------

export async function adjudicateContactDuplicateWithAI(
  contactA: ContactAdjudicationInput,
  contactB: ContactAdjudicationInput,
  callEdgeFn: EdgeFnCaller,
): Promise<AiContactVerdict> {
  const response = await callEdgeFn('adjudicate_contact_duplicate', { contact_a: contactA, contact_b: contactB });

  if (response.error) {
    throw new Error(`adjudicateContactDuplicateWithAI: ${response.error.message}`);
  }

  const d = (response.data ?? {}) as Partial<AiContactVerdict>;
  return {
    verdict:    d.verdict === 'same' || d.verdict === 'different' ? d.verdict : 'unsure',
    confidence: d.confidence === 'high' || d.confidence === 'medium' ? d.confidence : 'low',
    reasoning:  typeof d.reasoning === 'string' && d.reasoning.trim() ? d.reasoning.trim() : UNSURE.reasoning,
  };
}
