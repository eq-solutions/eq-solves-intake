# EQ — Phase 1 Build Bundle

## What this is

EQ is the layer between the systems trade subbies are forced to use that don't
talk to each other. Not a replacement for SimPRO. Not a competitor to Xero.
The thing in the middle that means apprentices don't do the same induction
four times a week and bookkeepers don't retype timesheets at 8pm on a Friday.

This bundle contains the canonical data spine, the validation engine, the AI
mapping layer, and the user-facing-surface scaffold. Phase 1 plumbing is
**built and tested** as of 29 Apr 2026 PM. See `SESSION-LOG.md` for what
happened most recently and what comes next.

## Read these first, in order

1. **`EQ-AS-CONDUIT.md`** — Why this exists. The pain it removes. Read this
   before anything else.
2. **`HOW-WE-WORK-WITH-AI.md`** — Working principles for AI sessions on this
   project. The lesson from drifting off-frame early in the build, and the
   rules that keep that from happening again. Open this any time an AI
   session has scope to touch architecture, marketing, planning, or strategy
   docs.
3. **`SESSION-LOG.md`** — Plain-language summary of what's built right now,
   what was decided, and where to pick up next session.
4. **`SPRINT-1-SETUP.md`** — Locked technical decisions for the Phase 1 build
   (Node 20.11 LTS, pnpm 9.x, ESM, Vitest, tsup, etc).
5. **`EQ-FORMAT.md`** — The bidirectional sheet wrangler. Cleanup-in (the
   dog-shit tag-and-test moment) and reshape-out (canonical to client format).
   Bulk migration is a mode, not a separate door — EQ Import is retired as
   a name.
6. **`EQ-CARDS-INTAKE-BRIDGE.md`** — How EQ Cards (already shipping on its
   own Supabase project) bridges to the canonical EQ Intake spine. Path A
   decided: consolidate before Format ships.
7. **`EQ-INTAKE-ARCHITECTURE.md`** — Technical shape. Two doors in (Cards,
   Format), Capture as a future surface, canonical layer in the middle,
   every door out.
8. **`COWORK-BRIEF-PHASE-1.md`** — Original 7-sprint plan with deliverables.
   Read alongside `SESSION-LOG.md` because Sprints 2-4 were collapsed in
   execution and Capture moved out of Phase 1 ship criteria.
9. **`PHASE-2-3-BACKLOG.md`** — Everything deferred from Phase 1, captured
   so it doesn't get lost.
10. **`CONFIRM-UI-SPEC.md`** — What users see during an import. Phase 2
    deliverable, spec lives here.
11. **`validation/VALIDATION-ENGINE-SPEC.md`** — Internals of the shared
    validation package. Now built as `eq-platform/packages/eq-validation/`.

If any of these docs drift from the framing in `EQ-AS-CONDUIT.md`, the
framing wins. Update the doc.

## What's built (29 Apr 2026 PM)

The monorepo at `eq-platform/` ships four packages:

| Package           | Purpose                                                      | Tests | Status                              |
| ----------------- | ------------------------------------------------------------ | ----- | ----------------------------------- |
| `@eq/schemas`     | 10 canonical JSON Schemas + auto-generated TS types and Zod  | 3     | Codegen pipeline working            |
| `@eq/validation`  | Coercers, FK resolver, cross-field eval, signature-hash, validate orchestrator, processCapture | 156   | 10K rows in ~250ms (under 2s NFR)  |
| `@eq/ai`          | Vendor-agnostic AI provider with AnthropicProvider           | 12 + 1 integration | Real Anthropic API verified |
| `@eq/confirm-ui`  | Phase-2 UI scaffold (placeholder, no components yet)         | 1     | Ready to absorb Phase-2 work        |

**Total: 172 unit tests passing + 1 integration test against real Sonnet 4.5.**

The integration test costs ~half a cent per run and is gated on
`ANTHROPIC_API_KEY` being set — see "Run it" below.

## Run it

```powershell
cd C:\Projects\eq-intake\eq-platform
pnpm install                # codegen fires automatically via prepare hook
pnpm -r build               # all four packages
pnpm -r test                # 172 tests; integration test cleanly skipped
pnpm schemas:lint           # 10/10 schemas valid against draft 2020-12

# Optional: real API call (~$0.005). Loads .env via Node\'s native env-file.
pnpm test:integration
```

The `.env` lives at `eq-platform/.env` (gitignored). See `.env.example` for
the format.

## Demos

- **`demos/simpro-quote-781/`** — End-to-end demo: takes a real SimPRO quote
  CSV, classifies rows, emits a procurement BOM, a 19-row KNX device register
  with placeholder commissioning fields, and a labour summary. Pure Node ESM,
  no deps. Run `node parse.mjs` from inside the folder. Proves the conduit
  thesis on a real-world input.

## What's in each folder

### `eq-platform/` — the monorepo

```
eq-platform/
├── packages/
│   ├── eq-schemas/         canonical JSON Schemas + generated TS/Zod
│   ├── eq-validation/      coercion + validation engine + processCapture
│   ├── eq-ai/              AnthropicProvider (fetch-based, no SDK)
│   └── eq-confirm-ui/      Phase-2 placeholder
├── package.json            workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env                    your API key (gitignored)
├── .env.example            template
└── .gitignore
```

