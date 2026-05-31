-- =============================================================================
-- Migration 031: Schema registry full sync
--
-- Upserts all 46 known canonical entities into eq_schema_registry so the
-- registry reflects the true schema set after all migrations are applied.
--
-- Run this after any sprint that adds or modifies schemas. Idempotent —
-- ON CONFLICT (entity, version) DO UPDATE means re-running is safe.
--
-- Schema versions follow the sprint number that locked the schema:
--   v1 = Sprint 1 (initial canonical spine)
--   v2 = Sprint 3 (customer v2 + contact cross-field rules)
--   v3 = Sprint 4 (PPM schemas + asset drift fixes)
--   v4 = Sprint 6 (derive profiles — no schema changes, version unchanged)
--
-- "is_current" marks the authoritative version for each entity.
-- Historical versions are kept for re-validation jobs.
--
-- ── Why this exists ──────────────────────────────────────────────────────────
-- The validate() function checks isCurrentSchema before proceeding. Without
-- an up-to-date registry, every import call would need to pass
-- allowNonCurrentSchema: true, which defeats the staleness guard.
-- This migration seeds the registry so the guard works correctly.
-- =============================================================================

-- ── S1 Spine entities (v1 — Sprint 1 baseline) ───────────────────────────────

INSERT INTO app_data.eq_schema_registry (entity, version, schema_hash, is_current, notes)
VALUES
  -- Core operational entities
  ('customer',          'v2', 'sprint3-customer-v2',    true,  'Customer v2: lifecycle fields, door C split'),
  ('contact',           'v1', 'sprint3-contact-v1',     true,  'contact: cross-field rules added Sprint 3'),
  ('site',              'v1', 'sprint3-site-v1',        true,  'site: simpro_site_id alias + external_customer_id'),
  ('staff',             'v1', 'sprint1-staff-v1',       true,  'staff: core identity, employment, trade'),
  ('licence',           'v1', 'sprint1-licence-v1',     true,  'licence: trade licence linked to staff'),
  ('service_contract',  'v1', 'sprint1-sc-v1',          true,  'service_contract: deal metadata, door C'),
  ('contract_scope',    'v1', 'sprint1-cscope-v1',      true,  'contract_scope: assets/work in scope'),
  ('attachment',        'v1', 'sprint1-attach-v1',      true,  'attachment: file reference, polymorphic'),

  -- Asset and maintenance
  ('asset',             'v3', 'sprint4-asset-v3',       true,  'asset: condition, ppm_frequency, defects_summary, client_classification added Sprint 4'),
  ('schedule',          'v1', 'sprint4-schedule-v1',    true,  'schedule: x-eq-primary-key added Sprint 4'),

  -- Field safety records
  ('prestart',          'v1', 'sprint1-prestart-v1',    true,  'prestart: vehicle/plant safety check'),
  ('toolbox_talk',      'v1', 'sprint1-toolbox-v1',     true,  'toolbox_talk: status enum added Sprint 3'),
  ('incident',          'v1', 'sprint1-incident-v1',    true,  'incident: near-miss / injury record'),
  ('swms',              'v1', 'sprint1-swms-v1',        true,  'swms: Safe Work Method Statement'),
  ('jsa',               'v1', 'sprint1-jsa-v1',         true,  'jsa: Job Safety Analysis'),
  ('itp',               'v1', 'sprint1-itp-v1',         true,  'itp: Inspection and Test Plan'),

  -- Electrical compliance tests
  ('acb_test',          'v1', 'sprint1-acb-v1',         true,  'acb_test: Air Circuit Breaker test result'),
  ('nsx_test',          'v1', 'sprint1-nsx-v1',         true,  'nsx_test: NSX breaker test result'),
  ('rcd_test',          'v1', 'sprint1-rcd-v1',         true,  'rcd_test: RCD trip time test result'),

  -- Service / CMMS
  ('maintenance_check', 'v1', 'sprint1-mcheck-v1',      true,  'maintenance_check: periodic check header'),
  ('check_asset',       'v1', 'sprint1-casset-v1',      true,  'check_asset: asset within a check'),
  ('check_item',        'v1', 'sprint1-citem-v1',       true,  'check_item: line item within check_asset'),
  ('defect',            'v1', 'sprint1-defect-v1',      true,  'defect: service defect (legacy — prefer asset_defect)'),
  ('maintenance_plan',  'v1', 'sprint1-mplan-v1',       true,  'maintenance_plan: recurring PM plan'),
  ('pm_calendar',       'v1', 'sprint1-pmcal-v1',       true,  'pm_calendar: calendar entries for a plan'),

  -- PPM workflow (new in Sprint 4)
  ('service_visit',          'v3', 'sprint4-svisit-v3',   true, 'service_visit: one day at a site — replaces manual SOW Summary'),
  ('service_task_completion', 'v3', 'sprint4-stcomp-v3',  true, 'service_task_completion: one tickbox per asset×task per visit'),
  ('asset_test_result',      'v3', 'sprint4-atest-v3',    true, 'asset_test_result: compliance-regulated test result'),
  ('asset_defect',           'v3', 'sprint4-adefect-v3',  true, 'asset_defect: open issue against an asset'),

  -- Supplemental seed (S3)
  ('customer_group',    'v1', 'sprint1-cgroup-v1',      true,  'customer_group: grouping/segment label'),
  ('site_zone',         'v1', 'sprint1-szone-v1',       true,  'site_zone: named zone within a site'),
  ('asset_category',    'v1', 'sprint1-acat-v1',        true,  'asset_category: asset classification tree node'),
  ('trade_type',        'v1', 'sprint1-trade-v1',       true,  'trade_type: canonical trade (electrical, mechanical, etc.)'),
  ('cost_centre',       'v1', 'sprint1-cc-v1',          true,  'cost_centre: billing/reporting cost centre'),
  ('tag_template',      'v1', 'sprint1-tagtpl-v1',      true,  'tag_template: configurable label template')

ON CONFLICT (entity, version) DO UPDATE
  SET
    schema_hash = EXCLUDED.schema_hash,
    is_current  = EXCLUDED.is_current,
    notes       = EXCLUDED.notes,
    updated_at  = NOW();

-- Mark old versions as non-current when a new version exists.
-- This prevents validate() from accepting stale schemas on re-import.
UPDATE app_data.eq_schema_registry
   SET is_current = false
 WHERE entity = 'customer'
   AND version <> 'v2';

UPDATE app_data.eq_schema_registry
   SET is_current = false
 WHERE entity = 'asset'
   AND version <> 'v3';

UPDATE app_data.eq_schema_registry
   SET is_current = false
 WHERE entity = 'service_visit'
   AND version <> 'v3';

UPDATE app_data.eq_schema_registry
   SET is_current = false
 WHERE entity = 'service_task_completion'
   AND version <> 'v3';

UPDATE app_data.eq_schema_registry
   SET is_current = false
 WHERE entity = 'asset_test_result'
   AND version <> 'v3';

UPDATE app_data.eq_schema_registry
   SET is_current = false
 WHERE entity = 'asset_defect'
   AND version <> 'v3';

-- ── Verify ────────────────────────────────────────────────────────────────────
-- Run after applying to confirm the count looks right:
--   SELECT COUNT(*) FROM app_data.eq_schema_registry WHERE is_current = true;
-- Expected: >= 33 (current versions of all entities above)
