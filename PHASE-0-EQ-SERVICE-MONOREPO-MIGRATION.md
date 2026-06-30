# Phase 0 — Move `eq-solves-service` into the `eq-platform` monorepo

> **⛔ Superseded / abandoned — 2026-06-30. Do not follow these steps.**
> This migration never landed. It was prep for the Maximo PDF demo, which is
> parked, so the reason to fold eq-service into this monorepo went away.
> eq-service and eq-shell are developed and deployed from their own standalone
> repos (`eq-solves-service`, `eq-shell`), shipping daily. The partial
> `apps/eq-service` + `apps/eq-shell` copies an earlier attempt left here were
> removed in #51. Kept below for historical context only.

**Authoring context:** 2026-05-21 evening. Drafted by Claude Opus 4.7 after Royce locked the scope cut for the Maximo PDF demo (~2026-06-04). This is the prep doc for tomorrow's session — read it cold and start.

**Plain-English goal:** eq-service stops being its own standalone repo and becomes `apps/eq-service/` inside `eq-platform`. After this phase, code inside eq-service can `import { parseMaximoPdfWo } from '@eq/intake'` like any other workspace consumer. Live behavior should not change. No new features. No Maximo skill yet. Just plumbing.

---

## 0. Why this happens before anything else

The Maximo PDF skill lives in `@eq/intake`. That package is `private: true` with `workspace:*` deps — it only resolves inside the eq-platform monorepo. eq-service today is outside that monorepo, so it can't see the skill. Three ways to bridge that gap; we picked monorepo over publish/copy because the rest of the EQ suite is going there anyway. See conversation 2026-05-21.

**Risk profile:** this is the riskiest phase of the whole demo plan. Next.js 16 + pnpm workspaces + Netlify build can bite on standalone tracing and symlink resolution. Budget: days 1–4. Slippage eats Phase 4 polish first.

---

## 1. Pre-flight (do these before any file moves)

- [ ] Confirm no in-flight branches on `C:/Projects/eq-solves-service` other than what Royce wants to carry over. `git status` + `git branch --no-merged main`.
- [ ] Confirm current Netlify site `eq-solves-service.netlify.app` builds green on its existing config. (We need a known-good baseline to compare against.)
- [ ] Snapshot all env vars from the Netlify dashboard for `eq-solves-service` site → paste into a local scratch file. Includes Sentry DSN, PostHog keys, Supabase keys, Resend, anything else. These get re-applied verbatim after the base-dir change.
- [ ] Versions sanity:
  - Node `>=20.11.0` (eq-platform requirement)
  - pnpm `9.15.9` (eq-platform `packageManager`)
  - eq-service runs Next.js `16.2.3`, React `19.2.4` — confirm eq-platform's other apps (currently just `eq-shell`) don't clash.
- [ ] Skim `eq-platform/apps/eq-shell/` to see how the existing app is wired into the workspace. Copy its patterns where they apply.

---

## 2. Migration steps (ordered)

### 2.1 Branch + scaffold
```
cd C:/Projects/eq-intake
git checkout -b claude/phase-0-eq-service-monorepo
mkdir eq-platform/apps/eq-service
```

### 2.2 Copy the tree
Copy `C:/Projects/eq-solves-service/*` → `C:/Projects/eq-intake/eq-platform/apps/eq-service/`, **excluding:**
- `node_modules/`
- `.next/`
- `.git/`
- `.netlify/` (build artifacts)
- any `_tmp_*` directories
- any local `.env.local` (env goes via Netlify dashboard, not source)

### 2.3 Adjust `apps/eq-service/package.json`
- Add workspace deps (minimal set for Phase 0 — just what the eventual skill consumer needs):
  ```json
  "@eq/intake": "workspace:*",
  "@eq/ai": "workspace:*"
  ```
