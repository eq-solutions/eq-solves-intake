import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";

// ---------------------------------------------------------------------------
// parse-maximo-pdf-wo — real HTTP endpoint for the `maximo-pdf-wo` skill.
//
// Deployed to: sks-canonical (ehowgjardagevnrluult)
// Requires:    ANTHROPIC_API_KEY secret set on the project
//
// Why this exists as an edge function rather than an eq-service API route:
// eq-service deploys to Netlify, whose synchronous functions cap out at
// ~26s (site is on nf_team_pro). Vision extraction of one Maximo WO PDF
// takes 28-80s (see docs/MAXIMO-PDF-CUTOVER-PLAN.md in this repo, written
// 2026-05-21 after a live demo run hit this exact wall). Supabase Edge
// Functions have a much longer wall-clock budget, and this project already
// runs one Anthropic-calling function (eq-ai-assist) with the API key
// configured — so this follows that proven path instead of standing up a
// new Netlify site/background-function migration.
//
// Multi-file requests are parsed CONCURRENTLY (Promise.all) specifically to
// keep wall-clock down — 4 sequential 60s vision calls would flirt with any
// platform's function timeout; 4 concurrent ones cost ~one call's worth of
// wall-clock instead.
//
// This is a from-scratch HTTP-shaped port of the logic in
// eq-platform/packages/eq-intake/src/skills/maximo-pdf-wo/ (extract.ts,
// to-canonical.ts, group.ts) in THIS repo, plus the field-mapping helpers in
// eq-platform/packages/eq-validation/src/parse-{frequency-suffix,job-plan-code,
// site-prefix}.ts. It is not a direct import of that package — Deno edge
// functions can't resolve local pnpm workspace packages, only jsr:/npm:/http
// specifiers — so the pure-logic pieces are vendored inline below rather than
// wired through @eq/ai's AIProvider abstraction. The vision call itself is
// reimplemented directly against the Anthropic Messages API using tool-use
// to force structured JSON output (more reliable than the free-text-JSON
// parsing @eq/ai's extract() uses).
//
// Response shape matches eq-solves-service's own wire contract exactly
// (lib/import/maximo-pdf-client.ts's MaximoPdfWoResultSchema) — NOT the
// eq-intake package's internal MaintenanceCheckBundle/CheckAssetInsert
// shape, which is richer than eq-service currently consumes. Keeping the
// wire shape stable here means eq-service's client + mapping code (already
// merged, already tested) never needs to change when this endpoint swaps
// in for the dev mock — only the env var does.
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_MAX_TOKENS = 8192;

// ============================================================================
// WIRE TYPES (must match lib/import/maximo-pdf-client.ts in eq-solves-service)
// ============================================================================

interface WireCheckAsset {
  work_order_number: string;
  asset_external_id: string | null;
  asset_name: string | null;
  location: string | null;
  priority: string | null;
  work_type: string | null;
  crew_id: string | null;
  target_start: string | null;
  target_finish: string | null;
  failure_code: string | null;
  problem: string | null;
  cause: string | null;
  remedy: string | null;
  ir_scan_result: string | null;
  classification: string | null;
}

interface WireBundle {
  group_key: string;
  site_code: string;
  plan_code: string;
  plan_code_raw: string;
  frequency: string | null;
  start_date: string;
  check_assets: WireCheckAsset[];
}

interface WireWarning {
  code: string;
  message: string;
  bundle_group_key?: string | null;
  work_order_number?: string | null;
}

interface WireResult {
  bundles: WireBundle[];
  warnings: WireWarning[];
  sources: { fileName: string; workOrderCount: number }[];
}

// ============================================================================
// VENDORED PURE HELPERS
// (ported from eq-platform/packages/eq-validation/src/parse-*.ts and
//  eq-platform/packages/eq-intake/src/skills/maximo-pdf-wo/to-canonical.ts —
//  see file header. Kept 1:1 with those originals; if they drift, re-sync
//  by diffing this block against the source files.)
// ============================================================================

const FREQUENCY_SUFFIX_MAP: Readonly<Record<string, string>> = Object.freeze({
  A: "annual",
  Q: "quarterly",
  "3": "quarterly",
  M: "monthly",
  S: "semi_annual",
  "6": "semi_annual",
  W: "weekly",
  "2": "2yr",
  "5": "5yr",
  "10": "10yr",
});

