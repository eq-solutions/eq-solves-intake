import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";

// ---------------------------------------------------------------------------
// parse-rcd-switchboard-schedule — HTTP endpoint for extracting circuit rows
// from a photographed electrical switchboard schedule card (the laminated
// CB / Amp / Description list bolted to a distribution board).
//
// Deployed to: sks-canonical (ehowgjardagevnrluult) — same project as
// parse-maximo-pdf-wo, which already has ANTHROPIC_API_KEY configured there.
//
// Consumer: eq-solves-service's RCD "Create Check" flow — a technician
// photographs a board, this endpoint returns a candidate circuit list, the
// tech reviews/corrects it (including which rows are RCD-protected) before
// anything is written to the database. This endpoint never touches a
// database — pure extraction, same division of responsibility as
// parse-maximo-pdf-wo.
//
// Single image in, single result out — deliberately simpler than
// parse-maximo-pdf-wo (no multi-page chunking, no text-layer fallback: a
// photograph has no extractable text layer, so every request goes straight
// to vision).
//
// RCD detection: real SKS switchboard schedules mark RCD-protected circuits
// with an asterisk next to the CB number (confirmed against the actual SKS
// blank templates, 2026-08-11) — the extraction prompt looks for that
// convention first, falling back to circuit-description wording ("RCD",
// "safety switch", "residual current"). Neither signal is trusted blindly:
// every row returns is_rcd_signal as a suggestion, not a fact — the eq-service
// review screen shows it as a pre-ticked, always-editable checkbox. This
// endpoint never decides what's an RCD, it only flags a best guess.
//
// verify_jwt is OFF, matching parse-maximo-pdf-wo in this same project (see
// that function's header comment for why — this project's Functions gateway
// rejects the legacy-format SUPABASE_SERVICE_ROLE_KEY JWT). Bounded blast
// radius: no DB access, worst case is Anthropic-token abuse.
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_MAX_TOKENS = 8192;

// ============================================================================
// WIRE TYPES (must match lib/import/switchboard-schedule-client.ts in
// eq-solves-service)
// ============================================================================

interface WireCircuit {
  circuit_no: string;
  description: string | null;
  amp_rating: string | null;
  is_rcd_signal: boolean;
}

interface WireWarning {
  code: string;
  message: string;
}

interface WireResult {
  circuits: WireCircuit[];
  warnings: WireWarning[];
  source: { fileName: string; circuitCount: number };
}

// ============================================================================
// ANTHROPIC VISION CALL
// ============================================================================

const EXTRACT_TOOL_SCHEMA = {
  name: "extract_switchboard_circuits",
  description:
    "Record every circuit breaker row printed on this switchboard schedule card. " +
    "The schedule is a table with a breaker/circuit number and a description, " +
    "usually an amp rating. Emit one array entry per circuit row found — do not " +
    "summarise or merge rows.",
  input_schema: {
    type: "object",
    properties: {
      circuits: {
        type: "array",
        items: {
          type: "object",
          required: ["circuit_no", "is_rcd_signal"],
          properties: {
            circuit_no: {
              type: "string",
              description:
                "The breaker/circuit number exactly as printed, including any " +
                "marker character next to it (e.g. '9', '12*').",
            },
            description: {
              type: ["string", "null"],
              description: "The circuit's label/description as printed, e.g. 'GPO West Wall'.",
            },
            amp_rating: {
              type: ["string", "null"],
              description: "Amp rating if printed on the row, e.g. '20A'. Null if not shown.",
            },
            is_rcd_signal: {
              type: "boolean",
              description:
                "Best-guess flag for whether this circuit is RCD-protected (a safety " +
                "switch), based on: (a) an asterisk or similar marker character next to " +
                "the circuit number — the most reliable signal on real SKS schedule " +
                "templates, or (b) the description explicitly mentioning 'RCD', 'safety " +
                "switch', or 'residual current'. Set false when neither signal is present " +
                "— do not guess from circuit type alone (e.g. do not assume every GPO is " +
                "RCD-protected just because that's common practice). This is a suggestion " +
                "a human will review, not a final answer — when genuinely unsure, prefer false.",
            },
          },
        },
      },
    },
    required: ["circuits"],
  },
};

async function extractCircuitsFromImage(
  apiKey: string,
  imageBytes: Uint8Array,
  mediaType: string,
  fileName: string,
): Promise<{ circuits: WireCircuit[]; warning?: string }> {
  const base64 = encodeBase64(imageBytes);

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
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            {
              type: "text",
              text:
                "This is a photo of an electrical switchboard schedule card — the laminated " +
                "list of circuit breakers bolted to a distribution board. Extract every " +
                "circuit row using the extract_switchboard_circuits tool.",
            },
          ],
        },
      ],
      tools: [EXTRACT_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: "extract_switchboard_circuits" },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API error ${resp.status} for '${fileName}': ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { content: Array<{ type: string; input?: unknown }> };
  const toolUse = data.content.find((b) => b.type === "tool_use");
  if (!toolUse || !toolUse.input || typeof toolUse.input !== "object") {
    return { circuits: [], warning: `No circuits extracted from '${fileName}' — vision call returned no tool result.` };
  }

  const raw = (toolUse.input as Record<string, unknown>)["circuits"];
  if (!Array.isArray(raw)) {
    return { circuits: [], warning: `'${fileName}' — extract tool result had no circuits array.` };
  }

  const circuits: WireCircuit[] = raw.map((c) => {
    const safe = c as Partial<WireCircuit>;
    return {
      circuit_no: String(safe.circuit_no ?? "").trim(),
      description: safe.description ? String(safe.description).trim() : null,
      amp_rating: safe.amp_rating ? String(safe.amp_rating).trim() : null,
      is_rcd_signal: Boolean(safe.is_rcd_signal),
    };
  }).filter((c) => c.circuit_no !== "");

  return { circuits };
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
      JSON.stringify({ error: "Expected multipart/form-data with a 'file' entry" }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return new Response(
      JSON.stringify({ error: "No file uploaded — expected multipart 'file' field" }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/heic"];
  if (!allowedTypes.includes(file.type)) {
    return new Response(
      JSON.stringify({ error: `Unsupported file type '${file.type}' — expected a photo (jpeg/png/webp/heic)` }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await extractCircuitsFromImage(apiKey, bytes, file.type, file.name);

    const warnings: WireWarning[] = [];
    if (result.warning) warnings.push({ code: "no_records_extracted", message: result.warning });
    if (result.circuits.length === 0 && !result.warning) {
      warnings.push({
        code: "no_records_extracted",
        message: `No circuit rows found in '${file.name}' — the photo may be unreadable. Try manual entry instead.`,
      });
    }

    const body: WireResult = {
      circuits: result.circuits,
      warnings,
      source: { fileName: file.name, circuitCount: result.circuits.length },
    };
    return new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
