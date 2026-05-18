# EQ — Project Briefing

> **For anyone (or any AI session) joining this project cold.** Read this
> first. The deeper docs are linked at the end.
>
> Last updated 2026-05-18.

---

## What EQ is

EQ is the layer between the systems trade subbies already use — SimPRO,
Xero, AroFlo, MYOB, ServiceM8, principal-contractor portals like
Equinix and NEXTDC. It removes the human-retyping step between them.

It is **not** a SaaS platform aggregating customer data. It is **not** a
replacement for any existing tool. Each customer's EQ instance sits
between *their* systems and stays out of every other customer's data.

**For whom and when:** the apprentice doing the same induction four
times this week. The bookkeeper retyping timesheets at 8pm Friday. The
PM photographing a SWMS and emailing it to a compliance officer who
uploads it into yet another portal. Every feature must trace to a
specific person and a specific moment.

**Read `EQ-AS-CONDUIT.md` for the full why.** Vocabulary check —
words that signal drift: "SaaS", "platform play", "TAM", "moat",
"customers" used generically, "scaling", "battle-tested". Avoid them.
Use "the boys", "the bookkeeper", "the moment of retyping".

---

## EQ as a set of modules

EQ ships as one **shell app per tenant**, with modules lazy-loaded
inside it:

```
                   ┌──────────────────────────────────┐
                   │  EQ Shell    (sks.eq.solutions)  │
                   │  ────────                        │
                   │  • Auth (one Supabase session)   │
                   │  • Per-tenant config (modules    │
                   │    enabled, brand palette)       │
                   └────┬──────┬──────┬──────┬────────┘
                        │      │      │      │
                  ┌─────┘      │      │      └─────┐
                  ▼            ▼      ▼            ▼
              [Cards]      [Intake] [Quotes]   [Service]
              lazy-loaded routes — each module is its own
              buildable React package
```

Modules:
- **EQ Cards** — mobile capture (inductions, prestarts, SWMS). Lives in a
  separate repo (`C:\Projects\eq-cards`), already in production for SKS
  on its own Supabase. Phase 4: migrates onto canonical.
- **EQ Field** — scheduling / staff. SKS Field LIVE is in production on
  its own Supabase. Phase 3: migrates onto canonical.
- **EQ Service** — work-order management. Built for SKS, going live in
  weeks. Will read/write canonical from day one.
- **EQ Intake** — multi-source intake + reshape-out (SimPRO bundle →
  Xero / MYOB / Outlook / SharePoint / custom-template). Built in this
  repo. Production-ready as a module; canonical wiring imminent.
- **EQ Quotes** — quoting tool for SKS. Stub placeholder today; reads
  customer/site/contact from canonical when built.

---

## Tenancy model — per-tenant Supabase

**Each EQ customer gets their own Supabase project.** Physical data
isolation, not RLS-shared. Decision logged 2026-05-18 after
walking through trade-offs.

Why per-tenant won:
- EQ touches payroll / compliance / sensitive operational data — physical
  isolation is the cleanest compliance story
- Blast radius of any future bug is one customer, not all
- $25/mo per tenant at Supabase Pro is rounding error at trade-subbie scale
- When customer count reaches ~20+, automate provisioning via the
  Supabase Management API

For SKS specifically:
- Supabase project name: **`sks-canonical-eq`** (Sydney region)
- This becomes SKS's canonical layer — every SKS EQ module reads/writes
  to it (Field, Service, Intake, Quotes, Cards eventually)
- Field LIVE + Cards stay on their existing Supabases until planned
  cutovers later (Phase 3 + 4)

For future tenants: same shell repo, new Netlify site, different env
vars (`VITE_SUPABASE_URL` etc.), new tenant-prefixed Supabase project.

**Read `EQ-TENANCY-MODEL.md` for the full architecture + the SKS Phase
1-4 path.**

---

## Repo layout

```
C:\Projects\eq-intake\           ← THIS REPO (intake + shell)
├── EQ-AS-CONDUIT.md             — the why (read first)
├── HOW-WE-WORK-WITH-AI.md       — working principles
├── EQ-INTAKE-ARCHITECTURE.md    — technical shape of the intake stack
├── EQ-TENANCY-MODEL.md          — per-tenant + shell pattern
├── EQ-FORMAT.md                 — bidirectional sheet wrangler
├── EQ-CARDS-INTAKE-BRIDGE.md    — Cards migration plan
├── EQ-BRIEFING.md               — this file
├── SESSION-LOG.md               — chronological work log
├── sql/                         — base migrations 001/002/003
├── demos/                       — standalone Node scripts
│   └── simpro-customer-rollup/  — the SimPRO→SharePoint CSV joiner
└── eq-platform/                 — pnpm workspace
    ├── apps/
    │   └── eq-shell/            — the per-tenant shell app
    │       └── DEPLOY.md        — step-by-step deploy guide
    ├── packages/
    │   ├── eq-schemas/          — JSON Schemas + TS/Zod/SQL codegen
    │   ├── eq-validation/       — coercers + validator orchestrator
    │   ├── eq-ai/               — vendor-agnostic AI provider
    │   ├── eq-intake/           — parsers (CSV/XLSX/PDF/photo)
    │   ├── eq-confirm-ui/       — single-file confirm flow components
    │   └── eq-intake-demo/      — Intake module + standalone playground
    └── scripts/
        └── db-apply.ts          — migration sequencer

C:\Projects\eq-cards\             ← separate repo (EQ Cards)
```

