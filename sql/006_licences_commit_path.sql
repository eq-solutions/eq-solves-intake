-- ============================================================================
-- EQ INTAKE — Licences commit path v1.0
-- ============================================================================
-- Extends eq_intake_commit_batch to accept the new licences table.
--
-- The RPC's whitelist + per-table case dispatch needs explicit entries for
-- every canonical table — see comment in sql/001_intake_spine.sql line 309
-- and the per-entity pattern in 003_schema_version_columns.sql.
--
-- This migration:
--   1. Adds 'licences' to the table whitelist
--   2. Adds a 'licences' branch to the case dispatch with INSERT + UPSERT
--      logic (UPSERT on conflict (licence_id) so re-imports of the same
--      source file idempotently refresh the row)
--
-- Same pattern as 003 added 'customers' and 'contacts'. Uses CREATE OR
-- REPLACE — the entire function body is re-declared with the licence
-- additions woven in. No other behaviour changes.
--
-- JWT claim path stays user_metadata.tenant_id; Phase 1.F will sweep all
-- canonical RLS + RPC tenant-checks to app_metadata in one go.
--
-- Run AFTER 005_licences_extensions.sql.
-- Idempotent — CREATE OR REPLACE means re-running is a no-op.
-- ============================================================================

set search_path = public;