function mapFrequencySuffix(suffix: string | null | undefined): string | null {
  const key = (suffix ?? "").trim().toUpperCase();
  if (key === "") return null;
  return FREQUENCY_SUFFIX_MAP[key] ?? null;
}

function splitJobPlanCode(raw: string | null | undefined): { code: string; suffix: string } {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { code: "", suffix: "" };
  const idx = trimmed.lastIndexOf("-");
  if (idx === -1) return { code: trimmed, suffix: "" };
  return { code: trimmed.slice(0, idx).trim(), suffix: trimmed.slice(idx + 1).trim() };
}

const SITE_PREFIX_RE = /^AU\d{2}-/;

function stripSitePrefix(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(SITE_PREFIX_RE, "");
}

interface JobPlanParts {
  prefix: string;
  canonicalCode: string;
  description: string | null;
}

function parseJobPlan(raw: string | null | undefined): JobPlanParts {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { prefix: "", canonicalCode: "", description: null };
  const sepIdx = trimmed.indexOf(" - ");
  if (sepIdx === -1) return { prefix: "", canonicalCode: trimmed, description: null };
  const prefix = trimmed.slice(0, sepIdx).trim();
  const remainder = trimmed.slice(sepIdx + 3).trim();
  if (!remainder) return { prefix, canonicalCode: "", description: null };
  const firstSpaceIdx = remainder.search(/\s/);
  if (firstSpaceIdx === -1) return { prefix, canonicalCode: remainder, description: null };
  return {
    prefix,
    canonicalCode: remainder.slice(0, firstSpaceIdx).trim(),
    description: remainder.slice(firstSpaceIdx + 1).trim() || null,
  };
}

function parseAssetCell(raw: string): { externalId: string | null; name: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { externalId: null, name: "" };
  const dashMatch = trimmed.match(/^([^\s—–-]+)\s*[—–-]\s*(.+)$/);
  if (dashMatch) {
    const lead = dashMatch[1]!.trim();
    const rest = dashMatch[2]!.trim();
    if (/^\d+$/.test(lead)) return { externalId: lead, name: rest };
  }
  return { externalId: null, name: trimmed };
}

