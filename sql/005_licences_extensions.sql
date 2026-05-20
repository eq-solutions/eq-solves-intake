-- ============================================================================
-- EQ INTAKE — Licences table extensions v1.0
-- ============================================================================
-- The base `licences` table is created by the schema codegen via
-- _all_tables.sql (one of the 13 entities derived from licence.schema.json).
-- This migration adds the layer on top that the codegen doesn't produce:
--
--   1. Performance indexes for the Cards wallet's two hot queries
--      (expiry-list-by-staff, type-filter-by-staff)
--   2. Row-level security policies — SELECT/INSERT/UPDATE/DELETE, all
--      gated by tenant_id from auth.jwt() user_metadata. Matches the
--      pattern in 001_intake_spine.sql + the live `core` tenant's
--      `2026_05_19_canonical_select_rls_policies` migration.
--   3. licence-photos storage bucket (private) + RLS policies. Path
--      convention: {tenant_id}/{staff_id}/{licence_id}/front.jpg —
--      tenant in path[1] so storage RLS can gate cheaply without
--      joining the licences table.
--
-- Run AFTER 004_security_advisor_fix.sql.
-- Idempotent — safe to re-run.
-- ============================================================================

set search_path = public;

-- ============================================================================
-- 1. EXTRA PERFORMANCE INDEXES
-- ============================================================================
-- Codegen produced:
--   licences_tenant_id_idx on (tenant_id)
--   licences_staff_id_idx on (staff_id)
--
-- Cards's wallet UI has two additional hot queries:
--   - "all my licences, sorted by expiry" → list view
--   - "my driver licence" → tap-to-copy on a specific type
-- Both filter by staff_id first; composite indexes win over a single-column.

create index if not exists licences_staff_expiry_idx
  on licences (staff_id, expiry_date)
  where active = true and expiry_date is not null;

create index if not exists licences_staff_type_idx
  on licences (staff_id, licence_type)
  where active = true;

-- ============================================================================
-- 2. ROW-LEVEL SECURITY POLICIES
-- ============================================================================
-- Pattern matches 001_intake_spine.sql + canonical SELECT policies applied
-- on `core` tenant 2026-05-19.
--
-- JWT claim path: auth.jwt() -> 'user_metadata' ->> 'tenant_id'.
-- This is the EXISTING canonical RLS pattern (12 tables already use it via
-- the 2026-05-19 canonical_select_rls_policies migration on `core` tenant).
--
-- IMPORTANT — Phase 1.F transition: per
-- C:\Projects\eq-context\eq\identity\IDENTITY-MODEL.md §6.2 + PHASE-1F-PLAN.md,
-- the unified identity model standardises on app_metadata (not user_metadata)
-- as the canonical claim location. Phase 1.F's migration will sweep ALL 13
-- canonical tables (the existing 12 + this new licences table) from
-- user_metadata to app_metadata in lockstep. Until Phase 1.F lands, we
-- match the existing pattern so the 13 tables read identically.
--
-- Postgres has no `create policy if not exists`. We use drop-then-create so
-- this migration is idempotent and safe to re-run.

drop policy if exists licences_select on licences;
create policy licences_select on licences
  for select
  using (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

drop policy if exists licences_insert on licences;
create policy licences_insert on licences
  for insert
  with check (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

drop policy if exists licences_update on licences;
create policy licences_update on licences
  for update
  using (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

drop policy if exists licences_delete on licences;
create policy licences_delete on licences
  for delete
  using (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

-- Note: no separate "row owner" check (e.g. staff_id = current user's staff_id).
-- Tenant-scoped read is the right granularity: a supervisor in the tenant
-- needs to see their team's licences for compliance / scheduling decisions.
-- Cards UI filters to "just me" client-side via WHERE staff_id = <current>.
-- If a tighter per-worker visibility model is needed later, add a second
-- policy that gates on staff_id from JWT claims.

-- ============================================================================
-- 3. set_updated_at TRIGGER
-- ============================================================================
-- Codegen doesn't add this; sites/staff/etc. don't have it either in the
-- _all_tables.sql output. Adding here so Cards's "last edited" surfaces
-- stay accurate.

create or replace function licences_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_licences_set_updated_at on licences;
create trigger trg_licences_set_updated_at
  before update on licences
  for each row execute function licences_set_updated_at();

-- ============================================================================
-- 4. STORAGE BUCKET — licence-photos (private)
-- ============================================================================
-- Mirrors Cards's existing licence-photos bucket on hshvnjzczdytfiklhojz.
-- Private — never publicly accessible. Access via signed URLs only, 1h
-- expiry, minted server-side or via Supabase JS client.
--
-- Path convention (changed from Cards):
--   Cards (today):    {user_id}/{licence_id}/front.jpg
--   Canonical (new):  {tenant_id}/{staff_id}/{licence_id}/front.jpg
--
-- tenant_id at path[1] means storage RLS can gate cheaply with a JWT claim
-- comparison instead of joining the licences table.

insert into storage.buckets (id, name, public)
values ('licence-photos', 'licence-photos', false)
on conflict (id) do nothing;

-- SELECT: any signed-in user from the right tenant can fetch any licence
-- photo within that tenant. Cards's UI further restricts client-side via
-- the signed-URL generation step.

drop policy if exists licence_photos_select on storage.objects;
create policy licence_photos_select on storage.objects
  for select
  using (
    bucket_id = 'licence-photos'
    and (storage.foldername(name))[1]::uuid
        = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
  );

-- INSERT: same gate. Path[1] must match the user's tenant. Allows photo
-- upload BEFORE the licences row exists (the typical capture flow:
-- photo → OCR → confirm → row).

drop policy if exists licence_photos_insert on storage.objects;
create policy licence_photos_insert on storage.objects
  for insert
  with check (
    bucket_id = 'licence-photos'
    and (storage.foldername(name))[1]::uuid
        = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
  );

-- UPDATE: re-uploading replaces the front/back photo. Same gate.

drop policy if exists licence_photos_update on storage.objects;
create policy licence_photos_update on storage.objects
  for update
  using (
    bucket_id = 'licence-photos'
    and (storage.foldername(name))[1]::uuid
        = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
  );

-- DELETE: clean-up on licence deletion.

drop policy if exists licence_photos_delete on storage.objects;
create policy licence_photos_delete on storage.objects
  for delete
  using (
    bucket_id = 'licence-photos'
    and (storage.foldername(name))[1]::uuid
        = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
  );

-- ============================================================================
-- 5. VERIFICATION QUERIES (run after apply, not part of the migration)
-- ============================================================================
-- -- Confirm RLS is enabled + policies exist:
-- select schemaname, tablename, rowsecurity
--   from pg_tables where tablename = 'licences';
-- select polname, polcmd from pg_policy
--   where polrelid = 'licences'::regclass;
--
-- -- Confirm storage bucket + policies exist:
-- select id, name, public from storage.buckets where id = 'licence-photos';
-- select policyname, cmd from pg_policies
--   where schemaname = 'storage' and tablename = 'objects'
--   and policyname like 'licence_photos_%';
--
-- -- Confirm indexes:
-- select indexname from pg_indexes where tablename = 'licences';