- Do NOT add `@eq/schemas` or `@eq/validation` yet. We bring those in during Phase 1/3 only if needed. Smaller initial dep set = fewer migration errors.
- Strip devDeps that the root `eq-platform/package.json` already provides (`tsx`, `typescript`, `vitest`). Keeps versions consistent.
- Keep `"name": "eq-solves-service"` so Netlify build commands stay readable.

### 2.4 Install + first build attempts
```
cd C:/Projects/eq-intake/eq-platform
pnpm install
pnpm --filter eq-solves-service typecheck
pnpm --filter eq-solves-service build
```
Fix errors as they come. Expect 2-3 rounds. Typical issues:
- Path aliases (`@/...`) need `tsconfig.json` to extend the workspace base correctly.
- `next.config.ts` may need `outputFileTracingRoot` pointing at `eq-platform/` so standalone tracing follows symlinks (see §3).
- Tailwind 4 PostCSS — should work unchanged, but watch for `content` globs missing workspace paths.

### 2.5 Smoke test locally
```
pnpm --filter eq-solves-service dev
```
- Log in, view dashboard.
- Navigate to `/maintenance/import` — should look identical to pre-migration.
- Check browser console: no new errors.
- Check Sentry dev project: no new flood of errors from the migrated dev session.

---

## 3. Build config gotchas (don't skip)

### 3.1 Netlify site config (the most fragile bit)
The existing Netlify site is wired to GitHub repo `eq-solutions/eq-solves-service`. After migration, the source of truth becomes a path inside `eq-solutions/eq-solves-intake`. Two paths forward:

**Option A — repoint the existing Netlify site to eq-solves-intake.**
- Base directory: `eq-platform/`
- Build command: `pnpm install --frozen-lockfile && pnpm --filter eq-solves-service build`
- Publish directory: `eq-platform/apps/eq-service/.next`
- Pros: same Netlify site, same DNS, same env vars stay in dashboard.
- Cons: a single misconfig and live production points at a half-built monorepo.

**Option B — new Netlify site for the monorepo target, switch DNS at the end.**
- Spin up a fresh Netlify site connected to eq-solves-intake.
- Configure as above.
- Re-paste env vars.
- Once green on staging URL, switch DNS / domain.
- Pros: zero-risk to live during Phase 0. Old site remains a rollback for free.
- Cons: more clicks, two sites to manage briefly.

**Recommendation:** Option B. The 30 minutes of extra setup buys real safety for a live customer-facing site. Confirm with Royce before pulling either trigger — Netlify config changes are deploy-adjacent and need explicit approval per global rules.

### 3.2 Next.js standalone tracing
If `apps/eq-service/next.config.ts` uses `output: 'standalone'`, set:
```ts
outputFileTracingRoot: path.join(__dirname, '../..')
```
Without this, Next.js traces will miss workspace symlinks and the standalone bundle ships broken.

### 3.3 Sentry / instrumentation files
`instrumentation.ts` and `instrumentation-client.ts` at eq-service root reference Sentry org/project slugs. These move with the rest of the tree — no code changes needed. But verify:
- `SENTRY_AUTH_TOKEN` env var survives the base-dir change on Netlify.
- Sentry release tagging — Sentry expects release IDs from the build env. Confirm `SENTRY_RELEASE` is still being computed by the build command, not assumed.

### 3.4 Supabase migrations
`apps/eq-service/supabase/migrations/` keeps its path-relative seeds. `supabase` CLI commands still run from `apps/eq-service/` if scripts are wired that way. Verify `package.json` script paths haven't been broken by the move.

### 3.5 Vitest config
eq-service has both `vitest` (unit) and `vitest.integration.config.ts`. After migration:
```
pnpm --filter eq-solves-service test
pnpm --filter eq-solves-service test:integration
```
should both still work. If integration tests hit a real Supabase, env vars need to be in the local `.env.test.local` (not committed).

---

## 4. Observability — preserve, don't rebuild

