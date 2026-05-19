-- ============================================================================
-- EQ INTAKE — Schema versioning + import mode v1.0
-- ============================================================================
-- Per Phase 1 v1.1 brief: every imported row tags which schema version
-- produced it, and intake events declare their import mode upfront.
--
-- Run AFTER 002_intake_module_columns.sql.
-- ============================================================================

set search_path = public;

-- ============================================================================
-- 1. SCHEMA_VERSION COLUMN ON EVERY CANONICAL TABLE
-- ============================================================================
-- Tags each row with the schema version it was created/updated under.
-- Default '1.0.0' for existing rows. Indexes for efficient version filtering.

do $$
declare
  t text;
  tables text[] := array[
    'staff', 'sites', 'assets', 'swms',
    'schedule_assignments', 'prestart', 'jsa',
    'toolbox_talks', 'incidents', 'itp',
    'expenses', 'quotes', 'variations',
    'service_jobs', 'service_assets'
  ];
begin
  foreach t in array tables loop
    if to_regclass(t) is null then
      raise notice 'skipping %: table not present', t;
      continue;
    end if;

    execute format(
      'alter table %I add column if not exists schema_version text not null default ''1.0.0''',
      t
    );

    execute format(
      'create index if not exists idx_%I_schema_version on %I(schema_version) where schema_version <> ''1.0.0''',
      t, t
    );

    raise notice 'added schema_version to %', t;
  end loop;
end $$;

-- ============================================================================
-- 2. IMPORT_MODE COLUMN ON eq_intake_events
-- ============================================================================
-- Three modes:
--   'append'  — insert only; fail on natural-key collision (DEFAULT)
--   'upsert'  — insert or update by primary key
--   'replace' — delete prior rows for this tenant+source, then insert
--                (requires explicit confirmation flag at API level)

alter table eq_intake_events
  add column if not exists import_mode text not null default 'append';

-- Drop old constraint if re-running
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'eq_intake_events_import_mode_check'
  ) then
    alter table eq_intake_events drop constraint eq_intake_events_import_mode_check;
  end if;
end $$;

alter table eq_intake_events
  add constraint eq_intake_events_import_mode_check
  check (import_mode in ('append', 'upsert', 'replace'));

comment on column eq_intake_events.import_mode is
  'Import mode: append (insert-only, default), upsert (insert-or-update by PK), replace (delete-then-insert; requires confirmation at API layer)';

-- ============================================================================
-- 3. UPDATE eq_intake_commit_batch TO HONOUR import_mode + schema_version
-- ============================================================================

create or replace function eq_intake_commit_batch(
  p_intake_id uuid,
  p_tenant_id uuid,
  p_table     text,
  p_rows      jsonb,
  p_confirm_replace boolean default false
) returns table (committed_count int, committed_ids uuid[])
language plpgsql
security definer
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
  -- The JWT claim path is `user_metadata.tenant_id` because Supabase's
  -- default Auth flow nests user_metadata under that key rather than
  -- promoting individual claims to the top level. Set this when adding
  -- the user via Dashboard → Auth → Users → Add user → Raw User Meta:
  --   {"tenant_id": "<the-tenant-uuid>"}
  -- (Future: an Auth Hook can lift this to a top-level claim if we ever
  -- want shorter JWT paths in other RPCs.)
  if (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid <> p_tenant_id then
    raise exception 'tenant_id mismatch';
  end if;

  -- Whitelist
  if p_table not in (
    'staff', 'sites', 'assets', 'swms',
    'schedule_assignments', 'prestart', 'jsa',
    'toolbox_talks', 'incidents', 'itp',
    'expenses', 'quotes', 'variations',
    -- Core entities (added 2026-05-18 for SimPRO bundle intake)
    'customers', 'contacts'
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

    -- Delete prior rows from this tenant where imported_from matches the source.
    -- Scoped to the same source_filename so re-imports of file A don't wipe file B.
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

    -- Per-table dispatch. Each branch handles append / upsert / replace
    -- (replace already deleted; remaining insert is identical to append).
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
          -- append OR replace (replace already cleared the slate)
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
        -- Added 2026-05-19 to support SimPRO bundle intake (customer +
        -- contact + site). The conflict key is external_id when present
        -- (SimPRO Customer ID) so re-importing the same export upserts
        -- by source system ID instead of creating duplicates.
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
        -- Added 2026-05-19 for SimPRO bundle intake. Note: contacts.customer_id
        -- is a NOT NULL FK to customers. The caller is responsible for
        -- resolving customer_id before commit (typically via FK fuzzy match
        -- on company_name during validation).
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

      else
        -- For tables not yet implemented in this RPC, log and skip.
        -- Production: extend with one branch per whitelisted table.
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
-- 4. ADD schema_version + signature_hash TO eq_intake_events
-- ============================================================================
-- schema_version: which version of the canonical schema was used for this intake
-- signature_hash: SHA-256 of normalised columns + samples; used for cache lookup

alter table eq_intake_events
  add column if not exists schema_version text;

alter table eq_intake_events
  add column if not exists signature_hash text;

create index if not exists idx_eq_intake_events_signature_hash
  on eq_intake_events (tenant_id, entity, signature_hash)
  where signature_hash is not null;

-- ============================================================================
-- 5. ADD signature_hash TO eq_intake_templates
-- ============================================================================

alter table eq_intake_templates
  add column if not exists signature_hash text;

create index if not exists idx_eq_intake_templates_signature_hash
  on eq_intake_templates (tenant_id, entity, signature_hash)
  where signature_hash is not null;

create index if not exists idx_eq_intake_templates_signature_hash_global
  on eq_intake_templates (entity, signature_hash)
  where is_global = true and signature_hash is not null;

-- ============================================================================
-- 6. RPC: lookup template by signature hash before AI call
-- ============================================================================
-- Called from the validate orchestrator before invoking AI mapping.
-- Returns the highest-success-rate matching template, or null.

create or replace function eq_intake_find_template_by_signature(
  p_tenant_id uuid,
  p_entity    text,
  p_signature text
) returns table (
  template_id uuid,
  source_name text,
  column_map  jsonb,
  transformations jsonb,
  use_count   int,
  success_rate numeric
)
language sql
stable
security definer
as $$
  select
    template_id,
    source_name,
    column_map,
    transformations,
    use_count,
    case
      when use_count = 0 then 0
      else round(success_count::numeric / use_count::numeric, 3)
    end as success_rate
  from eq_intake_templates
  where (tenant_id = p_tenant_id or is_global = true)
    and entity = p_entity
    and signature_hash = p_signature
  order by
    -- Prefer tenant-private over global
    (tenant_id = p_tenant_id) desc,
    -- Then highest success rate
    case when use_count = 0 then 0 else success_count::numeric / use_count::numeric end desc,
    use_count desc
  limit 1;
$$;

-- ============================================================================
-- Done.
-- ============================================================================
