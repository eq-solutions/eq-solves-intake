/**
 * previewContactMerge / executeContactMerge — the contact-merge RPC wrappers
 * (eq-shell 0234). Mirrors merge-duplicate-sites.test.ts.
 */

import { describe, it, expect } from "vitest";
import { previewContactMerge, executeContactMerge } from "../src/merge-duplicate-contacts.js";
import type { SupabaseLikeClient } from "../src/canonical/commit-canonical.js";

function fakeClient(
  handler: (name: string, params: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
): SupabaseLikeClient {
  return {
    rpc: async (name: string, params: Record<string, unknown>) => handler(name, params),
  } as unknown as SupabaseLikeClient;
}

const PREVIEW_PAYLOAD = {
  advisory_id: "a1",
  survivor_contact_id: "c-survivor",
  survivor_name: "Rowen Hansell",
  loser_contact_id: "c-loser",
  loser_name: "Rowen Hansell",
  loser_active: true,
  tables: [
    { table: "quote", count: 1 },
    { table: "contact_customer_links_redundant", count: 1 },
    { table: "contact_customer_links", count: 0 },
  ],
  total_rows: 2,
  already_merged: false,
};

describe("previewContactMerge", () => {
  it("maps the RPC preview payload faithfully", async () => {
    const client = fakeClient((name, params) => {
      expect(name).toBe("eq_contact_merge_preview");
      expect(params.p_advisory_id).toBe("a1");
      return { data: PREVIEW_PAYLOAD, error: null };
    });
    const preview = await previewContactMerge(client, "a1");
    expect(preview.survivor_contact_id).toBe("c-survivor");
    expect(preview.loser_contact_id).toBe("c-loser");
    expect(preview.tables).toHaveLength(3);
    expect(preview.total_rows).toBe(2);
    expect(preview.already_merged).toBe(false);
  });

  it("defaults missing fields when the RPC returns a bare object", async () => {
    const client = fakeClient(() => ({ data: {}, error: null }));
    const preview = await previewContactMerge(client, "a2");
    expect(preview.advisory_id).toBe("a2");
    expect(preview.tables).toEqual([]);
    expect(preview.total_rows).toBe(0);
    expect(preview.already_merged).toBe(false);
  });

  it("throws on RPC error so the console can surface it inline", async () => {
    const client = fakeClient(() => ({
      data: null, error: { message: "advisory row not found for tenant" },
    }));
    await expect(previewContactMerge(client, "nope")).rejects.toThrow(/advisory row not found/);
  });
});

describe("executeContactMerge", () => {
  it("calls the execute RPC with the mapped params", async () => {
    let seen: { name: string; params: Record<string, unknown> } = { name: "", params: {} };
    const client = fakeClient((name, params) => {
      seen = { name, params };
      return {
        data: {
          ok: true, merge_log_id: "m1", advisory_id: "a1",
          survivor_contact_id: "c-survivor", loser_contact_id: "c-loser",
          moved: { quote: 1, contact_customer_links: 0, contact_site_links: 0 },
        },
        error: null,
      };
    });
    const res = await executeContactMerge(client, { advisoryId: "a1", note: "confirmed same" });
    expect(seen.name).toBe("eq_contact_merge_execute");
    expect(seen.params.p_advisory_id).toBe("a1");
    expect(seen.params.p_note).toBe("confirmed same");
    expect(res.ok).toBe(true);
    expect(res.survivor_contact_id).toBe("c-survivor");
    expect(res.moved.quote).toBe(1);
  });

  it("passes a null note when none is given", async () => {
    let seen: Record<string, unknown> = {};
    const client = fakeClient((_name, params) => {
      seen = params;
      return { data: { ok: true, merge_log_id: "m2", advisory_id: "a2", survivor_contact_id: "s", loser_contact_id: "l", moved: {} }, error: null };
    });
    await executeContactMerge(client, { advisoryId: "a2" });
    expect(seen.p_note).toBeNull();
  });

  it("throws on RPC error (e.g. re-merge or missing manager role)", async () => {
    const client = fakeClient(() => ({
      data: null, error: { message: "caller is not an active manager on this tenant" },
    }));
    await expect(
      executeContactMerge(client, { advisoryId: "a3" }),
    ).rejects.toThrow(/not an active manager/);
  });
});
