# Overnight run summary — 2026-05-19 → 2026-05-20

**Branch:** `claude/competent-kilby-d313f5` (worktree at `.claude/worktrees/competent-kilby-d313f5/`).
**Started:** ~21:30 (5-tick loop, ~1.5 hours of autonomous compute).
**Result:** all 5 deliverables landed. Loop ended cleanly without hitting the 12-tick cap.

Self-paced `/loop` per Royce's go-ahead. Schemas + types + samples + parsers in this repo. `/admin/export` lives in a draft PR on the SKS production repo per the explicit cross-repo authorisation.

## PRs

- **eq-intake (this repo)** — *this PR* — `claude/competent-kilby-d313f5` → `main`. Schemas, types, samples + ajv harness, parser ports, ACB round-trip script.
- **eq-solves-service** — [#176](https://github.com/Milmlow/eq-solves-service/pull/176) draft — `claude-overnight/admin-export` → `main`. Adds `GET /api/admin/export`.

## What landed

### 1. Canonical schemas (`schemas/`) — 20 net-new + 1 updated

Built in the prior session, formally committed tonight as part of the loop. See `9ff453d` for the full set.

- **Core**: `customer`, `contact` (new); `site` (added `customer_id` FK, deprecated `client_name`)
- **Service**: `maintenance_plan`, `maintenance_plan_item`, `maintenance_check`, `check_asset`, `check_item`, `contract_scope`, `pm_calendar`
- **Tests**: `acb_test` + `acb_visual_check_item` + `acb_electrical_reading`; `nsx_test` + 2 children; `rcd_test` + `rcd_test_circuit`
- **Cross-cutting**: `defect`, `attachment`

### 2. TS type generator + generated types (`scripts/gen-types.mjs`, `types/`)

Generator script reads every schema and emits `*.d.ts`. Resolves `json-schema-to-typescript` from `eq-platform/node_modules` via `createRequire` — no top-level install.

Produces 29 type files (the 20 new schemas + the 9 originals from the prior session). Regenerate any time via `node scripts/gen-types.mjs`.

### 3. Sample fixtures (`samples/`)

- 10 `*-messy.csv` — real-world headers, alias columns, mixed formats. What the import pipeline sees as input.
- 11 `*-clean.csv` — canonical-shape, validate directly against the schema.
- 3 `*-clean.json` — nested entities (acb_test, nsx_test, rcd_test) with child rows.
- `samples/README.md` documents the convention.

### 4. ajv sample-validation harness

`eq-platform/packages/eq-validation/test/samples-validation.test.ts`. Auto-discovers every `*-clean.{csv,json}` and validates against its schema. Schema-aware CSV coercion (uses `properties[col].type` to coerce per column, not heuristic). Strips child arrays from JSON parents and validates each child against the matching child schema.

Result: 15/15 fixtures pass. Full eq-validation suite: 231/231 (up from 173 before tonight).

### 5. Ported parser pure-fns into `@eq/validation`

Lifted from `eq-solves-service/lib/import/delta-wo-parser.ts` so other intake pipelines can reuse without an eq-service dependency.

| Module | Exports |
|---|---|
| `parse-frequency-suffix.ts` | `FREQUENCY_SUFFIX_MAP` (frozen), `mapFrequencySuffix`, `knownFrequencySuffixes`, `FrequencyEnum` |
| `parse-job-plan-code.ts` | `splitJobPlanCode("LVACB-A")` → `{code, suffix}` |
| `parse-site-prefix.ts` | `stripSitePrefix("AU01-SY3")` → `"SY3"`, `hasMaximoSitePrefix` |
| `parse-jemena-asset-id.ts` | `isJemenaAssetId`, `extractJemenaAssetId`, `extractAllJemenaAssetIds` |

58 new vitest cases. Jemena ID extractor wasn't in delta-wo-parser as the brief implied — built fresh from the `JM######` pattern seen in `supabase/seeds/jemena-onboarding.sql` + the `rcd_test_circuit` schema's `jemena_circuit_asset_id` field.

### 6. `/api/admin/export` on eq-solves-service

[PR #176](https://github.com/Milmlow/eq-solves-service/pull/176) — DRAFT.

- `app/api/admin/export/route.ts` — GET handler, `isAdmin(role)` gated, tenant-scoped via `getApiUser()`.
- `lib/admin/canonical-export.ts` — `ENTITY_EXPORTERS` registry. Per-entity mappers reshape DB columns → canonical schema property names.

**Fully wired (8):** customer, site, asset, maintenance_check, check_asset, check_item, defect, acb_test (with children split via the `unit IS NULL` discriminator from the child schemas).
**Stubs (8):** contact, attachment, maintenance_plan, maintenance_plan_item, contract_scope, pm_calendar, nsx_test, rcd_test. Each returns `{count: 0, rows: [], note: "exporter not yet implemented"}` so consumers see what's missing at a glance.

Clean `tsc --noEmit` and `eslint`. Integration tests deferred — they need a tenant DB.

### 7. ACB round-trip prototype (`scripts/round-trip-acb.mjs`)

End-to-end demonstrator: pulls a canonical ACB payload, ajv-validates against `acb_test.schema.json` + the two child schemas, prints a structured report.

- `--fixture` mode: reads `samples/acb_test-clean.json`. Offline, no auth, what CI runs. Tonight's run: 1 parent ✓, 4 visual ✓, 4 electrical ✓, exit 0.
- `--url <endpoint>` mode: hits the deployed `/api/admin/export?entity=acb_test`. Reads bearer from `$EQ_SERVICE_TOKEN`. For a dev tenant.

## What was NOT done — open questions for Royce

### ⚠ Schema-drift between `schemas/` and `eq-platform/packages/eq-schemas/src/schemas/`

The eq-platform monorepo carries its own copy of 12 schemas that **diverges** from this repo's root `schemas/`. Most importantly: a CRM-flavoured `customer` (company_name / first_name / last_name / type=customer|prospect|lead, SimPRO aliases) coexists with the SKS-contract `customer` (CPI rules, SLAs, contract templates) that tonight's work created.

These look like **two different customer concepts** — the CRM "who do we quote" customer and the contract "who do we bill" customer. Tonight's brief was explicit about not resolving this; tagged in PLAN.md and **needs a design call**. Options:

1. Rename mine to `service_customer` and leave the CRM `customer` untouched
2. Treat the CRM `customer` as legacy, sync this repo's `customer` into eq-platform, soft-delete the CRM model
3. Both customer entities exist and link via a shared `entity_id` of some kind

Same question applies (to a lesser extent) to `contact`, `site`, `asset`, `schedule`, `toolbox-talk` — see the file-by-file table in `PLAN.md`.

### Stub exporters in `/api/admin/export`

8 of 16 entities return stubs. Each is mechanical — same shape as the wired ones, just need to be filled in. Estimated 1-2 hours of follow-up work to complete the full registry. Worth doing alongside integration tests.

### Integration tests for `/api/admin/export`

Skipped tonight because they need a tenant DB. The PR description has a 6-bullet test plan that should be run before merging.

### Live ACB round-trip

The `--fixture` mode is green tonight. The `--url` mode is built but un-tested — needs a deployed branch + a valid Supabase auth token. Easy to verify once #176 is merged to a dev branch and Netlify auto-deploys.

### Pre-existing typecheck errors

`pnpm typecheck` in eq-validation surfaces 3 pre-existing errors in `process-capture.ts` (missing `@eq/ai` workspace dep). Not touched tonight; mentioned in PLAN tick log so it doesn't get attributed to this run.

## File counts

Across both PRs:

- 20 new schemas + 1 updated (site.schema.json) in `schemas/`
- 29 generated TS type files in `types/`
- 1 generator script
- 21 sample CSV + 3 nested JSON in `samples/` + README
- 4 new src + 4 new test files in `eq-platform/packages/eq-validation/`
- 1 ajv harness test (`samples-validation.test.ts`)
- 1 round-trip prototype script
- 2 files on eq-solves-service (route + canonical-export library)
- 4 commits on eq-intake (worktree branch) + 1 commit on eq-solves-service (separate branch)
- 1 draft PR on eq-solves-service, 1 draft PR (this one) on eq-intake

## Commits on this branch

```
ef00c2f PLAN.md: Tick 4 done — eq-solves-service /admin/export draft PR #176
f64983d Port Delta/Maximo/Jemena parser pure-fns into @eq/validation
694e5f1 Sample fixtures + ajv harness for the 14 net-new canonical entities
9ff453d Add 20 canonical schemas + TS type generator + types/
09b9d65 Initial commit — Phase 1 EQ Intake + per-tenant canonical schema
```

Plus a final commit (this one) with `SUMMARY.md` + closing PLAN.md updates.

## Hard-limit compliance

- ✅ No npm/git deploys
- ✅ No Supabase migrations
- ✅ Cross-repo work only in eq-solves-service (no touches to SKS NSW Labour, EQ Field, or EQ Solves Service Netlify)
- ✅ All commits on branches; nothing merged, no force pushes, no main pushes
- ✅ Both PRs created as drafts
- ✅ Loop ended on completion of all 5 deliverables; well inside the 12-tick cap (used 5 ticks)
