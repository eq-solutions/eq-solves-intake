/**
 * adjudicateContactDuplicateWithAI — asks Claude (via the eq-ai-assist Edge
 * Function, action 'adjudicate_contact_duplicate') whether two contacts are
 * the same real person. Mirrors adjudicate-duplicate-ai.test.ts (Sites).
 */

import { describe, it, expect } from "vitest";
import { adjudicateContactDuplicateWithAI } from "../src/adjudicate-duplicate-contact-ai.js";
import type { EdgeFnCaller } from "../src/ai-client.js";

function fakeCaller(
  handler: (action: string, payload: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
): EdgeFnCaller {
  return async (action, payload) => handler(action, payload);
}

describe("adjudicateContactDuplicateWithAI", () => {
  it("calls the adjudicate_contact_duplicate action with both contacts", async () => {
    let seen: { action: string; payload: Record<string, unknown> } = { action: "", payload: {} };
    const call = fakeCaller((action, payload) => {
      seen = { action, payload };
      return { data: { verdict: "same", confidence: "high", reasoning: "Rob is a common nickname for Robert." }, error: null };
    });
    const res = await adjudicateContactDuplicateWithAI(
      { first_name: "Rob", last_name: "Smith", email: "rob@example.com" },
      { first_name: "Robert", last_name: "Smith", email: "rob@example.com" },
      call,
    );
    expect(seen.action).toBe("adjudicate_contact_duplicate");
    expect((seen.payload.contact_a as { first_name: string }).first_name).toBe("Rob");
    expect((seen.payload.contact_b as { first_name: string }).first_name).toBe("Robert");
    expect(res.verdict).toBe("same");
    expect(res.confidence).toBe("high");
    expect(res.reasoning).toMatch(/Rob/);
  });

  it("coerces an unexpected verdict/confidence to unsure/low", async () => {
    const call = fakeCaller(() => ({ data: { verdict: "maybe", confidence: "certain", reasoning: "  hmm  " }, error: null }));
    const res = await adjudicateContactDuplicateWithAI({ first_name: "A" }, { first_name: "B" }, call);
    expect(res.verdict).toBe("unsure");
    expect(res.confidence).toBe("low");
    expect(res.reasoning).toBe("hmm");
  });

  it("defaults a missing reason", async () => {
    const call = fakeCaller(() => ({ data: { verdict: "different", confidence: "medium" }, error: null }));
    const res = await adjudicateContactDuplicateWithAI({ first_name: "A" }, { first_name: "B" }, call);
    expect(res.verdict).toBe("different");
    expect(res.confidence).toBe("medium");
    expect(res.reasoning).toBe("No reason returned.");
  });

  it("returns unsure when the Edge Function returns no object", async () => {
    const call = fakeCaller(() => ({ data: null, error: null }));
    const res = await adjudicateContactDuplicateWithAI({ first_name: "A" }, { first_name: "B" }, call);
    expect(res.verdict).toBe("unsure");
    expect(res.reasoning).toBe("No reason returned.");
  });

  it("throws on Edge Function error so the caller can surface it inline", async () => {
    const call = fakeCaller(() => ({ data: null, error: { message: "ANTHROPIC_API_KEY secret not set on this project" } }));
    await expect(
      adjudicateContactDuplicateWithAI({ first_name: "A" }, { first_name: "B" }, call),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
