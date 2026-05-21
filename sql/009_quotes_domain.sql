-- ============================================================================
-- 009 — Quotes domain (canonical-readiness Unit 4)
-- ============================================================================
-- Adds 7 quote-domain tables to app_data, registers schemas in
-- shell_control.eq_schema_registry (module='quotes'), populates dispatch
-- in eq_intake_commit_batch_quotes, and updates the public router to
-- recognise the new table names.
--
-- Conventions (per eq-quotes-port/docs/architecture.md + 2026-05-20 plan
-- review):
--   - Money as INTEGER cents (never float)
--   - Quantities as INTEGER thousandths (qty_display = qty / 1000)
--   - Line items as separate table app_data.quote_line_item (Decision 5)
--   - Storage in per-tenant bucket tenant-{tenant_id} with quotes/{quote_id}/... paths
--   - Status taxonomy: draft, sent, accepted, rejected, expired, superseded
--   - Sharing app_data.customer, contact, site from core (no SKS-prefixed types)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------

-- 1.1 quote (header)
create table if not exists app_data.quote (
  quote_id              uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  customer_id           uuid not null references app_data.customers(customer_id) on delete restrict,
  contact_id            uuid null references app_data.contacts(contact_id) on delete set null,
  site_id               uuid null references app_data.sites(site_id) on delete set null,
  quote_number          text null,
  external_id           text null,
  project_name          text null,
  attn_name             text null,
  attn_first_name       text null,
  attn_phone            text null,
  address               text null,
  scope_of_works        text null,
  estimator_name        text null,
  estimator_initials    text null,
  status                text not null default 'draft',
  subtotal_cents        bigint not null default 0,
  gst_cents             bigint not null default 0,
  total_cents           bigint not null default 0,
  margin_pct            numeric(5,2) null,
  sent_at               timestamptz null,
  sent_by_initials      text null,
  notes                 text null,
  imported_at           timestamptz null,
  imported_from         text null,
  intake_id             uuid null,
  schema_version        text null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid null,
  updated_by            uuid null,
  constraint quote_status_check check (status in ('draft','sent','accepted','rejected','expired','superseded')),
  constraint quote_amounts_non_negative check (subtotal_cents >= 0 and gst_cents >= 0 and total_cents >= 0)
);

create index if not exists quote_tenant_idx on app_data.quote (tenant_id);
create index if not exists quote_customer_idx on app_data.quote (customer_id);
create index if not exists quote_status_idx on app_data.quote (tenant_id, status, created_at desc);
create index if not exists quote_number_idx on app_data.quote (tenant_id, quote_number) where quote_number is not null;

comment on table app_data.quote is
  'Quote header. Money fields are cents (bigint). Line items live in '
  'app_data.quote_line_item (separate table per 2026-05-20 Decision 5).';

-- 1.2 quote_line_item
create table if not exists app_data.quote_line_item (
  line_item_id          uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  quote_id              uuid not null references app_data.quote(quote_id) on delete cascade,
  line_number           int not null,
  description           text not null,
  quantity_thousandths  bigint not null default 1000,
  unit                  text null,
  unit_rate_cents       bigint not null default 0,
  line_total_cents      bigint not null default 0,
  category              text null,
  notes                 text null,
  imported_at           timestamptz null,
  imported_from         text null,
  intake_id             uuid null,
  schema_version        text null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid null,
  updated_by            uuid null,
  constraint line_qty_non_negative check (quantity_thousandths >= 0),
  constraint line_unit_rate_non_negative check (unit_rate_cents >= 0),
  constraint line_total_non_negative check (line_total_cents >= 0),
  constraint line_category_valid check (category is null or category in ('labour','material','equipment','subcontractor','other'))
);

create index if not exists quote_line_item_quote_idx on app_data.quote_line_item (quote_id, line_number);
create index if not exists quote_line_item_tenant_idx on app_data.quote_line_item (tenant_id);

