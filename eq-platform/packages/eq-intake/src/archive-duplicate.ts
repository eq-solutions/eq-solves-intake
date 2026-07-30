/**
 * @eq/intake — archive a flagged duplicate record from the Remediation Queue
 *
 * Calls eq_archive_duplicate_record (sql/064): a tenant-JWT-scoped RPC that
 * flips active=false (staff also on_roster=false) on a whitelisted table —
 * the same field set eq-shell's Staff/Contacts pages set, replicated here so
 * a duplicate flagged under the Queue's "Other duplicate flags" category can
 * be archived without leaving eq-intake for the entity screen first.
 */

import type { SupabaseLikeClient } from './canonical/commit-canonical.js';

export interface ArchiveDuplicateResult {
  applied: number;
}

const ARCHIVABLE_TABLES = new Set(['staff', 'contacts']);

export function isArchivableDuplicate(table: string): boolean {
  return ARCHIVABLE_TABLES.has(table);
}

export async function archiveDuplicateRecord(
  supabase: SupabaseLikeClient,
  input: { table: string; rowId: string },
): Promise<ArchiveDuplicateResult> {
  if (!ARCHIVABLE_TABLES.has(input.table)) {
    throw new Error(`archiveDuplicateRecord: "${input.table}" can't be archived from this screen`);
  }

  const { data, error } = await (supabase as unknown as {
    rpc: (name: string, params: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('eq_archive_duplicate_record', { p_table: input.table, p_row_id: input.rowId });

  if (error) {
    throw new Error(`archiveDuplicateRecord: ${error.message}`);
  }

  const d = (data ?? {}) as { applied?: number };
  return { applied: d.applied ?? 0 };
}
