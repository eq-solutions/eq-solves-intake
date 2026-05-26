-- ============================================================================
-- 008 — Decompose eq_intake_commit_batch (canonical-readiness Unit 3)
-- ============================================================================
-- Decomposes the mega-RPC into:
--   - 4 private shared library functions (_eq_intake_check_tenant_match,
--     _eq_intake_load_event_meta, _eq_intake_record_committed,
--     _eq_intake_apply_metadata)
--   - 5 per-domain public RPCs (eq_intake_commit_batch_core,
--     _cards, _field, _quotes, _service)
--   - 5 per-domain private unwinders for rollback
--   - Rewritten public eq_intake_commit_batch as a thin router that looks
--     up the entity's module via eq_schema_registry and dispatches
--   - Rewritten public eq_intake_rollback that dispatches to unwinders
--
-- Plus additive changes (Unit 3 architectural decisions):
--   - eq_intake_events.source_app text — JWT app_metadata.source_app claim
--   - eq_intake_events.intake_mode text default 'strict' — validation strictness
--   - eq_intake_row_audit.source_app text — for per-row attribution
--
-- Backwards-compatible: public eq_intake_commit_batch keeps its existing
-- 5-arg signature; p_intake_mode is the 6th arg with default 'strict'.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Additive columns
-- ----------------------------------------------------------------------------

alter table shell_control.eq_intake_events
  add column if not exists source_app text,
  add column if not exists intake_mode text default 'strict';

alter table shell_control.eq_intake_row_audit
  add column if not exists source_app text;

comment on column shell_control.eq_intake_events.source_app is
  'App that initiated the intake (e.g. ''shell'', ''cards'', ''field'', ''capture''). '
  'Read from app_metadata.source_app JWT claim by the calling client.';
comment on column shell_control.eq_intake_events.intake_mode is
  'Validation strictness: ''strict''|''lenient''|''ocr-best-effort''. '
  'Strict = full validation (live mobile capture). Lenient = optional fields '
  'allowed (bulk backfill). OCR-best-effort = future EQ Capture OCR path.';

-- ----------------------------------------------------------------------------
-- 2. Private shared library functions
-- ----------------------------------------------------------------------------