All three platforms (Sentry, PostHog, Microsoft Clarity) keep their existing project slugs and DSNs. Nothing about identity changes here. What changes is:
- Where Netlify reads env vars from (new site config if going with Option B).
- Whether source maps still get uploaded (depends on §3.3).

After Phase 0 deploys, verify:
- A deliberate test error in eq-service shows up in Sentry, source-mapped.
- PostHog events fire (open Live Events tab in PostHog EU instance).
- Clarity session is recording (open project, see live session count).

If any of those break, fix before declaring Phase 0 done. Phase 1 depends on Sentry catching vision-call failures.

---

## 5. Acceptance — Phase 0 is done when

- [ ] `pnpm --filter eq-solves-service build` succeeds locally.
- [ ] Deploy preview on Netlify (whatever site we chose) builds and serves.
- [ ] Smoke test on preview URL: login, dashboard, `/maintenance/import` all render without console errors.
- [ ] Sentry receives a test error from the preview, source-mapped.
- [ ] PostHog receives an event from the preview.
- [ ] Existing eq-service Vitest suite passes from inside the monorepo.
- [ ] `pnpm --filter eq-shell build` still succeeds (no regression to the other workspace app).
- [ ] Royce eyes the preview before merge.

Do NOT merge to main without Royce's explicit go. Auth/deploy changes are gated per global rules.

---

## 6. Rollback plan

The eq-solves-service repo at `C:/Projects/eq-solves-service` stays untouched throughout Phase 0. The existing Netlify site stays on its existing config. The live production URL `eq-solves-service.netlify.app` keeps serving from the old repo until DNS/domain is consciously cut over (Option B) or the Netlify base-dir is consciously switched (Option A).

**To roll back at any point:**
- Delete `eq-platform/apps/eq-service/` from the migration branch.
- Don't merge.
- Live production: untouched.

The point of no return is when Netlify cuts over. Pre-cutover, rollback is free.

---

## 7. Out of scope for Phase 0 (don't get sucked in)

- Adding the Maximo PDF drop-zone. That's Phase 1.
- Touching the confirm UI. That's Phase 2.
- Wiring `parseMaximoPdfWo` calls. That's Phase 1.
- Native `eq_intake_commit_batch` extensions. That's Phase 5 (post-demo).
- Migrating any other EQ app into the monorepo. Out of scope full stop.
- Renaming things, refactoring, "while we're here" cleanups. Phase 0 is a move, not a refactor.

---

## 8. Hand-off to Phase 1

When Phase 0 acceptance is met, Phase 1 picks up by:
1. Adding a server file at `apps/eq-service/app/api/parse-maximo-pdf/route.ts` (or matching Netlify function path under `netlify/functions/`).
2. `import { parseMaximoPdfWo } from '@eq/intake'` — this resolves cleanly because of Phase 0.
3. Calls the Anthropic provider via `@eq/ai`, JWT-forwarded from the user, never service key.
4. Streams PDF binary from form-data → vision call → returns parsed bundles JSON.
5. Drop-zone UI lives at `apps/eq-service/app/(app)/maintenance/import/` as a new "Maximo PDF" tab next to the existing spreadsheet tab.

Phase 1 brief lives in the original continuation prompt Royce handed off 2026-05-21. Re-read its §3.1 + §3.2 before starting.

---

## 9. Open questions for tomorrow

These are the things this doc deliberately did NOT decide because they need Royce's call in real time:

1. **Option A vs Option B for Netlify** (§3.1). Recommend B; ask before pulling the trigger.
2. **When to merge to main** — after Phase 0 alone, or hold until Phase 1 is also done? Holding means longer-lived migration branch. Merging early means Phase 1 lands on top cleanly.
3. **Eq-service git history** — copying the tree loses the per-file git history that's currently in `eq-solves-service.git`. Worth doing a `git subtree add` instead to preserve it? Trade-off: more complex Phase 0, but blame/history survives.

Ask in chat before acting on any of these.
