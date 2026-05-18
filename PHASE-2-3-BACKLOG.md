# EQ Intake — Phase 2/3+ Backlog

Items deferred from Phase 1 during the 28 Apr 2026 review. Captured here so they're not lost. Each item has a target phase and a brief rationale. Re-evaluate at start of each phase.

---

## Phase 2 (EQ Import UI + EQ Cards UI)

These items unblock the user-facing import experience.

### PPM workflow canonical entities (added 29 Apr 2026 evening)

Four new canonical schemas to support the PPM register → schedule → site
visit → completion → register-update loop end-to-end. Today this loop is
hand-driven — a coordinator hand-builds monthly SOWs from a master register
and an annual schedule; a bookkeeper retypes "Last Thermal: 2026-05-01"
back into the register from filled-in field paperwork. This is the pain
the conduit thesis most directly removes for contractors with recurring
client-mandated maintenance work.

**Why deferred from Phase 1 (despite being foundational):** Adding four
canonical schemas is design-heavy work that wants Royce in the chair —
FK directions, RLS posture, RPC surface, indexes for the most-common
queries. Not loop-friendly. The lighter additions to `asset` (condition,
ppm_frequency, client_classification, defects_summary) shipped in Phase 1.

**`service_visit`** — a day at a site. Replaces the manual Master
Schedule + SOW Summary sheets.
- visit_id (uuid), tenant_id, site_id (FK site), scheduled_date,
  actual_date, crew_lead (FK staff), client_job_code, status (planned /
  in_progress / complete / cancelled), logistics_notes, expected_assets
  (count), expected_circuits (count)
- Indexed on (tenant_id, site_id, scheduled_date)

**`service_task_completion`** — a single tickbox completed during a
visit. Replaces the SOW Asset Schedule's tickbox grid.
- completion_id (uuid), tenant_id, visit_id (FK service_visit),
  asset_id (FK asset), task_type (enum: annual_db_maint, msb_maint,
  thermal_test, rcd_test, generator_run_start, ups_maint,
  battery_load_test, earth_continuity_test, polarity_test, ...),
  completed (bool), completed_at (timestamp), tech (FK staff), notes
- One row per asset × task per visit.

**`asset_test_result`** — a compliance-regulated test result. Backs
the licensed-electrician signoff that must survive forever.
- result_id (uuid), tenant_id, asset_id (FK asset), test_type
  (enum: rcd_trip_time, thermal_scan, megger, earth_continuity, polarity,
  insulation_resistance, residual_current, voltage_drop, ...), test_date,
  tested_by (FK staff, nullable for external testers), tested_by_external
  (string, when not in our staff table), licence_number, signature_attached
  (file ref), pass_fail (enum: pass / fail / partial / inconclusive),
  raw_values (jsonb — test-type-specific structured result),
  action_taken_if_fail, test_cert_reference (string)
- This is the canonical record that "Last Thermal" / "Last RCD Test"
  fields on asset are derived from. One source of truth, queryable history.

**`asset_defect`** — an open issue against an asset.
- defect_id (uuid), tenant_id, asset_id (FK asset), raised_date,
  raised_by (FK staff), severity (enum: critical / high / medium / low),
  description, status (enum: open / in_progress / resolved / deferred /
  no_action), resolution_date, resolved_by, resolution_notes,
  estimated_cost, actual_cost, photo_attachments (file refs)
- The asset.defects_summary field (added in Phase 1) is the denormalised
  one-glance text; this is the structured truth.

**Why these four together:** They flip the workflow from "bookkeeper
manually keeps register in sync with paper coming back from site" to
"register is a view computed from visits + completions + test results +
open defects." Same data structure works for a 5-person crew with one
client and a 200-person crew with thirty clients — the second crew just
has more rows. This is "deeper integration as crew grows" under the
integration-depth pricing read (memory `eq_pricing_frame`), not a tiered
upsell.

**Out-of-scope for these four entities (split deliberately):**
- Cross-tenant template sharing for service_task definitions (Phase 5
  template marketplace; see existing entry below)
- Real-time crew tracking / location during visits (out of EQ scope —
  job-management systems do this)
- Photo evidence storage for completions (R2 retention design lands
  with Phase 4 export — references already supported via file refs)

**Acceptance:** Four canonical schemas + auto-generated TS/Zod types.
Migration script applying them to a real Supabase project. Three
real-world test fixtures (using generic placeholder customer names)
end-to-end through `validate()`: a Master Register import, a monthly
SOW import, a completed-visit upload. `processCapture()` updated to
recognise photographed RCD test reports and emit asset_test_result
records.

### Heuristic fallback mapping mode
When Claude is down/slow/expensive, fall back to alias-only matching (does any source column exactly match a `x-eq-source-aliases` entry?). Handles ~60% of real-world cases without AI. Manual mapping UI catches the rest.

**Why deferred from Phase 1:** Phase 1 has the alias data already in the schemas. This is a "use it without AI" path that needs the UI to expose it, which doesn't exist yet.

**Acceptance:** Toggle in EQ Import UI: "Use AI mapping (default)" vs "Manual / heuristic only". Latter never calls `eq-ai`. Coverage report shows what couldn't be matched without AI.

