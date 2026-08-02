/**
 * adjudicateQueueDuplicateWithAI — asks Claude (via the eq-ai-assist Edge
 * Function, action 'adjudicate_queue_duplicate') to sanity-check a Review
 * Queue duplicate flag before a human archives it. Unlike
 * adjudicateDuplicateWithAI (Sites), there's no second structured record —
 * just the flagged record's own fields plus the detector's reason text. The
 * wrapper must call the right action with that shape, coerce the answer to
 * the archive/keep/unsure vocabulary, and throw on an Edge Function error so
 * the caller can degrade.
 */

import { describe, it, expect } from "vitest";
import { adjudicateQueueDuplicateWithAI } from "../src/adjudicate-queue-duplicate-ai.js";
import type { EdgeFnCaller } from "../src/ai-client.js";

function fakeCaller(
  handler: (action: string, payload: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
): EdgeFnCaller {
  return async (action, payload) => handler(action, payload);
}

describe("adjudicateQueueDuplicateWithAI", () => {
  it("calls the adjudicate_queue_duplicate action with the record and reason", async () => {
    let seen: { action: string; payload: Record<string, unknown> } = { action: "", payload: {} };
    const call = fakeCaller((action, payload) => {
      seen = { action, payload };
      return { data: { verdict: "archive", confidence: "high", reasoning: "Same phone and email as the active record." }, error: null };
    });
    const res = await adjudicateQueueDuplicateWithAI(
      { first_name: "David", last_name: "Collings", email: "d.collings@example.com" },
      { reason: "Probable duplicate of linked contact 242776e4 (David Collins) - identical email.", currentValue: "unlinked inactive duplicate" },
      call,
    );
    expect(seen.action).toBe("adjudicate_queue_duplicate");
    expect((seen.payload.record as { first_name: string }).first_name).toBe("David");
    expect(seen.payload.reason).toMatch(/David Collins/);
    expect(seen.payload.current_value).toBe("unlinked inactive duplicate");
    expect(res.verdict).toBe("archive");
    expect(res.confidence).toBe("high");
  });

  it("passes null current_value when none was given", async () => {
    let seen: Record<string, unknown> = {};
    const call = fakeCaller((_action, payload) => {
      seen = payload;
      return { data: { verdict: "keep", confidence: "medium", reasoning: "Different customer, shared office line only." }, error: null };
    });
    await adjudicateQueueDuplicateWithAI({ first_name: "A" }, { reason: "same phone" }, call);
    expect(seen.current_value).toBeNull();
  });

  it("coerces an unexpected verdict/confidence to unsure/low", async () => {
    const call = fakeCaller(() => ({ data: { verdict: "maybe", confidence: "certain", reasoning: "  hmm  " }, error: null }));
    const res = await adjudicateQueueDuplicateWithAI({ first_name: "A" }, { reason: "r" }, call);
    expect(res.verdict).toBe("unsure");
    expect(res.confidence).toBe("low");
    expect(res.reasoning).toBe("hmm");
  });

  it("defaults a missing reasoning", async () => {
    const call = fakeCaller(() => ({ data: { verdict: "archive", confidence: "medium" }, error: null }));
    const res = await adjudicateQueueDuplicateWithAI({ first_name: "A" }, { reason: "r" }, call);
    expect(res.verdict).toBe("archive");
    expect(res.reasoning).toBe("No reason returned.");
  });

  it("returns unsure when the Edge Function returns no object", async () => {
    const call = fakeCaller(() => ({ data: null, error: null }));
    const res = await adjudicateQueueDuplicateWithAI({ first_name: "A" }, { reason: "r" }, call);
    expect(res.verdict).toBe("unsure");
    expect(res.reasoning).toBe("No reason returned.");
  });

  it("throws on Edge Function error so the caller can surface it inline", async () => {
    const call = fakeCaller(() => ({ data: null, error: { message: "ANTHROPIC_API_KEY secret not set on this project" } }));
    await expect(
      adjudicateQueueDuplicateWithAI({ first_name: "A" }, { reason: "r" }, call),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
