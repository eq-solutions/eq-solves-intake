# EQ Intake — Sprint Summary (Sprints 1–8)

> Last updated: 2026-05-28  
> All sprints merged to main. Work branched per sprint, merged --no-ff.

---

## What got built

### Sprint 1–3 (foundation, already merged before this session)
- Canonical spine: 42 schemas, `sql/001–027`
- Idempotent upserts on `(tenant_id, external_id)` partial index
- 5 canonical entity types: customer / site / contact / staff / licence
- Staff → licence FK two-pass resolution
- SimPRO rollup: dual browser+CLI engine parity, orphan handling
- RollupDropZone multi-sheet support
- Import progress streaming in CanonicalCommitSection
- Schema lint as pnpm check step

---

### Sprint 4 — PPM schemas + schema drift (`sql/028`)
- 4 new PPM tables: `service_visits`, `service_task_completions`, `asset_test_results`, `asset_defects`
- `asset` backfilled: `condition`, `ppm_frequency`, `defects_summary`, `client_classification`
- `x-eq-primary-key` added to asset / schedule / toolbox-talk schemas
- Chunked commit transactions: 500-row chunks, partial failure recovery

**Why it matters:** These four tables flip SKS from "bookkeeper manually types test results back into the register" to "register is computed from what happened on site."

---

### Sprint 5 — UI hardening + infra SQL + format profiles
**New derive profiles:**
- `equinix-audit-simpro`: Equinix audit CSV → SimPRO job completion. Normalises test types to SimPRO section names, handles column name variants.
- `ppm-sow`: canonical assets → PPM Statement of Work. Pre-populates scheduled tasks by asset type, sorts by criticality.

**UI (CanonicalCommitSection):**
- Pre-commit column mapping preview (shows source→canonical before you hit Save, unmatched columns highlighted amber)
- Download rejected rows as CSV (one click, all rejected rows with reason)

**SQL:**
- `sql/029`: per-tenant rolling-window rate limiting (50 calls/60 min)
- `sql/030`: `eq_get_intake_health` observability RPC (commit counts, error rate, entity breakdown, recent files)

**Scripts:**
- `scripts/migrate-cards-to-canonical.mjs`: idempotent one-shot migration from Cards Supabase → canonical staff + licence rows

---

### Sprint 6 — Bug fixes + export profiles + API intake edge function
**Bug fix (C1):** validate.ts row cap now emits ONE summary rejection entry instead of one-per-skipped-row. Eliminates memory blowup on large imports (a 1M-row import no longer allocates 900k objects).

**New derive profiles (registry now has 12):**
- `asset-register-export`: canonical assets → client-ready asset register (condition, criticality, open defects)
- `site-register-export`: canonical sites → site register (addresses, access instructions, emergency contacts)
- `service-visit-schedule`: canonical service visits → monthly schedule (sorted by date, status priority, cancelled visits last)

**Edge function — `edge-functions/api-intake`:**
- Fourth intake surface: POST canonical rows from any external system
- Bearer JWT auth, tenant_id from user_metadata or request body
- Rate-limited via sql/029 RPCs (429 if exceeded)
- `dry_run` flag: validate without writing
- Returns 200 (full/partial success), 422 (all rows rejected), 429 (rate limit)
- CORS headers for future cross-origin use

---

### Sprint 7 — Tests + schema registry sync
**Derive profile test suite (`eq-format-ui/test/derive-profiles.test.ts`):**
- 131 test assertions across 5 profiles + registry smoke tests
- Covers: column shape, row count, sort order, sort key stripping, edge cases (empty input, null fields, unknown enums), label normalisation

**validate.test.ts:** Updated cap test to assert exactly 1 `cap_exceeded` entry (not N).

**eq-format-ui:** Added vitest infrastructure (package.json, vite.config.ts, tsconfig.json).

**`sql/031_schema_registry_sync.sql`:** Upserts all 33+ canonical entities into `eq_schema_registry` with correct version markers and staleness cleanup. Run after any sprint that changes schemas.

---

### Sprint 8 — Developer experience + final hardening
**`sql/032_api_audit_log.sql`:**
- `app_data.api_intake_calls` table: records every api-intake edge function call
- `eq_record_api_intake_call` RPC: called by the edge function after each request
- `eq_get_api_call_log` RPC: Studio-friendly paginated call log for debugging integrations

**`scripts/apply-migrations.mjs`:**
- Sequential migration runner with tracking table (`app_data.eq_migrations`)
- Idempotent: already-applied migrations are skipped
- `--from` / `--to` flags to apply a range
- `--dry-run` to preview without executing
- `pnpm migrate` / `pnpm migrate:dry` scripts in workspace package.json

---

## Schema count
**46 schemas** across: S1 spine (30) · S2.A Field domain · S3 supplemental seed · 4 PPM entities

## SQL migration count
`sql/001–032` — 32 migrations total

## Derive profile count
**12 profiles** in the registry:
| ID | Input | Purpose |
|---|---|---|
| `bom` | raw | Bill of materials |
| `device-register` | raw | Device register |
| `labour-summary` | raw | Labour summary |
| `equinix-asset-register` | raw | Equinix asset register |
| `equinix-contractor` | raw | Equinix contractor portal |
| `xero-payroll-timesheets` | raw | Xero payroll timesheets |
| `myob-payroll-timesheets` | raw | MYOB payroll timesheets |
| `equinix-audit-simpro` | raw | Equinix audit → SimPRO job completion |
| `ppm-sow` | canonical | PPM Statement of Work |
| `asset-register-export` | canonical | Client-ready asset register |
| `site-register-export` | canonical | Site register |
| `service-visit-schedule` | canonical | Monthly service visit schedule |

## Bug status
| ID | Description | Status |
|---|---|---|
| C1 | 100k row cap silently truncates | **Fixed (Sprint 6)** — single summary entry, no memory blowup |
| C2 | FK misses silently dropped | **Fixed (Sprint 2)** — `fk_no_match` rejections emitted |
| C3 | CLI orphan drops | **Fixed** — orphan site + contact rows surface in output |

## What's NOT done (and why)
| Item | Reason deferred |
|---|---|
| E1: EQ Service write-through adapter | Separate repo (eq-solves-service) — needs explicit instruction per non-negotiables |
| Cards → canonical migration (actual run) | Needs `sks-canonical-eq` Supabase provisioned (billing decision) |
| Sprint 9: Template marketplace | Needs multi-tenant foundation first |
| PostHog / Sentry integration | Config-only change, can be wired when API keys are in env vars |

---

## How to apply SQL migrations

```sh
# Against the SKS NSW canonical Supabase:
node scripts/apply-migrations.mjs \
  --url  $SUPABASE_URL \
  --key  $SUPABASE_SERVICE_ROLE_KEY

# Dry run first to see what would run:
node scripts/apply-migrations.mjs --url $URL --key $KEY --dry-run
```

Or from the `eq-platform/` workspace:
```sh
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm migrate
```
