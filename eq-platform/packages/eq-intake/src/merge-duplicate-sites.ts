/**
 * @eq/intake — site merge (preview + execute)
 *
 * The last step in the site-resolver learning loop: 0179 catches a duplicate
 * at the write, 0183 records a human/AI verdict ("same"), and this closes it
 * — actually collapsing the two rows. previewSiteMergeteed calls
 * eq_site_merge_preview (eq-shell 0185): a pure read that lists exactly which
 * rows in which tables would move, so the console can show the human what
 * they're about to do before they do it. executeSiteMerge() calls
 * eq_site_merge_execute (eq-shell 0185): repoints every dependent row from the
 * loser site to the survivor, then soft-retires the loser (never deleted).
 *
 * Both RPCs are tenant-scoped via the caller's JWT and gated server-side —
 * execute additionally requires an active 'manager' role on the tenant and a
 * recorded 'same' verdict already on file. A caller without that role gets a
 * thrown error, which the console surfaces inline rather than hiding the
 * button (a non-manager should see why merge isn't available to them).
 *
 * Degrades gracefully: a tenant not yet on 0185 gets an RPC-not-found error,
 * which the caller's catch keeps the rest of the dashboard working through.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SiteMergeTableCount {
  table: string;
  count: number;
}

export interface SiteMergePreview {
  advisory_id:      string;
  survivor_site_id: string;
  survivor_name:    string | null;
  survivor_code:    string | null;
  loser_site_id:    string;
  loser_name:       string | null;
  loser_code:       string | null;
  loser_active:     boolean | null;
  tables:           SiteMergeTableCount[];
  total_rows:       number;
  already_merged:   boolean;
}

export interface SiteMergeResult {
  ok:               boolean;
  merge_log_id:     string;
  advisory_id:      string;
  survivor_site_id: string;
  loser_site_id:    string;
  moved:            Record<string, number>;
}

export interface SiteFlagPairResult {
  advisoryId:     string;
  alreadyFlagged: boolean;
}

// ---------------------------------------------------------------------------
// Public: previewSiteMerge
//
// Pure read — writes nothing. Throws on RPC error (missing verdict pair,
// tenant mismatch, RPC not deployed yet) so the caller can surface it inline.
// ---------------------------------------------------------------------------

export async function previewSiteMerge(
  supabase: SupabaseLikeClient,
  advisoryId: string,
): Promise<SiteMergePreview> {
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_site_merge_preview', { p_advisory_id: advisoryId });

  if (error) {
    throw new Error(`previewSiteMerge: ${error.message}`);
  }

  const d = (data ?? {}) as Partial<SiteMergePreview>;
  return {
    advisory_id:      d.advisory_id ?? advisoryId,
    survivor_site_id: d.survivor_site_id ?? '',
    survivor_name:    d.survivor_name ?? null,
    survivor_code:    d.survivor_code ?? null,
    loser_site_id:    d.loser_site_id ?? '',
    loser_name:       d.loser_name ?? null,
    loser_code:       d.loser_code ?? null,
    loser_active:     d.loser_active ?? null,
    tables:           Array.isArray(d.tables) ? d.tables : [],
    total_rows:       d.total_rows ?? 0,
    already_merged:   d.already_merged ?? false,
  };
}

// ---------------------------------------------------------------------------
// Public: executeSiteMerge
//
// The write. Requires: the advisory already carries a recorded 'same' verdict,
// the caller is an active 'manager' on the tenant, and the advisory has not
// already been merged. Throws on RPC error — the console surfaces it inline
// (e.g. "you need a manager role to merge sites") rather than pretending it
// succeeded.
// ---------------------------------------------------------------------------

export async function executeSiteMerge(
  supabase: SupabaseLikeClient,
  input: { advisoryId: string; note?: string },
): Promise<SiteMergeResult> {
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_site_merge_execute', {
    p_advisory_id: input.advisoryId,
    p_note:        input.note ?? null,
  });

  if (error) {
    throw new Error(`executeSiteMerge: ${error.message}`);
  }

  const d = (data ?? {}) as Partial<SiteMergeResult>;
  return {
    ok:               d.ok ?? true,
    merge_log_id:     d.merge_log_id ?? '',
    advisory_id:      d.advisory_id ?? input.advisoryId,
    survivor_site_id: d.survivor_site_id ?? '',
    loser_site_id:    d.loser_site_id ?? '',
    moved:            d.moved ?? {},
  };
}

// ---------------------------------------------------------------------------
// Public: flagSitePairForMerge
//
// The entry point for duplicates the write-time resolver never saw — e.g. two
// rows the generic Sites "Dupes" tab (name-match, read-only) finds that predate
// 0179 or never triggered a write. Calls eq_site_advisory_flag_pair (eq-shell
// 0186): manager-gated, same bar as executeSiteMerge, computes real similarity
// signals between the two named rows and creates a site_resolution_advisory
// row — the SAME shape 0179's trigger would have logged — so the existing
// Same/Different/Unsure -> Preview -> Confirm flow picks it up unchanged.
// Idempotent: flagging the same pair twice returns the existing advisory
// instead of creating a duplicate. Does NOT set a verdict or merge anything —
// a human still has to click Same before Preview/Confirm becomes reachable.
// ---------------------------------------------------------------------------

export async function flagSitePairForMerge(
  supabase: SupabaseLikeClient,
  input: { survivorSiteId: string; loserSiteId: string },
): Promise<SiteFlagPairResult> {
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_site_advisory_flag_pair', {
    p_survivor_id: input.survivorSiteId,
    p_loser_id:    input.loserSiteId,
  });

  if (error) {
    throw new Error(`flagSitePairForMerge: ${error.message}`);
  }

  const d = (data ?? {}) as { advisory_id?: string; already_flagged?: boolean };
  return {
    advisoryId:     d.advisory_id ?? '',
    alreadyFlagged: d.already_flagged ?? false,
  };
}
