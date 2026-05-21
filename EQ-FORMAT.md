# EQ Format — the sheet reshape-out package (plus an aspirational cleanup-in vision)

> Read `EQ-AS-CONDUIT.md` first. EQ Format is one of the conceptual doors that feeds the canonical spine. The framing for why it exists lives there.

**Status as of 2026-05-22:** Partially built. The reshape-out direction ships as `@eq/format-ui` with **three SimPRO-quote profiles** — BOM, device-register, labour-summary. The cleanup-in direction described later in this doc is aspirational, not code. Don't read this as "what's about to ship" — read it as "the named moment we'd build for if a real recurring version of that moment shows up."

The earlier framing of EQ Format as "the universal sheet wrangler, both directions" was vision-shaped. Reality is narrower and that's fine.

---

## What's built today — reshape-out only

`@eq/format-ui` ships **three reshape-out profiles**, all sharing one input shape (SimPRO quote CSV):

- **BOM** — procurement Bill of Materials grouped by section + cost centre + description + part
- **device-register** — addressable-device commissioning register (KNX starter set; the same pattern would work for DALI / BACnet / Modbus if a real recurring need lands)
- **labour-summary** — per-section labour hours breakdown

Adding a 4th profile is a single file under `eq-platform/packages/eq-format-ui/src/derive/profiles/` plus an explicit registry entry. No plugin system. No generic adapter layer. The registry stays a hardcoded Map on purpose — that's the brake on N×M scope creep.

The currently-named candidate for a 4th profile (per `PLAN-2026-05-22.md`) is Equinix audit format → SimPRO export. That profile lands when Royce's parallel workstream is ready, not speculatively.

## What's also available today as a desktop fallback

`@eq/intake-demo` takes a SimPRO bundle and emits five destination shapes (SharePoint rollup / Quotes-by-site / Xero ContactsImport / MYOB Card File / Outlook contacts) without an interactive cleanup step. It's the desktop drag-and-drop path, not the on-phone path. For the moments those destination shapes match, it's the value-from-day-one path — but it's owned by `@eq/intake-demo`, not `@eq/format-ui`.

---

## The aspirational cleanup-in direction (NOT built)

Everything below this point is *vision*, not roadmap. If a real recurring version of the moment described here surfaces from an outside-SKS user, this becomes a real build conversation. Until then, it's framing only.

### The named moment

A sparkie or apprentice has knocked together a tag-and-test register on their phone, or in a half-arsed Excel from the ute. Columns are wrong. Asset IDs are inconsistent — "Switchboard 3" in one row, "SB-3" in the next. Dates are dd/mm in some rows and mm/dd in others. Half the test-result fields are blank. They submit it and it's a mess.

That dog-shit attempt is the moment cleanup-in exists for. Not "we'll fix it later in the office" — right now, while the person who made it is still on site or just back in the ute, while the memory of which switchboard they actually meant is still fresh, the app walks them through cleanup. "You've got two different names for the same switchboard, which is it?" "This date looks American, did you mean 4 March or 3 April?" "You missed the test-result column on rows 7-12, want to fill those now or flag for review?"

Output is either a clean record pushed into the canonical spine (and onward to EQ Service / SimPRO / wherever the boss wants), or a tidy-looking submission sheet they can email to the client without embarrassment.

### Design constraints if it ever gets built

- **On-phone, fast.** The person who made the mess is often still on site. If it takes twenty minutes, nobody uses it.
- **Short questions, big buttons, photo-attach, voice-to-text.** Typing on a phone is annoying.
- **"Defer this field for review later"** — a single hard question shouldn't block the whole cleanup. User comes back at their desk to resolve flagged rows.

### What's already in the box that would back a build

The engine pieces exist: validation, FK fuzzy match, signature-hash mapping cache, the `@eq/confirm-ui` flag-and-fix flow. What's missing is a real user with a real recurring version of the moment, and a phone-shaped surface to deliver it through. Both wait.

### Bulk migration as a mode of cleanup-in

The bookkeeper with a five-year SimPRO export and forty thousand rows — they don't want a conversation, they want to say "here, sort it" and walk away. If cleanup-in ever ships, batch mode is a natural sibling: same engine, no interactivity, structured report at the end. Not built today; "EQ Import" was retired as a separate-door name.

---

## Relationship to EQ Cards

EQ Cards is the *first-touch* surface. New users meet EQ through Cards (induction in two minutes, expiry alerts, tap-to-copy onto site forms). When the boys use Cards on the day, there's nothing for Format to clean up — the data is already structured.

The cleanup-in vision is the *graceful-degradation* path for when the boys didn't use Cards. The spreadsheet they sent in instead. The PDF they emailed. The half-arsed register from the ute. Cleanup-in would catch the fall — *if* it ever gets built.

Reshape-out (the three SimPRO-quote profiles) is something else: a one-way emit from a quote document into derived shapes for downstream work. It runs on bundles that came through `@eq/intake-demo`, not on the safety-record path Cards covers.

---

## What EQ Format is not

- **Not a replacement for Excel.** People still author spreadsheets in Excel; if cleanup-in ships, it would make those sheets useful in canonical, but Excel keeps existing.
- **Not a generic ETL tool.** Reshape-out only knows the input shapes its profiles expect (today: SimPRO quote CSV). Adding a new input shape is a deliberate code change, not a config.
- **Not paywalled for safety-critical entities.** If cleanup-in ever ships, the SWMS / prestart / JSA / incident / ITP path is free — same rule as Cards. Niche client export formats are the things that earn their keep commercially. Pricing decisions wait for real usage.
- **Not bidirectional sync.** Reshape-out emits a sheet at a point in time. The user re-runs it when they want a fresh version. No live two-way binding to the client's portal.
- **Not a universal engine.** "The universal sheet wrangler" framing from the original v1 of this doc was aspirational. The build is narrowly scoped on purpose.

---

## Open questions if cleanup-in ever gets built

These don't need answers today. They're parked.

1. **What's the in-mode UI?** Web app, native mobile, or PWA inside Cards' existing shell? The on-phone constraint argues for shared infrastructure with Cards.
2. **Where does the canonical spine live?** Cleanup-in writes to canonical. The canonical Supabase needs to exist first (per `EQ-TENANCY-MODEL.md`).
3. **Which client formats are first for reshape-out?** Equinix is the obvious first target (per `PLAN-2026-05-22.md`). NEXTDC and the data-centre principal contractors next. Each format is bespoke and small — half a day of work per format once a real recurring need lands.

---

## Changelog

- **v2 (2026-05-22):** Reframed against the audit. Vision-vs-reality gap closed: reshape-out (3 profiles) described as the built thing, cleanup-in described as aspirational. "Universal sheet wrangler" framing retired. On-phone-constraint and sequencing sections folded into the "aspirational" section. References to "Sprint 1/2/3" stripped — sprint terminology is dead.
- **v1 (29 Apr 2026):** Initial doc. Captured the dog-shit tag-and-test moment, the bidirectional in/out flows, the bulk-migration mode, the fallback prettify path, the on-phone constraint, sequencing dependencies, and the relationship to Cards. Created in the same session that retired "EQ Import" as a separate named door.