create or replace function _eq_intake_check_tenant_match(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
begin
  if (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid <> p_tenant_id then
    raise exception 'tenant_id mismatch (JWT does not authorise this tenant)';
  end if;
end $$;

create or replace function _eq_intake_load_event_meta(
  p_intake_id uuid,
  p_tenant_id uuid
)
returns table (
  source_signature text,
  import_mode      text,
  schema_version   text,
  source_app       text,
  intake_mode      text
)
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
begin
  return query
  select
    coalesce(e.source_filename, e.source_kind || ':' || e.source_subkind, 'unknown') as source_signature,
    e.import_mode,
    e.schema_version,
    e.source_app,
    e.intake_mode
  from shell_control.eq_intake_events e
  where e.intake_id = p_intake_id and e.tenant_id = p_tenant_id;
end $$;

create or replace function _eq_intake_record_committed(
  p_intake_id uuid,
  p_count int
)
returns void
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
begin
  update shell_control.eq_intake_events
    set rows_committed = rows_committed + p_count
    where intake_id = p_intake_id;
end $$;

create or replace function _eq_intake_apply_metadata(
  p_row             jsonb,
  p_tenant_id       uuid,
  p_intake_id       uuid,
  p_source_sig      text,
  p_schema_version  text
)
returns jsonb
language sql
immutable
as $$
  select p_row
    || jsonb_build_object('tenant_id', p_tenant_id)
    || jsonb_build_object('intake_id', p_intake_id)
    || jsonb_build_object('imported_at', to_jsonb(now()))
    || jsonb_build_object('imported_from', to_jsonb(p_source_sig))
    || jsonb_build_object('schema_version', to_jsonb(p_schema_version));
$$;

-- ----------------------------------------------------------------------------
-- 3. Per-domain commit RPCs
-- ----------------------------------------------------------------------------
-- Each per-domain RPC:
--   1. Verifies tenant match
--   2. Validates p_table belongs to this domain
--   3. Loads event metadata
--   4. Handles replace mode (DELETE prior rows by imported_from signature)
--   5. Per-row: apply metadata + dispatch to entity INSERT/UPSERT
--   6. Records committed count on event
--   7. Returns (count, ids)
-- ----------------------------------------------------------------------------

-- 3.1 — CORE domain (customers, contacts, sites)
create or replace function eq_intake_commit_batch_core(
  p_intake_id        uuid,
  p_tenant_id        uuid,
  p_table            text,
  p_rows             jsonb,
  p_confirm_replace  boolean default false,
  p_intake_mode      text    default 'strict'
)
returns table (committed_count int, committed_ids uuid[])
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare
  v_count int := 0;
  v_ids uuid[] := array[]::uuid[];
  v_row jsonb;
  v_id  uuid;
  v_source_sig text;
  v_import_mode text;
  v_schema_version text;
  v_source_app text;
  v_intake_mode text;
  v_replace_count int;
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);

  if p_table not in ('customers', 'contacts', 'sites') then
    raise exception 'table % is not a core-domain entity (expected: customers/contacts/sites)', p_table;
  end if;

  select source_signature, import_mode, schema_version, source_app, intake_mode
  into v_source_sig, v_import_mode, v_schema_version, v_source_app, v_intake_mode
  from _eq_intake_load_event_meta(p_intake_id, p_tenant_id);

  if v_source_sig is null then
    raise exception 'intake_id % not found for tenant', p_intake_id;
  end if;

  if v_import_mode = 'replace' then
    if not p_confirm_replace then
      raise exception 'replace mode requires p_confirm_replace = true (destructive)';
    end if;
    execute format('delete from app_data.%I where tenant_id = $1 and imported_from = $2', p_table) using p_tenant_id, v_source_sig;
    get diagnostics v_replace_count = row_count;
    raise notice 'replace mode: deleted % prior rows from app_data.%', v_replace_count, p_table;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_row := _eq_intake_apply_metadata(v_row, p_tenant_id, p_intake_id, v_source_sig, v_schema_version);

    case p_table
      when 'customers' then
        if v_import_mode = 'upsert' then
          insert into app_data.customers
            select * from jsonb_populate_record(null::app_data.customers, v_row)
          on conflict (customer_id) do update set
            company_name=excluded.company_name, first_name=excluded.first_name, last_name=excluded.last_name,
            external_id=excluded.external_id, type=excluded.type, abn=excluded.abn, acn=excluded.acn,
            street_address=excluded.street_address, suburb=excluded.suburb, state=excluded.state, postcode=excluded.postcode,
            email=excluded.email, primary_phone=excluded.primary_phone, mobile_phone=excluded.mobile_phone,
            notes=excluded.notes, active=excluded.active,
            imported_at=excluded.imported_at, imported_from=excluded.imported_from,
            intake_id=excluded.intake_id, schema_version=excluded.schema_version
          returning customer_id into v_id;
        else
          insert into app_data.customers select * from jsonb_populate_record(null::app_data.customers, v_row) returning customer_id into v_id;
        end if;

      when 'contacts' then
        if v_import_mode = 'upsert' then
          insert into app_data.contacts
            select * from jsonb_populate_record(null::app_data.contacts, v_row)
          on conflict (contact_id) do update set
            first_name=excluded.first_name, last_name=excluded.last_name, email=excluded.email,
            work_phone=excluded.work_phone, mobile_phone=excluded.mobile_phone,
            customer_id=excluded.customer_id, external_id=excluded.external_id, position=excluded.position,
            active=excluded.active,
            imported_at=excluded.imported_at, imported_from=excluded.imported_from,
            intake_id=excluded.intake_id, schema_version=excluded.schema_version
          returning contact_id into v_id;
        else
          insert into app_data.contacts select * from jsonb_populate_record(null::app_data.contacts, v_row) returning contact_id into v_id;
        end if;

      when 'sites' then
        if v_import_mode = 'upsert' then
          insert into app_data.sites
            select * from jsonb_populate_record(null::app_data.sites, v_row)
          on conflict (site_id) do update set
            name=excluded.name, code=excluded.code, address_line_1=excluded.address_line_1,
            suburb=excluded.suburb, state=excluded.state, postcode=excluded.postcode,
            active=excluded.active,
            imported_at=excluded.imported_at, imported_from=excluded.imported_from,
            intake_id=excluded.intake_id, schema_version=excluded.schema_version
          returning site_id into v_id;
        else
          insert into app_data.sites select * from jsonb_populate_record(null::app_data.sites, v_row) returning site_id into v_id;
        end if;
    end case;

    if v_id is not null then
      v_count := v_count + 1;
      v_ids := array_append(v_ids, v_id);
    end if;
  end loop;

  perform _eq_intake_record_committed(p_intake_id, v_count);
  return query select v_count, v_ids;
end $$;

-- 3.2 — FIELD domain (staff, schedule, safety registers — full set after Unit 5)
create or replace function eq_intake_commit_batch_field(
  p_intake_id        uuid,
  p_tenant_id        uuid,
  p_table            text,
  p_rows             jsonb,
  p_confirm_replace  boolean default false,
  p_intake_mode      text    default 'strict'
)
returns table (committed_count int, committed_ids uuid[])
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare
  v_count int := 0;
  v_ids uuid[] := array[]::uuid[];
  v_row jsonb;
  v_id  uuid;
  v_source_sig text;
  v_import_mode text;
  v_schema_version text;
  v_source_app text;
  v_intake_mode text;
  v_replace_count int;
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);

  -- Field-domain whitelist (will grow when Unit 5 adds Field entities)
  if p_table not in ('staff', 'schedule_entries', 'prestart_checks', 'toolbox_talks',
                      'swms', 'jsa_records', 'itp_records', 'incidents') then
    raise exception 'table % is not a field-domain entity', p_table;
  end if;

  select source_signature, import_mode, schema_version, source_app, intake_mode
  into v_source_sig, v_import_mode, v_schema_version, v_source_app, v_intake_mode
  from _eq_intake_load_event_meta(p_intake_id, p_tenant_id);

  if v_source_sig is null then
    raise exception 'intake_id % not found for tenant', p_intake_id;
  end if;

  if v_import_mode = 'replace' then
    if not p_confirm_replace then
      raise exception 'replace mode requires p_confirm_replace = true';
    end if;
    execute format('delete from app_data.%I where tenant_id = $1 and imported_from = $2', p_table) using p_tenant_id, v_source_sig;
    get diagnostics v_replace_count = row_count;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_row := _eq_intake_apply_metadata(v_row, p_tenant_id, p_intake_id, v_source_sig, v_schema_version);

    case p_table
      when 'staff' then
        if v_import_mode = 'upsert' then
          insert into app_data.staff
            select * from jsonb_populate_record(null::app_data.staff, v_row)
          on conflict (staff_id) do update set
            first_name=excluded.first_name, last_name=excluded.last_name,
            email=excluded.email, phone=excluded.phone,
            employment_type=excluded.employment_type, active=excluded.active,
            imported_at=excluded.imported_at, imported_from=excluded.imported_from,
            intake_id=excluded.intake_id, schema_version=excluded.schema_version
          returning staff_id into v_id;
        else
          insert into app_data.staff select * from jsonb_populate_record(null::app_data.staff, v_row) returning staff_id into v_id;
        end if;

      when 'schedule_entries' then
        insert into app_data.schedule_entries
          select * from jsonb_populate_record(null::app_data.schedule_entries, v_row)
        returning schedule_id into v_id;

      when 'prestart_checks' then
        insert into app_data.prestart_checks
          select * from jsonb_populate_record(null::app_data.prestart_checks, v_row)
        returning prestart_id into v_id;

      when 'toolbox_talks' then
        insert into app_data.toolbox_talks
          select * from jsonb_populate_record(null::app_data.toolbox_talks, v_row)
        returning talk_id into v_id;

      when 'swms' then
        insert into app_data.swms
          select * from jsonb_populate_record(null::app_data.swms, v_row)
        returning swms_id into v_id;

      when 'jsa_records' then
        insert into app_data.jsa_records
          select * from jsonb_populate_record(null::app_data.jsa_records, v_row)
        returning jsa_id into v_id;

      when 'itp_records' then
        insert into app_data.itp_records
          select * from jsonb_populate_record(null::app_data.itp_records, v_row)
        returning itp_id into v_id;

      when 'incidents' then
        insert into app_data.incidents
          select * from jsonb_populate_record(null::app_data.incidents, v_row)
        returning incident_id into v_id;
    end case;

    if v_id is not null then
      v_count := v_count + 1;
      v_ids := array_append(v_ids, v_id);
    end if;
  end loop;

  perform _eq_intake_record_committed(p_intake_id, v_count);
  return query select v_count, v_ids;
