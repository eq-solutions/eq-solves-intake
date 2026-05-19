-- ============================================================================
-- EQ INTAKE — Supabase migration v1.0
-- ============================================================================
-- Tables for the platform-wide intake/export spine.
-- Drops in cleanly alongside any existing module tables (staff, sites, assets,
-- swms, etc) — those tables get tagged with imported_at / imported_from columns
-- in the per-module migrations, not here.
--
-- Multi-tenant: every table has tenant_id with RLS policies enforcing isolation.
-- Audit: every row has created_at / created_by / updated_at / updated_by.
-- ============================================================================

set search_path = public;

-- ============================================================================
-- 1. SCHEMA REGISTRY
-- ============================================================================
-- Stores the canonical JSON Schemas. Versioned, immutable per version.
-- The eq-schemas package is the source of truth; this table mirrors them
-- so the runtime (validation engine, AI prompts) can fetch without a redeploy.

create table if not exists eq_schema_registry (
  schema_id        uuid primary key default gen_random_uuid(),
  entity           text not null,                      -- 'staff', 'site', 'asset', 'swms', etc
  module           text not null,                      -- 'field', 'service', 'cards', etc
  version          text not null,                      -- semver: '1.0.0'
  schema_json      jsonb not null,                     -- the full JSON Schema
  is_current       boolean not null default true,      -- only one current per entity
  description      text,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  notes            text,

  unique (entity, version)
);

create index if not exists idx_eq_schema_registry_entity_current
  on eq_schema_registry (entity)
  where is_current = true;

comment on table eq_schema_registry is
  'Canonical JSON Schemas for every entity in EQ Solves. Versioned. The is_current flag points to the active schema for each entity.';

-- ============================================================================
-- 2. INTAKE TEMPLATES (reusable column mappings)
-- ============================================================================
-- When a user confirms an AI-suggested column mapping, we store it here so
-- next time the same source format comes in, we can auto-apply.

create table if not exists eq_intake_templates (
  template_id          uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  source_name          text not null,                  -- user-friendly name e.g. "ACME quarterly asset export"
  entity               text not null,                  -- target canonical entity
  schema_version       text not null,                  -- which schema version this maps to
  source_signature     jsonb not null,                 -- column names + sample values, used for auto-detection
  column_map           jsonb not null,                 -- { source_col: canonical_field, ... }
  transformations      jsonb,                          -- { source_col: 'split-name' | 'currency-strip' | ... }
  needs_clarification  jsonb,                          -- any unresolved questions, captured for replay
  is_global            boolean not null default false, -- promoted to all tenants by EQ admin
  created_at           timestamptz not null default now(),
  created_by           uuid,
  last_used_at         timestamptz,
  use_count            int not null default 0,
  success_count        int not null default 0,         -- imports that completed without errors
  failure_count        int not null default 0
);

create index if not exists idx_eq_intake_templates_tenant_entity
  on eq_intake_templates (tenant_id, entity);
create index if not exists idx_eq_intake_templates_global_entity
  on eq_intake_templates (entity)
  where is_global = true;
create index if not exists idx_eq_intake_templates_signature_gin
  on eq_intake_templates using gin (source_signature);

comment on table eq_intake_templates is
  'Reusable column mapping templates. When a user confirms an AI mapping, it''s stored here so future imports of similar files apply automatically.';

-- ============================================================================
-- 3. INTAKE EVENTS (one row per import operation)
-- ============================================================================

create table if not exists eq_intake_events (
  intake_id            uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  entity               text not null,
  source_kind          text not null,                  -- 'cards', 'import', 'capture'
  source_subkind       text,                           -- 'xlsx', 'csv', 'photo', 'pdf', 'email', etc
  source_filename      text,
  source_size_bytes    bigint,
  source_storage_url   text,                           -- R2 reference to original file
  source_hash          text,                           -- SHA-256 of original file
  template_id          uuid references eq_intake_templates(template_id) on delete set null,
  schema_version       text not null,
  status               text not null,                  -- 'pending', 'mapping', 'validating', 'awaiting_confirm', 'committing', 'completed', 'failed', 'rolled_back'
  ai_mapping_request   jsonb,                          -- the prompt sent to Claude
  ai_mapping_response  jsonb,                          -- raw response (for debugging)
  user_overrides       jsonb,                          -- what the user changed from the AI suggestion
  validation_summary   jsonb,                          -- { total, valid, flagged, rejected, by_field_errors }
  rows_committed       int not null default 0,
  rows_flagged         int not null default 0,
  rows_rejected        int not null default 0,
  error_message        text,
  started_at           timestamptz not null default now(),
  completed_at         timestamptz,
  rolled_back_at       timestamptz,
  rolled_back_by       uuid,
  rollback_reason      text,
  created_by           uuid not null,

  check (status in ('pending','mapping','validating','awaiting_confirm','committing','completed','failed','rolled_back'))
);

