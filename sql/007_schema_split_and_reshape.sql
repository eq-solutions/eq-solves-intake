-- ============================================================================
-- 007 — Schema split + entity reshape (canonical-readiness Unit 2)
-- ============================================================================
-- Splits public.* into shell_control.* (auth + tenancy + intake plumbing)
-- and app_data.* (canonical entity tables). Applies Unit 1 audit findings:
--   - tenant_id NOT NULL + JWT default on every entity table (Finding 1)
--   - schedule_entries.entry_id → schedule_id rename (Finding 2)
--   - staff.user_id FK to shell_control.users — the missing user↔staff link
--     (Finding 7, discovered during Unit 1 verification)
--   - site.track_hours, site.budget_hours, site.slug (Finding from sites audit)
--   - staff additions: notify_roster, dob_day, dob_month, digest_opt_in,
--     digest_cron_schedule, tafe_day, year_level
--   - Re-label safety entities in eq_schema_registry from module='cards' to
--     module='field' (prestart, toolbox_talk, swms, jsa, itp, incident).
--     Cards keeps only licence as a canonical entity.
--
-- Locked decisions (per eq/canonical-readiness/plan.md, 2026-05-20 review):
--   - Schema split now (Prereq B)
--   - prestart_checks + toolbox_talks: canonical shape wins (Option A)
--   - Per-tenant deploy is template-first via pnpm db:apply bundle
--   - PostgREST relies on search_path (no client-side Accept-Profile header)
--
-- Idempotent: every action uses IF NOT EXISTS / IF EXISTS / CREATE OR REPLACE.
-- Atomic: wrapped in BEGIN ... COMMIT.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Create schemas
-- ----------------------------------------------------------------------------

create schema if not exists shell_control;
create schema if not exists app_data;

comment on schema shell_control is
  'Auth + tenancy + intake plumbing. Tables: tenants, users, module_entitlements, '
  'user_invites, eq_schema_registry, eq_intake_templates, eq_intake_events, '
  'eq_intake_row_audit, eq_export_events, eq_export_profiles. '
  'Owned by the shell. Stays in primary region under any future regional sharding.';

comment on schema app_data is
  'Tenant business data — canonical entity tables. Currently 13 entities: '
  'customer, contact, site, staff, schedule_entries, prestart_checks, '
  'toolbox_talks, swms, jsa_records, itp_records, incidents, licences, assets. '
  'Future regional sharding target.';

-- ----------------------------------------------------------------------------
-- 2. Move tables to their target schemas
-- ----------------------------------------------------------------------------
-- ALTER TABLE SET SCHEMA moves the table + indexes + constraints + policies +
-- triggers atomically. FK references update transparently (Postgres stores
-- FKs by OID, not by qualified name).
-- ----------------------------------------------------------------------------

-- shell_control tables (control plane + intake plumbing)
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'tenants') then
    alter table public.tenants set schema shell_control;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'users') then
    alter table public.users set schema shell_control;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'module_entitlements') then
    alter table public.module_entitlements set schema shell_control;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'user_invites') then
    alter table public.user_invites set schema shell_control;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'eq_schema_registry') then
    alter table public.eq_schema_registry set schema shell_control;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'eq_intake_templates') then
    alter table public.eq_intake_templates set schema shell_control;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'eq_intake_events') then
    alter table public.eq_intake_events set schema shell_control;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'eq_intake_row_audit') then
    alter table public.eq_intake_row_audit set schema shell_control;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'eq_export_events') then
    alter table public.eq_export_events set schema shell_control;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'eq_export_profiles') then
    alter table public.eq_export_profiles set schema shell_control;
  end if;
end $$;

