# Overnight Run — 2026-05-19 → 2026-05-20

**Mode:** `/loop` self-paced, 15–30 min cadence, max 12 ticks.
**Branch:** `claude/competent-kilby-d313f5` (worktree at `.claude/worktrees/competent-kilby-d313f5/`).
**Scope confirmed by Royce:** TS types + sample fixtures + parser port + cross-repo `/admin/export` + ACB round-trip. Branch + push + draft PR authorised.

This file persists state across loop ticks. Each iteration: update the checkbox + add a brief note. On wake, read this top-to-bottom to pick up where the last tick left off.

---

## Decisions locked at tick 1

1. **Canonical schemas live in `C:\Projects\eq-intake\schemas\`** (per the original brief). The 20 files written in the previous session are the source of truth for tonight.
2. **TS types target `C:\Projects\eq-intake\types\`** (parallel to schemas/, not inside eq-platform). Royce's overnight brief said this explicitly.
3. **eq-validation = `C:\Projects\eq-intake\eq-platform\packages\eq-validation\`** (discovered, not `C:\Projects\eq-intake\packages\eq-validation\`).
4. **Generator script: `C:\Projects\eq-intake\scripts\gen-types.mjs`** (per Royce's brief verbatim). Uses `json-schema-to-typescript` from eq-platform/node_modules.
5. **eq-platform's `packages/eq-schemas/src/schemas/` is NOT touched tonight.** See "Schema-drift flag" below — it's a separate design call for Royce in the morning.
6. **DB schema is locked tonight.** No Supabase migrations. (Hard limit from brief.)
7. **Cross-repo writes (eq-solves-service)** authorised: branch + push + draft PR.

## ⚠ Schema-drift flag for Royce's morning review

While exploring, I found that **`C:\Projects\eq-intake\eq-platform\packages\eq-schemas\src\schemas\`** has a divergent set of 12 schemas. The drift is not trivial:

| File | Status |
|---|---|
| `incident.schema.json`, `itp.schema.json`, `jsa.schema.json`, `prestart.schema.json`, `staff.schema.json`, `swms.schema.json` | **SAME** as parent `schemas/` |
| `asset.schema.json`, `schedule.schema.json`, `site.schema.json`, `toolbox-talk.schema.json` | **DIFFER** (eq-platform versions were edited post the parent copies, or vice versa) |
| `customer.schema.json` | **DIFFERENT MODEL** — eq-platform has a CRM-style customer (company_name / first_name / last_name / type=customer\|prospect\|lead, SimPRO aliases). Parent schemas/ has my new SKS-contract customer (CPI rules, SLAs, contract templates). These are fundamentally different entities. |
| `contact.schema.json` | **DIFFERENT MODEL** — eq-platform version is its own shape; parent schemas/ has the unified-junction model I wrote. |
| 17 new entities I wrote tonight | **MISSING** from eq-platform |

**Hypothesis:** the eq-platform `eq-schemas` package was built earlier with a SimPRO-CRM lens, before this session's eq-solves-service canonical-migration brief. The parent `schemas/` is the new canonical source. Either: (a) eq-platform copies are stale and need replacing; (b) eq-platform models a *different* customer concept (the CRM customer, who gets quoted) and the SKS contract-customer is a NEW entity that should sit alongside it (maybe rename mine to `service_customer`?).

**Resolution NOT attempted tonight.** Surfaced here for Royce. All tonight's downstream work points at `C:\Projects\eq-intake\schemas\` so the eq-platform drift doesn't block anything.

---

## Tasks

- [x] **Tick 1 — PLAN.md scaffold** (this file, ~2026-05-19 evening)
- [x] **Tick 1 — TS type generator + types/ for all 29 schemas** (`scripts/gen-types.mjs`, 29 `*.d.ts` in `types/`)
- [x] **Tick 2 — Sample fixtures** (10 messy CSVs + 11 clean CSVs + 3 nested JSON in `samples/`)
- [x] **Tick 2 — ajv test harness** (`eq-platform/packages/eq-validation/test/samples-validation.test.ts` — 15/15 fixtures pass; full eq-validation suite 173/173 green)
- [x] **Tick 3 — Port parser pure-fns from eq-solves-service into eq-validation** (4 modules: `parse-frequency-suffix`, `parse-job-plan-code`, `parse-site-prefix`, `parse-jemena-asset-id`; 58 new tests; full suite 231/231 green)
- [ ] **Tick 4/5 — eq-service `/admin/export` endpoint (worktree, branch, push, draft PR)**
- [ ] **Tick 5/6 — ACB round-trip prototype (`scripts/round-trip-acb.mjs`)**
- [ ] **Last tick — SUMMARY.md + commit + draft PR for eq-intake worktree**

### Tick 2 (start ~22:25, ~10 min compute)

- Discovered worktree had no `node_modules` — ran `pnpm install --frozen-lockfile` once (~7s). Now self-contained.
- Built 21 CSV samples (10 messy + 11 clean) + 3 nested JSON for entities with child rows (acb_test, nsx_test, rcd_test).
- Wrote `samples-validation.test.ts` in eq-validation. Took two rev cycles to get right:
  - First pass: heuristic coerce-by-value-shape failed because it turned numeric strings (`intervals_text: "5"`) into integers, breaking string-typed schema columns.
  - Second pass: schema-aware coerce — looks up `properties[col].type` and coerces accordingly. Plus generic PK injection (any required `_id` field with `format: uuid`).
- One fixture bug: `check_asset-clean.csv` was missing `check_id` column. Added it.
- Now: 15 clean fixtures + 173-test full suite all green.
- Scheduling Tick 3 in ~20 min. Next: port `FREQUENCY_SUFFIX_MAP` + plan-code suffix splitter into eq-validation.

### Tick 3 (start ~22:57, ~10 min compute)

- Read `eq-solves-service/lib/import/delta-wo-parser.ts` + `jemena-rcd-parser.ts` to lift out the pure-function pieces. Jemena ID extraction wasn't in delta-wo-parser as the brief implied — built it fresh from the `JM######` shape seen in `supabase/seeds/jemena-onboarding.sql` (`JM003534`, `JM003468`, `JM003470` etc.).
- Added 4 modules under `eq-platform/packages/eq-validation/src/`:
  - `parse-frequency-suffix.ts` — `FREQUENCY_SUFFIX_MAP` (frozen), `mapFrequencySuffix`, `knownFrequencySuffixes`, `FrequencyEnum` type
  - `parse-job-plan-code.ts` — `splitJobPlanCode("LVACB-A")` → `{code, suffix}` on last dash
  - `parse-site-prefix.ts` — `stripSitePrefix("AU01-SY3")` → `"SY3"`, `hasMaximoSitePrefix` for non-mutating detect
  - `parse-jemena-asset-id.ts` — `isJemenaAssetId` (strict whole-string), `extractJemenaAssetId` (first match in free text), `extractAllJemenaAssetIds` (de-duped, source order)