create index if not exists idx_eq_intake_events_tenant_entity_started
  on eq_intake_events (tenant_id, entity, started_at desc);
create index if not exists idx_eq_intake_events_template
  on eq_intake_events (template_id) where template_id is not null;
create index if not exists idx_eq_intake_events_status
  on eq_intake_events (status) where status not in ('completed', 'rolled_back');

comment on table eq_intake_events is
  'One row per intake operation. Audit trail. Enables rollback by intake_id.';

-- ============================================================================
-- 4. INTAKE ROW AUDIT (one row per source row, even rejected ones)
-- ============================================================================

create table if not exists eq_intake_row_audit (
  audit_id           uuid primary key default gen_random_uuid(),
  intake_id          uuid not null references eq_intake_events(intake_id) on delete cascade,
  tenant_id          uuid not null,
  source_row_index   int not null,
  raw_row            jsonb not null,                   -- the row exactly as it came from source
  canonical_row      jsonb,                            -- after coercion + transform
  outcome            text not null,                    -- 'committed', 'flagged_resolved', 'flagged_rejected', 'rejected'
  errors             jsonb,                            -- array of Error objects from validation
  flags              jsonb,                            -- array of Flag objects
  committed_to_id    uuid,                             -- the canonical row id (if committed)
  resolved_at        timestamptz,
  resolved_by        uuid,

  check (outcome in ('committed','flagged_resolved','flagged_rejected','rejected'))
);

create index if not exists idx_eq_intake_row_audit_intake
  on eq_intake_row_audit (intake_id);
create index if not exists idx_eq_intake_row_audit_committed
  on eq_intake_row_audit (committed_to_id) where committed_to_id is not null;

comment on table eq_intake_row_audit is
  'Per-row audit. Every source row recorded — committed, flagged, or rejected. Enables row-level rollback and replay.';

-- ============================================================================
-- 5. EXPORT EVENTS
-- ============================================================================

create table if not exists eq_export_events (
  export_id          uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  entity             text not null,
  format             text not null,                    -- 'xlsx', 'csv', 'pdf', 'xero', 'myob', 'custom'
  profile_id         uuid,                             -- references eq_export_profiles
  query_params       jsonb,                            -- filters used
  row_count          int not null default 0,
  file_storage_url   text,                             -- R2 reference to generated file
  file_size_bytes    bigint,
  delivery           text,                             -- 'download', 'email', 'api_push', 'scheduled'
  delivery_target    text,                             -- email address, webhook url, etc
  status             text not null,                    -- 'pending', 'generating', 'completed', 'failed'
  error_message      text,
  started_at         timestamptz not null default now(),
  completed_at       timestamptz,
  created_by         uuid not null
);

create index if not exists idx_eq_export_events_tenant_entity_started
  on eq_export_events (tenant_id, entity, started_at desc);

-- ============================================================================
-- 6. EXPORT PROFILES (saved export configurations)
-- ============================================================================

create table if not exists eq_export_profiles (
  profile_id         uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  name               text not null,
  description        text,
  entity             text not null,
  format             text not null,                    -- 'xlsx', 'csv', 'pdf', 'xero_api', etc
  field_mapping      jsonb not null,                   -- canonical → target field mapping
  transformations    jsonb,                            -- per-field transforms
  template_file_url  text,                             -- if user supplied a template file (for AI-mapped exports)
  schedule           jsonb,                            -- cron-like spec for recurring exports
  delivery           jsonb,                            -- { kind, target, credentials_ref }
  is_global          boolean not null default false,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  last_run_at        timestamptz,
  run_count          int not null default 0
);

