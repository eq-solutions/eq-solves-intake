# Schema vs Real-World Source Gaps — 2026-05-19

**Branch:** `overnight-review-2026-05-19`
**Method:** Systematic cross-reference of all 12 canonical schemas against SimPRO fixtures (`simpro/`), synthetic edge-case fixtures (`test-fixtures/`), and the validation coercers (`eq-platform/packages/eq-validation/src/`). No schemas were modified.

Builds on `SIMPRO-FIXTURE-SMOKE-2026-05-19.md` (one-pass smoke on three real SimPRO CSVs). The country issue called out there was fixed in commit `92a7612` — site.country now has `x-eq-coerce: country-iso-alpha2`.

---

## TL;DR — Top 5 fixes to unblock real-world imports

1. **Site schema: drop the redundant `Primary Contact *` and `Postal *` columns into a transform spec, not just aliases.** 20 of 28 SimPRO site columns are unmapped because Primary Contact subfields belong on a separate `contact` row spawned at commit time, and Postal Address subfields don't exist on the canonical site (sites are physical-only). A `simpro-site` import transform should (a) split each row into one site + one contact, (b) discard or join the Postal/Tax fields. This affects 100% of SimPRO site rows (544/544).

2. **Contact schema: extract bracketed addresses from display-name emails BEFORE validating `format: email`.** SimPRO ships ~1% of contacts as `Name <addr@host>` — RFC 5322 valid as a display-name, but the basic email format check in `validate.ts` requires bare `local@domain`. Either add an email-cleanup coercer (`x-eq-coerce: email`) or strip in the import transform. Affects ~4/393 SimPRO contacts but is a recurring pattern across any source that exports "send-to" addresses.

3. **Customer schema: address `country` lacks the `x-eq-coerce: country-iso-alpha2` hint AND has no `maxLength`.** The site schema was fixed; customer was not. Today `country: "Australia"` passes by accident (no length check), but the canonical model is now inconsistent: site stores `"AU"`, customer stores `"Australia"`. Reporting / cross-entity joins on country will mis-bucket. Adding the coercer aligns customer to the site fix.

4. **Address swap detection — state and postcode get reversed in ~1.5% of SimPRO customer rows.** The state coercer correctly rejects "2020" as a state, but a 4-digit value in `state` plus a 2-3 letter value in `postcode` is a strong signal the columns are swapped. Add a row-level repair hint (try swap, see if both validate) before rejecting. Saves ~4 rows per 267-customer SimPRO export from confirm-UI manual fixing.

5. **`Archived` (SimPRO) → `active` inverse boolean is unhandled.** Across customer, contact, and site schemas, SimPRO ships an `Archived` column (Yes/No semantics) that semantically maps to `!active`. The boolean coercer handles Yes/No fine but there's no alias declaring `Archived` as an inverse of `active`. Either add a transform alias (`{"source": "Archived", "target": "active", "negate": true}`) or extend `x-eq-source-aliases` with an explicit negation marker. Touches every SimPRO customer/contact/site row that has been deactivated.

---

## customer

### Column aliases
- **Adequate** for SimPRO customer headers: all 34 of 35 columns map (γ confirmed). The only unmapped column is `Service Job Cost Centre` (SimPRO-specific accounting metadata with no canonical home — correct to drop).
- **Missing** aliases worth adding (for Xero/MYOB customer master exports — not in current fixtures but expected):
  - `email`: missing `["E-Mail", "Email Address", "EmailAddress"]` (norm collapses non-alphanum to `_` so "Email Address" → `email_address`, not already in aliases).
  - `phone`: missing `["Tel", "Telephone Number", "Phone Number", "Contact Number"]` — current aliases stop at `telephone`.
  - `abn`: missing `["A.B.N.", "ABN Number", "Tax Number"]`.
  - `street_address`: missing `["Address 1", "Addr 1", "Line 1"]` (`address_line_1` is present but the space-variant only catches via fuzzy match, not exact).
  - `company_name`: missing `["Account Name", "Client Name", "Card Name"]` (MYOB convention).