end $$;

-- 3.3 — CARDS domain (licence only)
create or replace function eq_intake_commit_batch_cards(
  p_intake_id        uuid,
  p_tenant_id        uuid,
  p_table            text,
  p_rows             jsonb,
  p_confirm_replace  boolean default false,
  p_intake_mode      text    default 'strict'
)
returns table (committed_count int, committed_ids uuid[])
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare
  v_count int := 0;
  v_ids uuid[] := array[]::uuid[];
  v_row jsonb;
  v_id  uuid;
  v_source_sig text;
  v_import_mode text;
  v_schema_version text;
  v_source_app text;
  v_intake_mode text;
  v_replace_count int;
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);

  if p_table not in ('licences') then
    raise exception 'table % is not a cards-domain entity (expected: licences)', p_table;
  end if;

  select source_signature, import_mode, schema_version, source_app, intake_mode
  into v_source_sig, v_import_mode, v_schema_version, v_source_app, v_intake_mode
  from _eq_intake_load_event_meta(p_intake_id, p_tenant_id);

  if v_source_sig is null then
    raise exception 'intake_id % not found for tenant', p_intake_id;
  end if;

  if v_import_mode = 'replace' then
    if not p_confirm_replace then
      raise exception 'replace mode requires p_confirm_replace = true';
    end if;
    execute format('delete from app_data.%I where tenant_id = $1 and imported_from = $2', p_table) using p_tenant_id, v_source_sig;
    get diagnostics v_replace_count = row_count;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_row := _eq_intake_apply_metadata(v_row, p_tenant_id, p_intake_id, v_source_sig, v_schema_version);

    if v_import_mode = 'upsert' then
      insert into app_data.licences
        select * from jsonb_populate_record(null::app_data.licences, v_row)
      on conflict (licence_id) do update set
        staff_id=excluded.staff_id, external_id=excluded.external_id,
        licence_type=excluded.licence_type, licence_number=excluded.licence_number,
        issuing_authority=excluded.issuing_authority, state=excluded.state,
        issue_date=excluded.issue_date, expiry_date=excluded.expiry_date,
        photo_front_path=excluded.photo_front_path, photo_back_path=excluded.photo_back_path,
        notes=excluded.notes, metadata=excluded.metadata, active=excluded.active,
        imported_at=excluded.imported_at, imported_from=excluded.imported_from,
        intake_id=excluded.intake_id, schema_version=excluded.schema_version
      returning licence_id into v_id;
    else
      insert into app_data.licences select * from jsonb_populate_record(null::app_data.licences, v_row) returning licence_id into v_id;
    end if;

    if v_id is not null then
      v_count := v_count + 1;
      v_ids := array_append(v_ids, v_id);
    end if;
  end loop;

  perform _eq_intake_record_committed(p_intake_id, v_count);
  return query select v_count, v_ids;