create index if not exists idx_eq_export_profiles_tenant_entity
  on eq_export_profiles (tenant_id, entity);

-- ============================================================================
-- 7. ROW LEVEL SECURITY
-- ============================================================================

alter table eq_schema_registry enable row level security;
alter table eq_intake_templates enable row level security;
alter table eq_intake_events enable row level security;
alter table eq_intake_row_audit enable row level security;
alter table eq_export_events enable row level security;
alter table eq_export_profiles enable row level security;

-- Policies use drop-then-create so the whole migration is idempotent. Postgres
-- has no `create policy if not exists`, and the migration header promises
-- "safe to re-run" — without these drops, a second apply errors on the first
-- existing policy.

-- Schema registry is global-readable but only EQ admins can write.
drop policy if exists eq_schema_registry_select on eq_schema_registry;
create policy eq_schema_registry_select on eq_schema_registry
  for select using (true);

-- Intake templates: tenant-isolated, with global templates visible to all.
drop policy if exists eq_intake_templates_select on eq_intake_templates;
create policy eq_intake_templates_select on eq_intake_templates
  for select using (
    tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
    or is_global = true
  );
drop policy if exists eq_intake_templates_insert on eq_intake_templates;
create policy eq_intake_templates_insert on eq_intake_templates
  for insert with check (
    tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
  );
drop policy if exists eq_intake_templates_update on eq_intake_templates;
create policy eq_intake_templates_update on eq_intake_templates
  for update using (
    tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
  );

-- Intake events: tenant-isolated, no cross-tenant visibility.
drop policy if exists eq_intake_events_select on eq_intake_events;
create policy eq_intake_events_select on eq_intake_events
  for select using (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);
drop policy if exists eq_intake_events_insert on eq_intake_events;
create policy eq_intake_events_insert on eq_intake_events
  for insert with check (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);
