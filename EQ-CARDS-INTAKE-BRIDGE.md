# EQ Cards ↔ EQ Intake — bridging contract

> Read `EQ-AS-CONDUIT.md` first. This doc is the bridge between the running EQ Cards product (in `C:\Projects\eq-cards`) and the canonical EQ Intake spine being built in this repo.

**Status as of 2026-05-22:** Path A decision still holds (consolidate, one canonical spine). The original sequencing language ("end of Sprint 3 / start of Phase 2") no longer maps to how the work has played out — sprint terminology is dead. Migration triggers on either of: the canonical Supabase getting provisioned, or a second EQ surface needing to read shared user data. Cards stays on its own Supabase project until then.

---

## Why this doc exists

EQ Cards is shipping today on its own Supabase project (`hshvnjzczdytfiklhojz`). EQ Intake is being built on a separate (yet-to-be-created) canonical Supabase project. Cards' own `ARCHITECTURE.md §18` describes a "module-isolated, share-API-between-products" model that contradicts Intake's "one canonical spine, multi-tenant by RLS" model. Cards' `STATUS.md` flags this with a TODO and explicitly says no action until Intake Sprint 1 lands.

This doc captures the decision we've made — and when it gets actioned.

---

## The decision: Path A (consolidate)

The architectural destination is **one canonical spine**. Cards data eventually lives in the canonical Supabase project alongside every other EQ surface. The §18 share-API model is preserved as an export profile for **external** consumers (e.g. Equinix's portal pulling Cards data into their compliance system) but is not used between EQ surfaces. Inside EQ, RLS on the canonical project is how every door reads and writes shared data.

### Why Path A and not Path B (federate)

The whole point of EQ is that a user signs up to Cards and instantly exists in every other EQ surface — no consent flow, no token exchange, no re-import. Path B's federation model adds friction at every cross-product boundary, which is exactly the friction EQ exists to remove. Path A makes the goal a one-liner: one user record in one database, every EQ product reads it.

The trade-offs are real (migration cost, blast-radius concentration, less independence for Cards as a standalone-sellable product) but they are downstream of getting the user-experience goal right.

---

## Migration timing

**Cards keeps running on its own Supabase project until the trigger fires.** The trigger is whichever happens first:

- The canonical Supabase (per `EQ-TENANCY-MODEL.md`) gets provisioned and the first EQ surface starts writing to it
- A second EQ surface needs to read shared user data from canonical (Format, Quotes, Service)

Whichever lands first, that's the cutover window. Until then, none of the spine work touches user data — schemas, validation engine, and AI mapping layer all sit downstream of the canonical project that doesn't yet exist. Cards is unaffected.

The migration itself is one deliberate weekend of work:

1. Provision (or repurpose) the canonical Supabase project.
2. Apply the spine migrations + canonical schemas.
3. Copy Cards' `profiles` rows into the canonical `staff` table (with `role = 'self'` per the schema mapping below).
4. Copy Cards' `licences` rows into the canonical `licences` (or attached-to-staff) shape.
5. Copy Cards' Storage bucket (licence photos) into the canonical Storage bucket, repointing the signed-URL paths.
6. Repoint the Cards app's Supabase client to the new project.
7. Retest the whole Cards flow end-to-end.
8. Inform any pilot users.
9. Tear down the old project once everything is verified for a couple of weeks.

---

## Schema mapping (current → canonical)

From Cards' STATUS.md:

| EQ Cards (today) | EQ Intake canonical |
|---|---|
| `profiles` | `staff` (a Cards user is a staff record where `role = self`) |
| `licences` | (no direct canonical equivalent yet — likely `staff.licences[]` jsonb or a separate `licences` table linked by FK; called when Sprint 1 schema lands) |
| `audit_log` | Subsumed by `eq_intake_row_audit` + `eq_intake_events` |

---

## What's safe to do in Cards during the pause

- Bugfixes on existing code paths
- OCR accuracy polish if real photos surface gaps
- Picking one of the three design directions (Linear / Wallet / Photo-first) and trimming the other two from the codebase
- Real licence-photo testing on a phone
- Piloting two or three real users on what's already built
- Verifying the PostHog event taxonomy keeps firing cleanly
- Doc cleanup

---

## What's not safe to do in Cards during the pause

- **Add new tables or new columns** to `profiles` / `licences`. That widens the migration in proportion. If a real bug forces a column addition, document it here so the canonical schema absorbs it later.
- **Add new canonical entities** (SWMS, prestarts, JSAs, toolbox, incidents, ITPs). Those land in the canonical project from day one, never in Cards.
- **Run the multi-tenant migration** (`tenant_id`, `schema_version` columns). That's spine work; goes in the canonical project.
- **Build the share-redeem endpoint** (Cards `ARCHITECTURE.md §18.2` / §18.3). That's external-consumer work and waits for after the migration.
- **Custom domain `cards.eq.solutions`**. Hold until post-migration so DNS doesn't point at the old project after the cutover.

---

## Cross-check after Sprint 1

When Sprint 1 lands the canonical `staff` schema, immediately diff it against Cards' `profiles` shape. Specific things to check:

1. **Field coverage.** Every field Cards stores has somewhere to land in `staff` — name, email, phone, address (broken into the components the canonical schema wants), date of birth, emergency contact, profile photo path, etc.
2. **Computed properties Cards relies on.** `Profile.isComplete`, `Profile.fullAddress` — still expressible from the canonical shape?
3. **Where licences live.** Cards has them as a separate table. The canonical model may want `staff.licences[]` jsonb for per-staff wallet semantics, or a separate `licences` table linked by FK for cross-staff aggregation. Make a call and document it.
4. **Auth identity.** Cards uses Supabase phone OTP — `auth.users.phone` populated, profile linked by `auth.uid()`. The canonical project will need the same auth model or a deterministic mapping path.

If the diff exposes mismatches, **the canonical schema absorbs the right shape**. We don't bend Cards to fit a worse schema.

---

## What §18 of Cards' ARCHITECTURE.md becomes after migration

`ARCHITECTURE.md §18` in the Cards repo gets rewritten as:

> Cards data lives in the canonical EQ Intake project. This section describes the export profile for **external** (non-EQ) consumers wanting to read a Cards user's wallet via the share-intent flow.

The internal cross-product story (share-tokens, redeem endpoint, destination registration between EQ surfaces) gets removed because it's redundant with RLS on the shared project. The "Settings → Connected apps" surface still ships eventually, but only for external apps the user has granted access to (e.g. Equinix's portal, a principal contractor's compliance system). Internal EQ surfaces don't appear in Connected apps because there's nothing to consent to — they're already inside the same project, gated by tenant membership.

---

## Risks and mitigations

**Migration risk grows with each pilot user added during the pause.** Today Cards has near-zero real users; migration is essentially trivial. With fifty pilot users, it's a real coordination job. *Mitigation:* pilot Cards judiciously during the pause; communicate the migration window with pilot users in advance.

**Schema drift between Cards and the canonical model.** Some fields will mismatch. *Mitigation:* the cross-check after Sprint 1, before any irreversible spine decisions.

**Auth identity mapping.** Cards' phone-OTP auth lives in `auth.users.phone`. The canonical project may want to support email + phone + multi-org membership. *Mitigation:* design the canonical auth model to gracefully accept phone-only users without forcing a backfill.

**Storage migration.** Photos in Cards' Storage bucket need to move with the rows. Signed URLs are 1h-TTL so they re-issue cheaply. *Mitigation:* scripted copy with a verification pass before tearing down the old bucket.

---

## Status log

- **2026-04-29:** Path A decided. Migration deferred until end of Sprint 3 / start of Phase 2. Cards stays on its own Supabase project in pause-and-polish mode. This doc created.
