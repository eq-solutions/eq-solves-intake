/**
 * readContactAdvisory — surfaces what the write-time contact resolver
 * (eq-shell 0233) flagged, via the eq_contact_advisory_summary RPC. Mirrors
 * read-site-advisory.test.ts — same wrapper shape, same failure modes.
 */

import { describe, it, expect } from "vitest";
import { readContactAdvisory, adjudicateContactAdvisory } from "../src/read-contact-advisory.js";
import type { SupabaseLikeClient } from "../src/canonical/commit-canonical.js";

function fakeClient(
  handler: (name: string, params: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
): SupabaseLikeClient {
  return {
    rpc: async (name: string, params: Record<string, unknown>) => handler(name, params),
  } as unknown as SupabaseLikeClient;
}

const FULL_PAYLOAD = {
  total: 2,
  matches: 1,
  ambiguous: 1,
  pending: 1,
  decided: 1,
  recent_days: 7,
  recent_count: 1,
  items: [
    {
      id: "a1", at: "2026-08-02T12:00:00Z", outcome: "match", confidence: "high",
      score: 0.9, candidate_name: "Rowen Hansell", candidate_email: "rowen.hansell@se.com",
      matched_name: "Rowen Hansell", matched_active: true,
      verdict: "same", verdict_note: null, decided_at: "2026-08-02T13:00:00Z",
    },
  ],
};

describe("readContactAdvisory", () => {
  it("maps the RPC summary payload faithfully", async () => {
    const client = fakeClient((name) => {
      expect(name).toBe("eq_contact_advisory_summary");
      return { data: FULL_PAYLOAD, error: null };
    });
    const summary = await readContactAdvisory(client);
    expect(summary.total).toBe(2);
    expect(summary.matches).toBe(1);
    expect(summary.ambiguous).toBe(1);
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0].matched_name).toBe("Rowen Hansell");
    expect(summary.items[0].verdict).toBe("same");
  });

  it("passes the day/limit window to the RPC", async () => {
    let seen: Record<string, unknown> = {};
    const client = fakeClient((_name, params) => {
      seen = params;
      return { data: { ...FULL_PAYLOAD, items: [] }, error: null };
    });
    await readContactAdvisory(client, { days: 30, limit: 50 });
    expect(seen.p_days).toBe(30);
    expect(seen.p_limit).toBe(50);
  });

  it("defaults missing fields and a missing items array to empty", async () => {
    const client = fakeClient(() => ({ data: { total: 5 }, error: null }));
    const summary = await readContactAdvisory(client);
    expect(summary.total).toBe(5);
    expect(summary.matches).toBe(0);
    expect(summary.items).toEqual([]);
  });

  it("returns an empty summary when the RPC returns no object", async () => {
    const client = fakeClient(() => ({ data: null, error: null }));
    const summary = await readContactAdvisory(client);
    expect(summary.total).toBe(0);
    expect(summary.items).toEqual([]);
  });

  it("throws on RPC error so the caller can treat it as non-fatal", async () => {
    const client = fakeClient(() => ({ data: null, error: { message: "function does not exist" } }));
    await expect(readContactAdvisory(client)).rejects.toThrow(/function does not exist/);
  });
});

describe("adjudicateContactAdvisory", () => {
  it("calls the adjudicate RPC with the mapped params", async () => {
    let seen: { name: string; params: Record<string, unknown> } = { name: "", params: {} };
    const client = fakeClient((name, params) => {
      seen = { name, params };
      return {
        data: { ok: true, verdict_id: "v1", advisory_id: "a1", verdict: "same" },
        error: null,
      };
    });
    const res = await adjudicateContactAdvisory(client, { advisoryId: "a1", verdict: "same", note: "same person" });
    expect(seen.name).toBe("eq_contact_advisory_adjudicate");
    expect(seen.params.p_advisory_id).toBe("a1");
    expect(seen.params.p_verdict).toBe("same");
    expect(seen.params.p_note).toBe("same person");
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("same");
  });

  it("passes a null note when none is given", async () => {
    let seen: Record<string, unknown> = {};
    const client = fakeClient((_name, params) => {
      seen = params;
      return { data: { ok: true, verdict_id: "v2", advisory_id: "a2", verdict: "different" }, error: null };
    });
    await adjudicateContactAdvisory(client, { advisoryId: "a2", verdict: "different" });
    expect(seen.p_note).toBeNull();
  });

  it("falls back to the input when the RPC returns a bare object", async () => {
    const client = fakeClient(() => ({ data: {}, error: null }));
    const res = await adjudicateContactAdvisory(client, { advisoryId: "a3", verdict: "unsure" });
    expect(res.ok).toBe(true);
    expect(res.advisory_id).toBe("a3");
    expect(res.verdict).toBe("unsure");
  });

  it("throws on RPC error so the caller can surface it inline", async () => {
    const client = fakeClient(() => ({ data: null, error: { message: "advisory row not found for tenant" } }));
    await expect(
      adjudicateContactAdvisory(client, { advisoryId: "nope", verdict: "same" }),
    ).rejects.toThrow(/advisory row not found/);
  });
});