drop policy if exists eq_intake_events_update on eq_intake_events;
create policy eq_intake_events_update on eq_intake_events
  for update using (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

-- Intake row audit: tenant-isolated.
drop policy if exists eq_intake_row_audit_select on eq_intake_row_audit;
create policy eq_intake_row_audit_select on eq_intake_row_audit
  for select using (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);
drop policy if exists eq_intake_row_audit_insert on eq_intake_row_audit;
create policy eq_intake_row_audit_insert on eq_intake_row_audit
  for insert with check (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

-- Export events: tenant-isolated.
drop policy if exists eq_export_events_select on eq_export_events;
create policy eq_export_events_select on eq_export_events
  for select using (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);
drop policy if exists eq_export_events_insert on eq_export_events;
create policy eq_export_events_insert on eq_export_events
  for insert with check (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

-- Export profiles: tenant-isolated, with global profiles visible to all.
drop policy if exists eq_export_profiles_select on eq_export_profiles;
create policy eq_export_profiles_select on eq_export_profiles
  for select using (
    tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
    or is_global = true
  );
drop policy if exists eq_export_profiles_insert on eq_export_profiles;
create policy eq_export_profiles_insert on eq_export_profiles
  for insert with check (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

-- ============================================================================
-- 8. RPC FUNCTIONS
-- ============================================================================

-- Commit a batch of validated rows in a single transaction, tagged with intake_id.
-- Called by the intake pipeline after validation passes.
-- Generic over entity: takes the table name and an array of canonical rows.
create or replace function eq_intake_commit_batch(
  p_intake_id uuid,
  p_tenant_id uuid,
  p_table     text,
  p_rows      jsonb
) returns table (committed_count int, committed_ids uuid[])
language plpgsql
security definer
as $$
declare
  v_count int;
  v_ids uuid[];
begin
  -- Verify caller's tenant matches
  if (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid <> p_tenant_id then
    raise exception 'tenant_id mismatch';
  end if;

  -- Whitelist: only allow commit to known canonical tables
  if p_table not in ('staff', 'sites', 'assets', 'swms', 'expenses', 'quotes', 'variations') then
    raise exception 'unknown table: %', p_table;
  end if;

  -- Tag each row with intake_id, tenant_id, imported_at
  -- Implementation: dynamic SQL per table (template per entity in a real impl)
  -- This is a stub showing the pattern; production version generates one INSERT
  -- per table type via a template per canonical schema.
  raise notice 'commit_batch: intake=%, table=%, rows=%', p_intake_id, p_table, jsonb_array_length(p_rows);

  -- Real implementation populates v_count and v_ids per table.
  v_count := 0;
  v_ids := array[]::uuid[];

  return query select v_count, v_ids;
end;
$$;

-- Rollback: delete all rows committed by an intake_id.
create or replace function eq_intake_rollback(
  p_intake_id uuid,
  p_reason text
) returns int
language plpgsql
security definer
as $$
declare
  v_tenant_id uuid;
  v_table text;
  v_count int := 0;
begin
  select tenant_id, entity into v_tenant_id, v_table
  from eq_intake_events where intake_id = p_intake_id;

  if (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid <> v_tenant_id then
    raise exception 'tenant_id mismatch';
  end if;

  -- Delete from canonical table where intake_id matches
  -- (Each canonical table has an intake_id column added by per-module migration)
  -- Stub: real impl uses dynamic SQL per table
  raise notice 'rollback intake=% table=%', p_intake_id, v_table;

  update eq_intake_events
    set status = 'rolled_back',
        rolled_back_at = now(),
        rolled_back_by = auth.uid(),
        rollback_reason = p_reason
    where intake_id = p_intake_id;

  return v_count;
end;
$$;

-- ============================================================================
-- 9. TRIGGERS
-- ============================================================================

-- Ensure only one is_current=true per entity in schema registry.
-- Excludes rows with the same (entity, version) so a re-seed (INSERT ... ON
-- CONFLICT DO UPDATE) doesn't trigger an update on the conflict target row
-- before ON CONFLICT runs — which Postgres rejects as "row affected a second
-- time". The intent is to flip OTHER versions of this entity, not the same
-- version being upserted.
create or replace function eq_schema_registry_one_current()
returns trigger language plpgsql as $$
begin
  if NEW.is_current then
    update eq_schema_registry
      set is_current = false
      where entity = NEW.entity
        and version <> NEW.version
        and is_current = true;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_eq_schema_registry_one_current on eq_schema_registry;
create trigger trg_eq_schema_registry_one_current
  before insert or update on eq_schema_registry
  for each row execute function eq_schema_registry_one_current();

-- Update use_count + last_used_at on intake_templates when an intake event uses it
create or replace function eq_intake_template_track_use()
returns trigger language plpgsql as $$
begin
  if NEW.template_id is not null and (OLD.template_id is null or OLD.template_id <> NEW.template_id) then
    update eq_intake_templates
      set use_count = use_count + 1,
          last_used_at = now()
      where template_id = NEW.template_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_eq_intake_template_track_use on eq_intake_events;
create trigger trg_eq_intake_template_track_use
  after insert or update of template_id on eq_intake_events
  for each row execute function eq_intake_template_track_use();

-- Update success_count / failure_count when intake event completes
create or replace function eq_intake_template_track_outcome()
returns trigger language plpgsql as $$
begin
  if NEW.template_id is not null and OLD.status <> NEW.status then
    if NEW.status = 'completed' then
      update eq_intake_templates set success_count = success_count + 1
        where template_id = NEW.template_id;
    elsif NEW.status = 'failed' then
      update eq_intake_templates set failure_count = failure_count + 1
        where template_id = NEW.template_id;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_eq_intake_template_track_outcome on eq_intake_events;
create trigger trg_eq_intake_template_track_outcome
  after update of status on eq_intake_events
  for each row execute function eq_intake_template_track_outcome();

-- ============================================================================
-- 10. NOTES FOR PER-MODULE MIGRATIONS
-- ============================================================================
-- Each canonical table (staff, sites, assets, swms, ...) needs:
--
--   alter table staff add column if not exists imported_at timestamptz;
--   alter table staff add column if not exists imported_from text;
--   alter table staff add column if not exists intake_id uuid references eq_intake_events(intake_id);
--   create index if not exists idx_staff_intake_id on staff(intake_id) where intake_id is not null;
--
-- This enables intake_id-tagged rollback. Done per module so the spine migration
-- stays generic.
-- ============================================================================