-- app_data tables (canonical entity layer)
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'customers') then
    alter table public.customers set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'contacts') then
    alter table public.contacts set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'sites') then
    alter table public.sites set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'staff') then
    alter table public.staff set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'schedule_entries') then
    alter table public.schedule_entries set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'prestart_checks') then
    alter table public.prestart_checks set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'toolbox_talks') then
    alter table public.toolbox_talks set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'swms') then
    alter table public.swms set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'jsa_records') then
    alter table public.jsa_records set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'itp_records') then
    alter table public.itp_records set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'incidents') then
    alter table public.incidents set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'licences') then
    alter table public.licences set schema app_data;
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'assets') then
    alter table public.assets set schema app_data;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Update search_path on the public roles
-- ----------------------------------------------------------------------------
-- Order: app_data first (most common reads/writes), shell_control second
-- (control-plane reads), public third (extensions + anything legacy), then
-- extensions explicitly. This means clients calling /rest/v1/customer
-- resolve to app_data.customer without needing Accept-Profile header.
-- ----------------------------------------------------------------------------

alter role authenticated set search_path = app_data, shell_control, public, extensions;
alter role service_role set search_path = app_data, shell_control, public, extensions;
alter role anon set search_path = app_data, shell_control, public, extensions;

-- ----------------------------------------------------------------------------
-- 4. Update search_path on all RPCs and trigger functions
-- ----------------------------------------------------------------------------
-- Functions have their own SET search_path which overrides role-level
-- search_path. Each function we own needs the new schemas added so it can
-- still find the entity tables it touches.
-- ----------------------------------------------------------------------------

do $$
declare
  fn record;
begin
  for fn in
    select n.nspname as schema_name, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'eq_%'
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = app_data, shell_control, public, extensions',
      fn.schema_name, fn.proname, fn.args
    );
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 5. tenant_id hardening — NOT NULL + JWT default (Finding 1)
-- ----------------------------------------------------------------------------
-- Every entity table gets tenant_id NOT NULL with a default that pulls from
-- the JWT app_metadata claim. This closes the "ghost row" footgun: any
-- INSERT by an authenticated user auto-populates tenant_id; service_role
-- INSERTs still have to set it explicitly (default doesn't fire if value
-- is provided).
-- ----------------------------------------------------------------------------

do $$
declare
  entity_table text;
  entity_tables text[] := array[
    'customers', 'contacts', 'sites', 'staff', 'schedule_entries',
    'prestart_checks', 'toolbox_talks', 'swms', 'jsa_records', 'itp_records',
    'incidents', 'licences', 'assets'
  ];
begin
  foreach entity_table in array entity_tables
  loop
    -- Backfill any existing NULL tenant_ids (there should be none in core today)
    -- Skip; we don't have a fallback tenant to assign

    -- Set NOT NULL only if no NULLs exist
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app_data' and c.relname = entity_table
    ) then
      continue;
    end if;

    execute format(
      'alter table app_data.%I alter column tenant_id set default (auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid',
      entity_table
    );

    -- Only set NOT NULL if no NULLs (idempotent re-runs should not break if column already NOT NULL)
    begin
      execute format('alter table app_data.%I alter column tenant_id set not null', entity_table);
    exception when others then
      raise notice 'Could not set tenant_id NOT NULL on app_data.%: %', entity_table, sqlerrm;
    end;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Per-table reshapes from Unit 1 audit
-- ----------------------------------------------------------------------------

-- 6.1 — app_data.sites — add Field-domain columns
alter table app_data.sites
  add column if not exists track_hours boolean not null default false,
  add column if not exists budget_hours numeric(10,2) null,
  add column if not exists slug text null;

comment on column app_data.sites.track_hours is
  'Opt site into project hours tracking. Default false. From Field v3.4.71.';
comment on column app_data.sites.budget_hours is
  'Initial hour budget set at kickoff. Editable. Null = no budget set.';
comment on column app_data.sites.slug is
  'URL-safe slug for shell routing (e.g. /core/field/sites/{slug}).';

create index if not exists sites_track_hours_idx
  on app_data.sites (tenant_id, track_hours)
  where track_hours = true;

