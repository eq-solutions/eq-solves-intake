# EQ Format — the universal sheet wrangler

> Read `EQ-AS-CONDUIT.md` first. EQ Format is one of the doors that feeds the canonical spine. The framing for why it exists lives there.

**Status:** Not built. Phase 2 deliverable, sequenced after the canonical schemas (Sprint 1), the validation engine (Sprint 2), and the AI mapping layer (Sprint 3) have landed.

---

## The named moment

A sparkie or apprentice has knocked together a tag-and-test register on their phone, or in a half-arsed Excel from the ute. Columns are wrong. Asset IDs are inconsistent — "Switchboard 3" in one row, "SB-3" in the next. Dates are dd/mm in some rows and mm/dd in others. Half the test-result fields are blank. Two photos ended up in the wrong cells. They submit it and it's a mess.

That dog-shit attempt is the moment EQ Format exists for. Not "we'll fix it later in the office" — right now, while the person who made it is still on site or just back in the ute, while the memory of which switchboard they actually meant is still fresh, EQ Format walks them through cleanup. "You've got two different names for the same switchboard, which is it?" "This date looks American, did you mean 4 March or 3 April?" "You missed the test-result column on rows 7-12, want to fill those now or flag for review?"

Output is either a clean record pushed into the canonical spine (and onward to EQ Service / SimPRO / wherever the boss wants), or a tidy-looking submission sheet they can email to the client without embarrassment.

---

## Two flows, one engine

EQ Format does both directions:

**In — cleanup of messy sheets coming in.** Interactive, conversational, on-phone, while-fresh. Single artefact, often small, often messy. Recognises what the sheet is supposed to be (tag-and-test register, prestart, asset list, timesheet, SWMS attachment list), maps the user's columns to canonical fields, asks about ambiguities, validates, commits.

**Out — reshape canonical data into someone else's shape.** Take a clean record that already lives in the spine (a SWMS that was approved, a staff member's profile, a list of assets at a site) and emit it as a sheet shaped the way a third party wants it. Equinix's audit pack format. NEXTDC's variation register. A hospital's compliance evidence bundle. A staff payslip-shape summary. A customer report.

Same engine — schema comprehension, validation, AI mapping — different surface and different direction.

---

## Bulk migration is a mode, not a separate door

The bookkeeper has a five-year SimPRO export. Forty thousand rows. They don't want a row-by-row conversation; they want to say "here, sort it" and walk away. That's EQ Format in batch mode. Same engine, no interactivity, accepts longer processing time, returns a structured report at the end of "this many rows ingested cleanly, this many flagged for review, here's why."

Earlier docs called this "EQ Import" as a separate door. It's not — it's a mode. Removing the duplication keeps the model simpler and the user's mental model honest: there's one tool for working with sheets, with two interaction styles depending on the size of the job.

---

## The fallback prettify path

Even before deep integrations exist, EQ Format earns its keep with a low-bar version: take a dog-shit attempt and give back something that doesn't embarrass the person submitting it. Consistent column headers, consistent date formats, consistent asset IDs, gaps clearly marked. They email the client a tidy sheet. Same artefact, less shame.

The deeper integration ("and also push it into SimPRO and Equinix's portal") layers on top once the door-out side is wired. The prettify path means EQ Format has value from day one without waiting for every integration to ship.

---

## On-phone constraint for in-mode interactivity

The person who made the mess is often still on site. The interactive cleanup has to work on a phone, fast. If it takes twenty minutes, nobody uses it.

Design implications: short questions, big buttons, photo-attach capability, voice-to-text for fields where typing on a phone is annoying, and a "defer this field for review later" option so a single hard question never blocks the whole cleanup. The user can always come back at their desk to resolve flagged rows.

Batch mode (the migration use case) is desktop-friendly because the bookkeeper running a five-year migration is already sitting at a screen.

---

## Sequencing — what has to land first

EQ Format depends on three things being real:

1. **Canonical schemas** (`packages/eq-schemas`) — Sprint 1, in flight. Without these, Format has nothing to map *into*.
2. **Validation engine** (`packages/eq-validation`) — Sprint 2. Coercion, FK resolution, cross-field rules. The reason Format can recognise what a sheet is and what's broken about it.
3. **AI mapping layer** (`packages/eq-ai`) — Sprint 3. Column-mapping AI is what handles "the user's columns are weird and inconsistent." Sets up the signature-hash cache so repeat shapes don't pay the AI cost twice.

After those three land, EQ Format is the first user-facing surface that exercises the whole stack end-to-end. Likely Sprint 4-5.

---

## Relationship to EQ Cards

EQ Cards is the *first-touch* surface. New users meet EQ through Cards (induction in two minutes, expiry alerts, tap-to-copy onto site forms). When the boys use Cards on the day, there's nothing for Format to clean up — the data is already structured.

EQ Format is the *graceful-degradation* path for when the boys didn't use Cards. The spreadsheet they sent in instead. The PDF they emailed. The half-arsed register from the ute. Format catches the fall.

Both feed the same canonical spine. Both read from it for things like "who is this user, what licences do they hold, what site are they on."

---

## What EQ Format is not

- **Not a replacement for Excel.** People still author spreadsheets in Excel; Format is the layer that makes those sheets useful in the canonical spine and exports back to client formats.
- **Not a generic ETL tool.** Format only knows the canonical entities (staff, sites, assets, SWMS, prestarts, JSAs, toolbox-talks, incidents, ITPs, schedule). If a sheet doesn't map to any of those, Format declines and tells the user what it does recognise.
- **Not paywalled for safety-critical entities.** The cleanup-in flow is free for SWMS, prestarts, JSAs, incidents, ITPs — same rule as Cards. Niche client export formats and bulk-migration speed are the things that earn their keep commercially. Pricing decisions wait for real usage.
- **Not bidirectional sync.** Reshape-out emits a sheet at a point in time. The user re-runs it when they want a fresh version. No live two-way binding to the client's portal.

---

## Open questions to settle when build starts

These don't need answers today, but the day Format is built they will:

1. **What's the in-mode UI?** Web app, native mobile, or PWA inside Cards' existing shell? The on-phone constraint argues for shared infrastructure with Cards.
2. **Where does the canonical spine live?** EQ Format reads from and writes to the canonical Supabase project. Cards' migration into the canonical project (per `EQ-CARDS-INTAKE-BRIDGE.md`) needs to happen before Format ships.
3. **Which client formats are first?** Equinix is the obvious first target — that's the proving ground. NEXTDC and the data-centre principal contractors next. Each format is bespoke and small — half a day of work per format once the engine exists.
4. **What's the batch-mode UI?** A drop-zone with progress and a structured report at the end is the simplest version. CSV upload, paste, drag-and-drop a workbook. No fancy real-time UI needed.

---

## Changelog

- **v1 (29 Apr 2026):** Initial doc. Captures the dog-shit tag-and-test moment, the bidirectional in/out flows, the bulk-migration mode, the fallback prettify path, the on-phone constraint, sequencing dependencies, and the relationship to Cards. Created in the same session that retired "EQ Import" as a separate named door.
