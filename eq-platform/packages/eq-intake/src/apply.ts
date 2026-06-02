/**
 * Apply — the (dumb) write step that lands an EmitResult into canonical.
 *
 * Deliberately transport-agnostic: the logic here just orders the upserts and
 * reports counts. The actual DB binding (supabase-js, a tenant RPC client, or
 * a test fake) is injected as an UpsertClient. That keeps the write idempotent
 * and unit-testable, and lets us point it at a Supabase BRANCH first, then the
 * SKS tenant on promotion, without changing this file.
 *
 * Order matters: grants (the entitlement) are upserted before licences so a
 * holder's access exists before their credentials land.
 */

import type { EmitResult } from "./emit.js";

export interface UpsertClient {
  /**
   * Idempotently upsert rows into `table`, conflict-resolving on `onConflict`
   * columns. Returns how many rows were written. Implementations: supabase-js
   * .from(table).upsert(rows, { onConflict }), a tenant RPC, or a test fake.
   */
  upsert(table: string, rows: Record<string, unknown>[], onConflict: string[]): Promise<number>;
}

export interface ApplyReport {
  grants_upserted: number;
  licences_upserted: number;
  dry_run: boolean;
}

export interface ApplyOptions {
  /** If true, don't call the client — just report what WOULD be written. */
  dryRun?: boolean;
  /** Table name for licences. Default "licences". */
  licencesTable?: string;
  /** Table name for grants. Default "licence_grants". */
  grantsTable?: string;
}

const GRANT_CONFLICT = ["tenant_id", "holder_email"];

export async function applyCanonicalRecords(
  result: EmitResult,
  client: UpsertClient,
  opts: ApplyOptions = {},
): Promise<ApplyReport> {
  const dryRun = opts.dryRun ?? false;
  const licencesTable = opts.licencesTable ?? "licences";
  const grantsTable = opts.grantsTable ?? "licence_grants";

  if (dryRun) {
    return { grants_upserted: result.grants.length, licences_upserted: result.licences.length, dry_run: true };
  }

  // Grants first — the entitlement must exist before the credentials it covers.
  const grants_upserted = result.grants.length
    ? await client.upsert(grantsTable, result.grants as unknown as Record<string, unknown>[], GRANT_CONFLICT)
    : 0;

  const licences_upserted = result.licences.length
    ? await client.upsert(licencesTable, result.licences as unknown as Record<string, unknown>[], result.upsert_key)
    : 0;

  return { grants_upserted, licences_upserted, dry_run: false };
}
