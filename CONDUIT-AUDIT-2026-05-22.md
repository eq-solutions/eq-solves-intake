# Audit against EQ-AS-CONDUIT — 2026-05-22

Audit of the 9 surviving root docs + every package under `eq-platform/packages/` + the canonical schemas. Organised by severity. Direct language — if something's bad, it's bad.

The conduit thesis in one line: **EQ is the layer between systems that don't talk to each other. Every feature traces to a specific person and a specific moment of retyping pain. Every row in deserves a row out.**

What follows reads through that lens.

---

## Critical — actively violates the conduit thesis or the no-silent-drops rule

The "every row in deserves a row out" rule is non-negotiable per `EQ-AS-CONDUIT.md` and was learned after the 72-site SimPRO loss on 2026-05-18. Three live violations found.

### C1. `validate()` orchestrator silently drops everything past 100k rows

[eq-platform/packages/eq-validation/src/validate.ts:185](eq-platform/packages/eq-validation/src/validate.ts:185)

```
const limit = Math.min(rows.length, maxRowsToReturn);
for (let rowIdx = 0; rowIdx < limit; rowIdx++) { ... }
```

A 110k-row file loses 10k rows. `total: rows.length` reports the correct count; the bucket arrays only ever hold up to `maxRowsToReturn`. There is no `rejected` record for the overflow. This is the exact pattern the conduit rule exists to prevent.

**Fix:** either reject upfront with a structured `cap_exceeded` reason record for every overflow row, or paginate. Don't silently truncate.

### C2. FK mismatch can land rows in `flagged` or `valid` instead of `rejected` — the 72-site pattern

[eq-platform/packages/eq-intake-demo/src/canonical/commit-canonical.ts:337-346](eq-platform/packages/eq-intake-demo/src/canonical/commit-canonical.ts:337)

In `resolveCustomerFk()`, sites/contacts whose `external_customer_id` doesn't resolve against the customer batch silently fall through without producing a rejection record. If the downstream schema treats `customer_id` as nullable or fuzzy-matchable, the row lands in `flagged_rows` or even `valid_rows` referencing a non-existent customer.

The SimPRO multi-tenant comma-list fix is correct in both engines (we take the first ID from `"31, 32, 208"`) — but if customer `31` is absent from the customer export, the row goes to flagged/valid instead of rejected. That's how 72 sites disappeared in May. The pattern is still live.

**Fix:** FK miss must always produce a `(rejected, reason: fk_no_match)` record. No exceptions for nullable FKs — nullable means "may be absent in the source"; it doesn't mean "may reference a customer that doesn't exist."

### C3. `simpro-customer-rollup` emits orphan sites but not orphan contacts

[demos/simpro-customer-rollup/rollup.mjs:364](demos/simpro-customer-rollup/rollup.mjs:364)

Orphan sites (sites whose customer ID is missing from the customer batch) get bundled into a synthetic `(Unassigned)` customer row in the output — visible, auditable. Orphan contacts are only logged to console: `const orphanContacts = totalContacts - matched`. The contacts themselves never reach the output CSV. SharePoint operator never sees them.

**Fix:** mirror the orphan-site pattern for contacts. Emit to output with an `[orphan]` marker. Same applies to the browser-side twin in `template.ts` per the dual-engine parity rule.

---

## Drift — language or scope that has wandered from the framing

### D1. EQ-FORMAT.md describes a universe; the build is three SimPRO profiles

[EQ-FORMAT.md](EQ-FORMAT.md) opens with "the universal sheet wrangler, both directions" — cleanup-in *and* reshape-out *and* batch mode *and* on-phone interactivity. The reality is much narrower:

- `eq-platform/packages/eq-format-ui/` ships **3 reshape-out profiles only** (BOM, device-register, labour-summary — all SimPRO-quote → something)
- Profile registry is a hardcoded Map with explicit imports — no plugin/discovery system, no N×M expansion mechanism
- **Cleanup-in does not exist** as code. Vision describes on-phone interactive cleanup with voice-to-text and big buttons; the package is desktop drag-drop CSV with grid mapping
- Zero coverage of safety-critical entities (SWMS / JSA / induction)

This is the gap Royce flagged. The *code* is healthier than the vision doc reads. The *doc* needs trimming back to what's actually built, with the rest moved into "things we might do if pain shows up." Replace "universal sheet wrangler, both directions" with "the SimPRO-quote-shape transformer; today three profiles, more when real pain shows up."

