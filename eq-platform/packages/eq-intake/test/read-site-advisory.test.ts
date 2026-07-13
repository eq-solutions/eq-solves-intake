/**
 * readSiteAdvisory — surfaces what the write-time site resolver (eq-shell 0179)
 * flagged, via the eq_site_advisory_summary RPC. The reader must map the RPC
 * payload faithfully, default missing fields, and treat an RPC error as fatal
 * so the dashboard's Promise.allSettled arm can degrade gracefully.
 */

import { describe, it, expect } from "vitest";
import { readSiteAdvisory } from "../src/read-site-advisory.js";
import type { SupabaseLikeClient } from "../src/canonical/commit-canonical.js";

function fakeClient(
  handler: (name: string, params: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
): SupabaseLikeClient {
  return {
    rpc: async (name: string, params: Record<string, unknown>) => handler(name, params),
  } as unknown as SupabaseLikeClient;
}

const FULL_PAYLOAD = {
  total: 3,
  matches: 1,
  ambiguous: 2,
  recent_days: 7,
  recent_count: 2,
  items: [
    {
      id: "a1", at: "2026-07-13T12:00:00Z", outcome: "ambiguous", confidence: "low",
      score: 0.81, candidate_name: "Sydney SY9", candidate_code: "SY9",
      matched_name: "SY9", matched_active: true,
    },
  ],
};

describe("readSiteAdvisory", () => {
  it("maps the RPC summary payload faithfully", async () => {
    const client = fakeClient((name) => {
      expect(name).toBe("eq_site_advisory_summary");
      return { data: FULL_PAYLOAD, error: null };
    });
    const summary = await readSiteAdvisory(client);
    expect(summary.total).toBe(3);
    expect(summary.matches).toBe(1);
    expect(summary.ambiguous).toBe(2);
    expect(summary.recent_count).toBe(2);
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0].matched_name).toBe("SY9");
    expect(summary.items[0].outcome).toBe("ambiguous");
  });

  it("passes the day/limit window to the RPC", async () => {
    let seen: Record<string, unknown> = {};
    const client = fakeClient((_name, params) => {
      seen = params;
      return { data: { ...FULL_PAYLOAD, items: [] }, error: null };
    });
    await readSiteAdvisory(client, { days: 30, limit: 50 });
    expect(seen.p_days).toBe(30);
    expect(seen.p_limit).toBe(50);
  });

  it("defaults missing fields and a missing items array to empty", async () => {
    const client = fakeClient(() => ({ data: { total: 5 }, error: null }));
    const summary = await readSiteAdvisory(client);
    expect(summary.total).toBe(5);
    expect(summary.matches).toBe(0);
    expect(summary.ambiguous).toBe(0);
    expect(summary.items).toEqual([]);
  });

  it("returns an empty summary when the RPC returns no object", async () => {
    const client = fakeClient(() => ({ data: null, error: null }));
    const summary = await readSiteAdvisory(client);
    expect(summary.total).toBe(0);
    expect(summary.items).toEqual([]);
  });

  it("throws on RPC error so the caller can treat it as non-fatal", async () => {
    const client = fakeClient(() => ({ data: null, error: { message: "function does not exist" } }));
    await expect(readSiteAdvisory(client)).rejects.toThrow(/function does not exist/);
  });
});
