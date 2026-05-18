import { describe, it, expect } from "vitest";
import { coerceDate } from "../src/coerce-date.js";
import type { Locale } from "../src/types.js";
import { loadFixture, parseExpected } from "./_helpers.js";

describe("coerceDate (fixture-driven)", async () => {
  const cases = await loadFixture("dates-test-cases.csv");

  for (const row of cases) {
    const input = row["input"] ?? "";
    const localeRaw = row["locale"] ?? "";
    const expected = parseExpected(row["expected"] ?? "");
    const note = row["note"] ?? "";

    // The strict "ambiguous" cases pass an empty locale to force ambiguity
    // detection; treat that as an explicit-ambiguity test.
    const locale = (localeRaw || "en-AU") as Locale;
    const strict = localeRaw === "";

    const label = `[${input}] (${localeRaw || "no-locale"}) — ${note}`;

    it(label, () => {
      const result = coerceDate(input, { locale, strict });

      switch (expected.kind) {
        case "empty":
        case "null":
          // Empty input is an empty/null case — coercer returns
          // value_null_or_empty (treated as success-with-null in some pipelines).
          // We accept either an error of that code, or ok with empty value.
          if (result.ok) {
            expect(result.value === "" || result.value === null || result.value === undefined).toBe(true);
          } else {
            expect(result.error).toBe("value_null_or_empty");
          }
          break;
        case "error":
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBe(expected.code);
          }
          break;
        case "value":
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value).toBe(expected.value);
          }
          break;
      }
    });
  }
});
