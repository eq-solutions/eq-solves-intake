-- ============================================================================
-- 014 — Rollback column fix + JWT claim path sweep (shell_control RLS)
-- ============================================================================
-- Two fixes in one migration:
--
-- A. ROLLBACK COLUMN BUG (Issue 1)
--    Migration 008 recreated eq_intake_rollback but used the wrong column name
--    `rolled_back_reason` in the UPDATE on shell_control.eq_intake_events.
--    The table DDL (001_intake_spine.sql) defines the column as `rollback_reason`
--    (no `d_back` prefix). Any rollback call would have errored at runtime with
--    "column does not exist".
--    Fix: recreate eq_intake_rollback with the correct column name.
--
-- B. JWT CLAIM PATH SWEEP — shell_control RLS (Issue 2)
--    Migrations 001-006 created RLS policies on shell_control tables using:
--      auth.jwt() -> 'user_metadata' ->> 'tenant_id'
--    Migration 007+ standardised on:
--      auth.jwt() -> 'app_metadata' ->> 'tenant_id'
--    This migration sweeps all shell_control table policies to app_metadata.
--    Tables covered:
--      - shell_control.eq_intake_templates   (select, insert, update)
--      - shell_control.eq_intake_events      (select, insert, update)
--      - shell_control.eq_intake_row_audit   (select, insert)
--      - shell_control.eq_export_events      (select, insert)
--      - shell_control.eq_export_profiles    (select, insert)
--
-- Idempotent: uses DROP IF EXISTS + CREATE (Postgres has no CREATE OR REPLACE
-- POLICY). Safe to re-run.
-- ============================================================================

-- ============================================================================
-- A. Fix eq_intake_rollback — correct column name rollback_reason
-- ============================================================================
-- Full body is identical to migration 008 except line:
--   rolled_back_reason = p_reason  →  rollback_reason = p_reason

create or replace function eq_intake_rollback(p_intake_id uuid, p_reason text)
returns table (unwound_count int)
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare
  v_tenant_id uuid;
  v_total int := 0;
  v_n int;
begin
  -- Look up the tenant for this intake
  select tenant_id into v_tenant_id
  from shell_control.eq_intake_events
  where intake_id = p_intake_id;

  if v_tenant_id is null then
    raise exception 'intake_id % not found', p_intake_id;
  end if;

  perform _eq_intake_check_tenant_match(v_tenant_id);

  -- Call every per-domain unwinder. Each is idempotent (returns 0 if no rows).
  -- Order: dependents first (cards licences FK to staff; field tables FK to sites)
  v_n := _eq_intake_unwind_cards(p_intake_id, v_tenant_id); v_total := v_total + v_n;
  v_n := _eq_intake_unwind_field(p_intake_id, v_tenant_id); v_total := v_total + v_n;
  v_n := _eq_intake_unwind_service(p_intake_id, v_tenant_id); v_total := v_total + v_n;
  v_n := _eq_intake_unwind_quotes(p_intake_id, v_tenant_id); v_total := v_total + v_n;
  v_n := _eq_intake_unwind_core(p_intake_id, v_tenant_id); v_total := v_total + v_n;

  -- Mark the event as rolled back
  -- FIX: column is rollback_reason (not rolled_back_reason as in migration 008)
  update shell_control.eq_intake_events
  set status = 'rolled_back',
      rolled_back_at = now(),
      rollback_reason = p_reason
  where intake_id = p_intake_id;

  return query select v_total;
end $$;

-- Re-apply grants (idempotent)
revoke execute on function eq_intake_rollback(uuid, text) from public, anon;
grant execute on function eq_intake_rollback(uuid, text) to authenticated;

-- ============================================================================
-- B. JWT claim path sweep — shell_control RLS policies
-- ============================================================================
-- All policies below: user_metadata → app_metadata
-- Pattern: DROP IF EXISTS then CREATE (no "create or replace policy" in Postgres)

-- ----------------------------------------------------------------------------
-- shell_control.eq_intake_templates
-- ----------------------------------------------------------------------------
drop policy if exists eq_intake_templates_select on shell_control.eq_intake_templates;
create policy eq_intake_templates_select on shell_control.eq_intake_templates
  for select using (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    or is_global = true
  );

drop policy if exists eq_intake_templates_insert on shell_control.eq_intake_templates;
create policy eq_intake_templates_insert on shell_control.eq_intake_templates
  for insert with check (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

drop policy if exists eq_intake_templates_update on shell_control.eq_intake_templates;
create policy eq_intake_templates_update on shell_control.eq_intake_templates
  for update
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

-- ----------------------------------------------------------------------------
-- shell_control.eq_intake_events
-- ----------------------------------------------------------------------------
drop policy if exists eq_intake_events_select on shell_control.eq_intake_events;
create policy eq_intake_events_select on shell_control.eq_intake_events
  for select using (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

drop policy if exists eq_intake_events_insert on shell_control.eq_intake_events;
create policy eq_intake_events_insert on shell_control.eq_intake_events
  for insert with check (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

drop policy if exists eq_intake_events_update on shell_control.eq_intake_events;
create policy eq_intake_events_update on shell_control.eq_intake_events
  for update
  using (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

-- ----------------------------------------------------------------------------
-- shell_control.eq_intake_row_audit
-- ----------------------------------------------------------------------------
drop policy if exists eq_intake_row_audit_select on shell_control.eq_intake_row_audit;
create policy eq_intake_row_audit_select on shell_control.eq_intake_row_audit
  for select using (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

drop policy if exists eq_intake_row_audit_insert on shell_control.eq_intake_row_audit;
create policy eq_intake_row_audit_insert on shell_control.eq_intake_row_audit
  for insert with check (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

-- ----------------------------------------------------------------------------
-- shell_control.eq_export_events
-- ----------------------------------------------------------------------------
drop policy if exists eq_export_events_select on shell_control.eq_export_events;
create policy eq_export_events_select on shell_control.eq_export_events
  for select using (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

drop policy if exists eq_export_events_insert on shell_control.eq_export_events;
create policy eq_export_events_insert on shell_control.eq_export_events
  for insert with check (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

-- ----------------------------------------------------------------------------
-- shell_control.eq_export_profiles
-- ----------------------------------------------------------------------------
drop policy if exists eq_export_profiles_select on shell_control.eq_export_profiles;
create policy eq_export_profiles_select on shell_control.eq_export_profiles
  for select using (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    or is_global = true
  );

drop policy if exists eq_export_profiles_insert on shell_control.eq_export_profiles;
create policy eq_export_profiles_insert on shell_control.eq_export_profiles
  for insert with check (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

-- ============================================================================
-- Migration record
-- ============================================================================
insert into app_data._eq_migrations (name) values ('014_rollback_column_fix')
on conflict (name) do nothing;
