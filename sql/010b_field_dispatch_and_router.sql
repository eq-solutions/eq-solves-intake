-- ============================================================================
-- 010b — Field dispatch + router update (canonical-readiness Unit 5 part 2)
-- ============================================================================
-- Applied separately from 010 because 010 creates the tables and 010b extends
-- the RPC dispatch. Both belong to Unit 5; split into two files keeps each
-- file under the 250-line review threshold.
--
-- Idempotent — CREATE OR REPLACE on every function.
-- ============================================================================

create or replace function eq_intake_commit_batch_field(
  p_intake_id uuid, p_tenant_id uuid, p_table text, p_rows jsonb,
  p_confirm_replace boolean default false, p_intake_mode text default 'strict')
returns table (committed_count int, committed_ids uuid[])
language plpgsql security definer set search_path = app_data, shell_control, public, extensions as $$
declare v_count int := 0; v_ids uuid[] := array[]::uuid[]; v_row jsonb; v_id uuid;
  v_source_sig text; v_import_mode text; v_schema_version text; v_source_app text; v_intake_mode text;
begin
  perform _eq_intake_check_tenant_match(p_tenant_id);
  if p_table not in (
    'staff','schedule_entries','prestart_checks','toolbox_talks','swms','jsa_records','itp_records','incidents',
    'timesheets','leave_requests','leave_balances','checkins','tenant_app_configs',
    'tenders','tender_enrichments','tender_nominations','tender_import_runs','tender_review_decisions',
    'site_diaries','weekly_reports',
    'apprentice_profiles','skills_ratings','feedback_entries','rotations','buddy_checkins','quarterly_reviews','engagement_logs','tafe_calendars',
    'schedule_change_logs','leave_approval_logs'
  ) then
    raise exception 'table % not field-domain', p_table;
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
      when 'staff' then
        if v_import_mode = 'upsert' then
          insert into app_data.staff select * from jsonb_populate_record(null::app_data.staff, v_row)
          on conflict (staff_id) do update set first_name=excluded.first_name, last_name=excluded.last_name,
            email=excluded.email, phone=excluded.phone, employment_type=excluded.employment_type,
            active=excluded.active, imported_at=excluded.imported_at, imported_from=excluded.imported_from,
            intake_id=excluded.intake_id, schema_version=excluded.schema_version
          returning staff_id into v_id;
        else
          insert into app_data.staff select * from jsonb_populate_record(null::app_data.staff, v_row) returning staff_id into v_id;
        end if;
      when 'schedule_entries' then insert into app_data.schedule_entries select * from jsonb_populate_record(null::app_data.schedule_entries, v_row) returning schedule_id into v_id;
      when 'prestart_checks' then insert into app_data.prestart_checks select * from jsonb_populate_record(null::app_data.prestart_checks, v_row) returning prestart_id into v_id;
      when 'toolbox_talks' then insert into app_data.toolbox_talks select * from jsonb_populate_record(null::app_data.toolbox_talks, v_row) returning talk_id into v_id;
      when 'swms' then insert into app_data.swms select * from jsonb_populate_record(null::app_data.swms, v_row) returning swms_id into v_id;
      when 'jsa_records' then insert into app_data.jsa_records select * from jsonb_populate_record(null::app_data.jsa_records, v_row) returning jsa_id into v_id;
      when 'itp_records' then insert into app_data.itp_records select * from jsonb_populate_record(null::app_data.itp_records, v_row) returning itp_id into v_id;
      when 'incidents' then insert into app_data.incidents select * from jsonb_populate_record(null::app_data.incidents, v_row) returning incident_id into v_id;
      when 'timesheets' then insert into app_data.timesheets select * from jsonb_populate_record(null::app_data.timesheets, v_row) returning timesheet_id into v_id;
      when 'leave_requests' then insert into app_data.leave_requests select * from jsonb_populate_record(null::app_data.leave_requests, v_row) returning leave_request_id into v_id;
      when 'leave_balances' then insert into app_data.leave_balances select * from jsonb_populate_record(null::app_data.leave_balances, v_row) returning leave_balance_id into v_id;
      when 'checkins' then insert into app_data.checkins select * from jsonb_populate_record(null::app_data.checkins, v_row) returning checkin_id into v_id;
      when 'tenant_app_configs' then insert into app_data.tenant_app_configs select * from jsonb_populate_record(null::app_data.tenant_app_configs, v_row) returning config_id into v_id;
      when 'tenders' then insert into app_data.tenders select * from jsonb_populate_record(null::app_data.tenders, v_row) returning tender_id into v_id;
      when 'tender_enrichments' then insert into app_data.tender_enrichments select * from jsonb_populate_record(null::app_data.tender_enrichments, v_row) returning enrichment_id into v_id;
      when 'tender_nominations' then insert into app_data.tender_nominations select * from jsonb_populate_record(null::app_data.tender_nominations, v_row) returning nomination_id into v_id;
      when 'tender_import_runs' then insert into app_data.tender_import_runs select * from jsonb_populate_record(null::app_data.tender_import_runs, v_row) returning import_run_id into v_id;
      when 'tender_review_decisions' then insert into app_data.tender_review_decisions select * from jsonb_populate_record(null::app_data.tender_review_decisions, v_row) returning decision_id into v_id;
      when 'site_diaries' then insert into app_data.site_diaries select * from jsonb_populate_record(null::app_data.site_diaries, v_row) returning site_diary_id into v_id;
      when 'weekly_reports' then insert into app_data.weekly_reports select * from jsonb_populate_record(null::app_data.weekly_reports, v_row) returning weekly_report_id into v_id;
      when 'apprentice_profiles' then insert into app_data.apprentice_profiles select * from jsonb_populate_record(null::app_data.apprentice_profiles, v_row) returning apprentice_profile_id into v_id;
      when 'skills_ratings' then insert into app_data.skills_ratings select * from jsonb_populate_record(null::app_data.skills_ratings, v_row) returning skills_rating_id into v_id;
      when 'feedback_entries' then insert into app_data.feedback_entries select * from jsonb_populate_record(null::app_data.feedback_entries, v_row) returning feedback_entry_id into v_id;
      when 'rotations' then insert into app_data.rotations select * from jsonb_populate_record(null::app_data.rotations, v_row) returning rotation_id into v_id;
      when 'buddy_checkins' then insert into app_data.buddy_checkins select * from jsonb_populate_record(null::app_data.buddy_checkins, v_row) returning buddy_checkin_id into v_id;
      when 'quarterly_reviews' then insert into app_data.quarterly_reviews select * from jsonb_populate_record(null::app_data.quarterly_reviews, v_row) returning quarterly_review_id into v_id;
      when 'engagement_logs' then insert into app_data.engagement_logs select * from jsonb_populate_record(null::app_data.engagement_logs, v_row) returning engagement_log_id into v_id;
      when 'tafe_calendars' then insert into app_data.tafe_calendars select * from jsonb_populate_record(null::app_data.tafe_calendars, v_row) returning tafe_calendar_id into v_id;
      when 'schedule_change_logs' then insert into app_data.schedule_change_logs select * from jsonb_populate_record(null::app_data.schedule_change_logs, v_row) returning log_id into v_id;
      when 'leave_approval_logs' then insert into app_data.leave_approval_logs select * from jsonb_populate_record(null::app_data.leave_approval_logs, v_row) returning log_id into v_id;
    end case;
    if v_id is not null then v_count := v_count + 1; v_ids := array_append(v_ids, v_id); end if;
  end loop;
  perform _eq_intake_record_committed(p_intake_id, v_count);
  return query select v_count, v_ids;