const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function coerceMaximoDate(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  const monthMatch = trimmed.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})$/);
  if (monthMatch) {
    const day = parseInt(monthMatch[1]!, 10);
    const monthName = monthMatch[2]!.toLowerCase().slice(0, 3);
    const year = parseInt(monthMatch[3]!, 10);
    const monthIdx = MONTH_ABBR.indexOf(monthName);
    if (monthIdx !== -1) {
      return `${year.toString().padStart(4, "0")}-${(monthIdx + 1).toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1]!, 10);
    const month = parseInt(slashMatch[2]!, 10);
    const year = parseInt(slashMatch[3]!, 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].+)?$/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  return null;
}

function nullIfBlank(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

// ============================================================================
// RAW EXTRACTED RECORD (one per WO, as returned by the vision tool call)
// ============================================================================

interface RawWorkOrder {
  wo_number: string;
  site: string;
  asset: string;
  status?: string | null;
  location?: string | null;
  work_type?: string | null;
  priority?: string | number | null;
  job_plan: string;
  crew_id?: string | null;
  target_start?: string | null;
  target_finish?: string | null;
  classification?: string | null;
  failure_code?: string | null;
  problem?: string | null;
  cause?: string | null;
  remedy?: string | null;
  ir_scan_result?: string | null;
}

const EXTRACT_TOOL_SCHEMA = {
  name: "extract_work_orders",
  description:
    "Record every distinct IBM Maximo work order found in this PDF. Each PDF may contain 1-N stapled WOs; emit one array entry per WO.",
  input_schema: {
    type: "object",
    properties: {
      work_orders: {
        type: "array",
        items: {
          type: "object",
          required: ["wo_number", "site", "asset", "job_plan"],
          properties: {
            wo_number: { type: "string", description: "Maximo WO number from the top of the header table, e.g. '4501310'." },
            site: { type: "string", description: "Site code as printed, e.g. 'AU01-CA1'." },
            asset: {
              type: "string",
              description:
                "Asset row exactly as printed. Two known shapes: '1070 — CA1-TS-AC-29-ATS' (numeric Maximo ID + descriptive name) or 'CA1-PTP - CA1-Comprehensive Utility Failure Test (PTP)' (no leading ID).",
            },
            status: { type: ["string", "null"], description: "Maximo status code, e.g. 'INPRG', 'WAPPROV', 'COMP'." },
            location: { type: ["string", "null"], description: "Sub-location within site." },
            work_type: { type: ["string", "null"], description: "Maximo work type: 'PM', 'CM', 'EM', 'CAL', 'INSP'." },
            priority: { type: ["string", "number", "null"], description: "Maximo priority, usually 1-4." },
            job_plan: { type: "string", description: "Job plan as printed, e.g. 'ATS-3 - E1.8 ATS-Automatic Transfer Switches'." },
            crew_id: { type: ["string", "null"] },
            target_start: { type: ["string", "null"], description: "Target start date as printed, e.g. '20-May-2026'." },
            target_finish: { type: ["string", "null"], description: "Target finish date as printed." },
            classification: { type: ["string", "null"] },
            failure_code: { type: ["string", "null"] },
            problem: { type: ["string", "null"] },
            cause: { type: ["string", "null"] },
            remedy: { type: ["string", "null"] },
            ir_scan_result: { type: ["string", "null"], description: "IR scan tick-box result — usually blank when scheduling." },
          },
        },
      },
    },
    required: ["work_orders"],
  },
};

// ============================================================================
// ANTHROPIC VISION CALL
// ============================================================================

async function extractWorkOrdersFromPdf(
  apiKey: string,
  fileBytes: Uint8Array,
  fileName: string,
): Promise<{ records: RawWorkOrder[]; warning?: string }> {
  const base64 = encodeBase64(fileBytes);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            {
              type: "text",
              text:
                "This is an IBM Maximo work order PDF export. Extract every WO header table found in the document using the extract_work_orders tool.",
            },
          ],
        },
      ],
      tools: [EXTRACT_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: "extract_work_orders" },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API error ${resp.status} for '${fileName}': ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { content: Array<{ type: string; input?: unknown }> };
  const toolUse = data.content.find((b) => b.type === "tool_use");
  if (!toolUse || !toolUse.input || typeof toolUse.input !== "object") {
    return { records: [], warning: `No work orders extracted from '${fileName}' — vision call returned no tool result.` };
  }

  const workOrders = (toolUse.input as Record<string, unknown>)["work_orders"];
  if (!Array.isArray(workOrders)) {
    return { records: [], warning: `'${fileName}' — extract tool result had no work_orders array.` };
  }

  return { records: workOrders as RawWorkOrder[] };
}

// ============================================================================
// MAPPING: raw WO -> wire check_asset + the group it belongs to
// ============================================================================

interface MappedRow {
  groupKey: string;
  siteCode: string;
  planCode: string;
  planCodeRaw: string;
  frequency: string | null;
  groupStartDate: string | null;
  checkAsset: WireCheckAsset;
  warnings: WireWarning[];
}

function mapWorkOrder(raw: RawWorkOrder, fileName: string): MappedRow {
  const warnings: WireWarning[] = [];
  const wo = String(raw.wo_number ?? "").trim();

  const siteCodeRaw = (raw.site ?? "").trim();
  const siteCode = stripSitePrefix(siteCodeRaw);
  if (!siteCode) {
    warnings.push({ code: "missing_field", message: `WO ${wo}: site code missing or unrecognised ('${siteCodeRaw}').`, work_order_number: wo });
  }

  const planParts = parseJobPlan(raw.job_plan);
  if (!planParts.canonicalCode) {
    warnings.push({ code: "missing_field", message: `WO ${wo}: could not parse job plan ('${raw.job_plan}').`, work_order_number: wo });
  }

  const { suffix: prefixSuffix } = splitJobPlanCode(planParts.prefix);
  const frequency = mapFrequencySuffix(prefixSuffix);
  if (!frequency && prefixSuffix !== "") {
    warnings.push({
      code: "unknown_frequency_suffix",
      message: `WO ${wo}: unknown frequency suffix '${prefixSuffix}' on plan prefix '${planParts.prefix}'.`,
      work_order_number: wo,
    });
  }

  const targetStartIso = coerceMaximoDate(raw.target_start);
  const targetFinishIso = coerceMaximoDate(raw.target_finish);
  if (raw.target_start && !targetStartIso) {
    warnings.push({ code: "invalid_date", message: `WO ${wo}: target_start '${raw.target_start}' is not a recognised date.`, work_order_number: wo });
  }

  const { externalId, name } = parseAssetCell(raw.asset);

  const checkAsset: WireCheckAsset = {
    work_order_number: wo,
    asset_external_id: externalId,
    asset_name: nullIfBlank(name),
    location: nullIfBlank(raw.location),
    priority: raw.priority === null || raw.priority === undefined ? null : String(raw.priority).trim(),
    work_type: nullIfBlank(raw.work_type),
    crew_id: nullIfBlank(raw.crew_id),
    target_start: targetStartIso,
    target_finish: targetFinishIso,
    failure_code: nullIfBlank(raw.failure_code),
    problem: nullIfBlank(raw.problem),
    cause: nullIfBlank(raw.cause),
    remedy: nullIfBlank(raw.remedy),
    ir_scan_result: nullIfBlank(raw.ir_scan_result),
    classification: nullIfBlank(raw.classification),
  };

  // Group on (site, plan, frequency, target_start date) — matches the Delta
  // xlsx importer's groupKey (lib/import/delta-wo-parser.ts::groupKey) so
  // both intake paths collapse identically-dated same-site-same-plan rows
  // into one maintenance_check.
  const groupStartDate = targetStartIso;
  const groupKey = [siteCode, planParts.canonicalCode, frequency ?? "", groupStartDate ?? ""].join("|");

  return {
    groupKey,
    siteCode,
    planCode: planParts.canonicalCode,
    planCodeRaw: planParts.prefix,
    frequency,
    groupStartDate,
    checkAsset,
    warnings,
  };
}

function groupMappedRows(rows: MappedRow[]): WireBundle[] {
  const byKey = new Map<string, WireBundle>();
  const sorted = [...rows].sort((a, b) => {
    if (a.groupKey !== b.groupKey) return a.groupKey.localeCompare(b.groupKey);
    return a.checkAsset.work_order_number.localeCompare(b.checkAsset.work_order_number);
  });

  for (const row of sorted) {
    let bundle = byKey.get(row.groupKey);
    if (!bundle) {
      bundle = {
        group_key: row.groupKey,
        site_code: row.siteCode,
        plan_code: row.planCode,
        plan_code_raw: row.planCodeRaw,
        frequency: row.frequency,
        // Fallback when no WO in the group had a parseable target_start —
        // today's date, so the UI never renders "Invalid Date". The missing
        // date is still surfaced via the warnings array above.
        start_date: row.groupStartDate ?? new Date().toISOString().slice(0, 10),
        check_assets: [],
      };
      byKey.set(row.groupKey, bundle);
    }
    bundle.check_assets.push(row.checkAsset);
  }

  const out = Array.from(byKey.values());
  out.sort((a, b) => [a.site_code, a.plan_code, a.start_date].join("|").localeCompare([b.site_code, b.plan_code, b.start_date].join("|")));
  return out;
}

// ============================================================================
// ENTRY POINT
// ============================================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY secret not set on this project" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response(
      JSON.stringify({ error: "Expected multipart/form-data with one or more 'files' entries" }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return new Response(
      JSON.stringify({ error: "No files uploaded — expected multipart 'files' field(s)" }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  try {
    const allRows: MappedRow[] = [];
    const warnings: WireWarning[] = [];
    const sources: { fileName: string; workOrderCount: number }[] = [];

    // Concurrent, not sequential — see file header. Wall-clock ≈ the
    // slowest single file's vision call, not the sum of all of them.
    const perFile = await Promise.all(
      files.map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { records, warning } = await extractWorkOrdersFromPdf(apiKey, bytes, file.name);
        return { fileName: file.name, records, warning };
      }),
    );

    for (const result of perFile) {
      sources.push({ fileName: result.fileName, workOrderCount: result.records.length });
      if (result.warning) {
        warnings.push({ code: "no_records_extracted", message: result.warning });
      }
      for (const raw of result.records) {
        const mapped = mapWorkOrder(raw, result.fileName);
        allRows.push(mapped);
        warnings.push(...mapped.warnings);
      }
    }

    const bundles = groupMappedRows(allRows);

    const body: WireResult = { bundles, warnings, sources };
    return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