end $$;

-- 3.4 — SERVICE domain (asset only)
create or replace function eq_intake_commit_batch_service(
  p_intake_id        uuid,
  p_tenant_id        uuid,
  p_table            text,
  p_rows             jsonb,
  p_confirm_replace  boolean default false,
  p_intake_mode      text    default 'strict'
)
returns table (committed_count int, committed_ids uuid[])
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare
  v_count int := 0;
  v_ids uuid[] := array[]::uuid[];
  v_row jsonb;
  v_id  uuid;
  v_source_sig text;
  v_import_mode text;
  v_schema_version text;
  v_source_app text;
  v_intake_mode text;
  v_replace_count int;
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);

  if p_table not in ('assets') then
    raise exception 'table % is not a service-domain entity (expected: assets)', p_table;
  end if;

  select source_signature, import_mode, schema_version, source_app, intake_mode
  into v_source_sig, v_import_mode, v_schema_version, v_source_app, v_intake_mode
  from _eq_intake_load_event_meta(p_intake_id, p_tenant_id);

  if v_source_sig is null then
    raise exception 'intake_id % not found for tenant', p_intake_id;
  end if;

  if v_import_mode = 'replace' then
    if not p_confirm_replace then
      raise exception 'replace mode requires p_confirm_replace = true';
    end if;
    execute format('delete from app_data.%I where tenant_id = $1 and imported_from = $2', p_table) using p_tenant_id, v_source_sig;
    get diagnostics v_replace_count = row_count;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_row := _eq_intake_apply_metadata(v_row, p_tenant_id, p_intake_id, v_source_sig, v_schema_version);

    if v_import_mode = 'upsert' then
      insert into app_data.assets
        select * from jsonb_populate_record(null::app_data.assets, v_row)
      on conflict (asset_id) do update set
        name=excluded.name, asset_type=excluded.asset_type,
        make=excluded.make, model=excluded.model, serial_number=excluded.serial_number,
        last_service_date=excluded.last_service_date, next_service_due=excluded.next_service_due,
        imported_at=excluded.imported_at, imported_from=excluded.imported_from,
        intake_id=excluded.intake_id, schema_version=excluded.schema_version
      returning asset_id into v_id;
    else
      insert into app_data.assets select * from jsonb_populate_record(null::app_data.assets, v_row) returning asset_id into v_id;
    end if;

    if v_id is not null then
      v_count := v_count + 1;
      v_ids := array_append(v_ids, v_id);
    end if;
  end loop;

  perform _eq_intake_record_committed(p_intake_id, v_count);
  return query select v_count, v_ids;
