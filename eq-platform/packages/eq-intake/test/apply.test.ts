/**
 * Apply tests — uses a fake UpsertClient (no real DB) to assert ordering,
 * idempotency key wiring, dry-run, and counts.
 */

import { describe, it, expect } from "vitest";
import { applyCanonicalRecords, type UpsertClient } from "../src/apply.js";
import type { EmitResult } from "../src/emit.js";

function fakeClient() {
  const calls: Array<{ table: string; rows: Record<string, unknown>[]; onConflict: string[] }> = [];
  const client: UpsertClient = {
    async upsert(table, rows, onConflict) {
      calls.push({ table, rows, onConflict });
      return rows.length;
    },
  };
  return { client, calls };
}

const RESULT: EmitResult = {
  licences: [
    { tenant_id: "t", staff_id: "s1", holder_email: "a@x", licence_type: "white_card", licence_number: null, state: null, expiry_date: null, asserted_by: "employer", verification_status: "asserted", claim_status: "unclaimed", active: true, source: "matrix-import", imported_from: "m", imported_at: "2026-06-02T00:00:00Z", notes: null },
  ],
  grants: [
    { tenant_id: "t", holder_email: "a@x", status: "implied", granted_by: "employer_assertion", scope: "all_licences" },
  ],
  upsert_key: ["tenant_id", "holder_email", "licence_type"],
  summary: { approved_people: 1, licences: 1, grants: 1, skipped_people: 0, skipped_unmapped: 0, skipped_no_email: 0, collapsed_duplicates: 0 },
};

describe("applyCanonicalRecords", () => {
  it("upserts grants BEFORE licences", async () => {
    const { client, calls } = fakeClient();
    await applyCanonicalRecords(RESULT, client);
    expect(calls.map((c) => c.table)).toEqual(["licence_grants", "licences"]);
  });

  it("passes the holder-keyed conflict targets", async () => {
    const { client, calls } = fakeClient();
    await applyCanonicalRecords(RESULT, client);
    expect(calls[0]!.onConflict).toEqual(["tenant_id", "holder_email"]);
    expect(calls[1]!.onConflict).toEqual(["tenant_id", "holder_email", "licence_type"]);
  });

  it("reports counts", async () => {
    const { client } = fakeClient();
    const report = await applyCanonicalRecords(RESULT, client);
    expect(report).toMatchObject({ grants_upserted: 1, licences_upserted: 1, dry_run: false });
  });

  it("dry-run writes nothing but reports what would land", async () => {
    const { client, calls } = fakeClient();
    const report = await applyCanonicalRecords(RESULT, client, { dryRun: true });
    expect(calls).toHaveLength(0);
    expect(report).toMatchObject({ grants_upserted: 1, licences_upserted: 1, dry_run: true });
  });

  it("respects custom table names", async () => {
    const { client, calls } = fakeClient();
    await applyCanonicalRecords(RESULT, client, { licencesTable: "sks_licences", grantsTable: "sks_grants" });
    expect(calls.map((c) => c.table)).toEqual(["sks_grants", "sks_licences"]);
  });
});