- All wired through `src/index.ts` public API.
- 4 corresponding test files, 58 new tests. Full eq-validation suite: 231/231 green.
- `pnpm typecheck` has 3 pre-existing errors in `process-capture.ts` (missing `@eq/ai` workspace dep), unrelated.
- Scheduling Tick 4 in ~20 min. Next: eq-solves-service `/admin/export` — cross-repo work begins here.

## Hard limits (from the loop brief)

- NO npm/git deploys. NO direct Supabase migrations.
- Cross-repo only in eq-solves-service. No SKS NSW Labour, EQ Field, EQ Solves Service Netlify.
- Branch + push + draft PR is OK. NO merges, NO force pushes, NO main pushes.
- Stop and ScheduleWakeup if a real blocker hits. Don't hammer.

## Tick log

### Tick 1 (start ~2026-05-19, evening)

- Explored repo. Found eq-platform monorepo with existing `eq-schemas` (generator, lint) and `eq-validation` (coercers + FK + cross-field-eval) packages.
- Discovered schema drift between parent `schemas/` and `eq-platform/packages/eq-schemas/src/schemas/` (see flag above).
- Locked decision: parent `schemas/` is canonical; tonight's outputs target `types/`, `samples/`, `scripts/` at the parent level + the existing `eq-platform/packages/eq-validation/` for the parser port.
- Built `scripts/gen-types.mjs` — resolves `json-schema-to-typescript` from `eq-platform/node_modules` via `createRequire`, no top-level install required.
- Generated 29 `*.d.ts` files in `types/` + an aggregator `types/index.d.ts`. Spot-checked `maintenance_check.d.ts` — clean output with full enum literals + JSDoc carried through from schema `description` fields.
- Scheduling Tick 2 in ~20 min. Next: sample fixtures.