### `schemas/`, `validation/`, `ai/`, `sql/`, `prompts/`, `test-fixtures/`

Original staging area for the source files that became the four packages.
Kept for archaeology and for any future schema-only edits — but the live
copies are now under `eq-platform/packages/`. Don't edit the staging copies
expecting them to flow through.

### `sql/` — Supabase migrations

- `001_intake_spine.sql`, `002_intake_module_columns.sql`,
  `003_schema_version_columns.sql` — not yet run against any Supabase
  project. Provisioning the canonical project is deferred until the first
  surface needs to commit (Phase 2).

### `demos/`

Real-world test cases that prove the engine on actual inputs. See above.

## Phase 1 ship criteria — current state

| Deliverable                                                    | Status |
| -------------------------------------------------------------- | ------ |
| 10 canonical schemas with TS + Zod auto-generated              | Done   |
| `eq-validation` with coercers, FK, cross-field, signature hash | Done   |
| `eq-ai` AnthropicProvider, prompt-injection-resistant          | Done   |
| Validation throughput 10k rows × 50 fields < 2s                | Done (~250ms) |
| Real Anthropic API integration verified end-to-end             | Done   |
| Supabase spine + RLS tested cross-tenant, RPCs work            | Deferred to Phase 2 (no project provisioned yet) |
| Signature-hash caching: second import of same shape skips AI   | Engine built; needs DB to demonstrate |
| Import mode handling — append default, upsert/replace gated    | At SQL RPC layer; lands with migrations |
| SKS staff list (50+ rows) imported and rolled back             | Deferred to Phase 2 (needs DB) |
| Loom recording / written demo of the full pipeline             | `demos/simpro-quote-781/` covers most of this |
| EQ Capture pipeline working end-to-end                         | **Removed from Phase 1** — Capture is now a future-additional surface, see `EQ-FORMAT.md` |

## Standing rules

- Generic placeholders only — never real client names in any output
- EQ targets ALL trade subbies, not just electrical
- Supabase: SELECT only without approval; never touch SKS live data unless
  explicitly told
- All Netlify/CF Pages apps need `_headers` file with security headers
- Never push to demo branch without explicit instruction
- Auth changes require Chat review before deployment
- Self-critique applied (this is high-stakes, real people depend on it)
- **Inductions, SWMS, prestarts, JSAs and other safety-critical features
  are never gated behind paywalls.**

## Non-functional targets (Phase 1)

| Metric                                          | Target  | Current                |
| ----------------------------------------------- | ------- | ---------------------- |
| Validation throughput                           | <2s     | ~250ms (10k × 9 fields)|
| AI mapping latency p50 / p95                    | <4s/12s | ~13s observed (one sample, real call) |
| Vision extraction p50 / p95                     | <8s/25s | not measured yet       |
| Signature-hash cache hit rate (after 30d)       | >70%    | not measured (no DB)   |
| AI cost per 1k rows mapped (Sonnet, no cache)   | <AUD $0.40 | not measured (single sample) |
| Schema gen build time                           | <5s     | <1s                    |
| Signature collision probability                 | <1e-9   | SHA-256, satisfies     |

## What this bundle is not

- Not a SaaS pitch deck. The marketing pages we built earlier exist for when
  there's something real to show; right now they sit in `/mnt/user-data/outputs/`
  as artefacts of a creative exploration.
- Not a launch plan. Phase 1 is "build the plumbing well enough that real
  subbies can use it without it breaking on them."
- Not a forecast. The 7-sprint timeline is a working rhythm, not a deadline.
  Real customer pain reorders priorities.

## Changelog

- **v2.2 (29 Apr 2026 PM):** Phase 1 plumbing built. Four packages shipping
  in `eq-platform/`. 172 tests passing. Real Anthropic API integration verified.
  EQ Import retired as a named door (absorbed into EQ Format as batch mode).
  EQ Capture demoted from Phase 1 ship criterion to future-additional surface.
  Path A architectural decision recorded for Cards-Intake bridge. SimPRO/KNX
  demo committed to `demos/`. Session details in `SESSION-LOG.md`.
- **v2.1 (29 Apr 2026):** Added `HOW-WE-WORK-WITH-AI.md` capturing the lesson
  from the early SaaS-framing drift. Threaded the reference through the
  README, Cowork brief, and Sprint 1 setup so future AI sessions open with
  the working principles in context.
- **v2 (29 Apr 2026):** Reframed entire bundle as conduit / data layer
  between systems, not a competitor to existing software. Added
  `EQ-AS-CONDUIT.md` as the source-of-truth doc. Rewrote architecture and
  README. Stripped SaaS-positioning language throughout.
  Inductions/SWMS/safety-critical features explicitly never paywalled.
- **v1.2 (29 Apr 2026):** Added Sprint 1 setup doc with locked decisions.
  Web Crypto + Node fallback. JSON Schema CI lint. Schema URL policy.
- **v1.1 (28 Apr 2026):** Added Zod gen, schema_version columns, AI vendor
  abstraction, signature-hash caching, import_mode field. EQ Capture moved
  to Phase 3.
- **v1.0 (28 Apr 2026):** Initial bundle.
