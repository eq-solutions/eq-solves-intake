#!/usr/bin/env node
/**
 * round-trip-acb.mjs — ACB test round-trip prototype.
 *
 * The full canonical migration loop is:
 *
 *     eq-solves-service DB
 *           │
 *           │  GET /api/admin/export?entity=acb_test   (PR #176)
 *           ▼
 *     canonical JSON
 *           │
 *           │  ajv validate against schemas/acb_test.schema.json
 *           │  + child rows against acb_visual_check_item /
 *           │    acb_electrical_reading schemas
 *           ▼
 *     pipeline-ready records
 *           │
 *           │  (eq-validation hooks here in a later iteration —
 *           │   FK resolution, cross-field rules, signature hash)
 *           ▼
 *     ready to re-emit / migrate / archive
 *
 * This script runs that loop end-to-end. Two modes:
 *
 *   --fixture           Read samples/acb_test-clean.json (shipped with
 *                       eq-intake). Always works offline; this is what we
 *                       run in CI / overnight loops.
 *   --url <endpoint>    Hit the deployed /api/admin/export?entity=acb_test
 *                       endpoint. Reads the bearer token from
 *                       $EQ_SERVICE_TOKEN. Use against a dev tenant.
 *
 * Usage examples:
 *   node scripts/round-trip-acb.mjs --fixture
 *   EQ_SERVICE_TOKEN=eyJ... node scripts/round-trip-acb.mjs \
 *     --url https://eq-solves-service.netlify.app/api/admin/export
 *
 * Exit codes:
 *   0   round-trip succeeded — every row + child validated against schema
 *   1   validation failed on at least one row
 *   2   harness error (bad args, network failure, missing schema)
 */

import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const SCHEMAS_DIR = join(REPO_ROOT, "schemas");
const SAMPLES_DIR = join(REPO_ROOT, "samples");
const EQ_PLATFORM = join(REPO_ROOT, "eq-platform");

// Resolve ajv from the eq-platform monorepo so we don't need a top-level install.
const requireFromPlatform = createRequire(
  pathToFileURL(join(EQ_PLATFORM, "package.json")).href,
);
const Ajv2020 = requireFromPlatform("ajv/dist/2020.js").default;
const addFormats = requireFromPlatform("ajv-formats").default;

// ── Arg parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { mode: null, url: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") out.mode = "fixture";
    else if (a === "--url") {
      out.mode = "live";
      out.url = argv[++i];
    } else if (a === "--help" || a === "-h") {
      out.mode = "help";
    } else {
      console.error(`Unknown arg: ${a}`);
      out.mode = "help";
    }
  }
  return out;
}

function printHelp() {
  console.log(`
ACB round-trip prototype.

  node scripts/round-trip-acb.mjs --fixture
  node scripts/round-trip-acb.mjs --url <endpoint>

Modes:
  --fixture     Read samples/acb_test-clean.json (offline). What CI runs.
  --url <url>   Hit a deployed /api/admin/export. Reads bearer from
                $EQ_SERVICE_TOKEN.
`);
}

// ── Load schemas ────────────────────────────────────────────────────

async function loadSchema(entity) {
  const raw = await readFile(join(SCHEMAS_DIR, `${entity}.schema.json`), "utf8");
  return JSON.parse(raw);
}

async function buildAcbValidators() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);

  const parentSchema = await loadSchema("acb_test");
  const visualSchema = await loadSchema("acb_visual_check_item");
  const electricalSchema = await loadSchema("acb_electrical_reading");

  return {
    validateParent: ajv.compile(parentSchema),
    validateVisual: ajv.compile(visualSchema),
    validateElectrical: ajv.compile(electricalSchema),
  };
}

// ── Source loaders ──────────────────────────────────────────────────

/**
 * Load the canonical ACB payload from the local sample. Returns the same
 * shape /api/admin/export?entity=acb_test would: a single envelope with
 * { tenant_id, exported_at, entity, schema_id, count, rows }.
 */
async function loadFromFixture() {
  const raw = await readFile(join(SAMPLES_DIR, "acb_test-clean.json"), "utf8");
  const one = JSON.parse(raw);
  return {
    tenant_id: one.tenant_id,
    exported_at: new Date().toISOString(),
    entity: "acb_test",
    schema_id: "https://schemas.eq.solutions/service/acb-test/v1.json",
    schema_version: "1.0.0",
    count: 1,
    rows: [one],
  };
}

/**
 * Hit the deployed /admin/export endpoint. Requires $EQ_SERVICE_TOKEN to
 * be set; the API uses Supabase-auth bearer tokens.
 */
async function loadFromUrl(baseUrl) {
  const token = process.env.EQ_SERVICE_TOKEN;
  if (!token) {
    throw new Error(
      "$EQ_SERVICE_TOKEN not set — needed for live mode. Get a token from a Supabase auth session.",
    );
  }
  const url = new URL(baseUrl);
  url.searchParams.set("entity", "acb_test");
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
  }
  const envelope = await res.json();
  // The API wraps results in `{ data, error }`. Single-entity short-circuit
  // (see app/api/admin/export/route.ts) returns the export body directly
  // inside `.data`.
  if (envelope.error) throw new Error(`API error: ${envelope.error}`);
  return envelope.data;
}

// ── Validation pass ─────────────────────────────────────────────────

/**
 * Validate the canonical ACB payload. Returns a structured report; does
 * NOT throw on validation failure — caller decides exit code from the
 * counts.
 */