### Value coercers needed
- `country` — **HIGH** — declare `x-eq-coerce: country-iso-alpha2` to match site. Today `default: "Australia"` and no `maxLength` means inconsistency with site (which stores `"AU"`).
- `abn` — no coercer. Real ABNs come as `11 222 333 444`, `11222333444`, `11-222-333-444`. No normalisation today. Acceptable as a string but downstream consumers will have to canonicalise themselves.
- `acn` — same as ABN.
- `currency` — no coercer. SimPRO ships `AUD` (correct ISO). If MYOB/Xero ship `Australian Dollar`, it fails the implicit `maxLength: 3`.

### Required-field gotchas
- `customer_id` is `x-eq-required-on-import: false` — generated on import. Good.
- `tenant_id` is `x-eq-system-managed` — stamped by intake. Good.
- Cross-field `customer_has_a_name` is enforceable but real SimPRO has rows with all three name fields blank (typically deleted-but-not-archived). Engine catches these correctly.

### FK / cross-field notes
- No FK fields. Standalone entity.
- `customer_has_a_name` rule fires correctly — γ saw 0 false rejections.

### Priority: **MEDIUM** — works for 240/267 SimPRO rows out of the box; the gaps are non-blocking (alias misses degrade gracefully via fuzzy match) except for the country inconsistency.

---

## contact

### Column aliases
- **Adequate** for SimPRO contact headers: 17/17 columns map (γ confirmed).
- **Missing** aliases for likely Xero/MYOB contact exports:
  - `email`: alias has `e_mail` but missing `["Email Address", "EmailAddress", "E-Mail Address"]`.
  - `mobile_phone`: missing `["Direct Number", "Direct Line"]`.
  - `work_phone`: missing `["Direct Phone", "Switchboard"]`.
  - `position`: missing `["Job Role", "Title"]` — note `title` is currently aliased to `salutation` on this schema, which is correct for SimPRO ("Contact Title" = Mr/Mrs) but conflicts with sources where Title = Job Title. **Alias conflict risk.**

### Value coercers needed
- `email` — **HIGH** — needs display-name extraction. Current format check rejects `John Fisher <jfisher@globalswitch.com.au>`. Add an email coercer (`x-eq-coerce: email`) that extracts the bracketed address before validating.
- No other coercer gaps — phones use `phone-au`, booleans use `boolean`.

### Required-field gotchas
- **`customer_id` required + FK** — this is the γ-documented 100% standalone-validate failure. Source CSVs only carry `external_customer_id` (SimPRO Customer ID); `customer_id` UUID is stamped by `commit-canonical.ts`'s `resolveCustomerFk()` step. **Document this in the schema description** ("expect to chain through resolveCustomerFk before validate when source has external customer ID") — otherwise anyone running `validate()` standalone will think the schema is broken.
- `first_name` + `last_name` required, `minLength: 1` — 46/393 SimPRO contacts have empty last_name (just "Rafael " with trailing space). Engine correctly rejects. **Possible enhancement:** allow a single-name contact (e.g. `first_name: "Rafael"`, `last_name: null`) by relaxing last_name to nullable when first_name is present. WHS / induction registers regularly carry mononymous workers (subbies known by one name).

### FK / cross-field notes
- `customer_id` FK references `customer.customer_id` with fuzzy match on `customers.company_name` and `customers.external_id`. The resolver in `fk-resolver.ts` handles this correctly per the unit tests.
- No cross-field rules — could use one warning "default_quote_contact && default_invoice_contact && default_statement_contact ⇒ likely the same person flagged in multiple roles."

### Priority: **HIGH** — every batch of contacts ships display-name emails (~1%) AND the required-customer-id pitfall is a UX trap for any new developer running validate() in isolation.

---

## site

### Column aliases
- **Inadequate** for SimPRO site headers: only 8/28 columns map.
- The 20 unmapped columns split into three groups:
  1. **`Primary Contact *` (7 columns)** — Title, First Name, Last Name, Position, Email, Work Phone, Mobile Phone, Fax. These belong on a `contact` entity, not site. Needs a row-split transform at import, not a column alias.
  2. **`Postal *` (5 columns)** — Contact, Address, Suburb, State, Postcode. The canonical site is physical-only (no postal address subfields). Either add postal_* fields to the site schema, or drop them at import. Currently dropped silently.
  3. **Misc (8 columns)** — Zone, Preferred Notification Method, Archived, Part Tax Code, Labour Tax Code, Public Notes, Private Notes.
     - `Archived` → should drive `active` (inverse). See TL;DR #5.
     - `Public Notes` / `Private Notes` → currently no alias to `notes`; would clobber each other if both were aliased. Need import-transform to concatenate or pick one.
     - `Zone`, `Preferred Notification Method`, tax codes → no canonical home. SimPRO-specific. Correct to drop, but worth documenting.

