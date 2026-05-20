# Continue: EQ Service ↔ EQ Core canonical migration

**Use this prompt when:** picking up the canonical-spine work after the 2026-05-19/20 overnight loop landed v1 schemas + `/api/admin/export` to production.

**Author:** Claude (Opus 4.7), with Royce's "10/10" framing. Last updated 2026-05-20.

---

## 0. The two-sentence summary

You are continuing work on the **EQ canonical layer** — a shared JSON Schema spec (in `eq-solves-intake/main`) that every EQ product reads from and writes to. The schemas are live and a read-only `/api/admin/export` endpoint serves real SKS production data in that shape from `eq-solves-service.netlify.app`. Your job is to pick the next piece of open debt or extension work and ship it cleanly without breaking what's live.

## 1. Royce is the user — internalise this BEFORE anything else

```
   ❌ NEVER frame work as:
       "wait for a real user / consumer to validate"
       "this is plumbing without water"
       "build a UI consumer first to test the schemas"

   ✓ Royce IS the user, the consumer, the architect.
     He has run Equinix data centre maintenance, Jemena RCD programmes,
     Ramsay healthcare contracts and SKS NSW operations for years.
     The schemas / lifecycle states / contract templates encode
     workflows he ALREADY does each month — by hand, in spreadsheets.
     The job is to encode those into running software.
```

This framing has been corrected multiple times in past sessions. Save the team the friction — start from this assumption. Memory entry: `[[feedback_royce_is_the_user]]`.

## 2. Read these FIRST, in this order

```
Memory (always in context):
  C:\Users\EQ\.claude\projects\C--Projects-eq-intake\memory\MEMORY.md
    └─ project_eq_intake_substrate_v1.md   ← state snapshot
    └─ project_door_c_customer_split.md    ← locked architectural decision
    └─ project_admin_export_endpoint.md    ← live endpoint reference
    └─ project_eq_platform_schema_drift_pending.md ← open debt
    └─ feedback_royce_is_the_user.md
    └─ loop_cadence.md  (if running autonomous /loop)
    └─ feedback_long_session_fatigue.md

Working docs (repo files):
  C:\Projects\eq-intake\PLAN.md     ← overnight tick-by-tick log
  C:\Projects\eq-intake\SUMMARY.md  ← elevator summary of what landed

Canonical source of truth:
  C:\Projects\eq-intake\schemas\*.schema.json  (30 files, v1+v2)

Live consumer:
  https://eq-solves-service.netlify.app/api/admin/export
  https://github.com/Milmlow/eq-solves-service/blob/main/app/api/admin/export/route.ts
  https://github.com/Milmlow/eq-solves-service/blob/main/lib/admin/canonical-export.ts
```

If anything in this prompt contradicts memory, **memory wins** — it may have been updated since this prompt was written.

## 3. The open debt, prioritised

```
  Priority   What                                         Unlocks for Royce          Time   Risk
  ────────   ──────────────────────────────────────────  ─────────────────────────  ─────  ──────
  ★ HIGH     1. ajv-validate the live endpoint output    Proves the canonical       ~10m   ★      
                vs the v2 customer schema                  shape SHIPS correctly                  
                                                          (not just compiles)                    
                                                                                                  
  ★ HIGH     2. Add CI to eq-solves-intake repo          Stops anyone (including    ~30m   ★      
                (ajv lint + gen-types + tests)             autonomous agents) from                 
                                                          pushing broken JSON                    
                                                                                                  
  ★★ MED     3. Fill the 8 stub exporters in             Every entity Royce ingests ~2-3h  ★★     
                /api/admin/export                          monthly becomes queryable               
                (contact, attachment, maint_plan,         in canonical shape                     
                 maint_plan_item, contract_scope,                                                
                 pm_calendar, nsx_test, rcd_test)                                                
                                                                                                  
  ★★ MED     4. Resolve eq-platform/eq-schemas drift     eq-shell + eq-confirm-ui   ~2-4h  ★★★    
                (see project_eq_platform_schema_drift_     stop running on stale                  
                 pending for the 3 options)                customer / contact shapes              
                                                                                                  
  ★★★ HIGH   5. Wire the first INGEST consumer:          The point of the whole     ~4-8h  ★★★    
                pick ONE workflow Royce does monthly       canonical layer.                       
                by hand (Delta WO xlsx, Jemena RCD         ONLY do this once 1-4                   
                multi-tab, ACB test sheet, contract        are unlocked.                          
                scope reconciliation) and wire it                                                  
                end-to-end through eq-validation                                                  
                                                                                                  
  LOW        6. Physical DB split — migrate                Removes derivation       ~2-4h  ★★★★   
                customers.contract_* into a real           heuristic in                            
                service_contracts table                    exportCustomer                         
                NEEDS EXPLICIT AUTHORISATION                                                      
                                                                                                  
  LOW        7. Write ADRs for the locked decisions       Future Royce / future     ~1h    ★      
                (Door C, lifecycle derivation,             collaborators don't                    
                 contract_scope dual-FK)                   re-litigate                            
                                                                                                  
  LOW        8. Fix process-capture.ts pre-existing       Clears CI noise           ~30m   ★      
                typecheck errors (missing @eq/ai dep)                                              
```

### Recommended sequencing

Items 1 and 2 are no-brainers — under an hour combined, both lock down what's already shipped. Do these first regardless of which bigger thing comes next.

