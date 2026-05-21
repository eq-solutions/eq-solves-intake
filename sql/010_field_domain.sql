-- ============================================================================
-- 010 — Field domain (canonical-readiness Unit 5)
-- ============================================================================
-- Single migration. Adds the Field domain entities to canonical so EQ
-- Solutions' next-generation Field module(s) can be built fresh in shell.
-- 23 new tables across 4 groups + 2 workflow event tables. Per 2026-05-20
-- review: no data migration, no dual operation. SKS NSW Labour stays on
-- its own infrastructure.
--
-- Groups (TOC):
--   1. CORE FIELD TABLES (~5): timesheets, leave_requests, leave_balances, checkins, tenant_app_configs
--   2. TENDER CLUSTER (~6): tenders, tender_enrichments, tender_nominations,
--      tender_nomination_clashes (view), tender_import_runs, tender_review_decisions
--   3. SITE REPORTS V2 (~2): site_diaries, weekly_reports
--   4. APPRENTICE CLUSTER (~8): apprentice_profiles, skills_ratings,
--      feedback_entries, rotations, buddy_checkins, quarterly_reviews,
--      engagement_logs, tafe_calendars
--   5. WORKFLOW EVENT LOGS (2): schedule_change_logs, leave_approval_logs
--
-- Conventions:
--   - Plural table names (matching existing canonical)
--   - Money in cents (bigint)
--   - tenant_id NOT NULL with JWT default
--   - RLS predicates use auth.jwt() app_metadata.tenant_id
--   - Per-tenant storage bucket tenant-{tenant_id} for photos
--   - Following Field's freeform shape where appropriate (e.g. site_diaries jsonb
--     for weather/repeating sections) but with canonical FK conventions
--
-- pending_schedule DROPPED (dead code per 2026-05-20 review Q1).
-- managers SUNSET — digest opt-in moves to staff (Unit 2).
-- ============================================================================

-- ============================================================================
-- GROUP 1: CORE FIELD TABLES
-- ============================================================================

-- 1.1 timesheets
create table if not exists app_data.timesheets (
  timesheet_id          uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  staff_id              uuid not null references app_data.staff(staff_id) on delete restrict,
  site_id               uuid null references app_data.sites(site_id) on delete set null,
  schedule_id           uuid null references app_data.schedule_entries(schedule_id) on delete set null,
  date                  date not null,
  start_time            time null,
  end_time              time null,
  hours                 numeric(6,2) not null default 0,
  break_minutes         int not null default 0,
  shift                 text null,
  task                  text null,
  status                text not null default 'draft',
  submitted_at          timestamptz null,
  approved_at           timestamptz null,
  approved_by_user_id   uuid null references shell_control.users(id) on delete set null,
  paid_at               timestamptz null,
  notes                 text null,
  imported_at           timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid null, updated_by uuid null,
  constraint timesheet_status_check check (status in ('draft','submitted','approved','rejected','paid')),
  constraint timesheet_hours_non_negative check (hours >= 0),
  constraint timesheet_shift_valid check (shift is null or shift in ('day','night','split','arvo'))
);
create index if not exists timesheets_tenant_date_idx on app_data.timesheets (tenant_id, date desc);
create index if not exists timesheets_staff_date_idx on app_data.timesheets (staff_id, date desc);
create index if not exists timesheets_site_date_idx on app_data.timesheets (site_id, date desc) where site_id is not null;

-- 1.2 leave_requests
create table if not exists app_data.leave_requests (
  leave_request_id      uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  staff_id              uuid not null references app_data.staff(staff_id) on delete restrict,
  leave_type            text not null,
  from_date             date not null,
  to_date               date not null,
  hours_requested       numeric(6,2) not null default 0,
  status                text not null default 'pending',
  reason                text null,
  approver_required     boolean not null default true,
  approver_id           uuid null references shell_control.users(id) on delete set null,
  decided_at            timestamptz null,
  decision_notes        text null,
  archived              boolean not null default false,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid null, updated_by uuid null,
  constraint leave_request_status_check check (status in ('pending','approved','rejected','cancelled')),
  constraint leave_request_type_check check (leave_type in ('annual','sick','personal','long_service','unpaid','tafe','other')),
  constraint leave_request_dates_valid check (to_date >= from_date),
  constraint leave_request_hours_non_negative check (hours_requested >= 0)
);
create index if not exists leave_requests_staff_idx on app_data.leave_requests (staff_id, from_date desc);
create index if not exists leave_requests_tenant_status_idx on app_data.leave_requests (tenant_id, status) where archived = false;

