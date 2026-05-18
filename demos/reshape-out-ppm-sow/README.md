# reshape-out-ppm-sow — canonical register → next month's SOW

## What this proves

EQ Format is bidirectional. Cleanup-in (messy spreadsheet → canonical) is
demonstrated by [`../simpro-quote-781/`](../simpro-quote-781/). This demo
proves **reshape-out**: canonical data → a real-shaped client artefact.

Specifically: given a Master Asset Register, an annual PPM Schedule, and
this month's visit-day allocation, generate the monthly SOW spreadsheet
that a field crew would actually take to site.

## The pain it removes

Today a coordinator builds this SOW by hand:

1. Open the Master Asset Register
2. Cross-reference the annual PPM Schedule to figure out which services
   are due in May for which sites
3. Look up which crews are assigned to which day
4. Write out a per-day-per-site asset list with task tickboxes
5. Build a per-site summary form for each visit
6. Print everything, hand it to the crew leads

For one client with one site that's twenty minutes. For one client with
four sites it's an evening. For thirty clients it's a full-time
coordinator role.

This script does the same job in <100ms with zero typing.

## Inputs (canonical shape)

- **`register.csv`** — 20 synthetic assets across 4 generic-named sites
  (Site-Alpha, Site-Bravo, Site-Charlie, Site-Delta). Mix of MSB, DB, UPS,
  generators. Real PPM-register columns: asset_id, site, region,
  asset_type, asset_name, make, model, circuits_qty, location,
  ppm_frequency, last_thermal, last_rcd_test, last_service, condition,
  defects_outstanding. Maps cleanly onto `asset.schema.json` (including
  the four fields added in Phase 1 iteration 2: condition, ppm_frequency,
  client_classification, defects_summary).

- **`schedule.csv`** — 9 scheduled services for May 2026. Long format:
  one row per (site × service_type × month × contractor). The canonical
  `service_schedule` entity would back this; today it's a flat sheet.

- **`visits.csv`** — 4 visit-day allocations. The canonical `service_visit`
  entity (parked for Phase 2 in `PHASE-2-3-BACKLOG.md`) would back this.

## Outputs

- **`sow-asset-schedule.csv`** — one row per (visit × asset × applicable
  task). 20 task rows across 4 visits. Each row has tickbox columns for
  every possible task type with `☐` where applicable and `—` where not
  (e.g. an MSB doesn't get an RCD Time Test). Tech_initials and notes
  columns for completion. Same shape as the real SOW Asset Schedule.

- **`sow-summary-<site>.csv`** — one per-site summary form per visit
  (4 files). Header block with date/site/crew + task list + signoff
  rows for the licensed sparkie. Same shape as the real SOW Summary
  template.

## Service → task mapping

The canonical relationship between scheduled services and on-site
tickboxes. Real EQ would store this in a `service_task_completion`
lookup table; here it's hardcoded for the demo.

| Service | Tasks |
|---|---|
| 6 Monthly PPM | Annual DB Maint, MSB Maint, Thermo Test, RCD Time Test |
| Monthly Generator Run Start | Generator Run Start |
| Annual UPS Maintenance | UPS Maint |

## Asset type → applicable task

A task only applies to the asset types that can receive it. An MSB
doesn't get an RCD Time Test (no RCDs); a generator doesn't get an
MSB Maint; etc. The script applies this filter so the SOW only lists
real work.

| Task | Applies to |
|---|---|
| Annual DB Maint | Distribution Board, UPS Distribution Board |
| MSB Maint | Main Switchboard |
| Thermo Test | Main Switchboard, Distribution Board, UPS Distribution Board |
| RCD Time Test | Distribution Board, UPS Distribution Board |
| Generator Run Start | Generator |
| UPS Maint | UPS Distribution Board |

## Run it

```
cd demos/reshape-out-ppm-sow
node derive.mjs
```

Pure Node ESM. No deps. Same shape as the SimPRO/KNX demo.

## Generic placeholder names only

This is a synthetic test fixture. No real client identifiers anywhere —
sites are Alpha/Bravo/Charlie/Delta, crews are A/B, contractors are
"SKS" and "UPS-Subbie" (genericised). The output reads exactly like a
real SOW but you can commit it to git without leaking customer data.

## Why this matters for EQ as conduit

A contractor with thirty data-centre / hospital / council clients runs
a PPM cycle on every one of them every month. The hand-built SOW is the
unit of pain. EQ Format reshape-out turns it into a derived artefact —
the canonical layer is the source of truth, the SOW is just one of
several outputs that get reshaped from it (others: per-client portal
uploads, compliance bundles, payroll exports).

A 5-person crew uses this to save an evening per month. A 200-person
crew uses the same engine, just with more rows. **Same product, deeper
integration as the crew grows. No tiers.**