**Recommended rewrite:** strip the on-phone-interactivity section unless it's about to ship. Drop "two flows, one engine" framing and describe what exists (reshape-out) honestly. Move the bidirectional vision into a "future" footnote.

### D2. EQ-CARDS-INTAKE-BRIDGE.md sequencing is from a build plan that no longer exists

[EQ-CARDS-INTAKE-BRIDGE.md:30-31](EQ-CARDS-INTAKE-BRIDGE.md:30) says "Migration window: between end of Sprint 3 and start of Phase 2." Sprint 3 was meant to be the AI mapping layer; that work shipped 29 April. Phase 2 was the confirm-UI / Cards bridge — confirm-UI shipped 14 May. The "sprint" frame is dead.

The Path A *decision* (consolidate Cards into the canonical spine) still holds. The sentence "Migration is deferred until end of Sprint 3" should become "Migration is deferred until the canonical Supabase has been provisioned and a second EQ surface needs to read shared user data — whichever happens first."

### D3. README.md cites 5 docs that no longer exist

[README.md:16-47](README.md:16) — the "Read these first, in order" list cites `SESSION-LOG.md`, `SPRINT-1-SETUP.md`, `COWORK-BRIEF-PHASE-1.md`, `CONFIRM-UI-SPEC.md`, `validation/VALIDATION-ENGINE-SPEC.md`. Three are now in `_archive/`; two were deleted; one was never written. Also doesn't mention `EQ-BRIEFING.md` despite the cold-start memory pointer + the deleted `HANDOVER.md` both treating BRIEFING as the primer.

**Recommended rewrite:** new read-order is `CONDUIT → HOW-WE-WORK → BRIEFING → TENANCY → INTAKE-ARCHITECTURE`. Format and Cards-bridge as referenced docs, not read-first. Drop the "What's built" table — it's a snapshot that decays; point at `git log` and the active backlog.

### D4. EQ-BRIEFING.md says "12 canonical JSON Schemas" — there are 30

[EQ-BRIEFING.md:136-138](EQ-BRIEFING.md:136) lists 12 schemas. The repo now has 30 in `schemas/` (per the 19→20 May overnight + 21 May S2.A work). Also says "Intake Module — production-ready" — that claim violates rule #4 of `HOW-WE-WORK-WITH-AI.md` (no "production-ready" without real users). And the "Waiting on Royce (Option C, two Supabase projects)" section dates the doc to a moment that has since shifted (Cards licence canonical landed without those projects existing).

**Recommended rewrite:** swap the dated "Current state" + "Waiting on Royce" sections for a one-paragraph "what's running today, check git log for what's running this week." Keep the modules table, the tenancy framing, and the working-with-Royce rules. Drop "production-ready" wording — replace with "starting point, real running will reveal flaws" per HOW-WE-WORK rule #4.

### D5. `processCapture` exists but isn't wired into any UI

`eq-platform/packages/eq-validation/src/process-capture.ts` orchestrates vision-AI → schema validate → confirm UI. No surface calls it. The `@eq/ai` integration is real (the `parseMaximoPdfWo` skill demonstrated end-to-end on 21 May per memory). But the conduit thesis says "if we can't name the person and the moment, the feature waits." Capture as a generic surface doesn't have a named moment yet — the Maximo skill is the closest, and it's deliberately parked (per memory `project_maximo_eq_service_integration_scope`).

