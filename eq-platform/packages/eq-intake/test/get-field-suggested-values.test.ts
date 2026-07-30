import { describe, it, expect } from "vitest";
import { getFieldSuggestedValues } from "../src/tidy-pass.js";

describe("getFieldSuggestedValues", () => {
  it("returns staff.schema.json's x-eq-suggested-values for staff.trade", () => {
    const values = getFieldSuggestedValues("staff", "trade");
    expect(values).not.toBeNull();
    expect(values).toContain("electrical");
    expect(values).toContain("plumbing");
  });

  it("returns null for a field with no suggested-values extension", () => {
    expect(getFieldSuggestedValues("staff", "first_name")).toBeNull();
  });

  it("returns null for a field that doesn't exist on the entity's schema", () => {
    expect(getFieldSuggestedValues("staff", "not_a_real_field")).toBeNull();
  });
});
