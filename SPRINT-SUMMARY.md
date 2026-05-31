# EQ Intake — What Got Built

> Last updated: 2026-05-29
> All work merged to main across two repos: `eq-intake` and `eq-solves-service`.

---

## The point of this work

The canonical layer is the product. EQ apps are replaceable interfaces that read and write to one source of truth. This sprint series built that source of truth and wired EQ Service into it.

---

## What is live and useful today

### Canonical Supabase (sks-canonical — ehowgjardagevnrluult)

**Tables with real data:**
- `customers` — 128 rows
- `sites` — 52 rows
- `staff` — 50 rows
- `assets` — 1000 rows (with `condition`, `ppm_frequency`, `criticality`, `last_service_date`, `next_service_due`)
- `licences` — 3 rows

**PPM tables (live, empty — populated by EQ Service write-through):**
- `service_visits`
- `service_task_completions`
- `asset_test_results`
- `asset_defects`

**RPCs callable from Studio today:**
- `eq_ppm_asset_status(tenant_id, site_id?)` — per-asset compliance snapshot
- `eq_ppm_site_summary(tenant_id, site_id?)` — per-site health, open defects, next visit
- `eq_ppm_overdue_assets(tenant_id, days_overdue?)` — assets past due sorted by criticality
- `eq_ppm_open_defects(tenant_id, severity?)` — open defects with age in days
- `eq_ppm_visit_completion_rate(tenant_id, from_date?, to_date?)` — task completion per visit

---

### EQ Service write-through (eq-solves-service — live at service.eq.solutions)

Every time a technician does work in EQ Service, the relevant record syncs to canonical:

| EQ Service action | Canonical table populated |
|---|---|
| Asset created / updated | `asset_test_results` via `syncAsset` |
| Test record saved (generic) | `asset_test_results` via `syncTestResult` |
| RCD test saved & marked complete | `asset_test_results` via `syncTestResult` |
| Defect raised | `asset_defects` via `syncDefect` |
| Defect status changed | `asset_defects` via `syncDefect` |

All syncs are fire-and-forget — EQ Service never blocks on canonical being reachable.

Key file: `lib/canonical-sync.ts` — `syncAsset`, `syncTestResult`, `syncDefect`, plus external-ID helpers (`eq-service:asset:<id>`, `eq-service:rcd_test:<id>`, etc.)

---

### eq-intake (canonical intake engine)

**What it does:** Parses structured files (CSV, XLSX, SimPRO exports) and commits rows to the canonical Supabase via RPCs.

**Four intake surfaces:**
1. `RollupDropZone` — browser drag-and-drop, multi-sheet XLSX
2. `CanonicalCommitSection` — browser canonical commit with mapping preview + rejected-row CSV download
3. `scripts/migrate-cards-to-canonical.mjs` — one-shot CLI migration (Cards → canonical)
4. `edge-functions/api-intake` — POST endpoint, Bearer JWT auth, rate-limited, `dry_run` flag

**SQL migrations (sql/001–035):**
- 001–027: canonical spine — customers, sites, contacts, staff, licences, RPCs, RLS
- 028: PPM tables on canonical
- 029: per-tenant rate limiting (50 calls / 60 min rolling window)
- 030: `eq_get_intake_health` observability RPC
- 031: schema registry sync
- 032: `api_intake_calls` audit log
- 033: `eq_exec_sql` RPC (service_role only, used by migration runner)
- 034: 5 PPM report RPCs
- 035: (contains materialized views — **not applied to sks-canonical**, dropped as premature)

**Migration runner:** `scripts/apply-migrations.mjs` — sequential, idempotent, `--dry-run` flag. `pnpm migrate` from the workspace root.

**Derive profiles (12):**

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

**Test coverage:** 131 assertions across all 5 canonical profiles + registry smoke tests (`eq-platform/packages/eq-format-ui/test/`).

---

## What is NOT built yet

| Item | Why not |
|---|---|
| PPM dashboard UI | No `/ppm` page exists in EQ Service. Build this before adding any more backend. |
| Cards → canonical migration (actual run) | Needs `sks-canonical-eq` Supabase provisioned (billing decision) |
| PostHog / Sentry wiring | Config-only, wire when API keys are ready |
| Materialized views for PPM | Dropped — premature without a dashboard. Add them if the live RPCs are too slow once a UI exists. |

---

## Known CI issues (eq-solves-service, pre-existing)

- `SUPABASE_ACCESS_TOKEN` GitHub secret expired — Data Quality workflow 401s on every push. Rotate in GitHub → Settings → Secrets.
- 4 moderate npm vulns remain (uuid chain through exceljs/svix/resend) — require breaking changes to fix, deferred.

---

## How to apply SQL migrations

```sh
node scripts/apply-migrations.mjs \
  --url  $SUPABASE_URL \
  --key  $SUPABASE_SERVICE_ROLE_KEY

# Dry run:
node scripts/apply-migrations.mjs --url $URL --key $KEY --dry-run

# From the eq-platform workspace:
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm migrate
```