### Token budgeting / batched column mapping
For files with 100+ columns, batch column-mapping calls to keep token usage and latency bounded. Cluster columns by likely entity area first (e.g. financial, contact, scheduling) and call AI per cluster.

**Why deferred from Phase 1:** Real-world files rarely exceed 30 columns. Premature optimisation until we see the failure mode.

**Acceptance:** Synthetic 200-column file maps successfully in <30s, no single AI call exceeds 8k input tokens.

### Multi-tab Excel parsing
Workbooks with multiple sheets — let user pick which sheet(s) to import, or auto-detect "this sheet is the staff list, this one is the asset register".

**Why deferred from Phase 1:** Phase 1 takes a single sheet's worth of rows as input. Sheet selection is a UI concern.

**Acceptance:** Upload a workbook with 4 tabs, get a tab-picker, can import from one or several to different canonical entities.

### Confirmation UI (the spec from `CONFIRM-UI-SPEC.md`)
React components for: mapping confirm screen, flagged-row resolution screen, commit progress, completion summary. Built in `packages/eq-confirm-ui` per the spec.

**Why deferred from Phase 1:** Phase 1 is shared packages + DB only. UI needs the packages to exist first.

**Acceptance:** Spec implemented end-to-end. Mobile responsive. Keyboard accessible. Telemetry events firing.

### Cloudflare Worker proxy for AI calls
Anthropic API calls go via a CF Worker that handles auth, rate limiting, request shaping, and response caching. Avoids exposing API keys client-side.

**Why deferred from Phase 1:** `eq-ai` package abstracts the call. Phase 1 can run server-side from Next.js API routes for SKS testing. Worker is the production hardening.

**Acceptance:** All client AI calls go via `https://ai-proxy.eq.solutions/...`. Worker enforces per-tenant rate limits. Failed/timed-out calls return structured errors that the client UI can recover from.

### Rate limiting on intake itself
Per-tenant queue with concurrency limit (e.g. max 3 concurrent imports per tenant, max 50 per day on free tier). Prevents accidental DDoS-via-import.

**Why deferred from Phase 1:** Quota concerns become real once UI exists.

**Acceptance:** Tenant exceeds quota → friendly error, retry-after header, telemetry event. Configurable per plan.

### Failure recovery for partial commits
If `eq_intake_commit_batch` fails on row 5,000 of 10,000, current behaviour is "transaction rolled back, nothing committed". Better: chunked transactions (e.g. 500 rows each), so partial progress is preserved and the user can retry just the failed chunks.

**Why deferred from Phase 1:** SKS first-run files are <500 rows. Chunking matters at scale.

**Acceptance:** 10k row import with simulated failure at row 5,000 → 4,500 rows committed, user gets a "retry from row 5,000" option, `eq_intake_events.status = 'partial'` until resolved.

### Observability dashboard
Track per-tenant: mapping success rate, average AI confidence, user override frequency, cache hit rate, rejection rates by error type. Alert on "rejection rate >20% for an entity over 7 days" (schema drift indicator).

**Why deferred from Phase 1:** `eq-ai` is already capturing the metrics; the dashboard UI is Phase 2 work.

**Acceptance:** EQ admin can see per-tenant intake health. Tenant admin can see their own. Alerts fire to Slack/email.

### Bulk inline editing of canonical values in confirm UI
Currently the confirm UI is review-only (per spec). Sometimes users want to fix small issues inline rather than re-uploading. Add a per-cell edit affordance with audit trail.

**Why deferred from Phase 1:** Risk of users introducing data quality problems they would have caught at source. Defer until we see the user behaviour.

**Acceptance:** Edit a flagged row's canonical value inline, edit is recorded in `eq_intake_row_audit.user_overrides`, original raw value preserved.

---

## Phase 3 (already moved here from Phase 5 in v1.1)

### EQ Capture mobile UX
Phase 1 builds the capture *pipeline*. Phase 3 builds the *experience*: mobile-first photo upload, batch session ("photograph all 12 prestart forms in one go"), offline queue for poor-signal sites.

**Acceptance:** SKS field crew can photograph paper SWMS on site, queue locally, upload when signal returns. Bulk session captures 5+ forms in a single workflow.

### Email-in capture forwarding
Tenant gets a capture inbox: `tenant-abc123@capture.eq.solutions`. Forwarded supplier PDFs, invoices, completed paper forms get auto-routed to the appropriate canonical entity based on document content.

**Acceptance:** Forward a supplier invoice PDF → appears in EQ Capture inbox within 60s, user reviews extraction, commits to expenses.

### Progressive onboarding for templates
After 3+ successful imports of the same template, prompt: "We notice you import HR data every month — want to schedule this?" Gentle automation suggestion, not forced.

**Acceptance:** Template hits 3+ successful uses → in-app prompt offering scheduled import. User can accept (configures schedule + delivery) or dismiss permanently.

### Sensitive field handling on export
Cost rates flagged sensitive on import — extend to export. Default to masked (`••••••`) for non-admin roles. Admin can opt-in to include.

