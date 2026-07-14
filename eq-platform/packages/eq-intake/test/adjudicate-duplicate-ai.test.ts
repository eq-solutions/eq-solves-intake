/**
 * adjudicateDuplicateWithAI — asks Claude (via the eq-ai-assist Edge Function,
 * action 'adjudicate_duplicate') whether two sites are the same real-world place.
 * The wrapper must call the right action, coerce the answer to the strict
 * vocabulary, and throw on an Edge Function error so the caller can degrade.
 */

import { describe, it, expect } from "vitest";
import { adjudicateDuplicateWithAI } from "../src/adjudicate-duplicate-ai.js";
import type { EdgeFnCaller } from "../src/ai-client.js";

function fakeCaller(
  handler: (action: string, payload: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
): EdgeFnCaller {
  return async (action, payload) => handler(action, payload);
}

describe("adjudicateDuplicateWithAI", () => {
  it("calls the adjudicate_duplicate action with both sites", async () => {
    let seen: { action: string; payload: Record<string, unknown> } = { action: "", payload: {} };
    const call = fakeCaller((action, payload) => {
      seen = { action, payload };
      return { data: { verdict: "same", confidence: "high", reasoning: "SVHN is St Vincent's Health Network." }, error: null };
    });
    const res = await adjudicateDuplicateWithAI(
      { name: "SVHN Emergency", code: "SVH" },
      { name: "St Vincent's Health Network", code: "SVH" },
      call,
    );
    expect(seen.action).toBe("adjudicate_duplicate");
    expect((seen.payload.site_a as { name: string }).name).toBe("SVHN Emergency");
    expect((seen.payload.site_b as { name: string }).name).toBe("St Vincent's Health Network");
    expect(res.verdict).toBe("same");
    expect(res.confidence).toBe("high");
    expect(res.reasoning).toMatch(/St Vincent/);
  });

  it("coerces an unexpected verdict/confidence to unsure/low", async () => {
    const call = fakeCaller(() => ({ data: { verdict: "maybe", confidence: "certain", reasoning: "  hmm  " }, error: null }));
    const res = await adjudicateDuplicateWithAI({ name: "A" }, { name: "B" }, call);
    expect(res.verdict).toBe("unsure");
    expect(res.confidence).toBe("low");
    expect(res.reasoning).toBe("hmm");
  });

  it("defaults a missing reason", async () => {
    const call = fakeCaller(() => ({ data: { verdict: "different", confidence: "medium" }, error: null }));
    const res = await adjudicateDuplicateWithAI({ name: "A" }, { name: "B" }, call);
    expect(res.verdict).toBe("different");
    expect(res.confidence).toBe("medium");
    expect(res.reasoning).toBe("No reason returned.");
  });

  it("returns unsure when the Edge Function returns no object", async () => {
    const call = fakeCaller(() => ({ data: null, error: null }));
    const res = await adjudicateDuplicateWithAI({ name: "A" }, { name: "B" }, call);
    expect(res.verdict).toBe("unsure");
    expect(res.reasoning).toBe("No reason returned.");
  });

  it("throws on Edge Function error so the caller can surface it inline", async () => {
    const call = fakeCaller(() => ({ data: null, error: { message: "ANTHROPIC_API_KEY secret not set on this project" } }));
    await expect(
      adjudicateDuplicateWithAI({ name: "A" }, { name: "B" }, call),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
