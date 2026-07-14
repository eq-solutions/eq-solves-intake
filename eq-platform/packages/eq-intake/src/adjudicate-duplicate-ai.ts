/**
 * @eq/intake — AI site-duplicate adjudicator (client wrapper)
 *
 * adjudicateDuplicateWithAI() asks Claude whether two site records are the same
 * real-world place, via the `adjudicate_duplicate` action on the eq-ai-assist
 * Edge Function. It returns the same verdict vocabulary as the human buttons
 * (same/different/unsure) plus a plain-English reason — so the console can
 * pre-fill the AI's suggestion and the human confirms with the tap they already
 * have (see adjudicateSiteAdvisory in ./read-site-advisory).
 *
 * This ADVISES only — it never writes a verdict or merges a site. The human's
 * confirmation is what gets recorded (eq-shell 0183). The API key stays server-
 * side in the Edge Function; the browser only invokes it (injected EdgeFnCaller,
 * same pattern as suggestGaps / askCanonical).
 */

import type { EdgeFnCaller } from './ai-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The fields we hand the model about each site. All optional — pass what you have. */
export interface SiteAdjudicationInput {
  name?:     string | null;
  code?:     string | null;
  address?:  string | null;
  suburb?:   string | null;
  customer?: string | null;
  active?:   boolean | null;
}

export interface AiSiteVerdict {
  verdict:    'same' | 'different' | 'unsure';
  confidence: 'high' | 'medium' | 'low';
  reasoning:  string;                          // one plain-English sentence
}

const UNSURE: AiSiteVerdict = {
  verdict: 'unsure', confidence: 'low', reasoning: 'No reason returned.',
};

// ---------------------------------------------------------------------------
// Public: adjudicateDuplicateWithAI
//
// Throws on Edge Function error so the caller can surface it inline (e.g. an
// "AI unavailable" state) without taking the dashboard down. The model's answer
// is coerced to the strict vocabulary; anything unexpected degrades to "unsure".
// ---------------------------------------------------------------------------

export async function adjudicateDuplicateWithAI(
  siteA: SiteAdjudicationInput,
  siteB: SiteAdjudicationInput,
  callEdgeFn: EdgeFnCaller,
): Promise<AiSiteVerdict> {
  const response = await callEdgeFn('adjudicate_duplicate', { site_a: siteA, site_b: siteB });

  if (response.error) {
    throw new Error(`adjudicateDuplicateWithAI: ${response.error.message}`);
  }

  const d = (response.data ?? {}) as Partial<AiSiteVerdict>;
  return {
    verdict:    d.verdict === 'same' || d.verdict === 'different' ? d.verdict : 'unsure',
    confidence: d.confidence === 'high' || d.confidence === 'medium' ? d.confidence : 'low',
    reasoning:  typeof d.reasoning === 'string' && d.reasoning.trim() ? d.reasoning.trim() : UNSURE.reasoning,
  };
}