-- 1.3 quote_status_history
create table if not exists app_data.quote_status_history (
  history_id            uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  quote_id              uuid not null references app_data.quote(quote_id) on delete cascade,
  from_status           text null,
  to_status             text not null,
  changed_by_initials   text null,
  changed_by_user_id    uuid null references shell_control.users(id) on delete set null,
  reason                text null,
  changed_at            timestamptz not null default now(),
  imported_at           timestamptz null,
  imported_from         text null,
  intake_id             uuid null,
  schema_version        text null,
  constraint qsh_to_status_check check (to_status in ('draft','sent','accepted','rejected','expired','superseded')),
  constraint qsh_from_status_check check (from_status is null or from_status in ('draft','sent','accepted','rejected','expired','superseded'))
);

create index if not exists quote_status_history_quote_idx on app_data.quote_status_history (quote_id, changed_at desc);

-- 1.4 quote_attachment (generated docs + uploaded files)
create table if not exists app_data.quote_attachment (
  attachment_id         uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  quote_id              uuid not null references app_data.quote(quote_id) on delete cascade,
  file_name             text not null,
  file_size_bytes       bigint null,
  mime_type             text null,
  storage_path          text null,
  sha256                text null,
  doc_type              text null,
  quote_snapshot        jsonb null,
  generated_by_initials text null,
  generated_at          timestamptz null,
  uploaded_at           timestamptz not null default now(),
  imported_at           timestamptz null,
  imported_from         text null,
  intake_id             uuid null,
  schema_version        text null,
  constraint qa_doc_type_valid check (doc_type is null or doc_type in ('docx','pdf','image','other'))
);

create index if not exists quote_attachment_quote_idx on app_data.quote_attachment (quote_id, uploaded_at desc);

-- 1.5 scope_template (reusable scope phrases)
create table if not exists app_data.scope_template (
  template_id           uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  name                  text not null,
  category              text null,
  body                  text not null,
  sort_order            int not null default 0,
  active                boolean not null default true,
  imported_at           timestamptz null,
  imported_from         text null,
  intake_id             uuid null,
  schema_version        text null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid null,
  updated_by            uuid null
);

create index if not exists scope_template_tenant_idx on app_data.scope_template (tenant_id, sort_order) where active = true;

-- 1.6 rate_library (curated rates for quoting)
create table if not exists app_data.rate_library (
  rate_id               uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  code                  text null,
  description           text not null,
  category              text null,
  unit                  text null,
  unit_cost_cents       bigint not null default 0,
  unit_sell_cents       bigint not null default 0,
  margin_pct            numeric(5,2) null,
  active                boolean not null default true,
  imported_at           timestamptz null,
  imported_from         text null,
  intake_id             uuid null,
  schema_version        text null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid null,
  updated_by            uuid null,
  constraint rate_category_valid check (category is null or category in ('labour','material','equipment','subcontractor','other')),
  constraint rate_cost_non_negative check (unit_cost_cents >= 0 and unit_sell_cents >= 0)
);

create unique index if not exists rate_library_tenant_code_uq on app_data.rate_library (tenant_id, code) where code is not null;
create index if not exists rate_library_active_idx on app_data.rate_library (tenant_id, category) where active = true;

-- 1.7 quote_email_outbox
create table if not exists app_data.quote_email_outbox (
  outbox_id             uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  quote_id              uuid not null references app_data.quote(quote_id) on delete cascade,
  to_email              text not null,
  to_name               text null,
  cc_emails             text[] null,
  bcc_emails            text[] null,
  subject               text not null,
  body_html             text null,
  body_text             text null,
  attachment_ids        uuid[] null,
  status                text not null default 'queued',
  queued_at             timestamptz not null default now(),
  sent_at               timestamptz null,
  failed_at             timestamptz null,
  error_message         text null,
  attempt_count         int not null default 0,
  imported_at           timestamptz null,
  imported_from         text null,
  intake_id             uuid null,
  schema_version        text null,
  constraint qeo_status_valid check (status in ('queued','sending','sent','failed','cancelled'))
);