### Value coercers needed
- `country` — **FIXED** in commit 92a7612 (`x-eq-coerce: country-iso-alpha2`).
- `postcode` — `^[0-9]{4}$` pattern. 2/544 SimPRO site rows fail this (e.g. blank postcode in a WA Wangara row). Engine correctly rejects. Could add tolerance for NZ 4-digit postcodes (already pass) and US/UK postcodes if `country` ≠ `AU`, but YAGNI for AU-only product.

### Required-field gotchas
- `name` required + `minLength: 1` — should not be a problem (SimPRO always exports Site Name).
- `active` required + `default: true` — applied via default-application step. Good.
- `site_id` and `tenant_id` system-managed.
- `customer_id` is **NOT** required on site (good — sites can exist without an owning customer at intake time).

### FK / cross-field notes
- `customer_id` FK to `customer.customer_id` with fuzzy match on `company_name` + `external_id`. Same chain-through-resolver pattern as contact.
- `coords_paired` rule: lat+lng must both be present or both null. Real SimPRO rarely populates either, so this is silent.
- `induction_url_when_required` warning: induction_required without induction_url. SimPRO doesn't track this so currently no-op.

### Priority: **HIGH** — 535/544 row rejection issue is fixed, but the column-mapping gap (8/28 = 29% coverage) is a documentation/transform gap, not a code bug. Most customer-side data on a site export is being silently dropped — the user has no idea their Primary Contact info isn't landing anywhere.

---

## staff

