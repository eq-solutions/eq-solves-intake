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
 * Degrades gracefully: if the RPC doesn't exist yet (a tenant not on 0180) the
 * caller's Promise.allSettled catch keeps the rest of the dashboard working.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

export interface SiteAdvisorySummary {
  total:        number;              // all flagged writes for the tenant
  matches:      number;              // outcome = match  (looks like the same site)
  ambiguous:    number;              // outcome = ambiguous (a human should decide)
  recent_days:  number;              // window backing recent_count
  recent_count: number;             // flagged within recent_days
  items:        SiteAdvisoryItem[];  // most-recent first, capped by the RPC
}

const EMPTY: SiteAdvisorySummary = {
  total: 0, matches: 0, ambiguous: 0, recent_days: 7, recent_count: 0, items: [],
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
    recent_days:  d.recent_days  ?? (opts?.days ?? 7),
    recent_count: d.recent_count ?? 0,
    items:        Array.isArray(d.items) ? d.items : [],
  };
}
