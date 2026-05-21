# Continue: wire `maximo-pdf-wo` skill into eq-service for onboarding day

**Use this prompt when:** picking up the eq-service-side integration of the `maximo-pdf-wo` skill landed in [PR #6](https://github.com/eq-solutions/eq-solves-intake/pull/6) on `eq-solves-intake`. The skill is built, tested, and proven against real Claude vision on real Equinix PDFs. This session wires it behind a user-facing flow in eq-service so it's demoable.

**Authoring context:** Claude Opus 4.7 (1M context), 2026-05-21 evening, after the live-AI fire test passed. Demo day with SKS execs + team + customers is the forcing function.

---

## 0. Two-sentence summary

The `maximo-pdf-wo` skill in `@eq/intake` takes an Equinix Maximo WO PDF and returns canonical `maintenance_check` + `check_asset` insert candidates. Your job is to put a drop-zone in `eq-solves-service` at `/maintenance/new` that runs the skill, lets the user confirm/correct, and commits the bundles as real maintenance checks — replacing the manual retype flow that exists today.

## 1. Royce is the user (load-bearing context)

See `[[feedback_royce_is_the_user]]` in memory. Same framing as the canonical-spine continuation prompt: don't propose "wait for a real consumer" or "validate with a beta customer." Royce ran Equinix data centre maintenance for years; the workflow is real; the demo audience is execs / team / customers.

## 2. What's already done (don't redo)

- `@eq/intake` exports `parseMaximoPdfWo({ files, ai })` returning `{ bundles, raw_records, warnings, sources }`. See `eq-platform/packages/eq-intake/src/skills/maximo-pdf-wo/index.ts`.
- `@eq/ai` `AnthropicProvider` handles PDF document blocks + 32K max output tokens (fixes landed in PR #6).
- 8 unit tests (mock AI) + 2 integration tests (real Claude vision) all green.
- Real-data result: 4 fixture PDFs → 20 WOs → 3 bundles, ~322s end-to-end. Per-PDF cost is roughly **$0.05–0.30 in Sonnet 4.5 tokens** (multi-page scans heavy on input tokens; verify in eq-ai metrics).

## 3. What needs to happen, in order

### Step 1 — Drop-zone on `/maintenance/new` (the surface)

Today `/maintenance/new` in eq-service expects manual entry: pick a site, pick a plan, type a due date, type asset IDs. The new affordance:

- A "Drop Maximo PDF" button alongside the existing form.
- On drop: stream the file to a new Netlify function `parse-maximo-pdf` that calls `parseMaximoPdfWo` server-side (the API key lives in env vars there, not the browser).
- Show a progress indicator — vision takes 20–80s per PDF; users will wait if they understand why.
- Multi-file: accept up to 4 PDFs in one drop (matches the Equinix email pattern Danny O'Toole sends).

### Step 2 — Confirm step (the human checkpoint)

Live AI is ~95% right, not 100%. Confirm-step UI shows extracted bundles before commit:

- One card per `MaintenanceCheckBundle` — site, plan, frequency, due_date.
- Below each card: a table of its `check_assets` — WO#, asset (name + Maximo external_id), priority, work type, target dates.
- Inline edit for any field that's wrong (CUFT's date discrepancy in the fixture is the canonical example — Claude saw 21-Jun, README said 20-Jun; user needs to be able to fix that).
- Per-row "low confidence" badge sourced from `result.warnings` and the per-field `visionConfidence`.
- "Commit all" button at the bottom; "Discard this bundle" per card.

Look at `eq-platform/packages/eq-confirm-ui/` — there's a confirm-flow pattern for spreadsheets that this should mirror (`flow.test.ts` shows the API). Reuse rather than build new.

### Step 3 — Foreign-key resolution

Skill emits raw lookup keys, not UUIDs:
- `maintenance_check.site_code` (e.g. `CA1`) → must resolve to `sites.id` via existing `sites.code` index.
- `maintenance_check.plan_code` (e.g. `E1.8`) → must resolve to `maintenance_plans.id` via `maintenance_plans.code` (with frequency as a tiebreaker since `E1.8 quarterly` and `E1.8 annual` are distinct plans — the fixture's live run found both).
- `check_asset.asset_external_id` (e.g. `1070`) → exact match against `assets.external_id`; fall back to fuzzy on `assets.name` when null.

Existing `lib/import/delta-wo-parser.ts` in eq-solves-service already does this for the xlsx path. Reuse `resolveFk` from `@eq/validation` — same primitives, same fuzzy threshold.

### Step 4 — Commit RPC

Two options, in order of preference:

1. **Reuse `commitDeltaImportAction`** by translating `MaintenanceCheckBundle` → the shape that function already accepts. Lowest risk; the function is battle-tested on the xlsx path.
2. **Extend the `eq_intake_commit_batch` RPC** in Supabase to accept Maximo bundles natively, so the audit trail tags rows with `imported_from='maximo_pdf_wo'` and the rollback path works. Cleaner long-term but more migration work.

Recommendation: do (1) for demo day, schedule (2) as follow-up.

### Step 5 — Attach the PDF as evidence

Each `maintenance_check` gets the source PDF stored in R2 (or wherever eq-service stores compliance artefacts today) and linked via `attachment.schema.json`. This is the audit story for SKS — "we didn't make this up, here's the source document Equinix sent."

### Step 6 — Demo polish

Before the day:
- A "Drop these 4 PDFs to see it work" preset on a non-prod tenant. Live demo with the actual Equinix fixture set.
- Stopwatch the manual baseline once — record how long it actually takes someone to retype these WOs into `/maintenance/new` manually. Use that number live on stage.
- Sentry alert wired so a failed vision call pages you, not the audience.

## 4. Demo-day narrative (three audiences)

| Audience | The line | What they should see |
|---|---|---|
| **SKS execs** | "EQ is the canonical layer. Parse once, emit everywhere — Xero, SimPRO, Equinix portal, audit packs." | Show 4 PDFs → maintenance calendar populates → same data flows into the existing Xero export. Architecture diagram on a slide for context. |
| **Team using it** | "You stop retyping. PDFs come in by email, drop them here, confirm, done." | Live walk-through of `/maintenance/new` drop-zone → confirm-step → calendar entry. Compare time-to-completion vs. their current manual flow. |
| **Customers** | "For your Equinix WOs (or NEXTDC, hospitals, etc), here's the cost-per-document and how it extends to your shape." | Same demo, plus a slide showing how the same `parseMaximoPdfWo` pattern becomes `parseSimproContract`, `parseJemenaRcdReport`, etc — the EQ Intake skill catalogue. |

## 5. Known watchouts

- **Cost ceiling** — set a per-tenant monthly budget on vision calls. Today's ~$0.30 × thousands of PDFs is real money; needs cost telemetry into PostHog.
- **Failure surface** — a vision call that returns garbage (or times out) shouldn't kill the whole bundle. Per-PDF try/catch; one failed PDF surfaces a warning, the others still commit.
- **Tenant isolation** — `commitDeltaImportAction` already enforces tenant_id via RLS, but the new Netlify function MUST forward the user's JWT, not use a service key. Auth changes need explicit Royce approval before deploy (see `~/.claude/CLAUDE.md` global rules).
- **Confirm-step is non-negotiable** — never auto-commit. The EQ thesis is "AI + human checkpoint, not unsupervised." Royce will flag any flow that lacks the confirm step.

## 6. What NOT to build in this session

- The same skill pattern for other source documents (SimPRO contracts, Jemena RCD reports). Those have their own fixtures + briefs; one skill per session.
- A standalone EQ Intake demo page. The eq-service integration is the demo.
- New canonical schemas. Existing `maintenance_check` + `check_asset` cover the shape.

## 7. Hand-off

When you finish, write up:
- A 2-paragraph chat summary for Royce (what shipped, what's left).
- A row in `EQ-BRIEFING.md` under "maximo PDF intake" status.
- A memory note `[[project_maximo_pdf_eq_service_integration]]` capturing key decisions (FK strategy, commit RPC choice, evidence-storage location).