end $$;

-- Updated router (recognises Quotes + Field Unit 5 + Cards/Core/Service)
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
    when 'swms' then 'swms' when 'jsa_records' then 'jsa' when 'itp_records' then 'itp' when 'incidents' then 'incident'
    when 'licences' then 'licence' when 'assets' then 'asset'
    when 'quote' then 'quote' when 'quote_line_item' then 'quote_line_item'
    when 'quote_status_history' then 'quote_status_history' when 'quote_attachment' then 'quote_attachment'
    when 'scope_template' then 'scope_template' when 'rate_library' then 'rate_library'
    when 'quote_email_outbox' then 'quote_email_outbox'
    when 'timesheets' then 'timesheet' when 'leave_requests' then 'leave_request'
    when 'leave_balances' then 'leave_balance' when 'checkins' then 'checkin'
    when 'tenant_app_configs' then 'tenant_app_config'
    when 'tenders' then 'tender' when 'tender_enrichments' then 'tender_enrichment'
    when 'tender_nominations' then 'tender_nomination' when 'tender_import_runs' then 'tender_import_run'
    when 'tender_review_decisions' then 'tender_review_decision'
    when 'site_diaries' then 'site_diary' when 'weekly_reports' then 'weekly_report'
    when 'apprentice_profiles' then 'apprentice_profile' when 'skills_ratings' then 'skills_rating'
    when 'feedback_entries' then 'feedback_entry' when 'rotations' then 'rotation'
    when 'buddy_checkins' then 'buddy_checkin' when 'quarterly_reviews' then 'quarterly_review'
    when 'engagement_logs' then 'engagement_log' when 'tafe_calendars' then 'tafe_calendar'
    when 'schedule_change_logs' then 'schedule_change_log' when 'leave_approval_logs' then 'leave_approval_log'
    else null end;
  if v_entity is null then raise exception 'commit not permitted to table % (unknown)', p_table; end if;
  select module into v_module from shell_control.eq_schema_registry where entity = v_entity and is_current = true;
  if v_module is null then raise exception 'no current schema for entity %', v_entity; end if;
  if v_module = 'core' then return query select * from eq_intake_commit_batch_core(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  elsif v_module = 'field' then return query select * from eq_intake_commit_batch_field(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  elsif v_module = 'cards' then return query select * from eq_intake_commit_batch_cards(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  elsif v_module = 'quotes' then return query select * from eq_intake_commit_batch_quotes(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  elsif v_module = 'service' then return query select * from eq_intake_commit_batch_service(p_intake_id, p_tenant_id, p_table, p_rows, p_confirm_replace, p_intake_mode);
  else raise exception 'unknown module %', v_module; end if;
end $$;

-- Updated field unwinder
create or replace function _eq_intake_unwind_field(p_intake_id uuid, p_tenant_id uuid) returns int
language plpgsql security definer set search_path = app_data, shell_control, public, extensions as $$
declare v_total int := 0; v_n int;
begin
  delete from app_data.leave_approval_logs where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.schedule_change_logs where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.engagement_logs where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.quarterly_reviews where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.buddy_checkins where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.rotations where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.feedback_entries where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.skills_ratings where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.apprentice_profiles where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tafe_calendars where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.weekly_reports where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.site_diaries where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tender_review_decisions where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tender_import_runs where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tender_nominations where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tender_enrichments where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tenders where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tenant_app_configs where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.checkins where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.leave_balances where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.leave_requests where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.timesheets where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.incidents where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.itp_records where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.jsa_records where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.swms where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.toolbox_talks where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.prestart_checks where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.schedule_entries where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.staff where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end $$;