---

## Current state (2026-05-18)

**Built and tested:**
- 12 canonical JSON Schemas (staff/site/asset/swms/prestart/jsa/toolbox/
  incident/itp/schedule + new customer + contact)
- SQL codegen producing per-entity `CREATE TABLE` from JSON Schemas
- Migration sequencer producing a 154 KB combined SQL file ready to
  paste into Supabase SQL editor
- `@eq/shell` with Supabase Auth + lazy module routing + SKS palette
- `@eq/intake-demo` (the Intake module) — production-ready, mounts in
  shell at `/intake`. Supports SimPRO bundle drop → 5 destination
  templates (SharePoint rollup / EQ Quotes-by-site / Xero ContactsImport
  / MYOB Card File / Outlook contacts) + user-supplied templates
- Standalone Node script `demos/simpro-customer-rollup/rollup.mjs` for
  one-off CLI runs
- 293 tests passing + 1 skipped

**Waiting on Royce (unblocking step — Option C, two Supabase projects):**
1. Create `eq-demo-canonical` Supabase project (Sydney) — ~5 min. This is
   the proving ground; everything gets validated here first.
2. Create `sks-canonical-eq` Supabase project (Sydney) — ~5 min. This is
   the live SKS canonical; fed the same SQL once demo is proven.
3. Drop demo credentials in `eq-platform/apps/eq-shell/.env.local` for
   local dev. SKS credentials go straight into the SKS Netlify env vars
   (no local copy needed — keeps SKS untouchable during iteration).
4. Paste `eq-platform/.generated/all-migrations.sql` into BOTH Supabase
   SQL editors → Run — ~1 min each.
5. Add first user to each via Supabase dashboard.

**Next session (~30-45 min once `eq-demo-canonical` is live):**
- Wire `IntakeModule`'s commit fn to call `eq_intake_commit_batch` RPC
- Add "commit canonical + download CSV" to the bundle flow
- Smoke-test end-to-end against demo
- Hand to Royce for live testing on demo with bookkeeper, SKS after

**Then live testing:** Royce + bookkeeper use EQ Intake for real SimPRO
exports → real SharePoint quoting work. Feedback re-orders priorities.

**Then phases 2-4** per `EQ-TENANCY-MODEL.md`:
- Build EQ Quotes proper, wire to canonical
- Build EQ Service, wire to canonical
- Phase 3: migrate Field LIVE onto canonical (planned cutover)
- Phase 4: migrate Cards onto canonical (per `EQ-CARDS-INTAKE-BRIDGE.md`)

---

## How to work with Royce

Per `HOW-WE-WORK-WITH-AI.md` + his global `~/.claude/CLAUDE.md`:

- **Direct, concise, no preamble.** Deliver first, explain briefly after.
- **Every question to him must have pre-populated answer options.** Use
  the AskUserQuestion tool. Recommended option first with
  `(Recommended)` suffix. Always include a free-text fallback option.
  Even for binary yes/no.
- **Explain before you ask.** Write a short briefing in chat before the
  AskUserQuestion call — what the question means, what's true today,
  what each option implies, what you recommend and why.
- **Never deploy without explicit instruction.** No `git push`. No
  Netlify deploys. No Supabase project creation. Those are Royce's
  steps.
- **Auth changes require explicit approval before any deployment.**
- **Never touch SKS Field LIVE Supabase or EQ Cards Supabase** unless
  the task explicitly says so. They're in production.
- **Lowercase file names, package names in backticks.**
- **Reference "the boys", "the bookkeeper", "6:30am on Tuesday"** —
  not "users" or "stakeholders" or "customers".
- **Plus Jakarta Sans font, EQ palette** (Sky `#3DA8D8`, Deep `#2986B4`,
  Ice `#EAF5FB`, Ink `#1A1A2E`). SKS palette (dark blue `#1F335C`,
  purple `#7C77B9`) when in SKS-branded surfaces.
- **No gradients, no shadows.** Linear/Notion aesthetic.
- **Honest qualifiers:** "this is a starting point. Real running will
  reveal flaws." NEVER "production-ready", "battle-tested", "ship-ready"
  unless real users have actually run it.

---

## When stuck

- Read `SESSION-LOG.md` for the most recent context
- Read `EQ-AS-CONDUIT.md` if framing feels off
- Check `~/.claude/projects/C--Projects-eq-intake/memory/` for
  auto-memory entries Royce has accumulated
- Ask Royce with pre-populated options
