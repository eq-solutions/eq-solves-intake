-- ============================================================================
-- 030 — Caller-tenant self-gating on authenticated-callable SECURITY DEFINER RPCs
-- ============================================================================
-- Applies to: any canonical project where these four RPCs already exist.
-- As of 2026-05-31 that is sks-canonical (ehowgjardagevnrluult) ONLY. The EQ
-- tenant does not yet expose them: eq-canonical (jvknxcmbtrfnxfrwfimn, control
-- plane) has no app_data; eq-canonical-internal (zaapmfdkgedqupfjtchl) has the
-- app_data tables but not these functions. Do NOT run this there to create them
-- fresh — that would add authenticated-callable surface. Run only once the EQ
-- side actually deploys the equivalent RPCs.
--
-- Closes a horizontal-authz gap flagged by the Supabase database linter
-- (0029_authenticated_security_definer_function_executable). Four SECURITY
-- DEFINER functions are EXECUTE-granted to `authenticated` but bypass RLS and
-- did not verify the caller belongs to the tenant they were acting on:
--
--   app_data.submit_safety_record(p_tenant_id, p_record_id, p_table_name)
--   app_data.approve_safety_record(p_tenant_id, p_record_id, p_table_name)
--     -> trusted a caller-supplied p_tenant_id outright.
--   public.eq_read_customers_by_intake(p_intake_id)
--   public.eq_read_staff_by_intake(p_intake_id)
--     -> returned id<->external_id pairs for any intake_id, no tenant scope.
--
-- Fix: each function now self-gates on the JWT tenant, mirroring how the
-- existing eq_upsert_* / eq_archive_* CRUD RPCs already check auth.jwt().
-- We do NOT revoke EXECUTE: the safety RPCs are designed to be called
-- browser-direct (migration 025), and the read RPCs are called by the intake
-- commit bridge (commit-canonical.ts) using the shell's authenticated client.
--
-- Dual call-path safety: these functions are also EXECUTE-granted to
-- `service_role` (server orchestrator / direct connections). A service_role
-- key or a non-REST connection has no 'authenticated' role claim, so the guard
-- below TRUSTS it and skips the tenant check. Only `authenticated` callers are
-- forced to match their own tenant. The committed-tenant rows therefore still
-- resolve for the normal browser flow (a user only ever commits/acts on their
-- own tenant); only cross-tenant reads/writes are now blocked.
--
-- The JWT claim path (app_metadata.tenant_id) is the same source RLS reads.
-- Idempotent (CREATE OR REPLACE) — safe to run on both projects.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- public.eq_read_customers_by_intake  (was migration 019)
-- ----------------------------------------------------------------------------
create or replace function eq_read_customers_by_intake(
  p_intake_id uuid
)
returns table(customer_id uuid, external_id text)
language sql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
  select c.customer_id, c.external_id
  from app_data.customers c
  where c.intake_id = p_intake_id
    and (
      -- service_role / non-REST / direct connection: trusted, no tenant scope
      coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role'
        is distinct from 'authenticated'
      -- authenticated (browser) caller: rows must belong to the caller's tenant
      or c.tenant_id =
         (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'tenant_id')::uuid
    );
$$;

revoke execute on function eq_read_customers_by_intake(uuid) from public, anon;
grant  execute on function eq_read_customers_by_intake(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- public.eq_read_staff_by_intake  (was migration 027)
-- ----------------------------------------------------------------------------
create or replace function eq_read_staff_by_intake(p_intake_id uuid)
returns table (staff_id uuid, external_id text)
language sql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
  select s.staff_id, s.external_id
  from   app_data.staff s
  where  s.intake_id = p_intake_id
    and  s.external_id is not null
    and (
      coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role'
        is distinct from 'authenticated'
      or s.tenant_id =
         (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'tenant_id')::uuid
    );
$$;

revoke execute on function eq_read_staff_by_intake(uuid) from public, anon;
grant  execute on function eq_read_staff_by_intake(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- app_data.submit_safety_record  (was migration 025)
-- ----------------------------------------------------------------------------
create or replace function app_data.submit_safety_record(
  p_tenant_id  uuid,
  p_record_id  uuid,
  p_table_name text
)
returns void
language plpgsql
security definer
set search_path = app_data
as $$
declare
  v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
begin
  -- Authenticated (browser) callers may only act within their own tenant.
  -- service_role / trusted server contexts bypass (no 'authenticated' role claim).
  if v_claims ->> 'role' = 'authenticated'
     and p_tenant_id is distinct from (v_claims -> 'app_metadata' ->> 'tenant_id')::uuid then
    raise exception 'Tenant mismatch: caller may not act on tenant %', p_tenant_id
      using errcode = 'EQ010';
  end if;

  if p_table_name = 'prestart_checks' then
    update app_data.prestart_checks
      set status = 'submitted'
    where prestart_id = p_record_id
      and tenant_id   = p_tenant_id
      and status      = 'draft';

  elsif p_table_name = 'toolbox_talks' then
    update app_data.toolbox_talks
      set status = 'submitted'
    where talk_id   = p_record_id
      and tenant_id = p_tenant_id
      and status    = 'draft';

  else
    raise exception 'Unknown table: %', p_table_name;
  end if;

  if not found then
    raise exception 'Record not found or not in draft state: % %', p_table_name, p_record_id;
  end if;
end;
$$;

revoke all    on function app_data.submit_safety_record(uuid, uuid, text) from public, anon;
grant  execute on function app_data.submit_safety_record(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- app_data.approve_safety_record  (was migration 025)
-- ----------------------------------------------------------------------------
create or replace function app_data.approve_safety_record(
  p_tenant_id  uuid,
  p_record_id  uuid,
  p_table_name text
)
returns void
language plpgsql
security definer
set search_path = app_data
as $$
declare
  v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
begin
  if v_claims ->> 'role' = 'authenticated'
     and p_tenant_id is distinct from (v_claims -> 'app_metadata' ->> 'tenant_id')::uuid then
    raise exception 'Tenant mismatch: caller may not act on tenant %', p_tenant_id
      using errcode = 'EQ010';
  end if;

  if p_table_name = 'prestart_checks' then
    update app_data.prestart_checks
      set status = 'approved'
    where prestart_id = p_record_id
      and tenant_id   = p_tenant_id
      and status      = 'submitted';

  elsif p_table_name = 'toolbox_talks' then
    update app_data.toolbox_talks
      set status = 'approved'
    where talk_id   = p_record_id
      and tenant_id = p_tenant_id
      and status    = 'submitted';

  else
    raise exception 'Unknown table: %', p_table_name;
  end if;

  if not found then
    raise exception 'Record not found or not in submitted state: % %', p_table_name, p_record_id;
  end if;
end;
$$;

revoke all    on function app_data.approve_safety_record(uuid, uuid, text) from public, anon;
grant  execute on function app_data.approve_safety_record(uuid, uuid, text) to authenticated;

-- Migration record
insert into app_data._eq_migrations (name) values ('030_secdef_caller_tenant_guard')
on conflict (name) do nothing;