**Acceptance:** Non-admin user generates export → cost rate column missing or masked. Admin user → full data with explicit consent click.

---

## Phase 4 (EQ Export build)

### Custom export profiles for client formats
Users define their own export templates (column mapping in reverse, plus formatting). AI-assisted: upload a target template, AI maps canonical fields → template columns.

**Acceptance:** User uploads "this is what our client ACME wants every month", AI builds the profile, future exports auto-generate to that format.

### Webhook / API intake surface — "EQ Connect"
Fourth intake surface (after Cards / Import / Capture). Customers' existing systems POST canonical-shaped JSON to `/api/v1/intake/<entity>`. Same validation engine, same flag-and-confirm UX (asynchronous).

**Why deferred:** Phase 1 thesis is "three doors in" — adding API muddies the marketing. Position as a Phase 4 enterprise feature.

**Acceptance:** Postman collection works against real endpoint. Webhook signature verification. Batch ingest of 1k records. Async confirmation flow (queue + email-back when ready).

### "Export to my accountant" one-click profiles
Pre-built export profiles for common AU accounting firms / formats. User picks "Export to Xero (BAS-ready)" or "Export to MYOB (timesheet format)" and it Just Works.

**Acceptance:** 5 pre-built profiles ship: Xero general, MYOB general, QuickBooks general, generic CSV BAS-ready, generic XLSX with AU date format.

### Bulk export API + scheduled jobs with webhooks
Export runs on a cron schedule. On completion, fire a webhook with download URL. Customer's pipeline pulls + processes.

**Acceptance:** Schedule "weekly Friday 5pm export of timesheets to XYZ format" → file generated, webhook fired with signed URL, audit trail captured.

### Dry-run preview for exports
Before generating a 10MB file, show the user a 10-row sample with all transformations applied. Catches mistakes early.

**Acceptance:** "Preview" button on export config shows live sample. "Generate" only available after preview reviewed.

### R2 retention policy
Codify the 7-year default + 30-year opt-in. Lifecycle policies move files to Glacier-equivalent after 90 days. Tenant admin can see retention status per file.

**Acceptance:** Default tenant has 7-year retention. Admin enables 30-year on Pro plan tier. Tier changes propagate retroactively (with confirmation).

---

## Phase 5+ / Backlog (no specific phase yet)

### Template marketplace — opt-in promotion to global library
Tenants who built valuable mappings can opt-in to share. EQ admin reviews + promotes to global. Other tenants benefit. Strong network effect, but data sensitivity concerns mean review is essential.

**Why deferred:** Premature until we have ≥20 tenants generating templates. Risk of leaking source-data signatures.

**Decision points before building:** Do tenant TOS allow this? What does the review process look like? Is template attribution displayed?

### Entity versioning / event sourcing lite
Append-only `entity_versions` log capturing every change to canonical rows. Regulators may eventually demand this; some industries require it.

**Why deferred:** `eq_intake_events` + `eq_intake_row_audit` already provide the lineage AU regulators care about. Triple the storage cost is not justified yet.

**Trigger to build:** A customer (likely a larger subbie working with regulated clients) genuinely needs SOC2 Type II evidence to keep their work.

### Virus scanning on upload
ClamAV or equivalent on every uploaded file before processing.

**Why deferred:** Files go to private R2, never executed, never re-served to other users. Real risk surface (XLSX macros) is ignored by the parser. ClamAV adds latency, catches almost nothing real.

**Trigger to build:** First procurement-driven SOC2 / ISO27001 conversation that demands it.

### Local model deployment for privacy-sensitive tenants
Some tenants (defence-adjacent, healthcare) won't allow data to touch external AI. `eq-ai` interface is built for this — implement a `LocalProvider` running ONNX/llama.cpp inference.

**Why deferred:** Vendor abstraction is in Phase 1; second implementation only matters when someone real needs it for genuine data-residency reasons.

**Trigger:** A customer can't use EQ otherwise because their client (e.g. defence-adjacent, healthcare regulator) requires data to stay on-prem.

### Mapping suggestions improvement loop
When a user overrides an AI mapping, capture the override and feed it as additional context to future similar imports. Learns the customer's preferences without retraining.

**Why deferred:** Telemetry needs to exist first (Phase 2). The signal-to-noise ratio of overrides isn't proven.

### Cross-entity dependencies in import
Currently each entity imports independently. A single ZIP could contain `staff.csv` + `sites.csv` + `assignments.csv` where assignments reference both. Resolve in dependency order with shared FK lookup cache.

**Why deferred:** Single-entity is the 90% case. Multi-entity import is a power-user feature.

---

## Decisions to revisit at Phase 2 kickoff

1. **Confirmation UI framework choice** — React in Next.js (current default) vs. shipping as a standalone widget that embeds in any app. Decide before sprint 1 of Phase 2.
2. **Cloudflare Worker proxy granularity** — one proxy for all AI calls, or per-call-type? Affects cost attribution and rate limiting design.
3. **Append vs upsert default for EQ Cards** — currently planning `append` default everywhere. Cards may want `upsert` (re-submitting a SWMS = update existing).

---

*Living document. Update at the end of each phase with new deferrals and re-evaluations.*
