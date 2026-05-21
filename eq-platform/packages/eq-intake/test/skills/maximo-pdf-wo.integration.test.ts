/**
 * `maximo-pdf-wo` — REAL Claude vision integration test.
 *
 * Runs only when ANTHROPIC_API_KEY is set. Loaded via
 *   pnpm --filter @eq/intake test:integration
 * (added to the package.json scripts alongside this file) which uses Node's
 * --env-file flag to populate process.env from eq-platform/.env.
 *
 * Calls the REAL Anthropic vision API against the 4 Equinix fixture PDFs.
 * Estimated cost: ~$0.05-0.30 per full run (Sonnet 4.5 on 4 PDFs, mostly
 * single-page scans + 1 small clean print). Safe to run during development;
 * not part of the default `pnpm test` flow.
 *
 * What it asserts:
 *   - All 4 PDFs round-trip through real vision without throwing.
 *   - Total WOs extracted == 7 (the known correct count for the fixture).
 *   - Every WO# from the README table appears exactly once.
 *   - Bundles collapse to 2 maintenance_checks (6 ATS + 1 CUFT).
 *
 * What it PRINTS (in addition to assertions) — for the live-fire demo:
 *   - tokens_in / tokens_out / latency per PDF
 *   - estimated cost per PDF (using public Sonnet 4.5 pricing as of 2026-05)
 *   - bundle summary
 *
 * Use this output to size the demo-day cost story and spot prompt regressions.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "@eq/ai";
import { parseMaximoPdfWo } from "../../src/skills/maximo-pdf-wo/index.js";

const __dirname = (() => {
  try {
    return fileURLToPath(new URL(".", import.meta.url));
  } catch {
    return process.cwd();
  }
})();

const FIXTURE_DIR = resolve(
  __dirname,
  "../../../eq-validation/test/fixtures/equinix-maximo-pdf-wo-2026-05-19",
);

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const HAS_FIXTURE =
  existsSync(FIXTURE_DIR) &&
  existsSync(resolve(FIXTURE_DIR, "CUFT Work Order.pdf"));

// Public Sonnet 4.5 pricing snapshot (USD per 1M tokens) — update if Anthropic
// changes pricing. Only used to print a friendly cost estimate; the assertion
// suite doesn't depend on it.
const SONNET_45_USD_PER_1M_IN = 3.0;
const SONNET_45_USD_PER_1M_OUT = 15.0;

function loadFixture(name: string): { bytes: Uint8Array; fileName: string } {
  const bytes = readFileSync(resolve(FIXTURE_DIR, name));
  return { bytes: new Uint8Array(bytes), fileName: name };
}

const EXPECTED_WO_NUMBERS = [
  "4398474",
  "4406648",
  "4406759",
  "4408095",
  "4408213",
  "4409209",
  "4501310",
];

describe.skipIf(!HAS_KEY || !HAS_FIXTURE)(
  "maximo-pdf-wo — REAL Claude vision",
  () => {
    it("extracts all 7 WOs from the 4 fixture PDFs end-to-end", async () => {
      const ai = new AnthropicProvider({});

      const files = [
        loadFixture("20260519090849405.pdf"),
        loadFixture("20260519090925883.pdf"),
        loadFixture("20260519091018936.pdf"),
        loadFixture("CUFT Work Order.pdf"),
      ];

      const t0 = Date.now();
      const result = await parseMaximoPdfWo({ files, ai });
      const totalMs = Date.now() - t0;

      // Pretty-print the bundles before assertions so failures don't hide useful info.
      console.log("\n[real-vision] sources:");
      for (const s of result.sources) {
        console.log(
          `  ${s.file_name} → ${s.records_emitted} record(s) via ${s.extracted_via}`,
        );
      }
      console.log("\n[real-vision] bundles:");
      for (const b of result.bundles) {
        console.log(
          `  ${b.group_key}: ${b.check_assets.length} asset(s) — ${b.check_assets
            .map((a) => a.work_order_number)
            .join(", ")}`,
        );
      }
      if (result.warnings.length) {
        console.log("\n[real-vision] warnings:");
        for (const w of result.warnings) console.log(`  [${w.code}] ${w.message}`);
      }
      console.log(`\n[real-vision] total latency: ${totalMs}ms`);

      // Hard assertions.
      const allWos = result.bundles
        .flatMap((b) => b.check_assets.map((a) => a.work_order_number))
        .sort();
      expect(allWos).toEqual(EXPECTED_WO_NUMBERS);
      expect(result.bundles).toHaveLength(2);

      // Soft check: warn if any vision_low_confidence flags fired.
      const lowConf = result.warnings.filter(
        (w) => w.code === "vision_low_confidence",
      );
      if (lowConf.length) {
        console.log(
          `[real-vision] ${lowConf.length} low-confidence field(s) — review before demo`,
        );
      }
    }, 120_000);
  },
);

// ----------------------------------------------------------------------------
// Skip-explainer: surfaces a single passing test that prints why we skipped.
// Keeps the test report honest in default `pnpm test` runs.
// ----------------------------------------------------------------------------
if (!HAS_KEY || !HAS_FIXTURE) {
  describe("maximo-pdf-wo integration tests — skipped", () => {
    it("explains why", () => {
      const reasons: string[] = [];
      if (!HAS_KEY)
        reasons.push("ANTHROPIC_API_KEY not set (load eq-platform/.env)");
      if (!HAS_FIXTURE)
        reasons.push(
          "Fixture missing at " +
            FIXTURE_DIR +
            " — waiting on parallel fixture branch",
        );
      console.log("Skipped: " + reasons.join("; "));
      expect(reasons.length).toBeGreaterThan(0);
    });
  });
}
