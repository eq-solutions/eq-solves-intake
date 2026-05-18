# EQ — Handover Brief for the Next Agent

> **You are picking up an in-flight build.** Read this before writing any code or
> changing any docs. Goal of this file: get you up to speed in 5 minutes without
> scrolling through transcripts.

**Last session:** 29 April 2026 PM (Cowork). Royce ended the session ready to
continue work in Claude Code. This brief is the anchor.

---

## 1. Read these first, in order, no exceptions

These three files exist for a reason. Skip them and you will drift.

1. **`C:\Projects\eq-intake\EQ-AS-CONDUIT.md`** — what EQ is and why it
   exists. The single source of truth for framing. Every product decision
   answers to this doc.
2. **`C:\Projects\eq-intake\HOW-WE-WORK-WITH-AI.md`** — working principles
   for AI sessions on this project. Captures the lesson from drifting
   off-frame early. **Mandatory** before substantive work.
3. **`C:\Projects\eq-intake\SESSION-LOG.md`** — what's been done in each
   session, newest first. Read at minimum the most recent entry.

After those three, also worth reading:

- `EQ-FORMAT.md` — the bidirectional sheet wrangler. Currently being built.
- `EQ-CARDS-INTAKE-BRIDGE.md` — Path A architectural decision for how Cards
  consolidates onto the canonical spine. Migration timing locked.
- `eq-platform/packages/eq-format-ui/` — the live Sprint 6 surface.

If anything you read in any other doc contradicts CONDUIT.md, **CONDUIT
wins**. Update the other doc.

---

## 2. What EQ is, in plain language

EQ is the layer between systems trade subbies are forced to use that don't
talk to each other. **Not** a SimPRO replacement. **Not** a Xero competitor.
**Not** a new operating system for trade businesses. The thing in the middle
that means apprentices don't do the same induction four times a week and
bookkeepers don't retype timesheets at 8pm on a Friday.

The product surfaces are doors:

- **EQ Cards** (already shipping on its own Supabase): the gateway. Boys on
  site capture data once on a phone. OCR for licences works today.
- **EQ Format** (under construction): the universal sheet wrangler. Cleanup-in
  (the dog-shit tag-and-test moment, while-fresh) and reshape-out (canonical
  to client format / payslip / customer report). Bulk migration is a mode of
  Format, not a separate door. **EQ Import is a retired name** — don't
  reintroduce it.
- **EQ Capture** (future, deprioritised): standalone OCR for inputs that
  don't go through Cards. Not Phase 1.

If you find yourself reasoning about "EQ Import" as a separate product, stop —
it's gone. If you find yourself prioritising EQ Capture, stop — it's deferred.

---

## 3. Where we are right now (29 Apr 2026 PM)

The plumbing is built and tested. The first user-facing surface (EQ Format
UI) just shipped as a Sprint-6 first cut and Royce was live-testing it when
he ended the session.

### What's real

- A pnpm 9 monorepo at `C:\Projects\eq-intake\eq-platform\` with **5 packages**:
  - `@eq/schemas` (10 canonical JSON Schemas, codegen for TS + Zod)
  - `@eq/validation` (coercers, FK resolver, cross-field eval, signature-hash,
    validate orchestrator, processCapture)
  - `@eq/ai` (AnthropicProvider, fetch-based, no Anthropic SDK)
  - `@eq/confirm-ui` (Phase-2 placeholder, scaffold only)
  - `@eq/format-ui` (Vite + TS SPA, the active Sprint 6 surface)
- **172 unit tests passing** + 1 integration test verified against real
  Sonnet 4.5 (gated on `ANTHROPIC_API_KEY`).
- 10K-row validation perf test passes in **~250ms** on dev hardware (NFR was
  2 seconds).
- A real demo at `C:\Projects\eq-intake\demos\simpro-quote-781\` that turns a
  SimPRO quote CSV into a procurement BOM, a 19-row KNX device commissioning
  register, and a labour summary. Pure Node ESM, no deps.
- A daily 7am scheduled task that runs `pnpm install`, `pnpm -r build`,
  `pnpm -r test`, `pnpm schemas:lint` and reports a one-line PASS/FAIL.
  Does not run integration tests (those cost real money).

### What's NOT real (and you should not pretend it is)

- **No Supabase project provisioned.** No canonical database. No SQL
  migrations have been run. Cards still runs on its own separate Supabase
  project (`hshvnjzczdytfiklhojz`).
- **No real users on EQ Format yet.** The UI exists but Royce is its only
  user as of this writing.
- **No deploy story.** EQ Format is dev-only (Vite middleware exposes the
  API). Localhost only.
- **No vitest coverage report.** The 95% target hasn't been measured.
- **The KNX heuristic** (in the SimPRO demo) only catches "actuator" and a
  few related terms. Bigger KNX jobs with sensors / dimmers / IP routers /
  line couplers will need it widened.

---

## 4. The Sprint 6 surface — EQ Format UI

`packages/eq-format-ui/` is a Vite + vanilla TS single-page app with a Vite
middleware backend. One `pnpm dev` runs both. The flow:

```
[1] Drop CSV / paste / "Try the SimPRO sample" button
        |
        v