### Column aliases
- No SimPRO staff fixture exists yet (SimPRO Service exports are a separate report). Compared against `test-fixtures/staff-clean.csv` and `staff-messy.csv`:
  - **Clean fixture** (`first_name, last_name, email, phone, employment_type, trade, start_date, active`) — exact matches, all map.
  - **Messy fixture** (`Emp #, Name, Mob, Type, Started, Rate, Trade`):
    - `Emp #` → norm `emp_` — **does not match** any alias. Needs `["emp_no", "emp #", "emp"]` on `external_id`.
    - `Name` — combined first+last. Needs a split-name transform (already a known gap — the schema's `x-eq-import-hints` flags this).
    - `Mob` → norm `mob` — **does not match** `mobile`/`phone_number`/`cell`/etc. Needs `["mob"]` on `phone`.
    - `Type` → matches `type` on employment_type. OK.
    - `Started` → matches `started` on start_date. OK.
    - `Rate` → ambiguous. Could be cost or charge. Engine correctly punts to user — the `x-eq-import-hints` explicitly calls this out.
    - `Trade` → matches `trade`. But value is `"Sparkie"` (slang for electrician). Schema has `x-eq-suggested-values` (not enum), so the value is preserved verbatim. Acceptable but doesn't normalize. Could add `x-eq-enum-aliases` mapping `{ "electrical": ["sparkie", "sparky"], "plumbing": ["plumber"], "communications": ["comms"], "carpentry": ["chippy"] }`.

### Value coercers needed
- `hourly_rate_cost` / `hourly_rate_charge` — both `number, null` so the generic number coercer runs. The fixture says `Rate = $45.00`. **Verified:** coerceNumber strips `$`, `AUD`, thousands separators, accounting negatives. No gap here.
- `email`: no `format: email` issues observed; aliases cover `email_address`, `e_mail`, `mail`, `work_email`.

### Required-field gotchas
- `employment_type` required + enum — the messy fixture's `Type=FT` resolves via `x-eq-enum-aliases.employee: ["ft", ...]`. Good.
- `first_name` + `last_name` required + `minLength: 1` — the messy fixture's single `Name` column needs splitting before validation. Schema flags this in import hints but no auto-transform exists.

### FK / cross-field notes
- `default_site_id` FK to `site.site_id` with fuzzy match on `site.name` + `site.code`. Standard.
- Cross-field rules `end_after_start`, `rate_charge_gte_cost`, `inactive_has_end_date` — all reasonable. The `rate_charge_gte_cost` warning would fire on the messy fixture if Rate is interpreted as charge but a cost exists. No real data exposure today.

### Priority: **MEDIUM** — works for clean staff exports, but the messy real-world ones (`Mob` not aliased, `$45.00` currency string, single Name column) all need fixing before EQ Field is broadly usable. Mostly a transform-spec issue, not schema.

---

## asset

### Column aliases
- Asset has the most comprehensive `x-eq-source-aliases` of any schema (~15-25 aliases per major field). No real fixtures to test against — no asset CSV in `simpro/`. Comparing against the schema's own `x-eq-import-hints.common_sources`:
  - "Existing PM contractor's register" (Tag, Description, Manufacturer, Model, Serial, Last PM, Next PM, Frequency) — every column has aliases. Should map cleanly.
  - "Client's facilities export" (Asset No, Building, Floor, Room, Asset Description, Make/Model, Install Date) — `Building`, `Floor`, `Room` map to `location_in_site` aliases. `Make/Model` is a combined field that needs splitting (no transform spec exists).
  - "Hand-built electrical asset list" (Switchboard, Circuit, Description, Amps) — no alias for `Switchboard` (likely → site_id or parent_asset_id depending on context). `Circuit` → no alias.

### Value coercers needed
- `criticality` enum + `x-eq-enum-aliases` — covers 1/2/3/4, p1/p2, tier 1/2/3, very high/high/medium/low. Solid.
- `condition` enum + aliases — covers ok/sat/pass/healthy/etc. Solid.
- `asset_type` is a free string with `x-eq-suggested-values` and `x-eq-enum-aliases` (sb, msb, ups, ahu, crac, etc). Real-world client registers will include types not in suggested list ("RPP-Lite", "ATS-Generator") — that's why suggested not enum. Good.
- `rating` is free text by design.
- `ppm_frequency` is free text. Has a TODO comment about parsing into formal schedule.

### Required-field gotchas
- `asset_id`, `tenant_id` system-managed.
- `site_id` required + FK — typical chain-through-resolver issue. Same pattern as contact.customer_id.
- `asset_type` required — but allows any string. Could be empty in a client export; engine would catch.
- `name` required + `minLength: 1`.

### FK / cross-field notes
- `site_id` FK (required), `parent_asset_id` FK (self-referential), `service_schedule_id` FK to `service_schedule` (entity doesn't yet exist in the 12-schema set — references a future schedule schema).
- Cross-field: `next_after_last` and `warranty_after_install` — both reasonable.

### Priority: **MEDIUM-LOW** — schema looks bullet-proof on aliases (~22 per field in some cases). No fixture data to actually exercise it though. The make/model split-column transform is the only gap that matters; it's documented in import hints.

---

## schedule

### Column aliases
- No fixture. Compared against `x-eq-import-hints.common_sources`:
  - "Wide-format weekly grid" — explicitly flagged as needing `unpivot-wide-grid` transform. Not a column-alias issue.
  - "Long format (Date, Staff, Site, Hours, Task)" — aliases for `date`, `staff`, `site`, `hours`, `task` all present. Should map.
  - "Workbench / SimPRO" (Date, Resource, Job No, Job Name, Hours, Cost Centre) — `Resource` → `staff` (aliased), `Job No` → `site` via external_id resolution. Cost Centre not aliased anywhere.

### Value coercers needed
- `hours_planned`, `hours_actual` are numbers with `minimum: 0, maximum: 24`. coerceNumber will handle `8`, `8.0`, `8h`, `08:00`? Probably not the time-of-day format. Real "Hours" columns in payroll exports sometimes use `08:00:00` for 8 hours. Engine would reject.
- `shift` enum + aliases — solid (d/pm/sat/ah/etc).
- `leave_type` enum + aliases — solid (al, sl, pl, rdo, ph).
- `date` — coerce-date handles all the AU formats per dates-test-cases.csv. Good.

### Required-field gotchas
- `entry_id` not-required-on-import (generated).
- `staff_id` + `site_id` required + FK — must chain through resolveFk.
- `date` required.
- `hours_planned` required + number — if source is text "8", coerceNumber handles it. If source is empty, rejects.

### FK / cross-field notes
- Two FKs (staff, site) plus optional supervisor_id FK to staff. Standard.
- Cross-field: `leave_no_site_required`, `actual_le_24`, `completed_has_actual` (warning).

### Priority: **LOW** — schema is internally consistent and import-hints document the known transforms needed. No fixture stress-test data yet.

---

## swms

### Column aliases
- Very few aliases — these schemas (swms, jsa, prestart, toolbox-talk, incident, itp) are designed to be filled by mobile capture / PDF extraction, not CSV import. The aliases that exist are minimal:
  - `external_id`: `["swms_no", "swms_number", "doc_no", "ref"]` ✓
  - `activity`: `["task", "work", "scope", "description", "job_description"]` ✓
  - `prepared_by`: `["author", "created_by", "prepared", "prepared_name"]` ✓
- **Gap:** importing an existing SWMS register from a contractor's old system would hit alias gaps on every nested array field (hazards, ppe_required, training_competency). But those are typed-array structures — not column-mappable without a transform spec.

### Value coercers needed
- All dates/datetimes use `x-eq-coerce: datetime` or `x-eq-coerce: date`. coerce-date handles a wide range. Good.
- Nested object fields (`hazards`, `signatures`, etc.) require structured input from capture, not CSV mapping.

### Required-field gotchas
- `site_id`, `activity`, `prepared_by`, `prepared_at`, `status` all required. For a SimPRO export there's no SimPRO source for SWMS — these would come from EQ Cards mobile capture or a paper PDF.
- `swms_id`, `tenant_id` system-managed.

### FK / cross-field notes
- `site_id` FK.
- `prepared_by_user_id` FK to user (which isn't in the 12-schema set — references the auth user table).
- Cross-field: `valid_until_after_from`, `active_needs_signatures`, `high_risk_needs_categories`, `hazards_have_controls` — all reasonable for capture-time validation, not import.

### Priority: **LOW** — SWMS isn't a CSV-import target. The schema is fit-for-purpose for mobile capture; import is YAGNI until the first customer asks.

---

## jsa, prestart, toolbox-talk, itp, incident

These five cards-module schemas share the same shape:
- Captured by EQ Cards mobile, EQ Capture (PDF/photo OCR), or EQ Vision — NOT typically CSV-imported.
- Minimal `x-eq-source-aliases` (just the obvious external_id, site, prepared_by/by-name aliases).
- Heavy nested-array structures (checkpoints, hazards, attendees, responses, involved_persons) that need typed input, not column mapping.
- All have a `source` enum stamped by the pipeline (`cards_mobile`, `import_spreadsheet`, `capture_pdf`, etc).

**Per-schema observations:**

### jsa
- Required: `jsa_id, tenant_id, site_id, task_description, prepared_by, prepared_at, steps`. The `steps` array `minItems: 1` requires non-empty.
- Cross-field: `active_needs_signatures`, `high_risk_residual_warn`.
- **Priority: LOW.**

### prestart
- Required: `prestart_id, tenant_id, site_id, date, completed_by, responses`.
- Cross-field: `no_answers_means_hazards` (warning).
- `responses[].answer` enum is `["yes", "no", "n/a"]` — case-sensitive lowercase. If a paper-form OCR returns "Yes", "Y", etc., it would fail. coerceEnumAlias doesn't apply because the items schema has no `x-eq-enum-aliases`. **Worth adding** enum aliases for these mobile/OCR sources: `{ "yes": ["Yes", "Y", "YES"], "no": ["No", "N", "NO"], "n/a": ["NA", "N/A", "not applicable"] }`.
- **Priority: LOW-MEDIUM** if EQ Capture is going to OCR paper prestarts.

### toolbox-talk
- Required: `talk_id, tenant_id, site_id, topic, delivered_by, delivered_at, attendees`. `attendees` `minItems: 1`.
- **Priority: LOW.**

### itp
- Required: `itp_id, tenant_id, site_id, itp_reference, checkpoints, performed_by, performed_at`. `checkpoints` `minItems: 1`.
- `checkpoints[].result` enum is `["pass", "fail", "n/a", "hold", "witness_required"]`. Same OCR-uppercase issue as prestart — common in test reports to see `PASS` / `FAIL`. Add enum aliases.
- Cross-field `instrument_calibration_recent` hard-codes `>= '2025-01-01'` — **time bomb**. This rule will silently start failing every year. Should be a computed "within 12 months of today" rule, not a string literal.
- **Priority: MEDIUM** because of the calibration-date time bomb.

### incident
- Required: `incident_id, tenant_id, site_id, incident_type, occurred_at, reported_by, description`. `description` `minLength: 10` — would reject "fell" or "tripped" one-word reports. Reasonable for a formal record but tight for quick mobile capture.
- `incident_type` enum has aliases (i, nm, ho, fa, etc).
- `severity` enum has aliases (1-4, low/med/high/extreme, etc).
- Cross-field rules are well-thought-out (notifiable_must_be_serious warning, injury_needs_involved_person error, lti_severity warning, reported_after_occurred error).
- **Priority: LOW.**

---

## Summary table — by priority

| Schema | Priority | Real-world rows affected | Primary gap |
|---|---|---|---|
| **site** | HIGH | 100% of SimPRO sites (544/544) drop Primary Contact data | Need row-split + Postal transform |
| **contact** | HIGH | ~1% of any contact source, plus 100% standalone validate trap | Display-name email coercion + doc the FK chain |
| **customer** | MEDIUM | All sources where country is full word vs ISO | Country coercer + inverse-Archived |
| **staff** | MEDIUM | Hand-built rosters (most subbies) | `Mob` alias + Name-split transform + currency strip |
| **asset** | MEDIUM-LOW | None (no fixture) | Make/Model split-column |
| **itp** | MEDIUM | 100% in 2026, growing each year | Hard-coded calibration date is a time bomb |
| **prestart** | LOW-MEDIUM | Whenever Capture OCRs paper prestarts | Enum-alias yes/no/n-a |
| **schedule** | LOW | None (no fixture) | None significant |
| **swms** | LOW | None (not imported) | None |
| **jsa** | LOW | None (not imported) | None |
| **toolbox-talk** | LOW | None (not imported) | None |
| **incident** | LOW | None (not imported) | None |

---

## Coercer-level cross-cutting observations

Independent of any single schema:

1. **Currency-string coercion is in coerceNumber, not a separate field-level coercer.** `coerce-number.ts` already strips `$`, `€`, `£`, `AUD`, accounting parens `(123.45)`, and `%` (with decimal conversion). Hourly rates from `staff-messy.csv` (`$45.00`) coerce cleanly. Not a gap — but worth noting that fields with `x-eq-coerce: number` get this for free, while string fields that happen to be currency strings (none in the canonical model today) would not.

2. **No phone-AU vs phone-international decision.** All phone aliases use `phone-au` coercer. SimPRO sites with international primary-contact phones (data centres with Singapore/HK contacts on AU sites — Equinix, etc.) would hit the `permissive` keep-raw path. Acceptable for now but worth flagging.

3. **No email coercer.** `format: email` does the basic check, but display-name extraction (`Name <addr>`), trailing periods, and surrounding whitespace aren't handled. Would be a single coercer reusable across customer.email, contact.email, staff.email, site.site_contact_email.

4. **No `negate` semantic in aliases.** `Archived` → `!active` requires a transform layer. Could be expressed in-schema with something like `x-eq-source-aliases-negated: ["archived", "deleted", "removed"]`.

5. **Cross-field rules with hard-coded dates will rot.** `itp.instrument_calibration_recent` uses a literal `>= '2025-01-01'`. This pattern shouldn't exist anywhere — use a function like `withinMonths(date, 12, today)`.

6. **`x-eq-foreign-key` is consistently declared but the standalone `validate()` doesn't run the resolver unless `fkLookup` is supplied.** That's correct design (validation package is DB-agnostic) but causes the 100%-rejection trap on contact/asset/incident/etc. when running validate() in test isolation. Worth documenting prominently.
