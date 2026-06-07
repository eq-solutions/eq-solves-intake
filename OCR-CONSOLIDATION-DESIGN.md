# Solution design — consolidate document/licence OCR onto EQ Intake

**Status:** Design (2026-06-07). **Build: post-SKS-go-live.** No production changes proposed here.
**Author context:** written after a suite-wide security pass found three separate, bespoke OCR/document-extraction implementations doing the same job.

---

## 1. Problem

"Scan a licence/document → structured fields" is currently solved **three different ways**, only one of which is the canonical engine:

| # | Where | Tech | Status |
|---|---|---|---|
| 1 | **eq-shell** `netlify/functions/ocr-parse.ts` | Google Document AI | Production. (Just had an auth gate added — was unauthenticated.) |
| 2 | **eq-cards** `supabase/functions/ocr-licence` | Claude Vision (bespoke) | Production (web). Mobile uses on-device ML Kit. |
| 3 | **EQ Intake** `@eq/ai` vision-extraction + `eq-intake/readers/photo.ts` + `eq-schemas/licence.schema.json` | Claude Vision (canonical engine) | **Package-only — not deployed behind any endpoint.** |

This violates the standing principle *"EQ Intake is the horizontal parsing service — don't build bespoke parsers elsewhere."* #1 and #2 are exactly the bespoke parsers that principle exists to prevent. Cost: two parsers to maintain, a paid Google Document AI dependency (and service account) that duplicates the Claude-Vision capability we already own, no shared canonical schema, no shared confidence/confirm pipeline.

## 2. Verified current state (2026-06-07, against live code)

- **Deployed Intake API** = `edge-functions/api-intake/index.ts`: `POST` canonical JSON `rows` for entities `customer | site | contact | staff | licence` → validate → `eq_commit_batch` RPC. **Explicitly "No AI mapping"** — caller must pre-shape rows. **No image/vision path.**
- **Vision engine** = `eq-platform/packages/eq-ai` (`VISION_EXTRACTION_SYSTEM_PROMPT`, `extract()`) + `eq-platform/packages/eq-intake/src/readers/photo.ts` (`parsePhoto()` → shapes vision output as a `ParsedSheet`, identical to CSV/XLSX/PDF readers → same validation + confirm UI). Returns `{ extracted, field_confidence, raw_text, uncertain_fields, warnings, metadata }`. **All call sites are in `packages/*`, the demo, and tests — none in `edge-functions/` (the deployed surface).**
- **Canonical licence schema** already exists: `eq-platform/packages/eq-schemas/src/schemas/licence.schema.json`.

**Conclusion:** the engine is built and the schema exists; the only missing piece is **productionising vision extraction as a callable endpoint** and **repointing Shell + Cards at it**.

## 3. Target architecture

Two composable stages, both owned by Intake, mirroring the existing extract→commit split:

```
  [photo/PDF bytes] ──► api-extract (NEW)  ──► canonical JSON + per-field confidence
                         (@eq/ai vision,         │
                          target = licence.schema)│  operator confirms/corrects
                                                  ▼
                        api-intake (EXISTS)  ◄── confirmed rows
                         entity=licence → eq_commit_batch → canonical licence record
```

1. **NEW `api-extract` edge function** — `POST { file_base64, media_type, entity, tenant_id }`. Loads the canonical schema for `entity` (start with `licence`), calls `@eq/ai` `extract()` / `parsePhoto()`, returns the extract result shape (fields + confidence + raw_text + warnings). Auth: Bearer JWT with `tenant_id` (same model as `api-intake`). Rate-limited and abuse-controlled (this runs a paid model — learn from the Shell incident: **never unauthenticated**).
2. **Reuse `api-intake`** unchanged for the commit half — `entity=licence` already exists.
3. **Shell + Cards become thin clients**: their OCR pages call `api-extract` (extract) then the existing confirm UI then `api-intake` (commit). Delete the bespoke extraction code.

Net: **one engine, one canonical schema, one confidence/confirm/commit pipeline, one AI provider (Claude Vision).**

## 4. Cutover plan (phased, post-go-live)

1. **Productionise `api-extract`** (Intake repo) with the `licence` schema; ship behind auth + rate limit; smoke with real licence images; confirm confidence/uncertain-field output is usable.
2. **Repoint eq-cards web** `ocr-licence` → call `api-extract`. (Cards already uses Claude Vision, so output parity should be close.) Keep mobile on-device ML Kit as-is — out of scope.
3. **Repoint eq-shell** `LicenceOcrPage` → `api-extract`; delete `ocr-parse.ts`.
4. **Retire** the Google Document AI dependency: remove the service account, its credentials in `shell_control.platform_config`, and the `GOOGLE_DOC_AI_*` env vars. (This also removes the cost + the attack surface we just had to gate.)
5. **Generalise** beyond licence as needed (other entities already have schemas).

Each step is independently shippable and reversible; no big-bang.

## 5. What gets retired
- `eq-shell/netlify/functions/ocr-parse.ts` (+ its Google Doc AI service account, credentials, env vars).
- `eq-cards/supabase/functions/ocr-licence` web path (mobile on-device path stays).
- One paid third-party dependency (Google Document AI) collapses into the Claude-Vision capability already owned.

## 6. Confirm BEFORE building (live-state checks — do not assume)
- **Source-of-truth repo:** is new Intake work landing in the standalone `eq-intake` repo (`edge-functions/`) or the in-flight `eq-platform/` monorepo? The architecture redo status was flagged "unknown" — confirm where `api-intake` actually deploys from and put `api-extract` there.
- **Deployment host:** which Supabase project hosts the Intake edge functions + the `eq_commit_batch` RPC (control plane vs a per-tenant plane)? `api-extract` must sit alongside it.
- **`@eq/ai` provider readiness:** confirm the Anthropic provider (`eq-ai/src/anthropic.ts`) is production-wired with real API calls — the demo uses `mock-ai.ts`. Needs an `ANTHROPIC_API_KEY` in the deploy env.
- **Output parity:** diff Shell (Google Doc AI) vs Intake (Claude Vision) field accuracy on real AU licence samples before retiring Shell's path.
- **Licence schema coverage:** confirm `licence.schema.json` covers every field Shell/Cards currently capture (name, number, class, expiry, DOB, issuing authority).

## 7. Risks & non-goals
- **Risk — accuracy regression:** Google Doc AI and Claude Vision may extract differently. Mitigate with a parity test on real samples (step 6) and a confidence gate before retiring Shell.
- **Risk — single-provider dependency:** consolidating onto Claude Vision concentrates on one model. Acceptable (it's already the canonical choice) but note it.
- **Non-goal — mobile:** Cards mobile on-device ML Kit stays; this is the web/server OCR paths only.
- **Non-goal — go-live:** this is **not** SKS-go-live work. Do not start the build until after 2026-06-21.

## 8. Effort (rough, post-go-live)
- `api-extract` function + auth + rate limit + licence wiring: ~1–2 days.
- Repoint Cards web + parity test: ~1 day.
- Repoint Shell + retire Google Doc AI: ~1 day.
- ~1 focused sprint total, sequenced so each step ships independently.
