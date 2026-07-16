/**
 * previewSiteMerge / executeSiteMerge — the site-merge RPC wrappers (eq-shell
 * 0185). The wrapper must map the RPC payload faithfully, default missing
 * fields, and treat an RPC error as fatal so the console can surface it inline
 * (e.g. "you need a manager role to merge sites") rather than swallowing it.
 */

import { describe, it, expect } from "vitest";
import { previewSiteMerge, executeSiteMerge, flagSitePairForMerge } from "../src/merge-duplicate-sites.js";
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
  survivor_site_id: "s-survivor",
  survivor_name: "SY9",
  survivor_code: "SY9",
  loser_site_id: "s-loser",
  loser_name: "Sydney SY9",
  loser_code: "SY9-B",
  loser_active: true,
  tables: [{ table: "assets", count: 4 }, { table: "jobs", count: 2 }],
  total_rows: 6,
  already_merged: false,
};

describe("previewSiteMerge", () => {
  it("maps the RPC preview payload faithfully", async () => {
    const client = fakeClient((name, params) => {
      expect(name).toBe("eq_site_merge_preview");
      expect(params.p_advisory_id).toBe("a1");
      return { data: PREVIEW_PAYLOAD, error: null };
    });
    const preview = await previewSiteMerge(client, "a1");
    expect(preview.survivor_site_id).toBe("s-survivor");
    expect(preview.loser_site_id).toBe("s-loser");
    expect(preview.tables).toHaveLength(2);
    expect(preview.tables[0]).toEqual({ table: "assets", count: 4 });
    expect(preview.total_rows).toBe(6);
    expect(preview.already_merged).toBe(false);
  });

  it("defaults missing fields when the RPC returns a bare object", async () => {
    const client = fakeClient(() => ({ data: {}, error: null }));
    const preview = await previewSiteMerge(client, "a2");
    expect(preview.advisory_id).toBe("a2");
    expect(preview.tables).toEqual([]);
    expect(preview.total_rows).toBe(0);
    expect(preview.already_merged).toBe(false);
  });

  it("throws on RPC error so the console can surface it inline", async () => {
    const client = fakeClient(() => ({
      data: null,
      error: { message: "advisory row has no recorded 'same' verdict" },
    }));
    await expect(previewSiteMerge(client, "a3")).rejects.toThrow(/recorded 'same' verdict/);
  });
});

describe("executeSiteMerge", () => {
  it("calls the execute RPC with the mapped params", async () => {
    let seen: { name: string; params: Record<string, unknown> } = { name: "", params: {} };
    const client = fakeClient((name, params) => {
      seen = { name, params };
      return {
        data: {
          ok: true, merge_log_id: "m1", advisory_id: "a1",
          survivor_site_id: "s-survivor", loser_site_id: "s-loser",
          moved: { assets: 4, jobs: 2 },
        },
        error: null,
      };
    });
    const res = await executeSiteMerge(client, { advisoryId: "a1", note: "confirmed via console" });
    expect(seen.name).toBe("eq_site_merge_execute");
    expect(seen.params.p_advisory_id).toBe("a1");
    expect(seen.params.p_note).toBe("confirmed via console");
    expect(res.ok).toBe(true);
    expect(res.merge_log_id).toBe("m1");
    expect(res.moved).toEqual({ assets: 4, jobs: 2 });
  });

  it("passes a null note when none is given", async () => {
    let seen: Record<string, unknown> = {};
    const client = fakeClient((_name, params) => {
      seen = params;
      return {
        data: { ok: true, merge_log_id: "m2", advisory_id: "a2", survivor_site_id: "s1", loser_site_id: "s2", moved: {} },
        error: null,
      };
    });
    await executeSiteMerge(client, { advisoryId: "a2" });
    expect(seen.p_note).toBeNull();
  });

  it("throws on RPC error (e.g. caller is not an active manager)", async () => {
    const client = fakeClient(() => ({
      data: null,
      error: { message: "caller is not an active manager on this tenant" },
    }));
    await expect(executeSiteMerge(client, { advisoryId: "nope" })).rejects.toThrow(/not an active manager/);
  });
});

describe("flagSitePairForMerge", () => {
  it("calls the flag-pair RPC with the mapped params", async () => {
    let seen: { name: string; params: Record<string, unknown> } = { name: "", params: {} };
    const client = fakeClient((name, params) => {
      seen = { name, params };
      return { data: { advisory_id: "a9", already_flagged: false }, error: null };
    });
    const res = await flagSitePairForMerge(client, { survivorSiteId: "s-survivor", loserSiteId: "s-loser" });
    expect(seen.name).toBe("eq_site_advisory_flag_pair");
    expect(seen.params.p_survivor_id).toBe("s-survivor");
    expect(seen.params.p_loser_id).toBe("s-loser");
    expect(res.advisoryId).toBe("a9");
    expect(res.alreadyFlagged).toBe(false);
  });

  it("surfaces an already-flagged pair as idempotent, not an error", async () => {
    const client = fakeClient(() => ({
      data: { advisory_id: "a5", already_flagged: true },
      error: null,
    }));
    const res = await flagSitePairForMerge(client, { survivorSiteId: "s1", loserSiteId: "s2" });
    expect(res.advisoryId).toBe("a5");
    expect(res.alreadyFlagged).toBe(true);
  });

  it("defaults missing fields when the RPC returns a bare object", async () => {
    const client = fakeClient(() => ({ data: {}, error: null }));
    const res = await flagSitePairForMerge(client, { survivorSiteId: "s1", loserSiteId: "s2" });
    expect(res.advisoryId).toBe("");
    expect(res.alreadyFlagged).toBe(false);
  });

  it("throws on RPC error (e.g. caller is not an active manager)", async () => {
    const client = fakeClient(() => ({
      data: null,
      error: { message: "caller is not an active manager on this tenant" },
    }));
    await expect(
      flagSitePairForMerge(client, { survivorSiteId: "s1", loserSiteId: "s2" }),
    ).rejects.toThrow(/not an active manager/);
  });
});
