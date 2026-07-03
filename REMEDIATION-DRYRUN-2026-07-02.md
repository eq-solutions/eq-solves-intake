# SKS Canonical Remediation — Supervised Dry Run

_2026-07-02 · sks-canonical (ehow) · tenant 7dee117c._

> **EXECUTION STATUS (updated same day, on Royce's "go both"):**
> ✅ Migration 057 APPLIED — `app_data.eq_remediation_queue` live on ehow.
> ✅ Review queue POPULATED — 137 pending entries (trade 54, emergency 54, email 14, format 1, link 4, duplicate 10), run_id `steward-run-001-2026-07-02`.
> ⏸ The 19 commits are STAGED, NOT EXECUTED — the session's permission layer blocks autonomous bulk writes to production canonical rows, which is the correct instinct for a first steward run. Ready-to-run, lineage-stamped batches: `sql/steward-run-001-commits.sql` (the 17 unanimous) and `sql/steward-run-001-ghodsi-cunninghame.sql` (the 2 with standing objections). Both attempted batches aborted atomically — zero staff/contact rows were modified.
> The section below is the dry-run analysis as originally produced; all counts were live-verified at analysis time.

## How this was produced

1. Full evidence pull from the live database (staff 81, licences 71, customers 44, contacts 230, sites 272 — format checks run in SQL using the exact validators from `normalize.ts`).
2. Steward ledger built: every flagged record assigned a proposed outcome (commit with evidence, or review queue with reason).
3. **21 proposed commits adjudicated by 3 independent adversarial reviewers each** (evidence lens, alternative-explanation lens, consequence-of-wrong lens). Survival requires ≥2 of 3 upholding at the "obvious call" bar.
4. **5 ground-truth auditors independently re-queried the live database** and checked the ledger's counts and record-level categorisation.
5. A completeness critic checked the whole run for silent drops and unresolved disputes.

Run stats: 69 agents (Claude Fable 5), ~3.0M tokens, 2m 20s. All database access read-only SELECTs.

## Corrections the audit layer forced (reality vs dashboard)

- **Active staff = 67, not 68.** The dashboard's "68 of 68" was stale by the time of this run. Every denominator below uses the live 67.
- **Missing emergency contacts = 54, not 55** (67 active − 13 who have one).
- Missing emails = 14 ✓, invalid formats = 6 ✓, unlinked contacts = 6 ✓ — confirmed exactly by independent re-query.

## WOULD COMMIT — 19 fixes that survived adversarial review

### Trade classification → `electrical` (13 staff, all 3/3 unanimous)

| Staff | staff_id | One-sentence defence |
|---|---|---|
| Harry Barton | 52fa75b3 | Holds NSW electrical licence 487859C (exp 2030) — and no other trade licence. |
| Vincent Costa | 5226a800 | Holds NSW electrical licence 240586C (exp 2026-09). |
| Brian Griffin-Colls | dc71dc2c | Holds NSW electrical licence 327760C plus LVR — a classic electrician stack. |
| Cicero Goncalves Da Silva Junior | 55ea2a14 | Holds NSW electrical licence 469037C (exp 2027). |
| Huon Henne | 337e793f | Holds NSW electrical licence 344493C; cabling registration is supplementary. |
| Jack Cluff | e4ed1290 | Holds electrical licence 304905C (exp 2028). |
| Damon Patrick Francis | 3325269f | Holds NSW electrical licence 453175C — his credential regardless of labour-hire channel. |
| Collin Rhys Toohey | 3c9714bd | Holds TWO electrical licences (NSW + QLD). |
| Rhys Scott | 8d1dfcf1 | Holds NSW electrical licence 371332C — **expires 2026-07-28, 26 days away**. |
| William Jonathan Brown | ff234dfb | Holds NSW electrical licence 401671C. |
| Benjamen Ritchie | 6018d216 | Holds NSW electrical licence 366137C; PM by role, electrician by trade. |
| Mitchell Forsyrh | 7db35cec | Holds NSW electrical licence 304820C; subcontractor via Correct Phase Electrical. |
| Liam Holmgreen | cd55f332 | His own staff record's role field reads "Licensed Electrician". |

### Format and link fixes (6)

| Record | Fix | Panel | Note |
|---|---|---|---|
| Julie Jones (contact, DigiCo) | work_phone `61 0408 109 546` → `0408109546` | 3/3 | Doubled prefix stripped; no digits invented. |
| David Collins (contact, Ramsay) | email `Collins, DCollinsD@…` → `CollinsD@ramsayhealth.com.au` | 3/3 | CSV import mangle; correct address corroborated by a second record. |
| Leon Jong (contact, Ramsay) | work_phone `9433 3807` → `0294333807` | 3/3 | Sydney customer, Sydney exchange; 02 inferred. |
| Sean Ghodsi (contact, Ramsay) | work_phone `9433 3444` → `0294333444` | 2/3 | One reviewer: "02 vs 03 not provable from data" — objection preserved below. |
| Roxanne Banaag (contact, The Mater) | work_phone `9923 7241` → `0299237241` | 3/3 | North Sydney hospital, 992x exchange. |
| Michael Cunninghame (contact, inactive) | link → Ramsay Health Care | 2/3 | One reviewer: Warners Bay Private (Newcastle) is a live alternative. |

**Standing objections (verbatim, for your judgment):** on Ghodsi, one reviewer noted the 02 prefix is inferred from customer geography and Melbourne 9433 exchanges exist; on Cunninghame, one reviewer noted his "Newcastle Region" title makes Warners Bay Private Hospital a competing answer and the record is inactive anyway. Both survived the pre-declared 2-of-3 rule; both are one word from demotion if you'd rather be conservative.

## DEMOTED BY THE PANEL — 2 fixes I proposed that got knocked back (0/3 each)

- **Eric Nguyen trade → "communications"**: his ACRS open-cabling registration equally supports the sibling value "data", and can't rule out electrician-who-holds-cabling-reg. Two values equally justified = not the obvious call. → Review queue with both suggestions.
- **Bhavna Pandian link → Schneider Electric Australia Pty Ltd**: three Schneider entities exist, and her "Cloud & Service Providers" title arguably points at Schneider Electric **IT** Australia instead. → Review queue with that steer.

## REVIEW QUEUE — 135 entries, nothing silently dropped

**Trade (54):** Eric Nguyen (suggest communications *or* data); 9 apprentices (Cardinale, Crowley, De La Fuente, Demamiel, Khreich, Lieu, Moody, Robinson, Su — suggest `electrical`, SKS being an electrical contractor, but per-person unproven); 44 with no trade evidence in any canonical record (Al-Gburi, Alakuzu, Angangan, Asri, Boyd, M. Miller, Brame, Brook-Jackson, R. Brown, Byrne, Cavanough, Chapman, Clohessy, de Biasi, Drinkwater, S. Bramall, Grills, Gross, Hartley, Hussain, Iliev, Ivicevic, Kilpatrick, Konakov, Krikellis, Lay, Lundberg, Maroni, Marston, McKee, Otto, Powell, Quintanilla Rodriguez, Reynolds, Rimmer, Rowe, Ryan, C. Scott, Tregoning, Trusler, Vita Pedrosa, Milmlow, Wheeler, Wilson).

**Emergency contact (54):** every active staff member except the 13 who have one. Not inferable from business records by definition — the defensible path is collection from the staff themselves (an EQ Cards prompt is the natural mechanism). Full name list verified against live data by the audit pass.

**Email (14):** 11 Direct staff get a suggested `first.last@sks.com.au` (pattern proven by 15+ existing mailboxes) but a guessed mailbox is never auto-committed — Nguyen, Hussain, Iliev, Ivicevic, Marston, McKee, Otto, Ryan, Ritchie, Toohey, Vita Pedrosa. 3 Labour Hire staff have no guessable personal email — Alakuzu, Grills, C. Scott.

**Format (1):** Heidi Korff's `+64 21 673 419` is a legitimate New Zealand number the AU-only validator flags; the value should probably stand — the validator is the limitation.

**Links (4):** Ben Dunn, Ben Cheam, Syed Rahi (@ap.equinix.com — five Equinix entities, domain evidence splits 49/13/8/3, not resolvable from data); Bhavna Pandian (three Schneider entities; panel steer: IT Australia).

**Duplicates (8 clusters — flagged only, never merged):** staff pairs sharing a phone: Jack Cluff, Vincent Costa (×2 inactive), William Brown, Yura Konakov, Rhys Scott, Elliot Gross; plus John Angangan (same name, different phone) and Anthony Hartley (same name + same sks.com.au email). Contact pair: David Collings (unlinked, inactive) duplicates David Collins (linked) — identical email once Collins's mangle is fixed.

## Observations (outside remediation scope, flagged separately)

- Huon Henne's LVR ticket shows expiry **2025-10-08** — expired ~9 months — yet the dashboard licence strip read "all current". Possible bug in the licence-expiry read path (55 rows reach the dashboard vs 71 in the table). Spun off as its own task.
- Dave Rimmer has no phone on file (only staff member without one) — phone-completeness wasn't a steward category this run.

## Estimated score impact (current composite formula)

- Commits alone: roughly **62 → 65** (trade rate 0% → 19%).
- Queue fully worked (trades resolved, emergency contacts collected, emails filled): roughly **mid-to-high 70s**. The remaining ceiling is licence coverage (55 records / 67 staff) and the 44 staff with no trade evidence.

## What happens next — two separate go/no-gos

1. **Apply migration `sql/057_remediation_queue.sql`** (drafted, in repo, NOT applied) — creates `app_data.eq_remediation_queue` on ehow so the 135 queue entries have somewhere real to live.
2. **Execute the 19 commits** via `eq_tidy_commit_fixes` (each stamped with an intake_id for full lineage and rollback).

Both need an explicit go. Option: drop Ghodsi + Cunninghame to the queue first (17 commits, zero standing objections).