create or replace function eq_intake_commit_batch(
  p_intake_id uuid,
  p_tenant_id uuid,
  p_table     text,
  p_rows      jsonb,
  p_confirm_replace boolean default false
) returns table (committed_count int, committed_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  v_ids   uuid[] := array[]::uuid[];
  v_row   jsonb;
  v_id    uuid;
  v_source_signature text;
  v_import_mode text;
  v_schema_version text;
  v_replace_count int;
begin
  -- Verify caller's tenant matches.
  -- JWT claim path: user_metadata.tenant_id. See IDENTITY-MODEL.md §6.2 —
  -- Phase 1.F will migrate this to app_metadata across all canonical RPCs
  -- + RLS in lockstep.
  if (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid <> p_tenant_id then
    raise exception 'tenant_id mismatch';
  end if;

  -- Whitelist
  if p_table not in (
    'staff', 'sites', 'assets', 'swms',
    'schedule_assignments', 'prestart', 'jsa',
    'toolbox_talks', 'incidents', 'itp',
    'expenses', 'quotes', 'variations',
    -- Core entities (added 2026-05-19 for SimPRO bundle intake)
    'customers', 'contacts',
    -- Cards canonical entity (added 2026-05-20 for Cards canonical migration)
    'licences'
  ) then
    raise exception 'commit not permitted to table %', p_table;
  end if;

  -- Verify intake event exists, get mode + version + source
  select
    coalesce(source_filename, source_kind || ':' || source_subkind, 'unknown'),
    import_mode,
    schema_version
  into v_source_signature, v_import_mode, v_schema_version
  from eq_intake_events
  where intake_id = p_intake_id
    and tenant_id = p_tenant_id;

  if not found then
    raise exception 'intake_id % not found for tenant', p_intake_id;
  end if;

  -- ------------------------------------------------------------------
  -- REPLACE MODE — delete first, requires explicit confirmation
  -- ------------------------------------------------------------------
  if v_import_mode = 'replace' then
    if not p_confirm_replace then
      raise exception 'replace mode requires p_confirm_replace = true (destructive operation)';
    end if;

    execute format(
      'delete from %I where tenant_id = $1 and imported_from = $2',
      p_table
    ) using p_tenant_id, v_source_signature;
    get diagnostics v_replace_count = row_count;

    raise notice 'replace mode: deleted % prior rows from %', v_replace_count, p_table;
  end if;

  -- ------------------------------------------------------------------
  -- INSERT / UPSERT each row, tagged with intake metadata
  -- ------------------------------------------------------------------
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_row := v_row
      || jsonb_build_object('tenant_id', p_tenant_id)
      || jsonb_build_object('intake_id', p_intake_id)
      || jsonb_build_object('imported_at', to_jsonb(now()))
      || jsonb_build_object('imported_from', to_jsonb(v_source_signature))
      || jsonb_build_object('schema_version', to_jsonb(v_schema_version));

    case p_table
      when 'staff' then
        if v_import_mode = 'upsert' then
          insert into staff
            select * from jsonb_populate_record(null::staff, v_row)
          on conflict (staff_id) do update set
            first_name        = excluded.first_name,
            last_name         = excluded.last_name,
            email             = excluded.email,
            phone             = excluded.phone,
            employment_type   = excluded.employment_type,
            active            = excluded.active,
            imported_at       = excluded.imported_at,
            imported_from     = excluded.imported_from,
            intake_id         = excluded.intake_id,
            schema_version    = excluded.schema_version
          returning staff_id into v_id;
        else
          insert into staff
            select * from jsonb_populate_record(null::staff, v_row)
          returning staff_id into v_id;
        end if;

      when 'sites' then
        if v_import_mode = 'upsert' then
          insert into sites
            select * from jsonb_populate_record(null::sites, v_row)
          on conflict (site_id) do update set
            name              = excluded.name,
            code              = excluded.code,
            address_line_1    = excluded.address_line_1,
            suburb            = excluded.suburb,
            state             = excluded.state,
            postcode          = excluded.postcode,
            active            = excluded.active,
            imported_at       = excluded.imported_at,
            imported_from     = excluded.imported_from,
            intake_id         = excluded.intake_id,
            schema_version    = excluded.schema_version
          returning site_id into v_id;
        else
          insert into sites
            select * from jsonb_populate_record(null::sites, v_row)
          returning site_id into v_id;
        end if;

      when 'assets' then
        if v_import_mode = 'upsert' then
          insert into assets
            select * from jsonb_populate_record(null::assets, v_row)
          on conflict (asset_id) do update set
            name              = excluded.name,
            asset_type        = excluded.asset_type,
            make              = excluded.make,
            model             = excluded.model,
            serial_number     = excluded.serial_number,
            last_service_date = excluded.last_service_date,
            next_service_due  = excluded.next_service_due,
            imported_at       = excluded.imported_at,
            imported_from     = excluded.imported_from,
            intake_id         = excluded.intake_id,
            schema_version    = excluded.schema_version
          returning asset_id into v_id;
        else
          insert into assets
            select * from jsonb_populate_record(null::assets, v_row)
          returning asset_id into v_id;
        end if;

      when 'customers' then
        if v_import_mode = 'upsert' then
          insert into customers
            select * from jsonb_populate_record(null::customers, v_row)
          on conflict (customer_id) do update set
            company_name      = excluded.company_name,
            first_name        = excluded.first_name,
            last_name         = excluded.last_name,
            external_id       = excluded.external_id,
            type              = excluded.type,
            abn               = excluded.abn,
            acn               = excluded.acn,
            street_address    = excluded.street_address,
            suburb            = excluded.suburb,
            state             = excluded.state,
            postcode          = excluded.postcode,
            email             = excluded.email,
            primary_phone     = excluded.primary_phone,
            mobile_phone      = excluded.mobile_phone,
            notes             = excluded.notes,
            active            = excluded.active,
            imported_at       = excluded.imported_at,
            imported_from     = excluded.imported_from,
            intake_id         = excluded.intake_id,
            schema_version    = excluded.schema_version
          returning customer_id into v_id;
        else
          insert into customers
            select * from jsonb_populate_record(null::customers, v_row)
          returning customer_id into v_id;
        end if;

      when 'contacts' then
        if v_import_mode = 'upsert' then
          insert into contacts
            select * from jsonb_populate_record(null::contacts, v_row)
          on conflict (contact_id) do update set
            first_name        = excluded.first_name,
            last_name         = excluded.last_name,
            email             = excluded.email,
            work_phone        = excluded.work_phone,
            mobile_phone      = excluded.mobile_phone,
            customer_id       = excluded.customer_id,
            external_id       = excluded.external_id,
            position          = excluded.position,
            active            = excluded.active,
            imported_at       = excluded.imported_at,
            imported_from     = excluded.imported_from,
            intake_id         = excluded.intake_id,
            schema_version    = excluded.schema_version
          returning contact_id into v_id;
        else
          insert into contacts
            select * from jsonb_populate_record(null::contacts, v_row)
          returning contact_id into v_id;
        end if;

      when 'licences' then
        -- Added 2026-05-20 for the Cards canonical migration. Conflict
        -- key is licence_id (the PK). On upsert, every column except
        -- licence_id + tenant_id + created_at + created_by is updateable.
        -- This is consistent with the customer/contact branches above —
        -- 'upsert' is the right mode when re-importing the same source
        -- file (e.g. Cards exports its existing data into canonical
        -- during the Unit 3 migration).
        if v_import_mode = 'upsert' then
          insert into licences
            select * from jsonb_populate_record(null::licences, v_row)
          on conflict (licence_id) do update set
            staff_id          = excluded.staff_id,
            external_id       = excluded.external_id,
            licence_type      = excluded.licence_type,
            licence_number    = excluded.licence_number,
            issuing_authority = excluded.issuing_authority,
            state             = excluded.state,
            issue_date        = excluded.issue_date,
            expiry_date       = excluded.expiry_date,
            photo_front_path  = excluded.photo_front_path,
            photo_back_path   = excluded.photo_back_path,
            notes             = excluded.notes,
            metadata          = excluded.metadata,
            active            = excluded.active,
            imported_at       = excluded.imported_at,
            imported_from     = excluded.imported_from,
            intake_id         = excluded.intake_id,
            schema_version    = excluded.schema_version
          returning licence_id into v_id;
        else
          -- append OR replace (replace already cleared the slate)
          insert into licences
            select * from jsonb_populate_record(null::licences, v_row)
          returning licence_id into v_id;
        end if;

      else
        -- For tables not yet implemented in this RPC, log and skip.
        raise notice 'commit_batch: handler for table % not yet implemented', p_table;
        v_id := null;
    end case;

    if v_id is not null then
      v_count := v_count + 1;
      v_ids := array_append(v_ids, v_id);
    end if;
  end loop;

  -- Update intake event progress
  update eq_intake_events
    set rows_committed = rows_committed + v_count
    where intake_id = p_intake_id;

  return query select v_count, v_ids;
end;
$$;

-- ============================================================================
-- VERIFICATION (run after apply, not part of the migration)
-- ============================================================================
-- -- Confirm the function exists at the new version + accepts 'licences':
-- select pg_get_function_arguments(p.oid), pg_get_function_result(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'eq_intake_commit_batch';
--
-- -- Test a no-op call (zero rows) against licences to confirm whitelist
-- -- passes. Replace tenant_id with a real value from your tenants table.
-- -- This will fail with "intake_id % not found" — that's the EXPECTED
-- -- error showing the whitelist check passed before the intake-event
-- -- lookup ran.
-- select * from eq_intake_commit_batch(
--   '00000000-0000-0000-0000-000000000001'::uuid,
--   '<your-tenant-uuid>'::uuid,
--   'licences',
--   '[]'::jsonb,
--   false
-- );