This isn't a code bug. It's drift in the framing: the code shape implies Capture is a Phase 1 surface; the actual decision was "Capture demoted to future-additional" (per the archived COWORK-BRIEF). The orchestrator file should stay (it's useful when a real moment lands); reference to "EQ Capture as a surface" should disappear from the active docs.

---

## Latent risk — fine today, will hurt later

### L1. Every code path runs single-tenant; the per-tenant tenancy model assumes provisioning that hasn't happened

`EQ-TENANCY-MODEL.md` describes per-tenant Supabase as the load-bearing isolation strategy. No tenant Supabase exists. Every test fixture, every demo, every smoke run uses a single in-memory or single-project context. The first moment a second customer's data touches this code, every assumption about `tenant_id` propagation, RLS posture, JWT claim path, and FK scoping gets stress-tested at once.

The JWT claim path is the highest-risk subset — memory `project_canonical_layer_gotchas` notes the tenant_id is at `user_metadata.tenant_id` (nested), and a single careless `claim.tenant_id` lookup leaks across tenants in test. Worth a focused review *before* the first second tenant exists.

**Action:** when the canonical Supabase gets provisioned, do a deliberate cross-tenant RLS test as the first thing. Don't let it be discovered by accident.

### L2. PHASE-2-3-BACKLOG.md is bloated; will compete with the real plan

[PHASE-2-3-BACKLOG.md](PHASE-2-3-BACKLOG.md) lists 30+ items across Phase 2 / 3 / 4 / 5. Several have no named pain — "Template marketplace," "Entity versioning / event sourcing," "Local model deployment for privacy-sensitive tenants," "Mapping suggestions improvement loop." These are "if a customer asks" items.

When Phase 3's plan lands, this backlog will be the source of "but we said we'd do that" pressure. Either trim the unnamed-pain items now or commit to using this as a *graveyard*, not a queue.

The PPM workflow canonical entities (added 29 Apr after Royce read three real PPM files) are the opposite — real-pain-anchored. They shouldn't be lost in the noise.

### L3. Schema drift between `schemas/` (30 entities, the new canonical) and `eq-platform/packages/eq-schemas/src/schemas/` (12 entities, the older copy)

Per memory `project_eq_platform_schema_drift_pending` and the now-archived overnight run notes: the eq-platform monorepo carries 12 schemas that diverge from the parent `schemas/`. Most importantly, `customer` is a different *entity concept* in each (CRM-flavoured in eq-platform, contract-flavoured in the root). The contract `customer` is the canonical decision (Door C: customer ≠ service_contract, per memory `project_door_c_customer_split`).

Today this drift doesn't break anything because the parent `schemas/` powers /api/admin/export and the eq-platform `eq-schemas` package powers the demos. The first time a demo wants to read canonical data via /api/admin/export, the two diverging customer models will collide.

**Action:** sync the contract-customer model into eq-platform's `eq-schemas` package, soft-delete the CRM-customer model. This is a deliberate session, not loop work.

### L4. Prestart and Toolbox-Talk schemas lack lifecycle state

`schemas/prestart.schema.json` and `schemas/toolbox-talk.schema.json` model the content as structured arrays (responses, attendees, actions) — good. But neither has a `status` enum.

SWMS, JSA, Incident, ITP all have full lifecycle enums (draft → active/submitted → ... → archived). Prestart and Toolbox are entity-thinking on content but document-thinking on lifecycle. They look more like "events that happened" than "records with state."

Won't bite today (the data shape is fine for the AI mapping demo). Will bite when Cards or Format starts asking "is this prestart still acknowledged?" or when an audit asks "show me all toolbox talks not yet acknowledged by all attendees."

**Action:** add `status` to both schemas next time someone is in there. Small additive change.

### L5. `xlsx.ts` empty-row skipping is silent; CSV parser surfaces empty + malformed rows

[eq-platform/packages/eq-intake/src/readers/xlsx.ts:138-144](eq-platform/packages/eq-intake/src/readers/xlsx.ts:138) — empty rows trigger `continue` with no reason record. CSV parser by contrast surfaces malformed + empty to `meta.malformed[]`. Inconsistent transparency.

This isn't critical (empty rows are genuinely junk), but it's the same shape as the silent-drop family. A paste from Excel with blank header padding loses those rows with no surfaced trace. Worth a small fix when xlsx.ts is next touched.

---

## Already good — call out so it gets protected

### G1. SWMS, JSA, Incident, ITP schemas are entity-thinking done right

Full lifecycle enums. Structured content arrays (hazards, steps, involved_persons, checkpoints). Cross-field rules enforcing real invariants (`active_needs_signatures`, `injury_needs_involved_person`, `notifiable_must_be_serious`). The `source` field on every safety entity tracks provenance (cards_mobile / import_spreadsheet / capture_pdf) — good audit hygiene.

This is the load-bearing work for any future compliance bundle. Protect it. Resist any future PR that "simplifies" SWMS into a `pdf_url` field.

### G2. `attachment.schema.json` is correctly polymorphic, not the source of truth

`attachment` is a generic file wrapper (entity_type + entity_id) linking storage metadata to a parent record. Each safety entity has an optional inline `attachments[]` array for supporting files, plus an `attachment` row for storage. The safety record is the source of truth; files are evidence. This is exactly the inversion the conduit thesis demands.

### G3. SimPRO multi-tenant comma-list parsing is fixed and parity is maintained

[demos/simpro-customer-rollup/rollup.mjs:199-204](demos/simpro-customer-rollup/rollup.mjs:199) and [commit-canonical.ts:339](eq-platform/packages/eq-intake-demo/src/canonical/commit-canonical.ts:339) both correctly split comma-lists and resolve via the first ID. The dual-engine parity rule (memory `project_simpro_rollup_dual_engine`) is being respected.

### G4. CSV parser surfaces malformed and empty rows to ParseMeta

[eq-platform/packages/eq-intake/src/readers/csv.ts:182-199](eq-platform/packages/eq-intake/src/readers/csv.ts:182) — malformed rows get line numbers + reasons in `meta.malformed[]`. Empty rows counted. This is the model the rest of the intake path should match (see L5 for xlsx.ts).

### G5. The 7-package architecture matches the conduit shape and doesn't over-extend

The seven packages map onto the conduit thesis cleanly:

- `@eq/schemas` — canonical layer source of truth (with codegen for TS/Zod/SQL)
- `@eq/validation` — the shared engine that runs on every intake path
- `@eq/intake` — parsers (the door from raw file → typed rows)
- `@eq/intake-demo` — wires Intake to the canonical via commit-canonical.ts (the SimPRO bundle home)
- `@eq/format-ui` — reshape-out profiles (the door out for SimPRO-shape data)
- `@eq/ai` — vendor-agnostic AI provider
- `@eq/confirm-ui` — the user-facing flag-and-fix UX

There's no `@eq/format-marketplace`, no `@eq/multi-tenant-billing`, no `@eq/admin-dashboard`. The package shape is honest about what's been built.

### G6. The `EQ-AS-CONDUIT.md` framing doc itself

The vocabulary throughout the codebase — including in PR descriptions, commit messages, and PHASE-2-3-BACKLOG — reads like the conduit doc rather than like the original SaaS-positioning artefact `HOW-WE-WORK-WITH-AI.md` describes. The reframe stuck. Most of the work after the 29 April reframe is in the right register. That alone is worth noting because it's the thing that almost didn't survive.

---

## Doc-by-doc quick verdict

| Doc | Verdict |
|---|---|
| EQ-AS-CONDUIT.md | Aligned. No edits needed. |
| HOW-WE-WORK-WITH-AI.md | Aligned. No edits needed. |
| EQ-BRIEFING.md | Drift on specifics (D4). Refresh: drop dated "Current state" + "Waiting on Royce", swap "production-ready" wording, update schema count. |
| EQ-INTAKE-ARCHITECTURE.md | Aligned, with one nuance: the "three doors in" framing still lists Cards / Import / Capture, but EQ Import is retired (became Format's batch mode) and Capture is "future-additional." Worth a small rewrite to say "two doors today (Cards, Format); Capture later when a real moment lands." |
| EQ-TENANCY-MODEL.md | Aligned on framing. Latent risk L1 (no tenants exist yet) is operational not doc-level. |
| EQ-CARDS-INTAKE-BRIDGE.md | Drift on sequencing (D2). One-paragraph fix. Decision (Path A) still holds. |
| EQ-FORMAT.md | Significant drift between vision and build (D1). Needs the most rewriting of any surviving doc. |
| PHASE-2-3-BACKLOG.md | Bloated (L2). Decide if it's a queue or a graveyard. |
| README.md | Out of sync with the cull (D3). Needs the most-changes-fastest rewrite. |

---

## Open question for Royce before Phase 3

The audit surfaces a question that needs your view before the plan can be sharp: **the Maximo PDF skill (memory `project_maximo_pdf_wo_skill`) demonstrated AI-vision-to-canonical end-to-end on 21 May, then got parked.** Capture-as-a-surface is meanwhile soft-deferred. Both decisions are defensible in isolation but together they describe a moment where EQ proved it can absorb a third-party document, then walked away from doing anything with that capability.

Is the parking decision durable, or is it worth one more think? Not asking you to unpark it — asking whether the audit should treat "Capture is deliberately cold" as a settled fact or a thing-to-revisit. I'll default to settled-fact for Phase 3 unless you say otherwise.
