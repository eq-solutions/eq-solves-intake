# SimPRO Fixture Smoke — 2026-05-19

**Branch:** `overnight-review-2026-05-19`
**Script:** `eq-platform/scripts/fixture-smoke.ts`
**Run with:** `pnpm tsx scripts/fixture-smoke.ts` from `eq-platform/`

Exercises the EQ Intake spine (parser → mapping → validation, no DB commit) against the three real SimPRO CSV exports in `simpro/`.

---

## Fixtures inventoried

| File | Rows | Entity | Notes |
|---|---:|---|---|
| `simpro/customer_export_2026-05-15_042003.csv` | 267 | customer | 35 columns, quoted commas, mixed phone formats, AU DD/MM/YYYY dates |
| `simpro/customer_contacts_export_2026-05-15_042008.csv` | 393 | contact | 17 columns, every contact joins to a customer by `simPRO Customer ID` |
| `simpro/site_export_2026-05-15_042020.csv` | 544 | site | 28 columns, all `Country = "Australia"` (full word, not ISO code) |

Plus `test-fixtures/` at repo root holds synthetic edge-case CSVs (booleans, dates, phones, states, staff clean+messy) used by unit tests — not exercised here because they're not SimPRO-shaped.

---

## Parser leg — clean across all three

`parseFile()` auto-detected CSV by extension on each fixture. Papa Parse handled the lot:

- **Encoding:** all UTF-8, no BOM
- **Delimiter:** auto-detected `,`
- **Malformed rows:** **0** in any of the three (1,204 rows total)
- **Empty rows skipped:** 0

Quoted fields containing commas (e.g. `"Level 2, 7-9 West Street"`, `"Unit B, 639 Gardeners Road"`) parsed cleanly. No row drops.

---

## Mapping leg — clean

`inferMapping()` (the helper in `intake-demo/src/canonical/commit-canonical.ts`, duplicated inline into the smoke script) resolved nearly every header via `x-eq-source-aliases`:

| Fixture | Source headers | Mapped | Unmapped |
|---|---:|---:|---:|
| customer | 35 | 34 | 1 |
| contact | 17 | 17 | 0 |
| site | 28 | 8 | 20 |

The customer/contact mapping is **production-ready** out of the box. Site looks bad but most of the 20 unmapped columns are by-design — Primary Contact subfields belong on the `contact` entity, Postal Address subfields don't exist on the `site` schema (sites are physical-only in the canonical model).

---

## Validation leg — by fixture

### customer (267 rows)

| | count |
|---|---:|
| valid | 240 |
| flagged | 21 |
| **rejected** | **6** |

**Rejections (all real source-data issues):**
- 4 rows with state/postcode columns swapped — SimPRO IDs 7 (Alfred Imaging), 32 (Equinix Australia), 158 (Unios), 160. State column contains `2020` or `2060` or `6065`, postcode contains the actual state code. → **engine correctly catches.**
- 1 row with `Anthea's` in the Email column → **engine correctly catches** invalid email format. SimPRO export glitch on `zz Test Company`.

**Flags (all 21 are `phone_kept_raw`):**
- 8-digit Sydney landlines without `02` prefix: `9476 3248`, `96599199`, `9922 4500`, `9018 4832`, `88247500`, `9516 1252`
- Literal `TBA`
- Suffixed names: `9566 7023 Christina`

This is the correct "kept the original string, flagged for human review" path — confidence in the AU phone coercer. No false rejections here.

### contact (393 rows)

| | count |
|---|---:|
| valid | 0 |
| flagged | 0 |
| **rejected** | **393** |

**Every contact row rejects with `field_required: customer_id`.** This is expected when running validate() in isolation: the contact schema declares `customer_id` (canonical UUID FK) as required, but the source CSV only has `simPRO Customer ID` which maps to `external_customer_id`. The UUID is stamped onto the row by `commit-canonical.ts`'s `resolveCustomerFk()` step, which runs **after** the customer batch commits and before the contact validate().

Two follow-on rejection patterns surfaced under the customer_id failure:
- **46 rows** also rejected on `last_name` (`field_required` + `field_length_invalid: length:0`) — real data: e.g. `Rafael ` in SimPRO with no surname. Engine correctly catches.
- **4 rows** rejected on email — `field_format_invalid`. These are RFC 5322 display-name format that SimPRO occasionally exports:
  - `John Fisher <jfisher@globalswitch.com.au>`
  - `Chan, Harry <ChanH@ramsayhealth.com.au>`
  - `Collins, DCollinsD@ramsayhealth.com.au`  ← actually malformed (no `<>`)
  - `Kashif ANWAR <kashif.anwar@se.com>`

