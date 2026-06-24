-- 056_contract_scope_router_fix.sql
--
-- Corrects four issues introduced by 054/055 that are already live on ehow:
--
--   1. NULLIF guard missing on customer_id cast in replace pre-delete — blank
--      customer_id would raise 'invalid input syntax for type uuid'.
--   2. _eq_intake_check_tenant_match not called — JWT tenant isolation dropped.
--   3. _eq_intake_record_committed not called — rows_committed counter stays 0.
--   4. No GRANT on the new 8-arg overload — authenticated role cannot call it.
--
-- Also fixes the router (eq_intake_commit_batch):
--   5. contract_scopes not in the entity CASE — committed to 'unknown table'.
--   6. service dispatch calls the old 6-arg overload — contract_scopes branch
--      never reached; router must load event meta and call the new 8-arg sig.
--
-- Idempotent: CREATE OR REPLACE on both functions + INSERT ... ON CONFLICT.
-- ============================================================================

-- ── 1–4. Corrected service function (055 body + all four fixes) ───────────

CREATE OR REPLACE FUNCTION public.eq_intake_commit_batch_service(
  p_intake_id      uuid,
  p_tenant_id      uuid,
  p_table          text,
  p_rows           jsonb,
  p_source_sig     text,
  p_schema_version text,
  p_import_mode    text DEFAULT 'append'::text,
  p_confirm_replace boolean DEFAULT false
)
RETURNS TABLE(committed_count integer, committed_ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app_data', 'shell_control', 'public', 'extensions'
AS $function$
DECLARE
  v_count int := 0;
  v_ids   uuid[] := ARRAY[]::uuid[];
  v_row   jsonb;
  v_id    uuid;
BEGIN
  IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'p_tenant_id is required'; END IF;
  IF p_intake_id IS NULL THEN RAISE EXCEPTION 'p_intake_id is required'; END IF;
  IF p_table NOT IN ('assets', 'contract_scopes') THEN
    RAISE EXCEPTION 'table % not service-domain (supported: assets, contract_scopes)', p_table;
  END IF;
  IF p_import_mode NOT IN ('append', 'upsert', 'replace') THEN
    RAISE EXCEPTION 'invalid import_mode: % (expected append | upsert | replace)', p_import_mode;
  END IF;
  IF p_table = 'contract_scopes' AND p_import_mode = 'upsert' THEN
    RAISE EXCEPTION 'upsert not supported for contract_scopes (no natural import key) — use append or replace';
  END IF;

  PERFORM _eq_intake_check_tenant_match(p_tenant_id);

  IF p_import_mode = 'replace' THEN
    IF NOT p_confirm_replace THEN RAISE EXCEPTION 'replace requires p_confirm_replace=true'; END IF;

    IF p_table = 'assets' THEN
      EXECUTE format('DELETE FROM app_data.%I WHERE tenant_id = $1 AND imported_from = $2', p_table)
        USING p_tenant_id, p_source_sig;

    ELSIF p_table = 'contract_scopes' THEN
      DELETE FROM app_data.contract_scopes cs
      USING (
        SELECT DISTINCT
          NULLIF(r ->> 'customer_id', '')::uuid AS customer_id,
          NULLIF(r ->> 'site_id', '')::uuid     AS site_id,
          r ->> 'financial_year'                AS financial_year
        FROM jsonb_array_elements(p_rows) AS r
      ) k
      WHERE cs.tenant_id      = p_tenant_id
        AND cs.customer_id    = k.customer_id
        AND cs.financial_year = k.financial_year
        AND cs.site_id IS NOT DISTINCT FROM k.site_id;
    END IF;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_row := _eq_intake_apply_metadata(v_row, p_tenant_id, p_intake_id, p_source_sig, p_schema_version);

    IF p_table = 'assets' THEN
      IF p_import_mode = 'upsert' THEN
        INSERT INTO app_data.assets
          SELECT * FROM jsonb_populate_record(NULL::app_data.assets, v_row)
          ON CONFLICT (asset_id) DO UPDATE SET
            external_id            = EXCLUDED.external_id,
            site_id                = EXCLUDED.site_id,
            parent_asset_id        = EXCLUDED.parent_asset_id,
            asset_type             = EXCLUDED.asset_type,
            name                   = EXCLUDED.name,
            make                   = EXCLUDED.make,
            model                  = EXCLUDED.model,
            serial_number          = EXCLUDED.serial_number,
            rating                 = EXCLUDED.rating,
            install_date           = EXCLUDED.install_date,
            warranty_expires       = EXCLUDED.warranty_expires,
            criticality            = EXCLUDED.criticality,
            condition              = EXCLUDED.condition,
            service_schedule_id    = EXCLUDED.service_schedule_id,
            ppm_frequency          = EXCLUDED.ppm_frequency,
            last_service_date      = EXCLUDED.last_service_date,
            next_service_due       = EXCLUDED.next_service_due,
            location_in_site       = EXCLUDED.location_in_site,
            barcode                = EXCLUDED.barcode,
            active                 = EXCLUDED.active,
            defects_summary        = EXCLUDED.defects_summary,
            client_classification  = EXCLUDED.client_classification,
            notes                  = EXCLUDED.notes,
            imported_at            = EXCLUDED.imported_at,
            imported_from          = EXCLUDED.imported_from,
            intake_id              = EXCLUDED.intake_id,
            schema_version         = EXCLUDED.schema_version
          RETURNING asset_id INTO v_id;
      ELSE
        INSERT INTO app_data.assets
          SELECT * FROM jsonb_populate_record(NULL::app_data.assets, v_row)
          RETURNING asset_id INTO v_id;
      END IF;

    ELSIF p_table = 'contract_scopes' THEN
      v_row := jsonb_build_object(
        'lifecycle_status',       'committed',
        'is_included',            true,
        'active',                 true,
        'billing_basis',          'fixed',
        'cycle_costs',            '{}'::jsonb,
        'year_totals',            '{}'::jsonb,
        'due_years',              '{}'::jsonb,
        'labour_hours_per_asset', '{}'::jsonb,
        'has_bundled_scope',      false,
        'commercial_gap',         false
      ) || v_row;
      IF NULLIF(v_row ->> 'scope_id', '') IS NULL THEN
        v_row := v_row || jsonb_build_object('scope_id', gen_random_uuid());
      END IF;
      INSERT INTO app_data.contract_scopes
        SELECT * FROM jsonb_populate_record(NULL::app_data.contract_scopes, v_row)
        RETURNING scope_id INTO v_id;
    END IF;

    IF v_id IS NOT NULL THEN
      v_count := v_count + 1;
      v_ids   := array_append(v_ids, v_id);
    END IF;
  END LOOP;

  PERFORM _eq_intake_record_committed(p_intake_id, v_count);
  RETURN QUERY SELECT v_count, v_ids;
END
$function$;

-- ── 4. GRANT on the 8-arg overload ────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.eq_intake_commit_batch_service(uuid, uuid, text, jsonb, text, text, text, boolean) TO authenticated;

-- ── 5. Register contract_scope entity in schema_registry ──────────────────

INSERT INTO shell_control.eq_schema_registry (entity, module, version, schema_json, description, is_current)
VALUES (
  'contract_scope',
  'service',
  '1.0.0',
  '{"x-eq-entity":"contract_scope","x-eq-module":"service","x-eq-version":"1.0.0","type":"object","description":"Service-domain contract scope row."}'::jsonb,
  'Service-domain contract scope.',
  true
)
ON CONFLICT (entity, version) DO UPDATE
  SET module = EXCLUDED.module, is_current = EXCLUDED.is_current;

-- ── 5–6. Updated router: adds contract_scopes and fixes service dispatch ──

create or replace function eq_intake_commit_batch(
  p_intake_id uuid, p_tenant_id uuid, p_table text, p_rows jsonb,
  p_confirm_replace boolean default false, p_intake_mode text default 'strict')
returns table (committed_count int, committed_ids uuid[])
language plpgsql security definer set search_path = app_data, shell_control, public, extensions as $$
declare v_entity text; v_module text;
  v_src text; v_sv text; v_imode text;
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);
  v_entity := case p_table
    when 'customers'          then 'customer'
    when 'contacts'           then 'contact'
    when 'sites'              then 'site'
    when 'staff'              then 'staff'
    when 'schedule_entries'   then 'schedule'
    when 'prestart_checks'    then 'prestart'
    when 'toolbox_talks'      then 'toolbox_talk'
    when 'swms'               then 'swms'
    when 'jsa_records'        then 'jsa'
    when 'itp_records'        then 'itp'
    when 'incidents'          then 'incident'
    when 'licences'           then 'licence'
    when 'assets'             then 'asset'
    when 'contract_scopes'    then 'contract_scope'
    when 'quote'              then 'quote'
    when 'quote_line_item'    then 'quote_line_item'
    when 'quote_status_history' then 'quote_status_history'
    when 'quote_attachment'   then 'quote_attachment'
    when 'scope_template'     then 'scope_template'
    when 'rate_library'       then 'rate_library'
    when 'quote_email_outbox' then 'quote_email_outbox'
    when 'timesheets'         then 'timesheet'
    when 'leave_requests'     then 'leave_request'
    when 'leave_balances'     then 'leave_balance'
    when 'checkins'           then 'checkin'
    when 'tenant_app_configs' then 'tenant_app_config'
    when 'tenders'            then 'tender'
    when 'tender_enrichments' then 'tender_enrichment'
    when 'tender_nominations' then 'tender_nomination'
    when 'tender_import_runs' then 'tender_import_run'
    when 'tender_review_decisions' then 'tender_review_decision'
    when 'site_diaries'       then 'site_diary'
    when 'weekly_reports'     then 'weekly_report'
    when 'apprentice_profiles' then 'apprentice_profile'
    when 'skills_ratings'     then 'skills_rating'
    when 'feedback_entries'   then 'feedback_entry'
    when 'rotations'          then 'rotation'
    when 'buddy_checkins'     then 'buddy_checkin'
    when 'quarterly_reviews'  then 'quarterly_review'
    when 'engagement_logs'    then 'engagement_log'
    when 'tafe_calendars'     then 'tafe_calendar'
    when 'schedule_change_logs' then 'schedule_change_log'
    when 'leave_approval_logs' then 'leave_approval_log'
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
    select source_signature, schema_version, import_mode
    into v_src, v_sv, v_imode
    from _eq_intake_load_event_meta(p_intake_id, p_tenant_id);
    if v_src is null then raise exception 'intake_id % not found for service commit', p_intake_id; end if;
    return query select * from eq_intake_commit_batch_service(
      p_intake_id, p_tenant_id, p_table, p_rows,
      v_src, v_sv, v_imode, p_confirm_replace
    );
  else
    raise exception 'unknown module %', v_module;
  end if;
end $$;
