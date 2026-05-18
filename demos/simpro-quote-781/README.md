# SimPRO quote -> EQ canonical demo

**Source:** `source.csv` (SimPRO export, 16 line-item rows, two pricing options for a stair-light job with KNX programming on Option 2).

**Run:**

```
cd demos/simpro-quote-781
node parse.mjs
```

No deps, pure Node ESM. Three output files appear in this folder.

---

## What the script does

1. Reads the SimPRO quote CSV (handles BOM, quoted thousands-separators).
2. Classifies every row by `Item Type`:
   - `One off Item` / `Prebuild` -> material (becomes a row in BOM, and a row per device in the KNX register if it matches a KNX heuristic).
   - `Labour` -> labour entry.
3. Groups materials by section + cost-centre + part to produce a procurement-ready bill of materials.
4. Expands every KNX-recognised device line into one row per individual device with placeholder commissioning fields and an auto-suggested KNX physical address (`1.1.1` ... `1.1.19`).
5. Rolls up labour by section + cost-centre + description.

## Where this maps to the EQ canonical layer

| SimPRO row type            | Canonical entity   | Where it lands in this demo                          |
| -------------------------- | ------------------ | ---------------------------------------------------- |
| Material (One off / Prebuild) | `asset` (broad sense) | `bom.csv` row + (if KNX) one row per qty in KNX register |
| Labour                     | `schedule` entry   | `labour-summary.csv` row                             |
| Section / Cost Centre      | grouping key       | preserved on every output row for round-tripping     |
| Cost Centre Subtotal       | derived            | reconciles against `bom.csv` totals + labour totals  |

The current demo bypasses the `validate()` engine for clarity. The same mapping
plugs straight into `@eq/validation` once we extend the canonical schemas with
KNX-specific fields (physical_address, group_address, function category). Then
the same input flows through coercion + cross-field validation + commit, with
the same output shape.

## Output files

### `bom.csv` -- procurement-ready

Grouped by `(section, cost_centre, part_number, description)`. Quantities summed,
unit + total costs and sell prices preserved. Drop into a supplier portal or
PO template.

Columns: `section, cost_centre, part_number, description, uom, quantity, unit_cost, unit_sell, total_cost, total_sell`.

### `knx-device-register.csv` -- commissioning placeholder

One row per individual KNX device (the 19 in-wall actuators expand to 19 rows).
Each row has an auto-suggested physical address (`1.1.1` ... `1.1.19`) and
empty placeholder fields the sparkie fills in on site as commissioning happens:
group addresses (main / middle / sub), function description, programmed flag,
tested-by, tested-date, status (default `pending`), free-text notes.

The auto-suggested physical addresses are a starting point only -- ETS will
override based on the project's actual area / line topology. The point is the
sparkie doesn't manually create 19 ETS device entries from scratch.

### `labour-summary.csv` -- hours by cost centre

Distinguishes KNX programming hours (9.5 hrs at the higher KNX rate) from
install hours (57 hrs) from travel hours (20 hrs tradesperson + 20 hrs
apprentice). Useful for variations and post-job profitability.

## Sanity check

Quote sell total reported by the script: **$30,811.33**.

Cost-centre subtotals from the SimPRO export reconcile against the sum of
material totals + labour line totals per cost centre.

## What this isn't (yet)

- Not wired into a UI -- the sparkie still runs a CLI. The user-facing
  surface is what EQ Format becomes in Phase 2.
- KNX device register is a placeholder template, not a live connection to ETS
  or the .knxproj file. Phase 3 candidate.
- BOM doesn't yet emit in any specific supplier format (e.g. Schneider Pro
  Submit, MMEM, Lawrence & Hanson). Each is a half-day export profile once we
  see real examples.
- The KNX heuristic is regex-based on description keywords. Works for the 19
  in-wall actuators in this quote; will need broadening when the friend has
  jobs with sensors / dimmers / IP routers / line couplers / KNX power supplies.

## Generic placeholders used

Per the standing rule (no real client names in outputs), this demo folder is
named `simpro-quote-781` rather than the friend\'s business name. Product
names (Foro 11, Gala, Sealink ferry) appear as in the source export -- those
are supplier / SKU names, not client names.