### site (544 rows)

| | count |
|---|---:|
| valid | 9 |
| flagged | 0 |
| **rejected** | **535** |

**535 rows rejected on `country: coerce_failed`** — every row except the 9 that have an empty Country cell. Cause: SimPRO exports the country as the full word `"Australia"`, but `site.schema.json` defines `country` as ISO 3166-1 alpha-2 (`maxLength: 2`, default `"AU"`). The schema's `x-eq-source-aliases` says `["nation", "country_code"]` — no alias maps `"Australia" → "AU"`.

This is **the single biggest blocker for site imports** from SimPRO.

Two additional small rejection patterns:
- 2 rows on `postcode: pattern_mismatch` — postcode field is something other than 4 digits (e.g. missing in WA Wangara row)
- 1 row on `state: coerce_failed` — same swapped-state-postcode pattern as customer

---

## Categorised findings

### Real bugs in the engine
**None found.** The parser, mapping, coercers, and validators all behaved correctly for the inputs given. Every rejection traces to either real source-data quality or a deliberate schema constraint.

### Missing schema aliases (note, don't fix — schemas are load-bearing)

**Site schema gaps that bite real-world SimPRO data:**
1. **`country` field** has no alias for `"Australia"` and no `x-eq-enum-aliases` to map full country names → ISO codes. Either:
   - Relax `maxLength: 2` and accept `"Australia"`, or
   - Add `x-eq-enum-aliases` mapping `"Australia" → "AU"`, or
   - Add a coercion `country-iso-alpha2` similar to `au-state`
   - **Whichever — this affects 535/544 site rows on a perfectly-formed SimPRO export.**
2. **`Archived`** column from SimPRO maps to nothing. Should arguably feed `active` (with inverse logic — `Archived: true` → `active: false`). Needs a transform spec, not just an alias.
3. **`Public Notes` / `Private Notes`** don't alias to `notes`. Two separate notes fields don't exist on the canonical site, so either join them or pick one.

**Contact schema observation:**
- The `email` coercer doesn't strip `Name <addr@host>` display-name wrappers. Common enough in exported contact lists (4/393 rows in this sample) to be worth a small "extract bracketed address" transform.

**Customer schema observation:**
- `Service Job Cost Centre` column is unmapped. Looks like SimPRO-specific accounting metadata with no canonical home, so probably correct as null.

### Real validation rejections (engine working as designed)
- Customer state/postcode swaps (4 rows) — real SimPRO data glitch
- Customer email contamination (1 row, "Anthea's") — real SimPRO data glitch
- Contact last_name empty (46 rows) — real data quality
- Phone strings that aren't AU phones — flagged + kept raw, not rejected

### Unexpected behaviour
1. **Standalone validate() of contact data rejects 100% of rows.** This is *technically correct* (the canonical FK isn't on the source) but it's a UX trap for anyone testing the validation layer without going through `commit-canonical.ts`. Worth documenting on the contact schema: "expect to chain through resolveCustomerFk() before validate() if your source has an external customer ID."
2. **`Country: "Australia"` rejecting at 98.3% rate on sites.** A canonical schema that rejects the most popular SimPRO export pattern in Australia for an AU-targeting product is a design smell. The schema's default is `"AU"` which is correct; the issue is the lack of inbound coercion from the full word.

---

## What was modified

- **Added:** `eq-platform/scripts/fixture-smoke.ts` — the smoke script
- **Added:** this report
- **No schema changes**
- **No engine changes**
- **No fixes committed** — every observed rejection is either correct engine behavior or a schema-aliases gap the task explicitly told me not to touch

The script imports the parser + validator via relative paths to each package's built `dist/` rather than `@eq/intake` / `@eq/validation`. The `eq-platform` workspace root has no @eq node_modules installed, so the workspace-scope imports don't resolve from `scripts/`. Relative dist paths sidestep that and require `pnpm -r build` to have been run (which it has, per today's session state).

---

## How to re-run

```sh
cd eq-platform
pnpm tsx scripts/fixture-smoke.ts                              # all three fixtures
pnpm tsx scripts/fixture-smoke.ts --fixture customer           # one at a time
pnpm tsx scripts/fixture-smoke.ts --fixture site --max-show 50 # surface more failures
pnpm tsx scripts/fixture-smoke.ts --limit 25                   # first 25 rows of each
```

The script prints to stdout — no files written, no DB calls.
