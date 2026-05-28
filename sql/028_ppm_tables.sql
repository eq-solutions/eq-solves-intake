-- ============================================================================
-- 028 — PPM tables: service_visit, service_task_completion, asset_test_result, asset_defect
-- ============================================================================
-- These four tables close the PPM loop for SKS NSW operations:
--
--   service_visit           — a crew day at a site (replaces hand-built SOW + schedule)
--   service_task_completion — one tickbox per asset × task per visit (replaces SOW grid)
--   asset_test_result       — compliance test record that "Last Thermal" is derived from
--   asset_defect            — open issue against an asset (source of defects_summary)
--
-- Schema registry entries are added so the intake engine can validate imports
-- against these entity types.
--
-- All tables:
--   - Scoped by tenant_id (RLS)
--   - Upsert-safe on (tenant_id, external_id) partial index
--   - Indexed for the most-common queries (site + date, asset + date)
-- ============================================================================

SET search_path = app_data, public, extensions;

-- ── asset: add columns introduced in Phase 1 that were missing from root schema ──
-- condition, ppm_frequency, defects_summary, client_classification
-- These are additive — safe to run against an existing assets table.

ALTER TABLE app_data.assets
  ADD COLUMN IF NOT EXISTS condition            varchar(32)  DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS ppm_frequency        varchar(100),
  ADD COLUMN IF NOT EXISTS defects_summary      varchar(500),
  ADD COLUMN IF NOT EXISTS client_classification jsonb;

DROP CONSTRAINT IF EXISTS assets_condition_check ON app_data.assets;
ALTER TABLE app_data.assets
  ADD CONSTRAINT assets_condition_check
    CHECK (condition IN ('good','fair','poor','needs_replacement','unknown'));

-- ============================================================================
-- service_visits
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_data.service_visits (
  visit_id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid         NOT NULL,
  external_id           varchar(64),
  site_id               uuid         NOT NULL REFERENCES app_data.sites(site_id),
  service_contract_id   uuid         REFERENCES app_data.service_contracts(contract_id),
  scheduled_date        date         NOT NULL,
  actual_date           date,
  crew_lead_id          uuid         REFERENCES app_data.staff(staff_id),
  client_job_code       varchar(100),
  status                varchar(32)  NOT NULL DEFAULT 'planned',
  expected_assets       integer,
  expected_circuits     integer,
  logistics_notes       text,
  intake_id             uuid,
  imported_at           timestamptz  DEFAULT now(),
  imported_from         text,
  created_at            timestamptz  DEFAULT now(),
  updated_at            timestamptz  DEFAULT now()
);

ALTER TABLE app_data.service_visits
  DROP CONSTRAINT IF EXISTS service_visits_status_check;
