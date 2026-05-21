# _archive — historical docs

Snapshots of planning, status, and engineering work that have been superseded by what's in the live code, in `git log`, or in surviving root docs. Kept here for archaeology — not for active reference.

**Do not link to these from current docs.** If a still-open item from one of these archives should still be acted on, migrate it into `PHASE-2-3-BACKLOG.md` or a new doc; don't reach back into `_archive/`.

Archived 2026-05-22 as part of the root-level documentation cull. See `git log` around that date for the cull rationale and the deleted-file list (most stale docs were deleted outright rather than archived).

## What's here

- **COWORK-BRIEF-PHASE-1.md** — Original 7-sprint plan from 28 Apr 2026, with a 29 Apr note admitting execution diverged (Sprints 2-4 collapsed, EQ Import retired, EQ Capture demoted). Worth keeping for the ship criteria and non-functional targets — they're the most explicit statement of what Phase 1 was *meant* to deliver, even though the path got bent.

- **SESSION-LOG.md** — Chronological work log 29 Apr → 18 May 2026 (95 KB, 1829 lines). Prose narrative of decisions made between commits. `git log` covers the *what*; this covers the *why* and the *what-we-rejected*. Stops on 2026-05-18 — work after that (Cards licence canonical, S2.A 22 Field schemas, /api/admin/export) is in git only.

- **SCHEMA-FIXTURE-GAPS.md** — Systematic schema-vs-fixture audit from 19 May 2026. Top-5 fix list and per-schema breakdown. The country-coercer fix landed in commit `92a7612`; most other findings remain open. Migrate any still-load-bearing items into `PHASE-2-3-BACKLOG.md` rather than acting from here directly.
