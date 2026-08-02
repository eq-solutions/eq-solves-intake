import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ---------------------------------------------------------------------------
// eq-ai-assist — AI-powered data quality for EQ Intake
//
// Deployed to: sks-canonical (ehowgjardagevnrluult)
// Requires:    ANTHROPIC_API_KEY secret set on the project
// Actions:     suggest_gaps | ask_canonical | adjudicate_duplicate |
//              adjudicate_queue_duplicate | adjudicate_contact_duplicate
//
// This file had gone stale (last touched by PR #69, missing
// adjudicate_queue_duplicate which shipped via a direct MCP deploy on
// 2026-08-02 with no matching repo commit) — found while adding
// adjudicate_contact_duplicate. Brought back in sync with what's actually
// live (verified via a readback of the deployed function before writing
// this). No other deploy tooling references this path; deploys are manual
// (Supabase MCP `deploy_edge_function`, Royce's explicit go each time) —
// keep this file and the live function in sync by hand until that's
// automated.
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

interface AdjudicateVerdict {
  verdict:    'same' | 'different' | 'unsure';
  confidence: 'high' | 'medium' | 'low';
  reasoning:  string;
}

interface QueueDuplicateVerdict {
  verdict:    'archive' | 'keep' | 'unsure';
  confidence: 'high' | 'medium' | 'low';
  reasoning:  string;
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
// Action: adjudicate_duplicate
//
// The write-time site resolver (eq-shell 0179) flags new-site writes that look
// like an existing site. This asks Claude to make the call a trigram matcher
// can't — using real-world knowledge (abbreviations, org/trading names, address
// equivalence, and the "same street address but a different tenancy" trap) —
// and to return a plain-English reason a non-technical operator can confirm.
// The verdict vocabulary matches the human buttons (same/different/unsure), so
// the answer can pre-fill the console. It NEVER merges anything — it advises.
// ---------------------------------------------------------------------------

async function handleAdjudicateDuplicate(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<AdjudicateVerdict> {
  const siteA = payload['site_a'] as Record<string, unknown> ?? {};
  const siteB = payload['site_b'] as Record<string, unknown> ?? {};

  if (Object.keys(siteA).length === 0 || Object.keys(siteB).length === 0) {
    throw new Error('adjudicate_duplicate requires both site_a and site_b');
  }

  const system = `You are an expert data steward for EQ, a field-service platform used by Australian trades businesses. Your job: decide whether two SITE records refer to the SAME real-world physical location, or two DIFFERENT ones.

Reason with real-world knowledge a string matcher cannot:
- Abbreviations, acronyms and trading names ("SVHN" = "St Vincent's Health Network"; "DC" ≈ "Distribution Centre"; "Bldg 2" = "Building 2").
- Address equivalence ("8 Egerton St" = "8 Egerton Street"; "Cnr High & Main" = the same corner).
- A shared address does NOT always mean the same site: distinct tenancies, units, levels, docks or buildings at one street address are DIFFERENT sites (e.g. "Level 2, 8 Egerton St" vs "Loading Dock, 8 Egerton St").
- A reused or shared site CODE with clearly different names/addresses is a red flag, not proof — weigh the names and addresses, not the code alone.
- If the two belong to different customers, lean toward different unless the address and name clearly say otherwise.

Choose ONE verdict:
- "same": confident they are the same physical site.
- "different": confident they are distinct sites.
- "unsure": you genuinely cannot tell from the given fields. Do NOT guess — prefer "unsure" over a low-confidence "same"/"different".

Return ONLY a JSON object — no markdown, no text outside it:
{"verdict": "same" | "different" | "unsure", "confidence": "high" | "medium" | "low", "reasoning": "<one plain-English sentence>"}

The reasoning must be a single sentence, name the specific clue you used, and avoid technical jargon.`;

  const user = `Site A (newly created):
${JSON.stringify(siteA, null, 2)}

Site B (existing record it resembles):
${JSON.stringify(siteB, null, 2)}

Are these the same real-world site?`;

  const text = await anthropicMessage(apiKey, system, user);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response as verdict JSON');

  let parsed: Partial<AdjudicateVerdict>;
  try {
    parsed = JSON.parse(match[0]) as Partial<AdjudicateVerdict>;
  } catch {
    throw new Error('AI returned malformed JSON for adjudicate_duplicate');
  }

  // Coerce to the strict vocabulary; anything unexpected degrades to "unsure".
  const verdict = parsed.verdict === 'same' || parsed.verdict === 'different'
    ? parsed.verdict
    : 'unsure';
  const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium'
    ? parsed.confidence
    : 'low';
  const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
    ? parsed.reasoning.trim()
    : 'No reason returned.';

  return { verdict, confidence, reasoning };
}

// ---------------------------------------------------------------------------
// Action: adjudicate_contact_duplicate
//
// The write-time contact resolver (eq-shell 0233) flags new-contact writes
// that look like an existing contact — same mechanism as adjudicate_duplicate
// above (Sites), just for people instead of places. Reasons with real-world
// knowledge a string matcher cannot: nicknames, maiden/married names, a
// shared company inbox used by several distinct people, someone who changed
// jobs (same person, different company_name today). NEVER merges — advises.
// ---------------------------------------------------------------------------

async function handleAdjudicateContactDuplicate(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<AdjudicateVerdict> {
  const contactA = payload['contact_a'] as Record<string, unknown> ?? {};
  const contactB = payload['contact_b'] as Record<string, unknown> ?? {};

  if (Object.keys(contactA).length === 0 || Object.keys(contactB).length === 0) {
    throw new Error('adjudicate_contact_duplicate requires both contact_a and contact_b');
  }

  const system = `You are an expert data steward for EQ, a field-service platform used by Australian trades businesses. Your job: decide whether two CONTACT records refer to the SAME real-world person, or two DIFFERENT people.

Reason with real-world knowledge a string matcher cannot:
- Nicknames and name variants ("Rob" = "Robert"; "Liz" = "Elizabeth"; a maiden vs married surname).
- A shared email or phone does NOT always mean the same person: a generic company inbox ("info@", "reception@", "accounts@") or a shared office switchboard number is used by several distinct people — weigh the name too, not the contact detail alone.
- A person can genuinely change company_name (they changed jobs) and still be the same person if the name/email/phone line up — don't assume different just because the company differs.
- If the two clearly belong to different companies AND the name/email/phone don't otherwise match, lean toward different.

Choose ONE verdict:
- "same": confident they are the same real person.
- "different": confident they are distinct people.
- "unsure": you genuinely cannot tell from the given fields. Do NOT guess — prefer "unsure" over a low-confidence "same"/"different".

Return ONLY a JSON object — no markdown, no text outside it:
{"verdict": "same" | "different" | "unsure", "confidence": "high" | "medium" | "low", "reasoning": "<one plain-English sentence>"}

The reasoning must be a single sentence, name the specific clue you used, and avoid technical jargon.`;

  const user = `Contact A (newly created):
${JSON.stringify(contactA, null, 2)}

Contact B (existing record it resembles):
${JSON.stringify(contactB, null, 2)}

Are these the same real person?`;

  const text = await anthropicMessage(apiKey, system, user);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response as verdict JSON');

  let parsed: Partial<AdjudicateVerdict>;
  try {
    parsed = JSON.parse(match[0]) as Partial<AdjudicateVerdict>;
  } catch {
    throw new Error('AI returned malformed JSON for adjudicate_contact_duplicate');
  }

  const verdict = parsed.verdict === 'same' || parsed.verdict === 'different'
    ? parsed.verdict
    : 'unsure';
  const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium'
    ? parsed.confidence
    : 'low';
  const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
    ? parsed.reasoning.trim()
    : 'No reason returned.';

  return { verdict, confidence, reasoning };
}

// ---------------------------------------------------------------------------
// Action: adjudicate_queue_duplicate
//
// The Review Queue's "duplicate" category (app_data.eq_remediation_queue,
// staff — contacts moved to the structured adjudicate_contact_duplicate flow
// above once eq-shell 0233 gave contacts a real write-time resolver) flags a
// record as a probable duplicate with only a free-text `reason` naming the
// suspected match — no structured second record like the resolvers above
// give. So this asks Claude to sanity-check the detector's OWN reasoning
// against the flagged record's fields, rather than compare two records. It
// never archives anything — the human still taps Archive
// (eq_archive_duplicate_record).
// ---------------------------------------------------------------------------

async function handleAdjudicateQueueDuplicate(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<QueueDuplicateVerdict> {
  const record = payload['record'] as Record<string, unknown> ?? {};
  const reason = String(payload['reason'] ?? '').trim();
  const currentValue = payload['current_value'];

  if (Object.keys(record).length === 0 || !reason) {
    throw new Error('adjudicate_queue_duplicate requires record and reason');
  }

  const system = `You are an expert data steward for EQ, a field-service platform used by Australian trades businesses. An automated detector has flagged a record as a probable duplicate of another record already in the system, and given its own reasoning. Your job: sanity-check that reasoning before a human archives the record.

You are NOT comparing two full records — you only have the flagged record's own fields and the detector's stated reason (which names the record it thinks this duplicates). Judge whether the reason itself holds up:
- A shared phone/email is strong evidence, but a shared OFFICE line or a generic company inbox (e.g. "info@", "reception@") is weak evidence on its own.
- If the reason mentions a different company/customer for the two records, be more cautious — a shared surname or similar name across different organisations is not proof of a duplicate.
- If the reasoning looks solid and internally consistent, say so plainly — don't manufacture doubt.

Choose ONE verdict:
- "archive": the detector's reasoning holds up — archiving is the right call.
- "keep": the detector's reasoning looks weak, or something in the record contradicts it — this may be a real, distinct record.
- "unsure": you genuinely cannot tell from what's given. Do NOT guess — prefer "unsure" over a low-confidence call.

Return ONLY a JSON object — no markdown, no text outside it:
{"verdict": "archive" | "keep" | "unsure", "confidence": "high" | "medium" | "low", "reasoning": "<one plain-English sentence>"}

The reasoning must be a single sentence, name the specific clue you used, and avoid technical jargon.`;

  const user = `Flagged record:
${JSON.stringify(record, null, 2)}

Current status: ${currentValue ?? 'unknown'}

Detector's own reasoning for flagging it: ${reason}

Should this record actually be archived as a duplicate?`;

  const text = await anthropicMessage(apiKey, system, user);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response as verdict JSON');

  let parsed: Partial<QueueDuplicateVerdict>;
  try {
    parsed = JSON.parse(match[0]) as Partial<QueueDuplicateVerdict>;
  } catch {
    throw new Error('AI returned malformed JSON for adjudicate_queue_duplicate');
  }

  const verdict = parsed.verdict === 'archive' || parsed.verdict === 'keep'
    ? parsed.verdict
    : 'unsure';
  const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium'
    ? parsed.confidence
    : 'low';
  const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
    ? parsed.reasoning.trim()
    : 'No reason returned.';

  return { verdict, confidence, reasoning };
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

    if (action === 'adjudicate_duplicate') {
      const data = await handleAdjudicateDuplicate(apiKey, payload);
      return new Response(
        JSON.stringify({ data, error: null }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    if (action === 'adjudicate_contact_duplicate') {
      const data = await handleAdjudicateContactDuplicate(apiKey, payload);
      return new Response(
        JSON.stringify({ data, error: null }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    if (action === 'adjudicate_queue_duplicate') {
      const data = await handleAdjudicateQueueDuplicate(apiKey, payload);
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
