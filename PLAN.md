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
- [ ] **Tick 2 — Sample fixtures (`samples/{entity}/{format}.csv\|json`)**
- [ ] **Tick 2/3 — ajv test harness in eq-validation that validates samples → schemas**
- [ ] **Tick 3/4 — Port parser pure-fns from eq-solves-service `delta-wo-parser.ts` into eq-validation + vitest covers**
- [ ] **Tick 4/5 — eq-service `/admin/export` endpoint (worktree, branch, push, draft PR)**
- [ ] **Tick 5/6 — ACB round-trip prototype (`scripts/round-trip-acb.mjs`)**
- [ ] **Last tick — SUMMARY.md + commit + draft PR for eq-intake worktree**

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

---

## 2026-05-20 morning — item §5 follow-up

Picked up item §5 ("first INGEST consumer") from `prompts/03-continue-canonical-spine.md`.

**Attempted:** new admin screen at `/admin/import` on eq-solves-service. Strict, ajv-validated against v1 maintenance_check + check_asset schemas. Mirrored both schemas into `lib/import/schemas/`. Added `lib/import/canonical-{validate,project}.ts`. New `commitDeltaCanonicalAction` projected each parsed row to canonical shape, ran ajv, then INSERTed via Database typed inserts. 7-test round-trip smoke verified parse → project → ajv → DB insert → inline export mirror equality. Landed as PR #177, merged 2026-05-20 ~09:36 UTC and auto-deployed.

**Reviewed with Royce:** he asked the right question — "does this create a maintenance check based on Equinix?" — and pushed back on the language. The strict screen was a duplicate of `/maintenance/import` for the visible end result, and its strictness (no fuzzy match, no inline plan/asset create) was worse than the existing wizard's forgiveness for the real monthly run.

**Reverted to fold:** PR #178 folded the useful bit — persisting the full Maximo payload (priority, work_type, crew_id, target_start/finish, failure_code, problem, cause, remedy, classification, ir_scan_result) onto each `check_asset` row — into the existing `commitDeltaImportAction` + `commitConsolidatedDeltaImportAction`. The /admin/import screen, canonical-validate, canonical-project, schemas mirror, ajv + ajv-formats deps and the round-trip test all removed. Helper extracted as `lib/import/delta-row-mapping.ts` (single-purpose, 17 unit tests on the enum normalisers + full mapping). Merged 2026-05-20 ~10:11 UTC.

**Outcome:**
- check_asset rows created via the monthly wizard now persist 16 columns instead of 5 (the 11 extra Maximo fields).
- /api/admin/export?entity=check_asset returns the wider payload for any row created after PR #178.
- "Schema-gated ingest end-to-end" is still parked. The persistence half is done; the validation gate isn't worth a parallel screen.

**Lesson captured in memory:** see `[[feedback_use_plain_language]]` (jargon habit Royce flagged in the same session) + `[[project_eq_service_canonical_migration]]` (don't build parallel strict importers; fold canonical-shape persistence into the existing surface).

**Next attempt at "canonical layer proves both directions":** ACB workflow ingest, per the locked sequencing in `[[project_eq_service_canonical_migration]]`.
