/**
 * @eq/intake — contact merge preview + execute (the "merge these" button)
 *
 * previewContactMerge()/executeContactMerge() call eq-shell migration 0234's
 * eq_contact_merge_preview / eq_contact_merge_execute RPCs. Mirrors
 * merge-duplicate-sites.ts exactly — see that file for the fuller design
 * notes. The one structural difference: contacts' merge only touches 3 FK
 * tables (quote, contact_customer_links, contact_site_links) vs. Sites' 26,
 * and two of those three carry a UNIQUE constraint the server-side RPC
 * dedupes around (a redundant link is dropped, not duplicated) — reflected
 * here as extra `*_redundant` rows in the preview's table breakdown.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContactMergeTableCount {
  table: string;
  count: number;
}

export interface ContactMergePreview {
  advisory_id:         string;
  survivor_contact_id: string;
  survivor_name:       string | null;
  loser_contact_id:    string;
  loser_name:          string | null;
  loser_active:        boolean | null;
  tables:               ContactMergeTableCount[];
  total_rows:           number;
  already_merged:       boolean;
}

export interface ContactMergeResult {
  ok:                  boolean;
  merge_log_id:        string;
  advisory_id:         string;
  survivor_contact_id: string;
  loser_contact_id:    string;
  moved:               Record<string, number>;
}

// ---------------------------------------------------------------------------
// Public: previewContactMerge
//
// Pure read (eq_contact_merge_preview) — nothing changes until Confirm is
// tapped. Throws on RPC error so the caller can surface it inline.
// ---------------------------------------------------------------------------

export async function previewContactMerge(
  supabase: SupabaseLikeClient,
  advisoryId: string,
): Promise<ContactMergePreview> {
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_contact_merge_preview', { p_advisory_id: advisoryId });

  if (error) {
    throw new Error(`previewContactMerge: ${error.message}`);
  }

  const d = (data ?? {}) as Partial<ContactMergePreview>;
  return {
    advisory_id:         d.advisory_id         ?? advisoryId,
    survivor_contact_id: d.survivor_contact_id ?? '',
    survivor_name:       d.survivor_name       ?? null,
    loser_contact_id:    d.loser_contact_id    ?? '',
    loser_name:          d.loser_name          ?? null,
    loser_active:        d.loser_active        ?? null,
    tables:               Array.isArray(d.tables) ? d.tables : [],
    total_rows:           d.total_rows          ?? 0,
    already_merged:       d.already_merged      ?? false,
  };
}

// ---------------------------------------------------------------------------
// Public: executeContactMerge
//
// The write (eq_contact_merge_execute). Requires a preview to already be on
// screen (mirrors the server-side precondition that a 'same' verdict must
// already be recorded — see eq-shell 0234).
// ---------------------------------------------------------------------------

export async function executeContactMerge(
  supabase: SupabaseLikeClient,
  input: { advisoryId: string; note?: string },
): Promise<ContactMergeResult> {
  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_contact_merge_execute', { p_advisory_id: input.advisoryId, p_note: input.note ?? null });

  if (error) {
    throw new Error(`executeContactMerge: ${error.message}`);
  }

  const d = (data ?? {}) as Partial<ContactMergeResult>;
  return {
    ok:                  d.ok                  ?? true,
    merge_log_id:        d.merge_log_id        ?? '',
    advisory_id:         d.advisory_id         ?? input.advisoryId,
    survivor_contact_id: d.survivor_contact_id ?? '',
    loser_contact_id:    d.loser_contact_id    ?? '',
    moved:               d.moved               ?? {},
  };
}
