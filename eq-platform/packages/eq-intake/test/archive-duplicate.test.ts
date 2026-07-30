import { describe, it, expect } from "vitest";
import { archiveDuplicateRecord, isArchivableDuplicate } from "../src/archive-duplicate.js";
import type { SupabaseLikeClient } from "../src/canonical/commit-canonical.js";

function fakeClient(response: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ name: string; params: unknown }> = [];
  const client = {
    rpc: async (name: string, params: unknown) => {
      calls.push({ name, params });
      return response;
    },
  } as unknown as SupabaseLikeClient;
  return { client, calls };
}

describe("isArchivableDuplicate", () => {
  it("allows staff and contacts", () => {
    expect(isArchivableDuplicate("staff")).toBe(true);
    expect(isArchivableDuplicate("contacts")).toBe(true);
  });

  it("rejects other entities", () => {
    expect(isArchivableDuplicate("sites")).toBe(false);
    expect(isArchivableDuplicate("customers")).toBe(false);
  });
});

describe("archiveDuplicateRecord", () => {
  it("rejects a non-archivable table before calling the RPC", async () => {
    const { client, calls } = fakeClient({ data: { applied: 1 }, error: null });
    await expect(archiveDuplicateRecord(client, { table: "sites", rowId: "s-1" }))
      .rejects.toThrow(/can't be archived/);
    expect(calls).toHaveLength(0);
  });

  it("calls eq_archive_duplicate_record with the right params and returns applied count", async () => {
    const { client, calls } = fakeClient({ data: { applied: 1 }, error: null });
    const result = await archiveDuplicateRecord(client, { table: "staff", rowId: "st-1" });
    expect(result.applied).toBe(1);
    expect(calls[0]).toEqual({
      name: "eq_archive_duplicate_record",
      params: { p_table: "staff", p_row_id: "st-1" },
    });
  });

  it("throws when the RPC returns an error", async () => {
    const { client } = fakeClient({ data: null, error: { message: "no tenant_id in JWT" } });
    await expect(archiveDuplicateRecord(client, { table: "contacts", rowId: "c-1" }))
      .rejects.toThrow(/no tenant_id in JWT/);
  });

  it("defaults applied to 0 when the RPC returns no count", async () => {
    const { client } = fakeClient({ data: {}, error: null });
    const result = await archiveDuplicateRecord(client, { table: "contacts", rowId: "c-2" });
    expect(result.applied).toBe(0);
  });
});
