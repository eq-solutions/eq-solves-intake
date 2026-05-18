# EQ Platform — Daily Green Check (2026-05-15)

## Status: **INCONCLUSIVE — check could not be executed**

The scheduled task ran in a Linux sandbox, but the eq-platform monorepo is a Windows-installed pnpm workspace mounted via virtiofs. The mount is read/write for *new* files but does not allow *unlinking* existing files. `pnpm install` aborts on its very first step (cleanup of leftover `_tmp_*` files from prior Windows runs) and so build / test / lint never get a chance to run.

Specific error:

```
[ERROR] EPERM: operation not permitted, unlink
  '/.../eq-platform/_tmp_3_3f4e18fba996d1995da01e0c2b226cd8'
```

The leftover `_tmp_3_*`, `_tmp_4_*`, `_tmp_14_*` zero-byte files are dated 29 Apr 2026 and pre-date today's run.

## What I could verify without running the toolchain

| Check | Baseline (29 Apr PM) | Today | Note |
|---|---|---|---|
| Workspace project count | 5 | **7** | New: `packages/eq-intake`, `packages/eq-intake-demo`. Not a regression — but the baseline numbers in the task file are stale. |
| `pnpm-lock.yaml` mtime | — | 14 May 2026 | Lockfile changed within the last 24h; install state on disk may be out of sync. |
| `packages/eq-schemas/src` mtime | — | 13 May 2026 | Schemas have moved since baseline; "10 schemas valid" expectation may also be stale. |
| `node_modules/.modules.yaml` | present | present, Windows paths | Confirms install was last performed on the host (Windows), not the sandbox. |

## Concerning? Yes — flagging two items

1. **Baseline drift.** The expected package count (5) and schema count (10) in the scheduled-task file no longer match the repo. Worth refreshing the baseline.
2. **No green confirmation today.** Build / test / lint were not run. If something is broken, this report will not catch it.

## Recommended next step

Run the four commands manually from a PowerShell terminal on the host:

```powershell
cd C:\Projects\eq-intake\eq-platform
pnpm install
pnpm -r build
pnpm -r test
pnpm schemas:lint
```

…and update the baseline in the scheduled-task file (`...\uploads\SKILL.md`) to reflect 7 packages and the current schema count.

If the sandbox should run this check unattended going forward, the task needs to either (a) run on the Windows side via a scheduled PowerShell job rather than this Linux sandbox, or (b) have its working copy moved off the virtiofs mount before pnpm operations.

## Integration test

Not run. As instructed.