After that, **ask Royce which monthly pain he wants to feel less of next.** That picks between items 3, 4, 5. Don't pick for him — this is the consumer-frame question.

## 4. Hard limits (do NOT cross without explicit per-action authorisation)

```
   ✗ NO deploys to any production Netlify site, even via merge
     to main. EVERY merge to main on eq-solves-service auto-deploys.
     Confirm BEFORE merging anything that would deploy.

   ✗ NO direct Supabase migrations without a dedicated session.
     The DB physical split (item 6) needs its own focused session
     with Royce awake.

   ✗ NO force pushes. NO merges from autonomous loops without
     Royce's explicit OK in-session.

   ✗ NO cross-repo writes outside eq-solves-service and
     eq-solves-intake. SKS NSW Labour, EQ Field, EQ Solves Service
     Netlify side are OFF LIMITS.

   ✗ NO commits with sensitive data. Real Equinix/Jemena/Ramsay
     identifiers are OK in commits (they're public companies);
     ABNs, phone numbers, internal Maximo asset IDs are NOT.

   ✗ DO NOT REINTRODUCE contract fields onto customer. The Door C
     split is locked. See [[project_door_c_customer_split]].
```

## 5. Decision protocol — when to ask, when to proceed

```
   Proceed without asking when:
     • The action is read-only (queries, file reads, test runs)
     • You're filling a stub that's already authorised in scope
     • You're adding tests / CI / docs
     • You're rewriting samples or fixtures
     • You're regenerating types from existing schemas

   PAUSE and ask when:
     • Any merge to main on a repo with auto-deploy wiring
     • Any change to the canonical schema model (new entity, breaking
       rev of v2 → v3, new required field, enum change)
     • Any cross-repo write
     • Any change to RLS policies / auth gates / role checks
     • Any "should we keep this open debt or close it now?" call
     • You hit a real blocker (failing tests, missing context, ambiguous
       design)

   When asking, ALWAYS use AskUserQuestion with pre-populated options.
   Recommended option first, marked (Recommended). Free-text always
   available. Single-line options. Brief context above the question.
```

## 6. Loop cadence (if running autonomous /loop)

```
   • 15-30 min between wakes (per [[loop_cadence]])
   • Escalate to 45 if mid-work
   • DON'T let the loop fail by waiting too long
   • Commit checkpoints between wakes so loss is bounded
   • Update PLAN.md every tick (state persists across context compression)
   • End the loop cleanly when scope is done — omit ScheduleWakeup
```

## 7. Definition of "done" for each candidate

```
  Item 1 (validate live):     ajv reports 0 errors on `/api/admin/export?entity=customer`
                              and `?entity=acb_test` outputs from a live tenant. Script lives
                              in scripts/validate-live-export.mjs, committed.

  Item 2 (CI):                .github/workflows/canonical-spine.yml runs on every PR. Includes
                              ajv schema lint, gen-types diff check, eq-validation tests, and
                              round-trip-acb.mjs --fixture. Green on a no-op PR.

  Item 3 (fill stubs):        Each stub becomes a real EntityExporter. Sample data appears in
                              live endpoint output. Integration test added per exporter.

  Item 4 (resolve drift):     Either eq-platform/eq-schemas updated to match canonical, OR
                              workspace dep wires it directly. project_eq_platform_schema_drift
                              memory entry updated to closed status.

  Item 5 (first ingest):      A spreadsheet Royce currently imports by hand becomes a button
                              click. End-to-end: file upload → parse → ajv validate → preview →
                              commit to DB. Tested against a real archive of last month's file.

  Item 6 (DB split):          Migration applied to dev. exportCustomer + exportServiceContract
                              pivot to read from their own tables. RLS preserved. Backfill plan
                              written and tested. NEEDS DEDICATED SESSION.

  Item 7 (ADRs):              docs/decisions/0001-canonical-vs-eq-platform.md,
                              docs/decisions/0002-door-c-customer-vs-contract.md,
                              docs/decisions/0003-lifecycle-type-derivation.md committed.

  Item 8 (typecheck):         pnpm typecheck in eq-validation returns clean. process-capture.ts
                              either gets @eq/ai dep wired or the file is reworked to not need
                              it for typecheck.
```

## 8. The actual asking script

When you've read the memory and are ready to start, the FIRST thing to do is briefing Royce on options. Don't dive in. Use:

> "I've read the substrate state. Items 1 (validate live) and 2 (CI) are no-brainers — about an hour combined to lock down what shipped overnight. After that we pick between filling stub exporters (item 3), resolving the eq-platform schema drift (item 4), or wiring the first real ingest consumer (item 5). Which monthly pain do you want to feel less of next?"

Then AskUserQuestion with those four as options, plus a "do items 1+2 only tonight, save the rest" option.

## 9. Now go

```
   Step 0  Read memory. All of it linked above.
   Step 1  Read PLAN.md + SUMMARY.md in eq-intake root.
   Step 2  Run `node scripts/round-trip-acb.mjs --fixture` to confirm
           the substrate is still working (should exit 0).
   Step 3  Ask Royce the section-8 question.
   Step 4  Execute his choice. Follow §4 hard limits. Follow §5 decision
           protocol. Update PLAN.md as you go.
   Step 5  Commit early, commit often. Squash-merge at the end with a
           clear message + PR description that anyone can read 6 months
           later and understand.
```

That's it. Don't rebuild context, don't re-explain what's done — read the memory, pick a thing, ship it.