end $$;

-- 3.5 — QUOTES domain (empty until Unit 4 populates)
create or replace function eq_intake_commit_batch_quotes(
  p_intake_id        uuid,
  p_tenant_id        uuid,
  p_table            text,
  p_rows             jsonb,
  p_confirm_replace  boolean default false,
  p_intake_mode      text    default 'strict'
)
returns table (committed_count int, committed_ids uuid[])
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);
  raise exception 'quotes domain has no entities yet (Unit 4 will populate). p_table = %', p_table;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Public dispatcher (router) — rewrites eq_intake_commit_batch
-- ----------------------------------------------------------------------------
-- The router maps singular registry entity names to plural table names,
-- looks up the module, and dispatches to the appropriate per-domain RPC.
-- Backwards-compatible — same external signature.
-- ----------------------------------------------------------------------------

create or replace function eq_intake_commit_batch(
  p_intake_id        uuid,
  p_tenant_id        uuid,
  p_table            text,
  p_rows             jsonb,
  p_confirm_replace  boolean default false,
  p_intake_mode      text    default 'strict'
)
returns table (committed_count int, committed_ids uuid[])
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare
  v_entity text;
  v_module text;
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);

  -- Map plural table name to singular registry entity
  v_entity := case p_table
    when 'customers' then 'customer'
    when 'contacts' then 'contact'
    when 'sites' then 'site'
    when 'staff' then 'staff'
    when 'schedule_entries' then 'schedule'
    when 'prestart_checks' then 'prestart'
    when 'toolbox_talks' then 'toolbox_talk'
    when 'swms' then 'swms'
    when 'jsa_records' then 'jsa'
    when 'itp_records' then 'itp'
    when 'incidents' then 'incident'
    when 'licences' then 'licence'
    when 'assets' then 'asset'
    else null
  end;

  if v_entity is null then
    raise exception 'commit not permitted to table % (unknown entity)', p_table;
  end if;

  -- Look up module
  select module into v_module
  from shell_control.eq_schema_registry
  where entity = v_entity and is_current = true;

  if v_module is null then
    raise exception 'no current schema registered for entity %', v_entity;
  end if;

  -- Dispatch
  if v_module = 'core' then
    return query select * from eq_intake_commit_batch_core(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  elsif v_module = 'field' then
    return query select * from eq_intake_commit_batch_field(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  elsif v_module = 'cards' then
    return query select * from eq_intake_commit_batch_cards(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  elsif v_module = 'quotes' then
    return query select * from eq_intake_commit_batch_quotes(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  elsif v_module = 'service' then
    return query select * from eq_intake_commit_batch_service(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  else
    raise exception 'unknown module %', v_module;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Per-domain unwinders (private)
-- ----------------------------------------------------------------------------
-- Each unwinder deletes rows from its domain's tables by intake_id.
-- Called from the public eq_intake_rollback dispatcher.
-- ----------------------------------------------------------------------------

create or replace function _eq_intake_unwind_core(p_intake_id uuid, p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare v_total int := 0; v_n int;
begin
  delete from app_data.customers where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.contacts where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.sites where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end $$;

create or replace function _eq_intake_unwind_field(p_intake_id uuid, p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare v_total int := 0; v_n int;
begin
  -- Order: leaf entities first, then anything with FK dependents
  delete from app_data.incidents where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.itp_records where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.jsa_records where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.swms where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.toolbox_talks where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.prestart_checks where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.schedule_entries where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.staff where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end $$;

create or replace function _eq_intake_unwind_cards(p_intake_id uuid, p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare v_total int := 0;
begin
  delete from app_data.licences where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_total = row_count;
  return v_total;
end $$;

create or replace function _eq_intake_unwind_service(p_intake_id uuid, p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare v_total int := 0;
begin
  delete from app_data.assets where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_total = row_count;
  return v_total;
end $$;

create or replace function _eq_intake_unwind_quotes(p_intake_id uuid, p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
begin
  -- Empty until Unit 4 populates quote entities
  return 0;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Rewrite eq_intake_rollback as a dispatcher
-- ----------------------------------------------------------------------------

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
  update shell_control.eq_intake_events
  set status = 'rolled_back',
      rolled_back_at = now(),
      rollback_reason = p_reason
  where intake_id = p_intake_id;

  return query select v_total;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Permission grants
-- ----------------------------------------------------------------------------

grant execute on function eq_intake_commit_batch(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_core(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_field(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_cards(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_quotes(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_service(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_rollback(uuid, text) to authenticated;

revoke execute on function _eq_intake_check_tenant_match(uuid) from public;
revoke execute on function _eq_intake_load_event_meta(uuid, uuid) from public;
revoke execute on function _eq_intake_record_committed(uuid, int) from public;
revoke execute on function _eq_intake_apply_metadata(jsonb, uuid, uuid, text, text) from public;
revoke execute on function _eq_intake_unwind_core(uuid, uuid) from public;
revoke execute on function _eq_intake_unwind_field(uuid, uuid) from public;
revoke execute on function _eq_intake_unwind_cards(uuid, uuid) from public;
revoke execute on function _eq_intake_unwind_quotes(uuid, uuid) from public;
revoke execute on function _eq_intake_unwind_service(uuid, uuid) from public;
