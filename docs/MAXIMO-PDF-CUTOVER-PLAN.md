# Maximo PDF intake — Netlify cutover plan

**Authoring context:** 2026-05-21 evening, after the morning-session audit. PR [#7](https://github.com/eq-solutions/eq-solves-intake/pull/7) is open against `eq-solutions/eq-solves-intake`. eq-service Netlify site `eq-solves-service` (ID `6af7bce6-9d4c-4567-88fa-783abf5eb041`, plan `nf_team_pro`) currently deploys from `Milmlow/eq-solves-service`. This doc covers the move to the monorepo source.

## TL;DR — three things in order

1. **Add `ANTHROPIC_API_KEY` to Netlify env** (you, via dashboard). The key never enters source.
2. **Decide on the 26-second cliff** before cutting over (see §3). This is the actual blocker, not the topology.
3. **Cutover via Option B** (new site → DNS swap). Documented step-by-step in §4.

## 1. Env var to add before cutover

Set via [Netlify dashboard → eq-solves-service → Site configuration → Environment variables](https://app.netlify.com/projects/eq-solves-service/configuration/env), or via the bundled Netlify MCP.

| Key | Value | Scopes | Contexts | Secret? |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | from console.anthropic.com (your account) | builds + functions + runtime | `production` only (deploy-previews don't need to burn vision tokens) | **yes** |

The route at [eq-platform/apps/eq-service/app/api/parse-maximo-pdf/route.ts](../eq-platform/apps/eq-service/app/api/parse-maximo-pdf/route.ts) reads `process.env.ANTHROPIC_API_KEY` and returns HTTP 500 with a clear "not configured" message when it's missing — so the failure mode is obvious if we ever forget.

Already present in env (verified via MCP, no action needed): `SUPABASE_*`, `SENTRY_*`, `POSTHOG_*`, `NEXT_PUBLIC_*`. PostHog `maximo_pdf_parsed` + `maximo_pdf_committed` events will land in EU instance automatically.

## 2. Skip Option A; Option B is the right move

| | **Option A — repoint existing site** | **Option B — new site + DNS swap** ✅ |
|---|---|---|
| Steps | Change Netlify site's connected repo from `Milmlow/eq-solves-service` to `eq-solutions/eq-solves-intake`, change base dir to `eq-platform/`, change build cmd to pnpm, redeploy. | New Netlify site connected to the monorepo. Configure base dir, build cmd, env vars (paste from existing). Verify on staging URL. Swap DNS / primary domain when ready. |
| Time | ~30 min | ~60 min |
| Risk | If anything's wrong, live `eq-solves-service.netlify.app` is broken until rolled back. Roll-back means another redeploy. | Old site keeps serving until you swap DNS. Failed staging URL has zero customer impact. Roll-back is "don't swap DNS." |
| Recommendation | — | Choose B. The extra 30 min buys real safety. |

## 3. The 26-second cliff — biggest risk, address before any cutover

Netlify Pro's synchronous function cap is 26 seconds. Background functions get 15 minutes, but require a different invocation pattern. Real-world latency on the four-PDF fixture (verified 2026-05-21):

| PDF | Pages | Latency |
|---|---|---|
| CUFT (clean) | 1 | ~28s |
| Scanned multi-WO #1 | 2 | ~80s |
| Scanned multi-WO #2 | 2 | ~80s |
| Scanned multi-WO #3 | 2 | ~80s |
| **Total 4-PDF run** | 7 | **~322s** |

Even a single scanned PDF blows the 26s limit. The route will return a Netlify-level timeout error to the client; the user sees a generic failure; Sentry will catch the function-aborted event.

**Three ways to clear the cliff:**

| Path | Effort | Tradeoff |
|---|---|---|
| **Run demo from localhost** (Royce's laptop, `pnpm --filter eq-solves-service dev`) | None | Authentic for a v1 demo. No production exposure of the issue. **Pick this for the 2026-06-04 demo if we don't have time for the refactor.** |
| **Background-function migration** | ~1 day | Server writes parse state to a `maintenance_imports` row, the client polls every 2-5s. Real production fix. Tracked as a follow-up task. |
| **Bump to Netlify Enterprise** | $ | Higher sync limit. Wrong reason to upgrade. |

The PR explicitly notes this isn't fixed. Don't cut over to a public URL with the sync route still in place — the first vision call will fail visibly.

## 4. Option B — step-by-step cutover

Pre-flight (do once we're past the 26s decision):

- [ ] Confirm PR #7 is merged to `eq-solves-intake/main` (or use the PR branch if you want a staging-only deploy first).
- [ ] Confirm `ANTHROPIC_API_KEY` is procured.
- [ ] Confirm DNS provider login is at hand (no surprises mid-cutover).

In Netlify dashboard or via MCP:

1. **Create new site** linked to `eq-solutions/eq-solves-intake`, branch `main` (or the PR branch for a dry run).
2. **Base directory**: `eq-platform/`
3. **Build command**: `pnpm install --frozen-lockfile && pnpm --filter eq-solves-service build`
4. **Publish directory**: `eq-platform/apps/eq-service/.next`
5. **Functions directory**: `eq-platform/apps/eq-service/.netlify/functions-internal` (Next.js default for App Router routes)
6. **Node version**: `20.11` or newer (matches workspace `engines.node`)
7. **Package manager**: `pnpm` (Netlify autodetects from `packageManager` field in root `package.json`)

Paste env vars from the existing site (run `manage-env-vars getAllEnvVars` on `6af7bce6-…` to dump, then bulk-add to the new site). Add `ANTHROPIC_API_KEY` separately.

Smoke test on the staging URL Netlify gives you:
- [ ] Login works.
- [ ] `/maintenance/import` renders both tabs.
- [ ] Spreadsheet tab still parses Delta xlsx correctly (no regression).
- [ ] Maximo PDF tab — drop ONE small fixture PDF (CUFT, ~28s). Confirm vision is wired. **It WILL time out at 26s; that's the cliff we already know about.**
- [ ] Sentry receives a deliberate test error. PostHog receives a `dashboard_viewed` event.

Once the staging site is healthy:

8. **Update DNS** — point the apex / `eq-solves-service.netlify.app` custom-domain at the new site. Or transfer the Netlify-managed `*.netlify.app` slug.
9. **Pause the old site** (don't delete) so we can roll back inside 5 minutes.
10. **Monitor Sentry + PostHog** for the next 24 hours. Any flood of errors → DNS-swap-back.

## 5. Rollback

Old Netlify site stays paused, not deleted. To roll back:

1. Repoint DNS / custom domain back at the old site.
2. Unpause the old site.

Live again on the old standalone repo in ~5 minutes.

## 6. Once Netlify is on the monorepo

- Push to `eq-solutions/eq-solves-intake/main` → deploys eq-service.
- Push to `Milmlow/eq-solves-service` → no effect on the live site (the old standalone is paused).
- You can either delete the old standalone repo or keep it as historical reference. **Don't delete until at least 2 weeks of stable monorepo deploys.**
