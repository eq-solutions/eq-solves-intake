-- ============================================================================
-- 018 — Fix _eq_intake_unwind_field: remove tenant_app_configs
-- ============================================================================
-- tenant_app_configs has no intake_id column — it is a config table, not an
-- intake data table, and should never be in the rollback unwind list.
-- The missing column caused eq_intake_rollback to throw
-- "column intake_id does not exist" whenever any intake was rolled back.
-- ============================================================================

create or replace function _eq_intake_unwind_field(p_intake_id uuid, p_tenant_id uuid)
returns integer
language plpgsql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
declare v_total int := 0; v_n int;
begin
  delete from app_data.leave_approval_logs      where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.schedule_change_logs     where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.engagement_logs          where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.quarterly_reviews        where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.buddy_checkins           where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.rotations                where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.feedback_entries         where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.skills_ratings           where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.apprentice_profiles      where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tafe_calendars           where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.weekly_reports           where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.site_diaries             where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tender_review_decisions  where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tender_import_runs       where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tender_nominations       where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tender_enrichments       where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.tenders                  where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  -- tenant_app_configs intentionally excluded: no intake_id column (config table, not intake data)
  delete from app_data.checkins                 where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.leave_balances           where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.leave_requests           where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.timesheets               where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.incidents                where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.itp_records              where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.jsa_records              where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.swms                     where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.toolbox_talks            where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.prestart_checks          where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.schedule_entries         where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from app_data.staff                    where intake_id = p_intake_id and tenant_id = p_tenant_id; get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end $$;

-- Migration record
insert into app_data._eq_migrations (name) values ('018_unwind_field_fix')
on conflict (name) do nothing;
