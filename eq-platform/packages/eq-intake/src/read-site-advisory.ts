/**
 * @eq/intake — write-time site resolver advisory reader
 *
 * readSiteAdvisory() returns what the write-time site resolver (eq-shell
 * migration 0179) flagged: new-site writes that matched, or were ambiguous
 * against, an existing site. It calls the eq_site_advisory_summary RPC, which
 * is tenant-scoped via the caller's JWT app_metadata.tenant_id.
 *
 * This is the "caught at the write" view — distinct from detectAllDuplicates(),
 * which scans the whole table on demand for duplicates already sitting in the
 * data. Here every row is a write the resolver stopped from silently becoming
 * a new duplicate.
 *
 * adjudicateSiteAdvisory() closes the loop: it records a human's verdict
 * (same / different / unsure) against a flagged row via the
 * eq_site_advisory_adjudicate RPC (eq-shell migration 0183). Each verdict is an
 * append-only label — the record of what a human judged — and the summary above
 * carries each row's latest verdict back so the console shows decided vs pending.
 *
 * Degrades gracefully: if the RPC doesn't exist yet (a tenant not on 0180/0183)
 * the caller's catch keeps the rest of the dashboard working.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SiteVerdict = 'same' | 'different' | 'unsure';

export interface SiteAdvisoryItem {
  id:             string;
  at:             string;                       // ISO timestamp of the flagged write
  outcome:        'match' | 'ambiguous';
  confidence:     'high' | 'low' | null;
  score:          number | null;                // 0..1 best-candidate score
  candidate_name: string | null;                // the incoming site's name
  candidate_code: string | null;                // the incoming site's code
  matched_name:   string | null;                // the existing site it resembled
  matched_active: boolean | null;               // whether that existing site is live
  verdict:        SiteVerdict | null;           // latest human verdict, null = undecided
  verdict_note:   string | null;                // optional note left with the verdict
  decided_at:     string | null;                // ISO timestamp of the latest verdict
}

export interface SiteAdvisorySummary {
  total:        number;              // all flagged writes for the tenant
  matches:      number;              // outcome = match  (looks like the same site)
  ambiguous:    number;              // outcome = ambiguous (a human should decide)
  pending:      number;              // flagged writes with no verdict yet
  decided:      number;              // flagged writes a human has adjudicated
  recent_days:  number;              // window backing recent_count
  recent_count: number;             // flagged within recent_days
  items:        SiteAdvisoryItem[];  // most-recent first, capped by the RPC
}

export interface AdjudicateResult {
  ok:          boolean;
  verdict_id:  string;
  advisory_id: string;
  verdict:     SiteVerdict;
}

const EMPTY: SiteAdvisorySummary = {
  total: 0, matches: 0, ambiguous: 0, pending: 0, decided: 0,
  recent_days: 7, recent_count: 0, items: [],
};

// ---------------------------------------------------------------------------
// Public: readSiteAdvisory
//
// The Supabase client must carry a JWT with app_metadata.tenant_id so the RPC
// scopes to the caller's tenant. Throws on RPC error so the caller (typically a
// Promise.allSettled arm) can treat it as non-fatal.
// ---------------------------------------------------------------------------

export async function readSiteAdvisory(
  supabase: SupabaseLikeClient,
  opts?: { days?: number; limit?: number },
): Promise<SiteAdvisorySummary> {
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_site_advisory_summary', { p_days: opts?.days ?? 7, p_limit: opts?.limit ?? 25 });

  if (error) {
    throw new Error(`readSiteAdvisory: ${error.message}`);
  }
  if (!data || typeof data !== 'object') return EMPTY;

  const d = data as Partial<SiteAdvisorySummary>;
  return {
    total:        d.total        ?? 0,
    matches:      d.matches      ?? 0,
    ambiguous:    d.ambiguous    ?? 0,
    pending:      d.pending      ?? 0,
    decided:      d.decided      ?? 0,
    recent_days:  d.recent_days  ?? (opts?.days ?? 7),
    recent_count: d.recent_count ?? 0,
    items:        Array.isArray(d.items) ? d.items : [],
  };
}

// ---------------------------------------------------------------------------
// Public: adjudicateSiteAdvisory
//
// Record a human's verdict (same / different / unsure) on a flagged advisory
// row via the eq_site_advisory_adjudicate RPC (eq-shell 0183). The Supabase
// client must carry the tenant JWT; the RPC rejects any advisory row outside
// the caller's tenant. Append-only — each call adds a verdict, latest wins.
// Throws on RPC error so the caller can surface it (e.g. an inline "couldn't
// save" state) without taking the dashboard down.
// ---------------------------------------------------------------------------

export async function adjudicateSiteAdvisory(
  supabase: SupabaseLikeClient,
  input: { advisoryId: string; verdict: SiteVerdict; note?: string },
): Promise<AdjudicateResult> {
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_site_advisory_adjudicate', {
    p_advisory_id: input.advisoryId,
    p_verdict:     input.verdict,
    p_note:        input.note ?? null,
  });

  if (error) {
    throw new Error(`adjudicateSiteAdvisory: ${error.message}`);
  }

  const d = (data ?? {}) as Partial<AdjudicateResult>;
  return {
    ok:          d.ok          ?? true,
    verdict_id:  d.verdict_id  ?? '',
    advisory_id: d.advisory_id ?? input.advisoryId,
    verdict:     d.verdict     ?? input.verdict,
  };
}
