-- ============================================================================
-- 015 — shell_control policy gap fill (missing UPDATE/DELETE policies)
-- ============================================================================
-- Migration 001 created initial RLS policies on shell_control tables but left
-- several CRUD operations without policies. Rows are only visible/writable when
-- a matching policy exists; missing policies silently block the operation.
--
-- Gaps identified by auditing 001-013:
--
--   shell_control.eq_intake_templates
--     present:  SELECT, INSERT, UPDATE
--     missing:  DELETE
--
--   shell_control.eq_intake_events
--     present:  SELECT, INSERT, UPDATE
--     missing:  DELETE
--
--   shell_control.eq_intake_row_audit
--     present:  SELECT, INSERT
--     missing:  UPDATE, DELETE
--
--   shell_control.eq_export_events
--     present:  SELECT, INSERT
--     missing:  UPDATE, DELETE
--
--   shell_control.eq_export_profiles
--     present:  SELECT, INSERT
--     missing:  UPDATE, DELETE
--
-- All new policies use app_metadata claim path (post-014 standard).
-- Pattern: DROP IF EXISTS then CREATE (idempotent).
-- Predicate: tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
-- ============================================================================

-- ----------------------------------------------------------------------------
-- shell_control.eq_intake_templates — add DELETE
-- ----------------------------------------------------------------------------
drop policy if exists eq_intake_templates_delete on shell_control.eq_intake_templates;
create policy eq_intake_templates_delete on shell_control.eq_intake_templates
  for delete
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

-- ----------------------------------------------------------------------------
-- shell_control.eq_intake_events — add DELETE
-- ----------------------------------------------------------------------------
drop policy if exists eq_intake_events_delete on shell_control.eq_intake_events;
create policy eq_intake_events_delete on shell_control.eq_intake_events
  for delete
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

-- ----------------------------------------------------------------------------
-- shell_control.eq_intake_row_audit — add UPDATE + DELETE
-- ----------------------------------------------------------------------------
drop policy if exists eq_intake_row_audit_update on shell_control.eq_intake_row_audit;
create policy eq_intake_row_audit_update on shell_control.eq_intake_row_audit
  for update
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

drop policy if exists eq_intake_row_audit_delete on shell_control.eq_intake_row_audit;
create policy eq_intake_row_audit_delete on shell_control.eq_intake_row_audit
  for delete
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

-- ----------------------------------------------------------------------------
-- shell_control.eq_export_events — add UPDATE + DELETE
-- ----------------------------------------------------------------------------
drop policy if exists eq_export_events_update on shell_control.eq_export_events;
create policy eq_export_events_update on shell_control.eq_export_events
  for update
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

drop policy if exists eq_export_events_delete on shell_control.eq_export_events;
create policy eq_export_events_delete on shell_control.eq_export_events
  for delete
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

-- ----------------------------------------------------------------------------
-- shell_control.eq_export_profiles — add UPDATE + DELETE
-- ----------------------------------------------------------------------------
drop policy if exists eq_export_profiles_update on shell_control.eq_export_profiles;
create policy eq_export_profiles_update on shell_control.eq_export_profiles
  for update
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

drop policy if exists eq_export_profiles_delete on shell_control.eq_export_profiles;
create policy eq_export_profiles_delete on shell_control.eq_export_profiles
  for delete
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

-- ============================================================================
-- Migration record
-- ============================================================================
insert into app_data._eq_migrations (name) values ('015_policy_gap_fill')
on conflict (name) do nothing;