ALTER TABLE app_data.service_visits
  ADD CONSTRAINT service_visits_status_check
    CHECK (status IN ('planned','in_progress','complete','cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS service_visits_tenant_external_id_uidx
  ON app_data.service_visits(tenant_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS service_visits_site_date_idx
  ON app_data.service_visits(tenant_id, site_id, scheduled_date);

CREATE INDEX IF NOT EXISTS service_visits_tenant_status_idx
  ON app_data.service_visits(tenant_id, status, scheduled_date);

-- RLS
ALTER TABLE app_data.service_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_visits_tenant_isolation ON app_data.service_visits;
CREATE POLICY service_visits_tenant_isolation ON app_data.service_visits
  USING (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

-- ============================================================================
-- service_task_completions
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_data.service_task_completions (
  completion_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL,
  visit_id       uuid        NOT NULL REFERENCES app_data.service_visits(visit_id),
  asset_id       uuid        NOT NULL REFERENCES app_data.assets(asset_id),
  task_type      varchar(100) NOT NULL,
  completed      boolean     NOT NULL DEFAULT false,
  completed_at   timestamptz,
  tech_id        uuid        REFERENCES app_data.staff(staff_id),
  result         varchar(32),
  notes          text,
  intake_id      uuid,
  imported_at    timestamptz DEFAULT now(),
  imported_from  text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

ALTER TABLE app_data.service_task_completions
  DROP CONSTRAINT IF EXISTS service_task_completions_result_check;
ALTER TABLE app_data.service_task_completions
  ADD CONSTRAINT service_task_completions_result_check
    CHECK (result IS NULL OR result IN ('pass','fail','partial','not_applicable','deferred'));

CREATE INDEX IF NOT EXISTS service_task_completions_visit_idx
  ON app_data.service_task_completions(tenant_id, visit_id);

CREATE INDEX IF NOT EXISTS service_task_completions_asset_idx
  ON app_data.service_task_completions(tenant_id, asset_id, completed_at DESC);

-- Prevent double-booking the same task on the same asset in the same visit
CREATE UNIQUE INDEX IF NOT EXISTS service_task_completions_visit_asset_task_uidx
  ON app_data.service_task_completions(visit_id, asset_id, task_type);

-- RLS
ALTER TABLE app_data.service_task_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_task_completions_tenant_isolation ON app_data.service_task_completions;
CREATE POLICY service_task_completions_tenant_isolation ON app_data.service_task_completions
  USING (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

-- ============================================================================
-- asset_test_results
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_data.asset_test_results (
  result_id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid         NOT NULL,
  external_id          varchar(64),
  asset_id             uuid         NOT NULL REFERENCES app_data.assets(asset_id),
  visit_id             uuid         REFERENCES app_data.service_visits(visit_id),
  test_type            varchar(100) NOT NULL,
  test_date            date         NOT NULL,
  tested_by_id         uuid         REFERENCES app_data.staff(staff_id),
  tested_by_external   varchar(200),
  licence_number       varchar(64),
  pass_fail            varchar(32)  NOT NULL,
  raw_values           jsonb,
  action_taken_if_fail text,
  test_cert_reference  varchar(100),
  signature_attached   text,
  notes                text,
  intake_id            uuid,
  imported_at          timestamptz  DEFAULT now(),
  imported_from        text,
  created_at           timestamptz  DEFAULT now(),
  updated_at           timestamptz  DEFAULT now()
);

ALTER TABLE app_data.asset_test_results
  DROP CONSTRAINT IF EXISTS asset_test_results_pass_fail_check;
ALTER TABLE app_data.asset_test_results
  ADD CONSTRAINT asset_test_results_pass_fail_check
    CHECK (pass_fail IN ('pass','fail','partial','inconclusive'));

CREATE UNIQUE INDEX IF NOT EXISTS asset_test_results_tenant_external_id_uidx
  ON app_data.asset_test_results(tenant_id, external_id)
  WHERE external_id IS NOT NULL;

-- Primary query: history for an asset, most recent first
CREATE INDEX IF NOT EXISTS asset_test_results_asset_date_idx
  ON app_data.asset_test_results(tenant_id, asset_id, test_date DESC);

-- Derive "last X test" per asset
CREATE INDEX IF NOT EXISTS asset_test_results_asset_type_date_idx
  ON app_data.asset_test_results(tenant_id, asset_id, test_type, test_date DESC);

-- RLS
ALTER TABLE app_data.asset_test_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asset_test_results_tenant_isolation ON app_data.asset_test_results;
CREATE POLICY asset_test_results_tenant_isolation ON app_data.asset_test_results
  USING (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

-- ============================================================================
-- asset_defects
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_data.asset_defects (
  defect_id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid         NOT NULL,
  external_id        varchar(64),
  asset_id           uuid         NOT NULL REFERENCES app_data.assets(asset_id),
  visit_id           uuid         REFERENCES app_data.service_visits(visit_id),
  raised_date        date         NOT NULL,
  raised_by_id       uuid         REFERENCES app_data.staff(staff_id),
  severity           varchar(32)  NOT NULL,
  description        text         NOT NULL,
  status             varchar(32)  NOT NULL DEFAULT 'open',
  resolution_date    date,
  resolved_by_id     uuid         REFERENCES app_data.staff(staff_id),
  resolution_notes   text,
  estimated_cost     numeric(12,2),
  actual_cost        numeric(12,2),
  photo_attachments  jsonb        DEFAULT '[]'::jsonb,
  intake_id          uuid,
  imported_at        timestamptz  DEFAULT now(),
  imported_from      text,
  created_at         timestamptz  DEFAULT now(),
  updated_at         timestamptz  DEFAULT now()
);

ALTER TABLE app_data.asset_defects
  DROP CONSTRAINT IF EXISTS asset_defects_severity_check;
ALTER TABLE app_data.asset_defects
  ADD CONSTRAINT asset_defects_severity_check
    CHECK (severity IN ('critical','high','medium','low'));

ALTER TABLE app_data.asset_defects
  DROP CONSTRAINT IF EXISTS asset_defects_status_check;
ALTER TABLE app_data.asset_defects
  ADD CONSTRAINT asset_defects_status_check
    CHECK (status IN ('open','in_progress','resolved','deferred','no_action'));

CREATE UNIQUE INDEX IF NOT EXISTS asset_defects_tenant_external_id_uidx
  ON app_data.asset_defects(tenant_id, external_id)
  WHERE external_id IS NOT NULL;

-- Open defects per asset (the most common UI query)
CREATE INDEX IF NOT EXISTS asset_defects_asset_status_idx
  ON app_data.asset_defects(tenant_id, asset_id, status, raised_date DESC);

-- All open/critical defects across a tenant (dashboard query)
CREATE INDEX IF NOT EXISTS asset_defects_tenant_severity_status_idx
  ON app_data.asset_defects(tenant_id, severity, status, raised_date DESC);

-- RLS
ALTER TABLE app_data.asset_defects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asset_defects_tenant_isolation ON app_data.asset_defects;
CREATE POLICY asset_defects_tenant_isolation ON app_data.asset_defects
  USING (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid);

-- ============================================================================
-- Schema registry entries
-- ============================================================================
-- Registers the new schemas so the intake engine's schema-version checks pass.
-- Deactivates any previous current version for each entity first (belt-and-suspenders).

UPDATE app_data.eq_schema_registry
  SET is_current = false
  WHERE entity IN ('service_visit','service_task_completion','asset_test_result','asset_defect');

INSERT INTO app_data.eq_schema_registry
  (entity, version, schema_id, is_current, published_at)
VALUES
  ('service_visit',           '1.0.0', 'https://schemas.eq.solutions/service/service_visit/v1.json',           true, now()),
  ('service_task_completion', '1.0.0', 'https://schemas.eq.solutions/service/service_task_completion/v1.json', true, now()),
  ('asset_test_result',       '1.0.0', 'https://schemas.eq.solutions/service/asset_test_result/v1.json',       true, now()),
  ('asset_defect',            '1.0.0', 'https://schemas.eq.solutions/service/asset_defect/v1.json',            true, now())
ON CONFLICT (entity, version) DO UPDATE
  SET is_current = EXCLUDED.is_current,
      published_at = EXCLUDED.published_at;