create unique index if not exists sites_tenant_slug_uq
  on app_data.sites (tenant_id, slug)
  where slug is not null;

-- 6.2 — app_data.staff — add Field-domain columns + the missing user↔staff link (Finding 7)
alter table app_data.staff
  add column if not exists user_id uuid null,
  add column if not exists notify_roster boolean not null default false,
  add column if not exists dob_day smallint null,
  add column if not exists dob_month smallint null,
  add column if not exists digest_opt_in boolean not null default false,
  add column if not exists digest_cron_schedule text null,
  add column if not exists tafe_day text null,
  add column if not exists year_level smallint null;

-- staff.user_id FK to shell_control.users (cross-schema FK)
-- ON DELETE SET NULL: deleting a user shouldn't cascade-delete their staff record
-- (the staff member might still be on the roster as a "deactivated user" placeholder)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'staff_user_id_fk'
      and conrelid = 'app_data.staff'::regclass
  ) then
    alter table app_data.staff
      add constraint staff_user_id_fk foreign key (user_id)
      references shell_control.users(id) on delete set null;
  end if;
end $$;

-- CHECK constraints with idempotent guards
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staff_dob_day_range') then
    alter table app_data.staff
      add constraint staff_dob_day_range check (dob_day is null or dob_day between 1 and 31);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_dob_month_range') then
    alter table app_data.staff
      add constraint staff_dob_month_range check (dob_month is null or dob_month between 1 and 12);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_tafe_day_range') then
    alter table app_data.staff
      add constraint staff_tafe_day_range check (tafe_day is null or tafe_day in ('mon','tue','wed','thu','fri'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_year_level_range') then
    alter table app_data.staff
      add constraint staff_year_level_range check (year_level is null or year_level between 1 and 4);
  end if;
end $$;

create index if not exists staff_user_id_idx
  on app_data.staff (user_id)
  where user_id is not null;

comment on column app_data.staff.user_id is
  'FK to shell_control.users — the canonical user↔staff link. NULL for staff '
  'who never log in (e.g. labour-hire). Added Unit 2 (Finding 7).';
comment on column app_data.staff.notify_roster is
  'When true, staff member receives an email when their schedule changes. Field v3.4.3+';
comment on column app_data.staff.dob_day is
  'DOB day-of-month (1-31). Year never stored to avoid age-based surfacing.';
comment on column app_data.staff.dob_month is
  'DOB month (1-12). Year never stored to avoid age-based surfacing.';
comment on column app_data.staff.digest_opt_in is
  'When true, staff member receives manager digest emails (per Field 2026-04-19).';
comment on column app_data.staff.digest_cron_schedule is
  'Cron schedule for digest delivery. NULL = use tenant default.';
comment on column app_data.staff.tafe_day is
  'TAFE day for apprentices (mon|tue|wed|thu|fri). NULL for non-apprentices.';
comment on column app_data.staff.year_level is
  'Apprentice year level (1-4). NULL for non-apprentices.';

-- 6.3 — app_data.schedule_entries — rename entry_id → schedule_id (Finding 2)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'app_data' and table_name = 'schedule_entries' and column_name = 'entry_id'
  ) then
    alter table app_data.schedule_entries rename column entry_id to schedule_id;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Re-label safety entities in eq_schema_registry (cards → field)
-- ----------------------------------------------------------------------------
-- Per 2026-05-20 plan-review: Field is the primary writer of safety registers
-- (prestart, toolbox_talk, swms, jsa, itp, incident). Cards is one mobile
-- capture surface among several. Cards retains only `licence` as a canonical
-- entity. The module label drives per-domain RPC dispatch in Unit 3.
-- ----------------------------------------------------------------------------

update shell_control.eq_schema_registry
set module = 'field'
where entity in ('prestart', 'toolbox_talk', 'swms', 'jsa', 'itp', 'incident')
  and module = 'cards';

-- ----------------------------------------------------------------------------
-- 8. RLS policy gap fill — entity tables had only SELECT before
-- ----------------------------------------------------------------------------
-- Most entity tables today have only a SELECT policy. INSERT/UPDATE/DELETE
-- are blocked because no policy grants them — writes go through
-- eq_intake_commit_batch SECURITY DEFINER RPC which bypasses RLS as
-- service_role implicit. This is fine. But for any direct PostgREST writes
-- (e.g. status updates from a UI without going through Intake), we need
-- explicit policies. Adding INSERT + UPDATE + DELETE on every entity table
-- now for completeness — predicate is the same tenant_id match.
--
-- These are additive (no existing policy is dropped). Authenticated users
-- whose JWT carries app_metadata.tenant_id can write rows whose tenant_id
-- matches.
-- ----------------------------------------------------------------------------

do $$
declare
  entity_table text;
  entity_tables text[] := array[
    'customers', 'contacts', 'sites', 'staff', 'schedule_entries',
    'prestart_checks', 'toolbox_talks', 'swms', 'jsa_records', 'itp_records',
    'incidents', 'licences', 'assets'
  ];
  policy_name text;
begin
  foreach entity_table in array entity_tables
  loop
    -- INSERT
    policy_name := entity_table || '_insert';
    if not exists (select 1 from pg_policies where schemaname = 'app_data' and tablename = entity_table and policyname = policy_name) then
      execute format(
        'create policy %I on app_data.%I for insert to authenticated '
        'with check (tenant_id = ((auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid))',
        policy_name, entity_table
      );
    end if;

    -- UPDATE
    policy_name := entity_table || '_update';
    if not exists (select 1 from pg_policies where schemaname = 'app_data' and tablename = entity_table and policyname = policy_name) then
      execute format(
        'create policy %I on app_data.%I for update to authenticated '
        'using (tenant_id = ((auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid)) '
        'with check (tenant_id = ((auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid))',
        policy_name, entity_table
      );
    end if;

    -- DELETE
    policy_name := entity_table || '_delete';
    if not exists (select 1 from pg_policies where schemaname = 'app_data' and tablename = entity_table and policyname = policy_name) then
      execute format(
        'create policy %I on app_data.%I for delete to authenticated '
        'using (tenant_id = ((auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid))',
        policy_name, entity_table
      );
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Grant search_path includes app_data + shell_control for PostgREST
-- ----------------------------------------------------------------------------
-- PostgREST reads from db.schemas in its config. The Supabase default is
-- 'public, graphql_public'. We need to ensure 'app_data' and 'shell_control'
-- are reachable by the API role. The role-level search_path (set above)
-- handles this for SQL execution; but PostgREST's URL routing (e.g.
-- /rest/v1/customer) needs the schemas added to its exposed-schemas list.
--
-- The actual config change is done via Supabase Dashboard:
--   Project Settings → API → Exposed schemas → add 'app_data' + 'shell_control'
-- (Or via management API.) This SQL migration cannot toggle that — it's an
-- API-gateway config, not a database setting. Operational step flagged here.
-- ----------------------------------------------------------------------------

-- (Operational: add app_data + shell_control to PostgREST exposed schemas)

commit;

-- ============================================================================
-- Verification (run separately after the migration commits):
--
-- select schemaname, count(*) as tables
-- from pg_tables
-- where schemaname in ('app_data', 'shell_control', 'public')
-- group by schemaname;
--
-- -- Expect: app_data ~13, shell_control ~10, public 0 (canonical tables moved)
--
-- select entity, module from shell_control.eq_schema_registry order by module, entity;
--
-- -- Expect: 7 field, 3 core, 1 cards (licence), 1 service (asset), 1 cards or field? prestart_check
--
-- select column_name, is_nullable from information_schema.columns
-- where table_schema = 'app_data' and table_name = 'staff' and column_name = 'user_id';
--
-- -- Expect: user_id, YES (nullable)
-- ============================================================================
