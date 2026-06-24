import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ---------------------------------------------------------------------------
// eq-ai-assist — AI-powered data quality for EQ Intake
//
// Deployed to: sks-canonical (ehowgjardagevnrluult)
// Requires:    ANTHROPIC_API_KEY secret set on the project
// Actions:     suggest_gaps | ask_canonical
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Schema description given to the model for ask_canonical
const ENTITY_SCHEMA = `
Available tables (schema: app_data):
- staff:     staff_id, first_name, last_name, email, phone, trade, emergency_contact_name, active
- customers: customer_id, company_name, first_name, last_name, email, primary_phone, abn, suburb, postcode, state, active
- sites:     site_id, name, address_line_1, suburb, postcode, state, customer_id, active
- contacts:  first_name, last_name, email, work_phone, customer_id, company_name, active
- assets:    name, asset_type, serial_number, make, model, site_id, active
- licences:  licence_id, staff_id, licence_type, licence_number, issuing_authority, state, issue_date, expiry_date, active
`.trim();

interface GapSuggestion {
  field:           string;
  suggested_value: string | null;
  confidence:      'high' | 'medium' | 'low';
  reasoning:       string;
}

interface AskIntent {
  entity:          string;
  filters:         Array<{ field: string; op: string; value?: unknown }>;
  display_columns: string[];
  description:     string;
}

// ---------------------------------------------------------------------------
// Anthropic API wrapper (fetch-based, no npm dep needed in Deno)
// ---------------------------------------------------------------------------

async function anthropicMessage(
  apiKey: string,
  system: string,
  user: string,
): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    content: Array<{ type: string; text: string }>;
  };
  return data.content.find((b) => b.type === 'text')?.text ?? '';
}

// ---------------------------------------------------------------------------
// Action: suggest_gaps
// ---------------------------------------------------------------------------

async function handleSuggestGaps(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<GapSuggestion[]> {
  const entity        = String(payload['entity'] ?? '');
  const context       = payload['context'] as Record<string, unknown> ?? {};
  const missingFields = payload['missing_fields'] as string[] ?? [];

  if (!entity || missingFields.length === 0) return [];

  const system = `You are a data quality assistant for EQ, a field service management platform used by Australian trades businesses.

When asked to suggest values for missing record fields:
- Use available record context as clues
- Suggest specific, actionable values when reasonably inferable
- Return null for suggested_value when you cannot make a confident inference
- Keep reasoning to one concise sentence

Return ONLY a JSON array. No text outside the JSON. Each item must be:
{"field": string, "suggested_value": string | null, "confidence": "high" | "medium" | "low", "reasoning": string}`;

  const user = `Entity type: ${entity}
Available data: ${JSON.stringify(context)}
Missing fields to fill: ${JSON.stringify(missingFields)}

Suggest a value for each missing field.`;

  const text = await anthropicMessage(apiKey, system, user);

  // Extract JSON array (model may wrap in markdown code blocks)
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    return JSON.parse(match[0]) as GapSuggestion[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Action: ask_canonical
// ---------------------------------------------------------------------------

async function handleAskCanonical(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<AskIntent> {
  const question = String(payload['question'] ?? '').trim();
  if (!question) throw new Error('question is required');

  const system = `You are a data query assistant for EQ, a field service management platform.

Given a natural language question, return a JSON object describing how to query the data.

${ENTITY_SCHEMA}

Filter operators: is_null, is_not_null, eq, neq, contains, not_contains, gt, lt

Return ONLY valid JSON matching this shape (no explanation, no markdown):
{"entity": string, "filters": [{"field": string, "op": string, "value"?: any}], "display_columns": string[], "description": string}

Rules:
- entity must be one of: staff, customers, sites, contacts, assets, licences
- description should be a short phrase like "Staff with no trade classification"
- display_columns should be 3–5 of the most relevant columns
- If the question is ambiguous, pick the most likely entity`;

  const text = await anthropicMessage(apiKey, system, question);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response as intent JSON');

  try {
    return JSON.parse(match[0]) as AskIntent;
  } catch {
    throw new Error('AI returned malformed JSON for ask_canonical');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return new Response(
      JSON.stringify({ data: null, error: { message: 'ANTHROPIC_API_KEY secret not set on this project' } }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return new Response(
      JSON.stringify({ data: null, error: { message: 'Invalid JSON body' } }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const { action, ...payload } = body;

  try {
    if (action === 'suggest_gaps') {
      const data = await handleSuggestGaps(apiKey, payload);
      return new Response(
        JSON.stringify({ data, error: null }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    if (action === 'ask_canonical') {
      const data = await handleAskCanonical(apiKey, payload);
      return new Response(
        JSON.stringify({ data, error: null }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ data: null, error: { message: `Unknown action: ${String(action)}` } }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ data: null, error: { message } }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