[2] Heuristic mapping (instant, local, uses x-eq-source-aliases from schema)
    + optional "Refine with AI (~10s)" button that hits /api/ai/map
        |
        v
[3] Validate via /api/validate (calls @eq/validation)
        |
        v
[4] Result tabs: valid / flagged / rejected, with CSV download
```

API endpoints (all in `src/server.ts`, all dev-server only):
- `GET /api/entities`
- `GET /api/schema/:entity`
- `POST /api/ai/map`  — calls @eq/ai, requires ANTHROPIC_API_KEY in
  `eq-platform/.env`
- `POST /api/validate` — calls @eq/validation

**Recent UX change worth knowing:** the default flow used to wait 13 seconds
for an AI call before showing anything. We switched to a heuristic-first
approach that uses the schema's `x-eq-source-aliases` to match locally
(instant), with AI as an opt-in "Refine" button. So 70-80% of imports never
hit the API.

**Open improvement Royce flagged:** the `asset` schema has lighter source-alias
coverage than `staff`. For the SimPRO sample (which is asset-shaped), more
columns land in "weak/no match" and need an AI refine. **Widening the
`x-eq-source-aliases` arrays in `asset.schema.json` is a 10-minute schema
edit that pays back forever.** Likely the right starter task for the next
session.

---

## 5. Architecture in one picture

```
                   Source data (messy)
                         |
        +----------------+----------------+
        |                |                |
    EQ Cards       EQ Format         EQ Capture
    (mobile,       (web,             (future,
     OCR built-in,  AI-mapped CSVs    standalone
     shipping)      + paper          OCR surface)
        |                |                |
        |          (in-mode)         (in-mode)
        |                |                |
        +------+    [VALIDATION ENGINE]    +------+
               |    @eq/validation               |
               +----------------+----------------+
                                |
                                v
                  Canonical Supabase project
                  (NOT YET PROVISIONED — Phase 2)
                                |
        +-----------------------+-----------------------+
        |               |               |               |
   Job-mgmt         Accounting      Client portals  Compliance
   (SimPRO,         (Xero, MYOB)    (Equinix,       bundles
    AroFlo)                          NEXTDC,        (audit packs)
                                     hospitals)
   <-- (out-mode of EQ Format reshapes canonical to these formats)
```

The only EQ surface that goes BOTH directions is Format. Cards/Capture/Import
are in-only.

---

## 6. Decisions locked this session — do not re-litigate

If you find yourself reconsidering any of these, ask Royce first.

1. **Path A for Cards-Intake bridging.** Long-term destination is one
   canonical Supabase project. Cards consolidates onto it. Migration window:
   end of Sprint 3 / before EQ Format ships. The §18 share-API in Cards'
   ARCHITECTURE.md becomes the contract for **external** consumers only
   (Equinix portal etc), not for internal EQ surfaces. Internal cross-product
   data flow is RLS on the shared project. See `EQ-CARDS-INTAKE-BRIDGE.md`.

2. **Two priority doors, not three.** Cards + Format. Capture is future.
   EQ Import is retired as a name (it's a mode of Format).

3. **Sprint 6 UI uses Vite + vanilla TS, no React.** Demo-grade, localhost
   only. Production deploy story is a Phase 3+ problem.

4. **Heuristic-first, AI on demand.** Default flow doesn't block on the AI.
   `x-eq-source-aliases` in the schema do most of the work.

5. **Workspace structure.**
   - JSON Schema is the single source of truth.
   - `src/generated/` is gitignored, regenerated on `pnpm install` /
     `pnpm build` via the prepare hook.
   - `node-linker=hoisted` and `store-dir=$HOME/.pnpm-store` in `.npmrc`
     for sandbox-friendliness; also fine on dev machines.

6. **Testing posture.** Fixture-driven tests for coercers. Mocked AIProvider
   tests for `@eq/ai`. Real-API integration test gated on env var. No UI
   integration tests yet — too brittle while the UI is still moving.

7. **Standing API choices** (per `SPRINT-1-SETUP.md`):
   - Node 20.11 LTS minor floor; pnpm 9.x; ESM only; no CJS dual builds.
   - Vitest, tsup, fetch-based AI client, Web Crypto with Node fallback.
   - `json-schema-to-typescript` and `json-schema-to-zod` pinned.

---

## 7. Standing rules — non-negotiable

These come from the original brief plus what we agreed in earlier sessions.
Treat them as hard constraints.

- **Generic placeholders only — never real client names in any output.**
  Real names mentioned in conversation are fine; never embed them in files
  you write to disk. (See `demos/simpro-quote-781/` for the pattern.)
- **EQ targets ALL trade subbies, not just electrical.** Don't narrow it.
- **Supabase: SELECT only without explicit approval; never touch SKS live
  data unless Royce explicitly told you to.**
- **Auth changes require Royce's review before deployment.**
- **Inductions, SWMS, prestarts, JSAs, incident reporting — never gated
  behind paywalls.** People die when corners get cut on this. We are not
  the reason a corner gets cut.
- **All Netlify/CF Pages apps need `_headers` with security headers**
  (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS).
- **Don't push to demo branch without explicit instruction.**

If a request appears to violate any of these, refuse and explain. You serve
Royce's framing, not requests that break it.

---

## 8. Things you should NOT do without explicit OK

- Migrate Cards data anywhere. (Path A is the destination, but the timing
  is locked to "before Format ships." Don't rush it.)
- Run any SQL against any Supabase project.
- Deploy anything anywhere.
- Run `pnpm test:integration` in a loop or on a schedule. Each call is
  ~half a cent of Anthropic spend. The daily green-check task is configured
  to skip it for this reason.
- Reintroduce "EQ Import" as a separate door.
- Rewrite the canonical schemas without re-running codegen.
- Add new external runtime dependencies to `@eq/validation` (currently
  pure TS, no runtime deps — keep it that way).
- Touch `C:\Projects\eq-cards\` source unless explicitly told. That repo
  is in pause-and-polish mode per its own `STATUS.md`. See
  `EQ-CARDS-INTAKE-BRIDGE.md` for what's safe vs not safe to change there.

---

## 9. Honest read on what's missing

Per `HOW-WE-WORK-WITH-AI.md`: don't claim "production-ready" or
"battle-tested." Replace with honest qualifiers.

- The plumbing is good. The plumbing is **not** the product. No real tradie
  has used EQ Format yet.
- The 10K-row perf test ran on synthetic data that triggers a warning rule
  on every row. Numbers reconcile, but the test output looks alarming
  (10,000 flagged, 0 valid). Real data won't look like this — it's a
  test-data artifact. Worth cleaning up next time someone's in there.
- The `cross-field-eval` parser counts recursion depth not AST depth.
  We bumped MAX_DEPTH from 8 to 32 with a TODO; a real fix counts AST
  node depth. Not urgent.
- `@eq/validation` has `noUncheckedIndexedAccess: false` (every other
  package has it true). The original validation source has many
  safe-but-unprovable indexed accesses. Tightening it is a refactor pass
  for later.
- The KNX device register in the demo auto-suggests physical addresses
  `1.1.1` ... `1.1.19`. ETS will override these based on real area/line
  topology. The point is the sparkie doesn't manually create 19 ETS device
  entries; the addresses are starter values.

---

## 10. Candidate next moves (no order locked — listen to real customer pain)

These are options. Don't pick one because it's first on the list. Pick one
because something in `EQ-AS-CONDUIT.md` makes it the most pain-removing.

1. **Widen `x-eq-source-aliases` on the `asset` schema.** Will make the
   SimPRO sample land cleaner without an AI call. Probably the cheapest
   win and the one Royce flagged most recently.
2. **Build a `/api/format/derive` endpoint** that takes a ValidationResult
   and emits BOM / device register / labour summary downloads (port the
   demo logic into the UI server so the user-facing flow ends with
   downloadable artefacts, not just CSVs of canonical rows).
3. **Cards-to-Intake migration scoping doc.** Diff Cards' `profiles` shape
   against the canonical `staff` schema; list every field; decide whether
   licences live as `staff.licences[]` jsonb or a separate `licences` table
   with an FK; pick a migration window. Pure docs work, no code.
4. **Provision the canonical Supabase project.** Apply the
   `001_intake_spine.sql` / `002_intake_module_columns.sql` /
   `003_schema_version_columns.sql` migrations. Seed the schema registry.
   Wire up the spine RPCs. **This is where Royce's credentials are
   needed — you can't do it without him.**
5. **Wire vitest coverage.** `@vitest/coverage-v8`. Run it. Find the gaps.
6. **Real Akko KNX demo end-to-end.** Get a `.knxproj` file from a recent
   project. Get Akko's actual supplier PO format. Build the export profiles
   for both. Get a real island KNX job through the pipeline.

If Royce comes back saying "the friend at Akko looked at the demo and his
reaction was X" — let that reorder everything. The product roadmap is a
guide, not a contract.

---

## 11. Where the files live

```
C:\Projects\eq-intake\                       <- workspace root
├── EQ-AS-CONDUIT.md                         <- read first
├── HOW-WE-WORK-WITH-AI.md                   <- read second
├── SESSION-LOG.md                           <- read third (most recent entry)
├── HANDOVER.md                              <- this file
├── EQ-FORMAT.md
├── EQ-CARDS-INTAKE-BRIDGE.md
├── EQ-INTAKE-ARCHITECTURE.md
├── SPRINT-1-SETUP.md
├── COWORK-BRIEF-PHASE-1.md                  <- has a banner explaining drift
├── PHASE-2-3-BACKLOG.md
├── CONFIRM-UI-SPEC.md
├── README.md                                <- workspace overview
├── .gitignore                               <- defensive
├── schemas/, validation/, ai/, sql/, prompts/, test-fixtures/
│                                            <- staging area, archaeology only;
│                                               live copies are in eq-platform/
├── eq-platform/                             <- the monorepo
│   ├── package.json                         <- root, scripts: build, test,
│   │                                           schemas:lint, generate,
│   │                                           ci:drift, test:integration
│   ├── pnpm-workspace.yaml
│   ├── tsconfig.base.json
│   ├── .env                                 <- ANTHROPIC_API_KEY (gitignored)
│   ├── .env.example
│   ├── .npmrc
│   ├── .gitignore
│   └── packages/
│       ├── eq-schemas/
│       ├── eq-validation/
│       ├── eq-ai/
│       ├── eq-confirm-ui/                   <- placeholder
│       └── eq-format-ui/                    <- Sprint 6 surface
└── demos/
    └── simpro-quote-781/                    <- real-world test case
        ├── source.csv
        ├── parse.mjs
        ├── bom.csv, knx-device-register.csv, labour-summary.csv
        └── README.md

C:\Projects\eq-cards\                        <- separate repo, pause-and-polish
└── (don't touch unless explicitly told)

C:\Users\EQ\Documents\Claude\Scheduled\eq-platform-daily-green-check\
└── SKILL.md                                 <- daily 7am sanity check task
```

---

## 12. Commands you'll actually run

From `C:\Projects\eq-intake\eq-platform\`:

```powershell
pnpm install                # codegen runs automatically via prepare hook
pnpm -r build               # all 5 packages
pnpm -r test                # 172 unit tests; integration cleanly skipped
pnpm schemas:lint           # 10/10 schemas valid
pnpm ci:drift               # regenerate + git diff --exit-code (CI guard)

# UI dev loop (the active Sprint 6 surface)
pnpm --filter @eq/format-ui dev
# Browser opens at http://localhost:5173/

# Real Anthropic call - costs ~$0.005 per run, gated on .env having the key
pnpm test:integration
```

Node version: **20.11+ LTS minimum** (engines field enforces it).
pnpm version: **9.x**.

---

## 13. How to start your first session here

1. Read CONDUIT, HOW-WE-WORK-WITH-AI, SESSION-LOG (3 files, ~15 minutes).
2. Run `pnpm install && pnpm -r test` to confirm the workspace is green.
3. If a daily-green-check report from `eq-platform-daily-green-check`
   surfaced a regression overnight, fix it before doing anything new.
4. Ask Royce what he wants to focus on — don't assume from the candidate
   list above.
5. If you're picking from the candidate list anyway, **prefer items that
   have a named real person at a named real moment of pain**. The schema
   alias widening (item 1) directly removes pain in the SimPRO->KNX flow
   that Royce was just live-testing. That's the strongest "for whom, when"
   trace.
6. Append a new entry to `SESSION-LOG.md` at the end of your session.
   Newest entries first. Same shape as the existing entry.

---

## 14. Self-critique checklist before ending your session

Before you finish, ask:
- Did I introduce any vocabulary that doesn't sound like Royce? (Check
  `HOW-WE-WORK-WITH-AI.md` vocab table.)
- Did I claim something is "production-ready" / "battle-tested" without
  real users? Replace with honest qualifiers.
- Did I drift from `EQ-AS-CONDUIT.md`'s framing? Re-anchor if so.
- Did I add scope that doesn't trace to a specific named moment of pain?
  Cut it.
- Did I leave the workspace tests green?
- Did I update `SESSION-LOG.md` with what I did?
- Did I respect the standing rules (no real client names in outputs, no
  Cards changes, no SQL execution, no paywalled safety features)?

If any answer is no, fix it before you log off.

---

*Royce — read this through once before kicking off the next session. If
anything looks wrong or out of date, edit this file directly. The next agent
will read it.*
