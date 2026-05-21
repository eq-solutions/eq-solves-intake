# Markdown cull — executed 2026-05-22

**Status:** Executed in this commit. This file is the record of what was done.

Original proposal was conservative (11 archive / 9 delete). Royce called for brutal — most archives flipped to deletes because the content is either in code, in commit messages, or already duplicated in a surviving doc. The bar landed at: a doc earns archive only if it preserves prose narrative or analysis that isn't recoverable from `git log`.

Final: **9 KEEP / 3 ARCHIVE / 17 DELETE**.

---

## What survived (9)

| File | Why it stays |
|---|---|
| [EQ-AS-CONDUIT.md](EQ-AS-CONDUIT.md) | Source-of-truth framing. Every other doc reads through this. |
| [HOW-WE-WORK-WITH-AI.md](HOW-WE-WORK-WITH-AI.md) | Working principles. Vocab check that stops the SaaS drift. |
| [EQ-BRIEFING.md](EQ-BRIEFING.md) | Cold-start primer. Memory pointer lives here. (Stale on specifics — Phase 2 flags refresh.) |
| [EQ-INTAKE-ARCHITECTURE.md](EQ-INTAKE-ARCHITECTURE.md) | Technical shape: three doors in, canonical middle, every door out. |
| [EQ-TENANCY-MODEL.md](EQ-TENANCY-MODEL.md) | Per-tenant Supabase decision. Load-bearing. |
| [EQ-CARDS-INTAKE-BRIDGE.md](EQ-CARDS-INTAKE-BRIDGE.md) | Path A decision for Cards migration. Decision still holds; sequencing language is stale (Phase 2 flag). |
| [EQ-FORMAT.md](EQ-FORMAT.md) | On probation. Phase 2 will pressure-test for N×M scope creep. |
| [PHASE-2-3-BACKLOG.md](PHASE-2-3-BACKLOG.md) | Active parking lot. Phase 3 will trim. |
| [README.md](README.md) | Repo entry point. Phase 2 flags rewrite (currently cites archived/deleted docs). |

## What got archived (3)

Moved to `_archive/` with an index at [_archive/README.md](_archive/README.md). Earned archive — not delete — because they hold prose narrative or audit findings that aren't fully recoverable from `git log`.

- **COWORK-BRIEF-PHASE-1.md** — Original 7-sprint plan + Phase 1 ship criteria + NFR targets. Most explicit statement of what Phase 1 *was meant to deliver*. Execution diverged but the targets are still the most useful reference for "did we meet what we set out to do."
- **SESSION-LOG.md** (95 KB) — Chronological prose journal 29 Apr → 18 May. Decision rationale that doesn't fit in commit messages. Stops on 18 May; recent work is in `git log` only.
- **SCHEMA-FIXTURE-GAPS.md** — Engineering audit of 12 canonical schemas vs SimPRO fixtures. Top-5 fix list, most still open. Migrate live items into `PHASE-2-3-BACKLOG.md` rather than acting from here.

## What got deleted (17)

| File | Why it's gone, not archived |
|---|---|
| HANDOVER.md | 1 KB redirect. Its read-order list is already in README. The redirect was the entire content. |
| CONFIRM-UI-SPEC.md | The `@eq/confirm-ui` package shipped per this spec on 14 May. The code is now authoritative — re-reading the spec to understand the UI would be slower than reading the code. |
| LOOP-PUNCHLIST.md | All 8 items shipped. Item descriptions are duplicated in their commit messages and in the resulting code. Parking-lot items moved into `PHASE-2-3-BACKLOG.md` already. |
| PLAN.md | Tick log for the 19→20 May overnight loop. Work landed via PR. Replaced by `PLAN-2026-05-22.md` in Phase 3. |
| SIMPRO-FIXTURE-SMOKE-2026-05-19.md | The blocker it found (country coercion) is fixed (commit `92a7612`). Remaining observations are in SCHEMA-FIXTURE-GAPS (archived). |
| SPRINT-1-SETUP.md | Sprint 1 decisions (Node 20.11, pnpm 9.x, ESM, Vitest, tsup) are now visible in `package.json` and `tsconfig.base.json`. The doc is "decisions about what we'd do" — we did them. |
| SUMMARY.md | Same 19→20 May overnight run that SESSION-LOG covers in detail. Duplicate. |
| eq-platform-daily-green-check-2026-05-15.md | INCONCLUSIVE failed-sandbox-check from 1 week ago. Its only finding was "the `_tmp_*` files break pnpm install" — those files are being deleted in this same commit. Self-resolving. |
| STATUS-2026-04-30.html | Styled HTML status snapshot. Substance covered by archived SESSION-LOG and `git log`. |
| 8 × `_tmp_*` zero-byte files | Cleanup leftovers from interrupted pnpm runs that got committed by accident. Caused the 15 May green-check to fail. |

## Three things to know now, before Phase 2

These affect the post-cull state and aren't blockers — they're flags for Phase 2.

1. **README.md is out of sync.** Its "read these first in order" list cites 5 docs that are now archived or deleted (CONFIRM-UI-SPEC, COWORK-BRIEF, SESSION-LOG, SPRINT-1-SETUP, validation/VALIDATION-ENGINE-SPEC). Also doesn't list EQ-BRIEFING, which my memory + the deleted HANDOVER both treated as the cold-start primer. Phase 2 will propose the rewrite.

2. **EQ-BRIEFING.md is 4 days stale on specifics.** Last update 2026-05-18. Cards licence canonical (PR #5/#6), S2.A 22 Field-domain schemas (`3b935db`), and `/api/admin/export` all landed after. The framing is right; the "current state" section claims are wrong. Phase 2 work.

3. **EQ-CARDS-INTAKE-BRIDGE.md sequencing is wrong.** Path A *decision* still holds. The "end of Sprint 3 / start of Phase 2" timing is from a build sequence that's no longer reality. One-line correction in Phase 2.
