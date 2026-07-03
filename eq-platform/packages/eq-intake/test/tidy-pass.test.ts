/**
 * Tidy pass — gap classification and messages must be plain English and
 * correctly typed, never a raw ValidationError.kind leaked to the UI.
 *
 * Regression: the gap-type check compared against 'required_field_missing',
 * but the validator's real kind is 'field_required' — so every required-field
 * gap was mis-badged "Invalid format" and, since field_required carries no
 * .message/.reason, rendered the raw kind string ("field_required") as the
 * issue text instead of a sentence.
 */

import { describe, it, expect } from "vitest";
import { runTidyPass } from "../src/tidy-pass.js";
import type { SupabaseLikeClient } from "../src/canonical/commit-canonical.js";

const TENANT = "7dee117c-98bd-4d39-af8c-2c81d02a1e85";

function fakeClient(staffRows: unknown[]): SupabaseLikeClient {
  return {
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name === "eq_tidy_read_entity" && params.p_table === "staff") {
        return { data: staffRows, error: null };
      }
      return { data: [], error: null };
    },
  } as unknown as SupabaseLikeClient;
}

describe("runTidyPass — required-field gaps", () => {
  it("classifies a missing required field as required_missing, not format_invalid", async () => {
    const client = fakeClient([
      {
        staff_id: "s-1",
        tenant_id: TENANT,
        first_name: "Tom",
        last_name: "Ivicevic",
        employment_type: null,
        active: true,
      },
    ]);

    const report = await runTidyPass({ supabase: client, tenantId: TENANT, entities: ["staff"] });
    const gap = report.gaps.find((g) => g.field === "employment_type");

    expect(gap).toBeDefined();
    expect(gap!.gap_type).toBe("required_missing");
  });

  it("never surfaces the raw ValidationError.kind as the message", async () => {
    const client = fakeClient([
      {
        staff_id: "s-1",
        tenant_id: TENANT,
        first_name: "Tom",
        last_name: "Ivicevic",
        employment_type: null,
        active: true,
      },
    ]);

    const report = await runTidyPass({ supabase: client, tenantId: TENANT, entities: ["staff"] });
    const gap = report.gaps.find((g) => g.field === "employment_type");

    expect(gap!.message).not.toBe("field_required");
    expect(gap!.message).toBe("Employment Type is required.");
  });

  it("gives an invalid enum value a readable message with the field name spelled out", async () => {
    const client = fakeClient([
      {
        staff_id: "s-1",
        tenant_id: TENANT,
        first_name: "Tom",
        last_name: "Ivicevic",
        employment_type: "Direct",
        active: true,
      },
    ]);

    const report = await runTidyPass({ supabase: client, tenantId: TENANT, entities: ["staff"] });
    const gap = report.gaps.find((g) => g.field === "employment_type");

    expect(gap).toBeDefined();
    expect(gap!.message).toContain("Direct");
    expect(gap!.message).not.toBe("field_enum_invalid");
  });
});
