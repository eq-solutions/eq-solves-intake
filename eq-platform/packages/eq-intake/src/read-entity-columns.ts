/**
 * @eq/intake — shared column-projected entity reader
 *
 * Wraps eq_tidy_read_entity_columns (0303_tidy_read_entity_columns.sql) with
 * a fallback to the original full-row eq_tidy_read_entity for any tenant
 * where the projected RPC hasn't been dispatched yet — it's rolled out
 * per-tenant via eq-shell's tenant-migrate.yml, not fleet-wide (first
 * dispatch: sks/ehow only, 2026-09-07; eq/zaap not yet covered). Falls back
 * on ANY error rather than string-matching Postgres's specific
 * undefined-function message, so it also covers the RPC existing but
 * erroring for some other reason. Once every tenant has it, the fallback
 * branch simply never fires.
 *
 * duplicate-detect.ts deliberately does NOT use this — its completeness
 * tie-break needs every column on the row, so it keeps calling
 * eq_tidy_read_entity directly, unprojected.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

type RpcClient = {
  rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export async function readEntityColumns(
  supabase: SupabaseLikeClient,
  table: string,
  columns: string[],
): Promise<{ data: unknown; error: { message: string } | null }> {
  const client = supabase as unknown as RpcClient;
  const projected = await client.rpc('eq_tidy_read_entity_columns', { p_table: table, p_columns: columns });
  if (!projected.error) return projected;
  return client.rpc('eq_tidy_read_entity', { p_table: table });
}
