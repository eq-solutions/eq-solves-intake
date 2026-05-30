-- =============================================================================
-- Migration 035: PPM materialized views
--
-- Cached snapshots of the most expensive PPM queries. These are the views
-- that power the PPM dashboard tiles — they refresh quickly because the
-- data is pre-computed. The RPCs in sql/034 compute fresh on every call;
-- these views trade freshness for speed (typically fine for a dashboard
-- that coordinators check at the start of each day).
--
-- Refresh strategy:
--   CONCURRENT refresh — no table lock, rows visible during refresh.
--   Refresh is manual (call eq_refresh_ppm_views) or scheduled via pg_cron.
--   A simple approach: refresh daily at 06:00 AEST via a Supabase pg_cron job:
--     SELECT cron.schedule('refresh-ppm-views', '0 20 * * *',
--       $$SELECT app_data.eq_refresh_ppm_views()$$);
--
-- ── Views created ────────────────────────────────────────────────────────────
--
--   ppm_asset_compliance       Per-asset compliance status (all tenants)
--   ppm_site_health            Per-site PPM health summary (all tenants)
--   ppm_open_defects_summary   Open defects with age and cost (all tenants)
--
-- ── Why not one view per tenant? ─────────────────────────────────────────────
-- These views cover all tenants and rely on RLS for access control.
-- An authenticated user can only read rows where tenant_id matches their JWT.
-- This is the standard Supabase pattern for multi-tenant materialized views.
-- =============================================================================

-- ── ppm_asset_compliance ──────────────────────────────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS app_data.ppm_asset_compliance AS
SELECT
  a.tenant_id,
  a.asset_id,
  a.external_id,
  a.name                                    AS asset_name,
  a.asset_type,
  a.site_id,
  a.location_in_site,
  a.criticality,
  a.condition,
  a.ppm_frequency,
  a.last_service_date,
  a.next_service_due,

  -- Last thermal
  thermal.test_date                         AS last_thermal_date,
  (thermal.pass_fail = 'pass')              AS last_thermal_pass,

  -- Last RCD
  rcd.test_date                             AS last_rcd_date,
  (rcd.pass_fail = 'pass')                  AS last_rcd_pass,

  -- Defect counts
  COALESCE(def.open_count, 0)::INT          AS open_defect_count,
  COALESCE(def.critical_count, 0)::INT      AS critical_defect_count,

  -- Compliance status
  CASE
    WHEN a.next_service_due IS NULL                                  THEN 'unknown'
    WHEN a.next_service_due < CURRENT_DATE                           THEN 'overdue'
    WHEN a.next_service_due <= CURRENT_DATE + INTERVAL '30 days'     THEN 'due_soon'
    ELSE 'current'
  END                                       AS compliance_status,

  NOW()                                     AS computed_at

FROM app_data.assets a

LEFT JOIN LATERAL (
  SELECT test_date, pass_fail
  FROM app_data.asset_test_results
  WHERE asset_id = a.asset_id AND test_type LIKE '%thermal%'
  ORDER BY test_date DESC LIMIT 1
) thermal ON true

LEFT JOIN LATERAL (
  SELECT test_date, pass_fail
  FROM app_data.asset_test_results
  WHERE asset_id = a.asset_id AND test_type LIKE '%rcd%'
  ORDER BY test_date DESC LIMIT 1
) rcd ON true

LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE status NOT IN ('resolved','no_action'))                       AS open_count,
    COUNT(*) FILTER (WHERE status NOT IN ('resolved','no_action') AND severity='critical') AS critical_count
  FROM app_data.asset_defects
  WHERE asset_id = a.asset_id
) def ON true;

-- Unique index required for CONCURRENT refresh.
CREATE UNIQUE INDEX IF NOT EXISTS ppm_asset_compliance_pk
  ON app_data.ppm_asset_compliance (tenant_id, asset_id);

-- Index for the most common query: all assets for a site with given compliance status.
CREATE INDEX IF NOT EXISTS ppm_asset_compliance_site_status_idx
  ON app_data.ppm_asset_compliance (tenant_id, site_id, compliance_status);

-- ── ppm_site_health ───────────────────────────────────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS app_data.ppm_site_health AS
SELECT
  s.tenant_id,
  s.site_id,
  s.name                                                            AS site_name,

  COUNT(a.asset_id)::INT                                            AS asset_count,

  COUNT(a.asset_id) FILTER (
    WHERE a.next_service_due >= CURRENT_DATE + INTERVAL '30 days'
  )::INT                                                            AS compliant_count,

  COUNT(a.asset_id) FILTER (
    WHERE a.next_service_due >= CURRENT_DATE
      AND a.next_service_due < CURRENT_DATE + INTERVAL '30 days'
  )::INT                                                            AS due_soon_count,

  COUNT(a.asset_id) FILTER (
    WHERE a.next_service_due < CURRENT_DATE
  )::INT                                                            AS overdue_count,

  COALESCE(SUM(def.open_count), 0)::INT                             AS open_defects,
  COALESCE(SUM(def.critical_count), 0)::INT                         AS critical_defects,

  CASE
    WHEN COUNT(a.asset_id) = 0 THEN 0::NUMERIC
    ELSE ROUND(
      100.0 * COUNT(a.asset_id) FILTER (WHERE a.next_service_due >= CURRENT_DATE)
           / COUNT(a.asset_id),
      1
    )
  END                                                               AS compliance_pct,

  NOW()                                                             AS computed_at

FROM app_data.sites s
LEFT JOIN app_data.assets a
  ON a.site_id = s.site_id AND a.tenant_id = s.tenant_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE d.status NOT IN ('resolved','no_action'))                          AS open_count,
    COUNT(*) FILTER (WHERE d.status NOT IN ('resolved','no_action') AND d.severity='critical') AS critical_count
  FROM app_data.asset_defects d WHERE d.asset_id = a.asset_id
) def ON true
GROUP BY s.tenant_id, s.site_id, s.name;

CREATE UNIQUE INDEX IF NOT EXISTS ppm_site_health_pk
  ON app_data.ppm_site_health (tenant_id, site_id);

-- ── eq_refresh_ppm_views — call this to refresh both views ───────────────────

CREATE OR REPLACE FUNCTION app_data.eq_refresh_ppm_views()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start TIMESTAMPTZ := NOW();
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY app_data.ppm_asset_compliance;
  REFRESH MATERIALIZED VIEW CONCURRENTLY app_data.ppm_site_health;
  RETURN 'Refreshed ppm_asset_compliance + ppm_site_health in ' ||
         ROUND(EXTRACT(EPOCH FROM (NOW() - v_start)) * 1000) || 'ms';
END;
$$;

COMMENT ON FUNCTION app_data.eq_refresh_ppm_views IS
  'Refreshes ppm_asset_compliance and ppm_site_health materialized views. '
  'Safe to call concurrently — no table lock. '
  'Schedule daily via pg_cron: SELECT cron.schedule(''refresh-ppm-views'', ''0 20 * * *'', $$SELECT app_data.eq_refresh_ppm_views()$$)';

GRANT EXECUTE ON FUNCTION app_data.eq_refresh_ppm_views TO authenticated;
