# Canonical entity sample fixtures

Realistic input fixtures for the canonical schemas in `../schemas/`. Two flavours per entity (where applicable):

- **`{entity}-messy.csv`** — what real data looks like *before* the import pipeline touches it. Mixed header conventions, alias names (per the `x-eq-source-aliases` keys in the schema), inconsistent date/phone/boolean formats, edge cases mentioned in `x-eq-import-hints.watchouts` for that schema. Not directly schema-valid — these are the *inputs* to the import pipeline.
- **`{entity}-clean.csv`** or **`{entity}-clean.json`** — canonical canonical-shape data. Column names match schema property names, types are coerced, enums are normalised. These validate clean against the schema (see `../eq-platform/packages/eq-validation/test/samples-validation.test.ts`).

JSON is used for entities with nested children (tests with reading/check-item arrays, RCD boards with circuits). CSV is used for everything flat.

## Run the validation harness

```sh
cd eq-platform/packages/eq-validation
pnpm test -- test/samples-validation.test.ts
```

The harness:
1. Auto-discovers every `*-clean.{csv,json}` in this directory.
2. Loads the matching schema from `../../../../../schemas/{entity}.schema.json`.
3. CSV: parses each row, coerces values to match the schema's declared `type` per column, injects placeholder `tenant_id` and primary-key UUID where the schema requires them.
4. JSON: validates the parent shape, then strips known child arrays (`visual_check_items`, `electrical_readings`, `circuits`) and validates each one against its child schema.

If a fixture stops validating against its schema, you'll see it fail here first — the test names match the filename.

## Adding a new entity

1. Pick a realistic header set from your source system. Put it in `{entity}-messy.csv`.
2. Hand-translate to the canonical shape, one row per logical record. Save as `{entity}-clean.csv` (or `{entity}-clean.json` if nested).
3. Run the harness. The new fixture should be picked up automatically.
4. If validation fails, the harness reports the ajv errors — usually a missing required field or a type-coerced cell that the schema wants as something else.

## What's covered today

Generated 2026-05-19 in the overnight loop. Fixtures present for: customer, contact, maintenance_plan, maintenance_plan_item, maintenance_check, check_asset, check_item, contract_scope, pm_calendar, defect, attachment, acb_test (+ children), nsx_test (+ children), rcd_test (+ circuits).

Not covered yet (lower-priority, separate session): asset, site, staff, incident, itp, jsa, prestart, schedule, swms, toolbox-talk. These have older fixtures under `eq-platform/packages/eq-validation/test/fixtures/` that the existing tests already exercise.