function validate(payload, validators) {
  const { validateParent, validateVisual, validateElectrical } = validators;
  const report = {
    parentRowsOk: 0,
    parentRowsFailed: 0,
    visualItemsOk: 0,
    visualItemsFailed: 0,
    electricalReadingsOk: 0,
    electricalReadingsFailed: 0,
    overallResultBreakdown: { Pass: 0, Fail: 0, Defect: 0, Pending: 0 },
    failures: [],
  };

  for (let i = 0; i < payload.rows.length; i++) {
    const row = payload.rows[i];

    const visualItems = Array.isArray(row.visual_check_items)
      ? row.visual_check_items
      : [];
    const electricalReadings = Array.isArray(row.electrical_readings)
      ? row.electrical_readings
      : [];

    // Validate parent shape with children stripped — the schema doesn't
    // declare the child arrays, and ajv with default `additionalProperties`
    // would accept them, but stripping makes the failure message clearer
    // when something else trips.
    const parentOnly = { ...row };
    delete parentOnly.visual_check_items;
    delete parentOnly.electrical_readings;

    const parentOk = validateParent(parentOnly);
    if (parentOk) {
      report.parentRowsOk++;
    } else {
      report.parentRowsFailed++;
      report.failures.push({
        kind: "parent",
        rowIndex: i,
        acb_test_id: row.acb_test_id,
        errors: validateParent.errors,
      });
    }

    if (row.overall_result in report.overallResultBreakdown) {
      report.overallResultBreakdown[row.overall_result]++;
    }

    for (let j = 0; j < visualItems.length; j++) {
      const okV = validateVisual(visualItems[j]);
      if (okV) report.visualItemsOk++;
      else {
        report.visualItemsFailed++;
        report.failures.push({
          kind: "visual",
          rowIndex: i,
          childIndex: j,
          parent_id: row.acb_test_id,
          errors: validateVisual.errors,
        });
      }
    }

    for (let j = 0; j < electricalReadings.length; j++) {
      const okE = validateElectrical(electricalReadings[j]);
      if (okE) report.electricalReadingsOk++;
      else {
        report.electricalReadingsFailed++;
        report.failures.push({
          kind: "electrical",
          rowIndex: i,
          childIndex: j,
          parent_id: row.acb_test_id,
          errors: validateElectrical.errors,
        });
      }
    }
  }

  return report;
}

function fmtNum(n) {
  return n.toString().padStart(4, " ");
}

function printReport(payload, report) {
  console.log("─".repeat(64));
  console.log("ACB round-trip — validation report");
  console.log("─".repeat(64));
  console.log(`Source:           ${payload.entity} (schema ${payload.schema_id})`);
  console.log(`Tenant:           ${payload.tenant_id ?? "(unknown)"}`);
  console.log(`Exported at:      ${payload.exported_at}`);
  console.log(`Parent rows:      ${payload.count} (declared) / ${payload.rows.length} (actual)`);
  console.log("");
  console.log("Schema validation:");
  console.log(
    `  acb_test parents:                ${fmtNum(report.parentRowsOk)} ok, ${fmtNum(report.parentRowsFailed)} failed`,
  );
  console.log(
    `  acb_visual_check_item children:  ${fmtNum(report.visualItemsOk)} ok, ${fmtNum(report.visualItemsFailed)} failed`,
  );
  console.log(
    `  acb_electrical_reading children: ${fmtNum(report.electricalReadingsOk)} ok, ${fmtNum(report.electricalReadingsFailed)} failed`,
  );
  console.log("");
  console.log("Overall result breakdown (Maximo-style):");
  for (const [k, v] of Object.entries(report.overallResultBreakdown)) {
    console.log(`  ${k.padEnd(10)} ${fmtNum(v)}`);
  }

  if (report.failures.length > 0) {
    console.log("");
    console.log("Failures (first 10):");
    for (const f of report.failures.slice(0, 10)) {
      console.log(
        `  [${f.kind}] row=${f.rowIndex}${f.childIndex !== undefined ? ` child=${f.childIndex}` : ""} parent=${f.acb_test_id ?? f.parent_id}`,
      );
      for (const e of f.errors ?? []) {
        console.log(`     ${e.instancePath || "(root)"} → ${e.message}`);
      }
    }
  }
  console.log("─".repeat(64));
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.mode === "help" || args.mode === null) {
    printHelp();
    process.exit(args.mode === null ? 2 : 0);
  }

  let payload;
  try {
    if (args.mode === "fixture") {
      console.log("[round-trip-acb] mode: fixture (samples/acb_test-clean.json)");
      payload = await loadFromFixture();
    } else {
      console.log(`[round-trip-acb] mode: live (${args.url})`);
      payload = await loadFromUrl(args.url);
    }
  } catch (e) {
    console.error(`[round-trip-acb] load failed: ${e.message}`);
    process.exit(2);
  }

  let validators;
  try {
    validators = await buildAcbValidators();
  } catch (e) {
    console.error(`[round-trip-acb] schema load failed: ${e.message}`);
    process.exit(2);
  }

  const report = validate(payload, validators);
  printReport(payload, report);

  const anyFailed =
    report.parentRowsFailed > 0 ||
    report.visualItemsFailed > 0 ||
    report.electricalReadingsFailed > 0;

  process.exit(anyFailed ? 1 : 0);
}

main().catch((e) => {
  console.error("[round-trip-acb] unhandled error:", e);
  process.exit(2);
});
