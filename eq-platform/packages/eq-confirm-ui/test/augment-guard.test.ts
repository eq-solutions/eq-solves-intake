/**
 * Regression — augment() must NOT silently swallow a missing @eq/intake export.
 *
 * Before issue #47, store.ts caught every error from the enrichment/dedup pass
 * and logged "continuing without suggestions", so a stale @eq/intake build
 * (where `detectDuplicates` etc. arrive as `undefined`) degraded silently — the
 * exact failure mode that masked the smart-asset-import bug. The dependency
 * guard now throws a clear TypeError, and validate() rethrows it.
 */

import { describe, it, expect, vi } from "vitest";

// Simulate a stale/mismatched @eq/intake build: one export missing.
vi.mock("@eq/intake", async (importActual) => {
  const actual = await importActual<typeof import("@eq/intake")>();
  return { ...actual, detectDuplicates: undefined };
});

import { createConfirmFlow } from "../src/index.js";
import type { AIProvider, MapInput, MapResult } from "@eq/ai";
import { ASSET_SCHEMA } from "./fixtures/asset-schema.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function identityAi(): AIProvider {
  return {
    async map(input: MapInput): Promise<MapResult> {
      return {
        mappings: input.sourceColumns.map((c) => ({
          sourceColumn: c,
          canonicalField: c,
          confidence: 1,
          reason: "identity",
        })),
        unmappedRequiredFields: [],
        warnings: [],
        suggestions: [],
        needsClarification: [],
        metrics: {
          provider: "mock", model: "mock", tokensIn: 0, tokensOut: 0,
          latencyMs: 0, success: true, retried: false,
          startedAt: new Date().toISOString(),
        },
      };
    },
    async extract() {
      throw new Error("not used");
    },
  };
}

describe("augment() dependency guard — issue #47", () => {
  it("surfaces a missing @eq/intake export instead of degrading silently", async () => {
    const flow = createConfirmFlow();
    flow.driver.configure({
      schema: ASSET_SCHEMA,
      tenantId: TENANT,
      ai: identityAi(),
      enableEnrichment: false,
      commit: async (rows) => ({ committed: rows.length, failed: 0 }),
    });

    const csv = "name,serial_number\nBoard A,SN-1\n";
    await flow.driver.runToConfirmMapping({
      name: "assets.csv",
      bytes: new TextEncoder().encode(csv),
    });

    await expect(flow.driver.validate()).rejects.toThrow(
      /detectDuplicates is not a function/,
    );
    expect(flow.useStore.getState().status.kind).toBe("error");
  });
});