-- 1.3 leave_balances
create table if not exists app_data.leave_balances (
  leave_balance_id            uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  staff_id                    uuid not null references app_data.staff(staff_id) on delete restrict,
  al_balance_hours            numeric(6,2) not null default 0,
  sick_balance_hours          numeric(6,2) not null default 0,
  long_service_balance_hours  numeric(6,2) not null default 0,
  personal_balance_hours      numeric(6,2) not null default 0,
  notes                       text null,
  updated_by_user_id          uuid null references shell_control.users(id) on delete set null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists leave_balances_staff_uq on app_data.leave_balances (tenant_id, staff_id);

-- 1.4 checkins
create table if not exists app_data.checkins (
  checkin_id            uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  staff_id              uuid not null references app_data.staff(staff_id) on delete restrict,
  site_id               uuid null references app_data.sites(site_id) on delete set null,
  week                  text null,
  checked_in_at         timestamptz not null default now(),
  latitude              numeric(10,7) null,
  longitude             numeric(10,7) null,
  device_id             text null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null
);
create index if not exists checkins_staff_idx on app_data.checkins (staff_id, checked_in_at desc);
create index if not exists checkins_site_idx on app_data.checkins (site_id, checked_in_at desc) where site_id is not null;

-- 1.5 tenant_app_configs (Field-specific tenant toggles per Decision 4)
create table if not exists app_data.tenant_app_configs (
  config_id             uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  feature_flags         jsonb not null default '{}'::jsonb,
  field_settings        jsonb not null default '{}'::jsonb,
  notes                 text null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists tenant_app_configs_tenant_uq on app_data.tenant_app_configs (tenant_id);

-- ============================================================================
-- GROUP 2: TENDER CLUSTER
-- ============================================================================

-- 2.1 tenders
create table if not exists app_data.tenders (
  tender_id             uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  tender_number         text null,
  external_id           text null,
  title                 text not null,
  client_name           text null,
  customer_id           uuid null references app_data.customers(customer_id) on delete set null,
  stage                 text not null default 'watch',
  estimated_value_cents bigint null,
  close_date            date null,
  department            text null,
  estimator_user_id     uuid null references shell_control.users(id) on delete set null,
  scope_summary         text null,
  notes                 text null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid null, updated_by uuid null,
  constraint tender_stage_check check (stage in ('watch','confirmed','likely','won','lost','withdrawn')),
  constraint tender_value_non_negative check (estimated_value_cents is null or estimated_value_cents >= 0)
);
create index if not exists tenders_tenant_stage_idx on app_data.tenders (tenant_id, stage, close_date);
create index if not exists tenders_close_date_idx on app_data.tenders (close_date) where close_date is not null;

-- 2.2 tender_enrichments
create table if not exists app_data.tender_enrichments (
  enrichment_id         uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  tender_id             uuid not null references app_data.tenders(tender_id) on delete cascade,
  source                text null,
  source_url            text null,
  content               jsonb null,
  attachments           jsonb null,
  notes                 text null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(),
  created_by uuid null
);
create index if not exists tender_enrichments_tender_idx on app_data.tender_enrichments (tender_id);

-- 2.3 tender_nominations
create table if not exists app_data.tender_nominations (
  nomination_id         uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  tender_id             uuid not null references app_data.tenders(tender_id) on delete cascade,
  staff_id              uuid null references app_data.staff(staff_id) on delete set null,
  role                  text null,
  nominated_by_user_id  uuid null references shell_control.users(id) on delete set null,
  start_date            date null,
  end_date              date null,
  notes                 text null,
  status                text not null default 'proposed',
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint tender_nomination_status_check check (status in ('proposed','confirmed','withdrawn','clashed'))
);
create index if not exists tender_nominations_tender_idx on app_data.tender_nominations (tender_id);
create index if not exists tender_nominations_staff_idx on app_data.tender_nominations (staff_id, start_date) where staff_id is not null;

-- 2.4 tender_nomination_clashes (view) — identifies overlapping nominations
create or replace view app_data.tender_nomination_clashes as
select
  a.nomination_id as nomination_a_id,
  b.nomination_id as nomination_b_id,
  a.staff_id,
  a.tender_id as tender_a_id,
  b.tender_id as tender_b_id,
  greatest(a.start_date, b.start_date) as overlap_start,
  least(a.end_date, b.end_date) as overlap_end,
  a.tenant_id
from app_data.tender_nominations a
join app_data.tender_nominations b
  on a.staff_id = b.staff_id
 and a.tenant_id = b.tenant_id
 and a.nomination_id < b.nomination_id
 and a.start_date is not null and b.start_date is not null
 and a.end_date is not null and b.end_date is not null
 and a.start_date <= b.end_date and b.start_date <= a.end_date
 and a.status not in ('withdrawn')
 and b.status not in ('withdrawn');

-- 2.5 tender_import_runs
create table if not exists app_data.tender_import_runs (
  import_run_id         uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  source_filename       text not null,
  rows_processed        int not null default 0,
  rows_created          int not null default 0,
  rows_updated          int not null default 0,
  rows_skipped          int not null default 0,
  status                text not null default 'completed',
  error_message         text null,
  started_at            timestamptz not null default now(),
  completed_at          timestamptz null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  constraint tir_status_check check (status in ('running','completed','failed'))
);
create index if not exists tender_import_runs_tenant_idx on app_data.tender_import_runs (tenant_id, started_at desc);

-- 2.6 tender_review_decisions
create table if not exists app_data.tender_review_decisions (
  decision_id           uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  tender_id             uuid not null references app_data.tenders(tender_id) on delete cascade,
  review_date           date not null,
  decision              text not null,
  rationale             text null,
  decided_by_user_id    uuid null references shell_control.users(id) on delete set null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(),
  constraint trd_decision_check check (decision in ('keep_watching','escalate','bid','pass','park'))
);
create index if not exists tender_review_decisions_tender_idx on app_data.tender_review_decisions (tender_id, review_date desc);

-- ============================================================================
-- GROUP 3: SITE REPORTS V2
-- ============================================================================

-- 3.1 site_diaries (full shift picture per site — mirrors Field's site_diaries v1)
create table if not exists app_data.site_diaries (
  site_diary_id         uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  site_id               uuid not null references app_data.sites(site_id) on delete restrict,
  diary_date            date not null,
  shift_type            text null,
  start_time            time null,
  end_time              time null,
  supervisor_name       text null,
  supervisor_user_id    uuid null references shell_control.users(id) on delete set null,
  subcontractor         text null,
  weather               jsonb not null default '{}'::jsonb,
  work_areas            jsonb not null default '[]'::jsonb,
  delays                jsonb not null default '[]'::jsonb,
  incidents             jsonb not null default '[]'::jsonb,
  visitors              jsonb not null default '[]'::jsonb,
  materials_received    text null,
  equipment_status      text null,
  notes                 text null,
  attendance            jsonb not null default '[]'::jsonb,
  photo_paths           jsonb not null default '[]'::jsonb,
  status                text not null default 'draft',
  submitted_at          timestamptz null,
  submitted_by_user_id  uuid null references shell_control.users(id) on delete set null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid null, updated_by uuid null,
  constraint site_diary_status_check check (status in ('draft','submitted')),
  constraint site_diary_shift_check check (shift_type is null or shift_type in ('day','night','split'))
);
create index if not exists site_diaries_tenant_date_idx on app_data.site_diaries (tenant_id, diary_date desc);
create index if not exists site_diaries_site_date_idx on app_data.site_diaries (site_id, diary_date desc);

-- 3.2 weekly_reports (placeholder — Field's actual Weekly Report build is gated on Diary usage signal)
create table if not exists app_data.weekly_reports (
  weekly_report_id      uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  site_id               uuid not null references app_data.sites(site_id) on delete restrict,
  week_ending_date      date not null,
  hseq_metrics          jsonb not null default '{}'::jsonb,
  itp_summary           jsonb not null default '[]'::jsonb,
  hold_points           jsonb not null default '[]'::jsonb,
  rfis                  jsonb not null default '[]'::jsonb,
  progress_summary      text null,
  next_week_focus       text null,
  notes                 text null,
  attendance_summary    jsonb not null default '{}'::jsonb,
  status                text not null default 'draft',
  submitted_at          timestamptz null,
  submitted_by_user_id  uuid null references shell_control.users(id) on delete set null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid null, updated_by uuid null,
  constraint weekly_report_status_check check (status in ('draft','submitted'))
);
create unique index if not exists weekly_reports_site_week_uq on app_data.weekly_reports (site_id, week_ending_date);

-- ============================================================================
-- GROUP 4: APPRENTICE CLUSTER
-- ============================================================================

-- 4.1 apprentice_profiles
create table if not exists app_data.apprentice_profiles (
  apprentice_profile_id uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  staff_id              uuid not null references app_data.staff(staff_id) on delete restrict,
  trade                 text null,
  year_level            smallint null,
  tafe_provider         text null,
  rto_code              text null,
  mentor_user_id        uuid null references shell_control.users(id) on delete set null,
  buddy_staff_id        uuid null references app_data.staff(staff_id) on delete set null,
  start_date            date null,
  expected_completion   date null,
  notes                 text null,
  active                boolean not null default true,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint apprentice_year_level_check check (year_level is null or year_level between 1 and 4)
);
create unique index if not exists apprentice_profiles_staff_uq on app_data.apprentice_profiles (staff_id);

-- 4.2 skills_ratings
create table if not exists app_data.skills_ratings (
  skills_rating_id      uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  apprentice_profile_id uuid not null references app_data.apprentice_profiles(apprentice_profile_id) on delete cascade,
  skill_name            text not null,
  rating                smallint not null,
  rated_by_user_id      uuid null references shell_control.users(id) on delete set null,
  rated_at              timestamptz not null default now(),
  notes                 text null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  constraint skills_rating_range_check check (rating between 1 and 5)
);
create index if not exists skills_ratings_apprentice_idx on app_data.skills_ratings (apprentice_profile_id, rated_at desc);

-- 4.3 feedback_entries
create table if not exists app_data.feedback_entries (
  feedback_entry_id     uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  apprentice_profile_id uuid not null references app_data.apprentice_profiles(apprentice_profile_id) on delete cascade,
  feedback_text         text not null,
  feedback_type         text null,
  from_user_id          uuid null references shell_control.users(id) on delete set null,
  occurred_at           timestamptz not null default now(),
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  constraint feedback_type_check check (feedback_type is null or feedback_type in ('positive','constructive','incident','observation'))
);
create index if not exists feedback_entries_apprentice_idx on app_data.feedback_entries (apprentice_profile_id, occurred_at desc);

-- 4.4 rotations
create table if not exists app_data.rotations (
  rotation_id           uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  apprentice_profile_id uuid not null references app_data.apprentice_profiles(apprentice_profile_id) on delete cascade,
  site_id               uuid null references app_data.sites(site_id) on delete set null,
  focus                 text null,
  start_date            date not null,
  end_date              date null,
  outcome_notes         text null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now()
);
create index if not exists rotations_apprentice_idx on app_data.rotations (apprentice_profile_id, start_date desc);

-- 4.5 buddy_checkins
create table if not exists app_data.buddy_checkins (
  buddy_checkin_id      uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  apprentice_profile_id uuid not null references app_data.apprentice_profiles(apprentice_profile_id) on delete cascade,
  buddy_staff_id        uuid null references app_data.staff(staff_id) on delete set null,
  checked_in_at         timestamptz not null default now(),
  notes                 text null,
  rating                smallint null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  constraint buddy_checkin_rating_check check (rating is null or rating between 1 and 5)
);
create index if not exists buddy_checkins_apprentice_idx on app_data.buddy_checkins (apprentice_profile_id, checked_in_at desc);

-- 4.6 quarterly_reviews
create table if not exists app_data.quarterly_reviews (
  quarterly_review_id   uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  apprentice_profile_id uuid not null references app_data.apprentice_profiles(apprentice_profile_id) on delete cascade,
  quarter               smallint not null,
  year                  smallint not null,
  reviewer_user_id      uuid null references shell_control.users(id) on delete set null,
  content               jsonb not null default '{}'::jsonb,
  outcome               text null,
  decided_at            timestamptz null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(),
  constraint qr_quarter_check check (quarter between 1 and 4),
  constraint qr_year_check check (year between 2020 and 2099),
  constraint qr_outcome_check check (outcome is null or outcome in ('on_track','at_risk','needs_intervention','complete'))
);
create unique index if not exists quarterly_reviews_apprentice_qy_uq on app_data.quarterly_reviews (apprentice_profile_id, year, quarter);

-- 4.7 engagement_logs
create table if not exists app_data.engagement_logs (
  engagement_log_id     uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  apprentice_profile_id uuid not null references app_data.apprentice_profiles(apprentice_profile_id) on delete cascade,
  event_type            text not null,
  event_summary         text null,
  occurred_at           timestamptz not null default now(),
  recorded_by_user_id   uuid null references shell_control.users(id) on delete set null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null
);
create index if not exists engagement_logs_apprentice_idx on app_data.engagement_logs (apprentice_profile_id, occurred_at desc);

-- 4.8 tafe_calendars
create table if not exists app_data.tafe_calendars (
  tafe_calendar_id      uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  year                  smallint not null,
  trade                 text null,
  year_level            smallint null,
  term_dates            jsonb not null default '[]'::jsonb,
  public_holidays       jsonb not null default '[]'::jsonb,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  created_at timestamptz not null default now(),
  constraint tafe_year_check check (year between 2020 and 2099),
  constraint tafe_year_level_check check (year_level is null or year_level between 1 and 4)
);

-- ============================================================================
-- GROUP 5: WORKFLOW EVENT LOGS (per 2026-05-20 audit-log hybrid Q4 decision)
-- ============================================================================

-- 5.1 schedule_change_logs
create table if not exists app_data.schedule_change_logs (
  log_id                uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  schedule_id           uuid null references app_data.schedule_entries(schedule_id) on delete set null,
  staff_id              uuid null references app_data.staff(staff_id) on delete set null,
  site_id               uuid null references app_data.sites(site_id) on delete set null,
  change_type           text not null,
  old_value             jsonb null,
  new_value             jsonb null,
  changed_by_user_id    uuid null references shell_control.users(id) on delete set null,
  changed_at            timestamptz not null default now(),
  reason                text null,
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  constraint schedule_change_type_check check (change_type in ('created','staff_changed','site_changed','date_changed','hours_changed','status_changed','deleted','reassigned'))
);
create index if not exists schedule_change_logs_schedule_idx on app_data.schedule_change_logs (schedule_id, changed_at desc) where schedule_id is not null;

-- 5.2 leave_approval_logs
create table if not exists app_data.leave_approval_logs (
  log_id                uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null default (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid,
  leave_request_id      uuid not null references app_data.leave_requests(leave_request_id) on delete cascade,
  from_status           text null,
  to_status             text not null,
  decided_by_user_id    uuid null references shell_control.users(id) on delete set null,
  decision_notes        text null,
  decided_at            timestamptz not null default now(),
  imported_at timestamptz null, imported_from text null, intake_id uuid null, schema_version text null,
  constraint leave_approval_log_status_check check (to_status in ('pending','approved','rejected','cancelled'))
);
create index if not exists leave_approval_logs_request_idx on app_data.leave_approval_logs (leave_request_id, decided_at desc);

-- ============================================================================
-- updated_at triggers
-- ============================================================================

do $$
declare t text;
declare tables_with_updated_at text[] := array[
  'timesheets','leave_requests','leave_balances','tenant_app_configs',
  'tenders','tender_nominations','site_diaries','weekly_reports',
  'apprentice_profiles'
];
begin
  foreach t in array tables_with_updated_at loop
    execute format('drop trigger if exists trg_%I_updated_at on app_data.%I', t, t);
    execute format('create trigger trg_%I_updated_at before update on app_data.%I for each row execute function app_data._set_updated_at()', t, t);
  end loop;
end $$;

-- ============================================================================
-- RLS: enable + tenant-scoped policies for all new tables
-- ============================================================================

do $$
declare t text;
declare field_tables text[] := array[
  'timesheets','leave_requests','leave_balances','checkins','tenant_app_configs',
  'tenders','tender_enrichments','tender_nominations','tender_import_runs','tender_review_decisions',
  'site_diaries','weekly_reports',
  'apprentice_profiles','skills_ratings','feedback_entries','rotations','buddy_checkins','quarterly_reviews','engagement_logs','tafe_calendars',
  'schedule_change_logs','leave_approval_logs'
];
declare pn text;
begin
  foreach t in array field_tables loop
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

-- ============================================================================
-- Register schemas in eq_schema_registry (placeholders; JSON files in @eq/schemas)
-- ============================================================================

insert into shell_control.eq_schema_registry (entity, module, version, schema_json, description, is_current) values
  ('timesheet', 'field', '1.0.0', '{"x-eq-entity":"timesheet","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Worked hours per staff member per day."}'::jsonb, 'Worked hours per staff member per day.', true),
  ('leave_request', 'field', '1.0.0', '{"x-eq-entity":"leave_request","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Staff leave request with approval workflow."}'::jsonb, 'Staff leave request.', true),
  ('leave_balance', 'field', '1.0.0', '{"x-eq-entity":"leave_balance","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Per-staff annual / sick / long-service leave balances."}'::jsonb, 'Leave balances.', true),
  ('checkin', 'field', '1.0.0', '{"x-eq-entity":"checkin","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Site check-in with optional GPS."}'::jsonb, 'Site check-in.', true),
  ('tenant_app_config', 'field', '1.0.0', '{"x-eq-entity":"tenant_app_config","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Field-specific tenant feature flags + settings."}'::jsonb, 'Tenant app config.', true),
  ('tender', 'field', '1.0.0', '{"x-eq-entity":"tender","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Tender pipeline opportunity."}'::jsonb, 'Tender opportunity.', true),
  ('tender_enrichment', 'field', '1.0.0', '{"x-eq-entity":"tender_enrichment","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Supplementary tender data."}'::jsonb, 'Tender enrichment.', true),
  ('tender_nomination', 'field', '1.0.0', '{"x-eq-entity":"tender_nomination","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Staff nominated for a tender."}'::jsonb, 'Tender nomination.', true),
  ('tender_import_run', 'field', '1.0.0', '{"x-eq-entity":"tender_import_run","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Tender CSV import audit."}'::jsonb, 'Tender import run.', true),
  ('tender_review_decision', 'field', '1.0.0', '{"x-eq-entity":"tender_review_decision","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Fortnightly tender review decision."}'::jsonb, 'Tender review decision.', true),
  ('site_diary', 'field', '1.0.0', '{"x-eq-entity":"site_diary","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Daily site diary."}'::jsonb, 'Site diary.', true),
  ('weekly_report', 'field', '1.0.0', '{"x-eq-entity":"weekly_report","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Weekly site report (placeholder shape)."}'::jsonb, 'Weekly report.', true),
  ('apprentice_profile', 'field', '1.0.0', '{"x-eq-entity":"apprentice_profile","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Apprentice extension of a staff record."}'::jsonb, 'Apprentice profile.', true),
  ('skills_rating', 'field', '1.0.0', '{"x-eq-entity":"skills_rating","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Skills rating for an apprentice (1-5)."}'::jsonb, 'Skills rating.', true),
  ('feedback_entry', 'field', '1.0.0', '{"x-eq-entity":"feedback_entry","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Feedback for an apprentice."}'::jsonb, 'Feedback entry.', true),
  ('rotation', 'field', '1.0.0', '{"x-eq-entity":"rotation","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Apprentice site rotation."}'::jsonb, 'Rotation.', true),
  ('buddy_checkin', 'field', '1.0.0', '{"x-eq-entity":"buddy_checkin","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Apprentice buddy check-in."}'::jsonb, 'Buddy check-in.', true),
  ('quarterly_review', 'field', '1.0.0', '{"x-eq-entity":"quarterly_review","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Apprentice quarterly review."}'::jsonb, 'Quarterly review.', true),
  ('engagement_log', 'field', '1.0.0', '{"x-eq-entity":"engagement_log","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Apprentice engagement event log."}'::jsonb, 'Engagement log.', true),
  ('tafe_calendar', 'field', '1.0.0', '{"x-eq-entity":"tafe_calendar","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"TAFE term dates + public holidays per trade/year."}'::jsonb, 'TAFE calendar.', true),
  ('schedule_change_log', 'field', '1.0.0', '{"x-eq-entity":"schedule_change_log","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Schedule change workflow audit log."}'::jsonb, 'Schedule change log.', true),
  ('leave_approval_log', 'field', '1.0.0', '{"x-eq-entity":"leave_approval_log","x-eq-module":"field","x-eq-version":"1.0.0","type":"object","description":"Leave approval workflow audit log."}'::jsonb, 'Leave approval log.', true)
on conflict (entity, version) do update set
  schema_json = excluded.schema_json, description = excluded.description, module = excluded.module;