create index if not exists quote_email_outbox_status_idx on app_data.quote_email_outbox (tenant_id, status, queued_at);
create index if not exists quote_email_outbox_quote_idx on app_data.quote_email_outbox (quote_id);

-- ----------------------------------------------------------------------------
-- 2. updated_at triggers (using existing eq_set_imported_at pattern... actually
-- we need a generic updated_at trigger. Reusing the pattern from Field migrations.)
-- ----------------------------------------------------------------------------

create or replace function app_data._set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
declare tables_with_updated_at text[] := array['quote','quote_line_item','scope_template','rate_library'];
begin
  foreach t in array tables_with_updated_at loop
    execute format('drop trigger if exists trg_%I_updated_at on app_data.%I', t, t);
    execute format('create trigger trg_%I_updated_at before update on app_data.%I for each row execute function app_data._set_updated_at()', t, t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. RLS — enable + add policies per the 2026-05-20 pattern
-- ----------------------------------------------------------------------------

do $$
declare t text;
declare quote_tables text[] := array['quote','quote_line_item','quote_status_history','quote_attachment','scope_template','rate_library','quote_email_outbox'];
declare pn text;
begin
  foreach t in array quote_tables loop
    execute format('alter table app_data.%I enable row level security', t);

    pn := t || '_select';
    if not exists (select 1 from pg_policies where schemaname = 'app_data' and tablename = t and policyname = pn) then
      execute format('create policy %I on app_data.%I for select to authenticated using (tenant_id = ((auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid))', pn, t);
    end if;

    pn := t || '_insert';
    if not exists (select 1 from pg_policies where schemaname = 'app_data' and tablename = t and policyname = pn) then
      execute format('create policy %I on app_data.%I for insert to authenticated with check (tenant_id = ((auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid))', pn, t);
    end if;

    pn := t || '_update';
    if not exists (select 1 from pg_policies where schemaname = 'app_data' and tablename = t and policyname = pn) then
      execute format('create policy %I on app_data.%I for update to authenticated using (tenant_id = ((auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid)) with check (tenant_id = ((auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid))', pn, t);
    end if;

    pn := t || '_delete';
    if not exists (select 1 from pg_policies where schemaname = 'app_data' and tablename = t and policyname = pn) then
      execute format('create policy %I on app_data.%I for delete to authenticated using (tenant_id = ((auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid))', pn, t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Update eq_intake_commit_batch_quotes RPC with dispatch + the router
-- ----------------------------------------------------------------------------

create or replace function eq_intake_commit_batch_quotes(
  p_intake_id uuid, p_tenant_id uuid, p_table text, p_rows jsonb,
  p_confirm_replace boolean default false, p_intake_mode text default 'strict')
returns table (committed_count int, committed_ids uuid[])
language plpgsql security definer set search_path = app_data, shell_control, public, extensions as $$
declare v_count int := 0; v_ids uuid[] := array[]::uuid[]; v_row jsonb; v_id uuid;
  v_source_sig text; v_import_mode text; v_schema_version text; v_source_app text; v_intake_mode text;
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);
  if p_table not in ('quote','quote_line_item','quote_status_history','quote_attachment','scope_template','rate_library','quote_email_outbox') then
    raise exception 'table % not quotes-domain', p_table;
  end if;
  select source_signature, import_mode, schema_version, source_app, intake_mode
  into v_source_sig, v_import_mode, v_schema_version, v_source_app, v_intake_mode
  from _eq_intake_load_event_meta(p_intake_id, p_tenant_id);
  if v_source_sig is null then raise exception 'intake_id % not found', p_intake_id; end if;
  if v_import_mode = 'replace' then
    if not p_confirm_replace then raise exception 'replace requires p_confirm_replace=true'; end if;
    execute format('delete from app_data.%I where tenant_id = $1 and imported_from = $2', p_table) using p_tenant_id, v_source_sig;
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_row := _eq_intake_apply_metadata(v_row, p_tenant_id, p_intake_id, v_source_sig, v_schema_version);
    case p_table
      when 'quote' then
        insert into app_data.quote select * from jsonb_populate_record(null::app_data.quote, v_row) returning quote_id into v_id;
      when 'quote_line_item' then
        insert into app_data.quote_line_item select * from jsonb_populate_record(null::app_data.quote_line_item, v_row) returning line_item_id into v_id;
      when 'quote_status_history' then
        insert into app_data.quote_status_history select * from jsonb_populate_record(null::app_data.quote_status_history, v_row) returning history_id into v_id;
      when 'quote_attachment' then
        insert into app_data.quote_attachment select * from jsonb_populate_record(null::app_data.quote_attachment, v_row) returning attachment_id into v_id;
      when 'scope_template' then
        insert into app_data.scope_template select * from jsonb_populate_record(null::app_data.scope_template, v_row) returning template_id into v_id;
      when 'rate_library' then
        insert into app_data.rate_library select * from jsonb_populate_record(null::app_data.rate_library, v_row) returning rate_id into v_id;
      when 'quote_email_outbox' then
        insert into app_data.quote_email_outbox select * from jsonb_populate_record(null::app_data.quote_email_outbox, v_row) returning outbox_id into v_id;
    end case;
    if v_id is not null then v_count := v_count + 1; v_ids := array_append(v_ids, v_id); end if;
  end loop;
  perform _eq_intake_record_committed(p_intake_id, v_count);
  return query select v_count, v_ids;
end $$;

-- Update the router to recognise quote-domain table names
create or replace function eq_intake_commit_batch(
  p_intake_id uuid, p_tenant_id uuid, p_table text, p_rows jsonb,
  p_confirm_replace boolean default false, p_intake_mode text default 'strict')
returns table (committed_count int, committed_ids uuid[])
language plpgsql security definer set search_path = app_data, shell_control, public, extensions as $$
declare v_entity text; v_module text;
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);
  v_entity := case p_table
    when 'customers' then 'customer' when 'contacts' then 'contact' when 'sites' then 'site'
    when 'staff' then 'staff' when 'schedule_entries' then 'schedule'
    when 'prestart_checks' then 'prestart' when 'toolbox_talks' then 'toolbox_talk'
    when 'swms' then 'swms' when 'jsa_records' then 'jsa' when 'itp_records' then 'itp'
    when 'incidents' then 'incident' when 'licences' then 'licence' when 'assets' then 'asset'
    -- Quotes domain (Unit 4)
    when 'quote' then 'quote' when 'quote_line_item' then 'quote_line_item'
    when 'quote_status_history' then 'quote_status_history' when 'quote_attachment' then 'quote_attachment'
    when 'scope_template' then 'scope_template' when 'rate_library' then 'rate_library'
    when 'quote_email_outbox' then 'quote_email_outbox'
    else null end;
  if v_entity is null then raise exception 'commit not permitted to table % (unknown)', p_table; end if;
  select module into v_module from shell_control.eq_schema_registry where entity = v_entity and is_current = true;
  if v_module is null then raise exception 'no current schema for entity %', v_entity; end if;
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
  else raise exception 'unknown module %', v_module; end if;
end $$;

-- Update the unwinder
create or replace function _eq_intake_unwind_quotes(p_intake_id uuid, p_tenant_id uuid) returns int
language plpgsql security definer set search_path = app_data, shell_control, public, extensions as $$
declare v_total int := 0; v_n int;
begin
  -- Order: leaf (FK dependents) first
  delete from app_data.quote_email_outbox where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.quote_attachment where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.quote_status_history where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.quote_line_item where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.quote where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.scope_template where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.rate_library where intake_id = p_intake_id and tenant_id = p_tenant_id;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end $$;