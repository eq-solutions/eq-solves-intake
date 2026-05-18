import { describe, it, expect } from "vitest";
import { coercePhoneAU } from "../src/coerce-phone-au.js";
import { loadFixture, parseExpected } from "./_helpers.js";

describe("coercePhoneAU (fixture-driven)", async () => {
  const cases = await loadFixture("phones-test-cases.csv");

  for (const row of cases) {
    const input = row["input"] ?? "";
    const expected = parseExpected(row["expected"] ?? "");
    const note = row["note"] ?? "";
    const label = `[${JSON.stringify(input)}] — ${note}`;

    it(label, () => {
      const result = coercePhoneAU(input, { locale: "en-AU" });

      switch (expected.kind) {
        case "empty":
          // Empty phone → ok:true with empty value, or value_null_or_empty error
          if (result.ok) {
            expect(result.value === "" || result.value === null || result.value === undefined).toBe(true);
          } else {
            expect(result.error).toBe("value_null_or_empty");
          }
          break;
        case "error":
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toBe(expected.code);
          break;
        case "value":
          // The phone coercer preserves unparseable input verbatim with a note
          // (per spec: "phone_format_unrecognised_kept_raw"). Either way, the
          // expected output value should match.
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.value).toBe(expected.value);
          break;
      }
    });
  }
});
