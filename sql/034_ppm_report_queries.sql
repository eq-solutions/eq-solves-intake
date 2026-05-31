-- =============================================================================
-- Migration 034: PPM report RPCs
--
-- These are the computed views that flip the PPM workflow from manual to
-- automatic. Instead of a bookkeeper retyping "Last Thermal: 2026-05-01"
-- back into the register after every visit, these RPCs compute it from
-- what actually happened (asset_test_results, service_task_completions,
-- asset_defects).
--
-- ── RPCs added ───────────────────────────────────────────────────────────────
--
-- eq_ppm_asset_status(p_tenant_id, p_site_id?)
--   Per-asset PPM status snapshot. The "smart asset register" view.
--   Returns: asset details + last_thermal_date + last_rcd_date + last_service +
--            open_defect_count + criticality + next_due + compliance_status
--
-- eq_ppm_site_summary(p_tenant_id, p_site_id?)
--   Per-site PPM health. What percentage of assets are current? Any overdue?
--   Returns: site_id, asset_count, compliant_count, overdue_count,
--            open_critical_defects, next_visit_date
--
-- eq_ppm_overdue_assets(p_tenant_id, p_days_overdue?)
--   Assets where next_service_due has passed (or will pass in p_days_overdue).
--   Returns: asset, site, last_service, next_due, days_overdue, crew_lead
--
-- eq_ppm_open_defects(p_tenant_id, p_severity?)
--   Open defects, optionally filtered by severity.
--   Returns: defect details + asset + site + raised_by + age_days
--
-- eq_ppm_visit_completion_rate(p_tenant_id, p_from_date?, p_to_date?)
--   For each service visit in a date range: how many tasks were completed?
--   Returns: visit, site, scheduled tasks, completed tasks, completion_rate%
--
-- ── Usage from the UI ──────────────────────────────────────────────────────
-- These RPCs back the future EQ Service "PPM dashboard" module.
-- They can also be called from Supabase Studio directly for spot-checks.
-- =============================================================================

-- ── eq_ppm_asset_status ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_data.eq_ppm_asset_status(
  p_tenant_id UUID,
  p_site_id   UUID DEFAULT NULL
)
RETURNS TABLE (
  asset_id              UUID,
  external_id           TEXT,
  asset_name            TEXT,
  asset_type            TEXT,
  site_id               UUID,
  location_in_site      TEXT,
  criticality           TEXT,
  condition             TEXT,
  ppm_frequency         TEXT,
  last_service_date     DATE,
  next_service_due      DATE,
  last_thermal_date     DATE,
  last_thermal_pass     BOOLEAN,
  last_rcd_date         DATE,
  last_rcd_pass         BOOLEAN,
  open_defect_count     INT,
  critical_defect_count INT,
  compliance_status     TEXT    -- 'current' | 'overdue' | 'due_soon' | 'unknown'
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.asset_id,
    a.external_id,
    a.name                              AS asset_name,
    a.asset_type,
    a.site_id,
    a.location_in_site,
    a.criticality,
    a.condition,
    a.ppm_frequency,
    a.last_service_date,
    a.next_service_due,

    -- Last thermal imaging test
    thermal.test_date                   AS last_thermal_date,
    (thermal.pass_fail = 'pass')        AS last_thermal_pass,

    -- Last RCD test
    rcd.test_date                       AS last_rcd_date,
    (rcd.pass_fail = 'pass')            AS last_rcd_pass,

    -- Open defect counts
    COALESCE(def.open_count, 0)::INT    AS open_defect_count,
    COALESCE(def.critical_count, 0)::INT AS critical_defect_count,

    -- Compliance status
    CASE
      WHEN a.next_service_due IS NULL         THEN 'unknown'
      WHEN a.next_service_due < CURRENT_DATE  THEN 'overdue'
      WHEN a.next_service_due <= CURRENT_DATE + INTERVAL '30 days' THEN 'due_soon'
      ELSE 'current'
    END                                 AS compliance_status

  FROM app_data.assets a

  -- Latest thermal test per asset
  LEFT JOIN LATERAL (
    SELECT test_date, pass_fail
    FROM app_data.asset_test_results
    WHERE tenant_id = p_tenant_id
      AND asset_id  = a.asset_id
      AND test_type LIKE '%thermal%'
    ORDER BY test_date DESC
    LIMIT 1
  ) thermal ON true

  -- Latest RCD test per asset
  LEFT JOIN LATERAL (
    SELECT test_date, pass_fail
    FROM app_data.asset_test_results
    WHERE tenant_id = p_tenant_id
      AND asset_id  = a.asset_id
      AND test_type LIKE '%rcd%'
    ORDER BY test_date DESC
    LIMIT 1
  ) rcd ON true

  -- Open defect summary per asset
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)                                                       AS open_count,
      COUNT(*) FILTER (WHERE severity = 'critical')                  AS critical_count
    FROM app_data.asset_defects
    WHERE tenant_id = p_tenant_id
      AND asset_id  = a.asset_id
      AND status NOT IN ('resolved', 'no_action')
  ) def ON true

  WHERE a.tenant_id = p_tenant_id
    AND (p_site_id IS NULL OR a.site_id = p_site_id)

  ORDER BY
    CASE a.criticality
      WHEN 'critical' THEN 0
      WHEN 'high'     THEN 1
      WHEN 'medium'   THEN 2
      WHEN 'low'      THEN 3
      ELSE 4
    END,
    a.asset_type,
    a.external_id;
END;
$$;

COMMENT ON FUNCTION app_data.eq_ppm_asset_status IS
  'Per-asset PPM status snapshot. Returns last thermal/RCD test dates, '
  'open defect counts, and compliance status for each asset. '
  'Filter by site_id or pass NULL for all sites.';

GRANT EXECUTE ON FUNCTION app_data.eq_ppm_asset_status TO authenticated;

-- ── eq_ppm_site_summary ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_data.eq_ppm_site_summary(
  p_tenant_id UUID,
  p_site_id   UUID DEFAULT NULL
)
RETURNS TABLE (
  site_id                 UUID,
  site_name               TEXT,
  asset_count             INT,
  compliant_count         INT,
  due_soon_count          INT,
  overdue_count           INT,
  unknown_count           INT,
  open_defects            INT,
  open_critical_defects   INT,
  compliance_pct          NUMERIC,
  next_visit_date         DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.site_id,
    s.name                                                      AS site_name,

    COUNT(a.asset_id)::INT                                      AS asset_count,

    COUNT(a.asset_id) FILTER (
      WHERE a.next_service_due IS NOT NULL
        AND a.next_service_due >= CURRENT_DATE + INTERVAL '30 days'
    )::INT                                                      AS compliant_count,

    COUNT(a.asset_id) FILTER (
      WHERE a.next_service_due IS NOT NULL
        AND a.next_service_due >= CURRENT_DATE
        AND a.next_service_due < CURRENT_DATE + INTERVAL '30 days'
    )::INT                                                      AS due_soon_count,

    COUNT(a.asset_id) FILTER (
      WHERE a.next_service_due IS NOT NULL
        AND a.next_service_due < CURRENT_DATE
    )::INT                                                      AS overdue_count,

    COUNT(a.asset_id) FILTER (
      WHERE a.next_service_due IS NULL
    )::INT                                                      AS unknown_count,

    COALESCE(SUM(def.open_count), 0)::INT                       AS open_defects,
    COALESCE(SUM(def.critical_count), 0)::INT                   AS open_critical_defects,

    CASE
      WHEN COUNT(a.asset_id) = 0 THEN 0
      ELSE ROUND(
        100.0 * COUNT(a.asset_id) FILTER (
          WHERE a.next_service_due IS NOT NULL
            AND a.next_service_due >= CURRENT_DATE
        ) / COUNT(a.asset_id),
        1
      )
    END                                                         AS compliance_pct,

    -- Next scheduled visit for this site
    (
      SELECT MIN(sv.scheduled_date)
      FROM app_data.service_visits sv
      WHERE sv.tenant_id = p_tenant_id
        AND sv.site_id   = s.site_id
        AND sv.status    = 'planned'
        AND sv.scheduled_date >= CURRENT_DATE
    )                                                           AS next_visit_date

  FROM app_data.sites s
  LEFT JOIN app_data.assets a
    ON a.site_id = s.site_id AND a.tenant_id = p_tenant_id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'no_action'))        AS open_count,
      COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'no_action') AND severity = 'critical') AS critical_count
    FROM app_data.asset_defects
    WHERE tenant_id = p_tenant_id AND asset_id = a.asset_id
  ) def ON true

  WHERE s.tenant_id = p_tenant_id
    AND (p_site_id IS NULL OR s.site_id = p_site_id)

  GROUP BY s.site_id, s.name
  ORDER BY open_critical_defects DESC, overdue_count DESC, s.name;
END;
$$;

COMMENT ON FUNCTION app_data.eq_ppm_site_summary IS
  'Per-site PPM health: asset counts, compliance %, open defects, next visit. '
  'Sorted by severity — sites with critical open defects first.';

GRANT EXECUTE ON FUNCTION app_data.eq_ppm_site_summary TO authenticated;

-- ── eq_ppm_overdue_assets ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_data.eq_ppm_overdue_assets(
  p_tenant_id    UUID,
  p_days_overdue INT DEFAULT 0   -- 0 = already overdue; negative = look ahead
)
RETURNS TABLE (
  asset_id          UUID,
  external_id       TEXT,
  asset_name        TEXT,
  asset_type        TEXT,
  site_name         TEXT,
  location_in_site  TEXT,
  criticality       TEXT,
  last_service_date DATE,
  next_service_due  DATE,
  days_overdue      INT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.asset_id,
    a.external_id,
    a.name                                      AS asset_name,
    a.asset_type,
    s.name                                      AS site_name,
    a.location_in_site,
    a.criticality,
    a.last_service_date,
    a.next_service_due,
    (CURRENT_DATE - a.next_service_due)::INT    AS days_overdue
  FROM app_data.assets a
  LEFT JOIN app_data.sites s
    ON s.site_id = a.site_id AND s.tenant_id = p_tenant_id
  WHERE a.tenant_id = p_tenant_id
    AND a.next_service_due IS NOT NULL
    AND a.next_service_due <= CURRENT_DATE + (p_days_overdue || ' days')::INTERVAL
  ORDER BY
    CASE a.criticality WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
    a.next_service_due;
END;
$$;

COMMENT ON FUNCTION app_data.eq_ppm_overdue_assets IS
  'Returns assets that are overdue (or due within p_days_overdue days). '
  'p_days_overdue = 0: already overdue. p_days_overdue = 30: overdue or due within 30 days.';

GRANT EXECUTE ON FUNCTION app_data.eq_ppm_overdue_assets TO authenticated;

-- ── eq_ppm_open_defects ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_data.eq_ppm_open_defects(
  p_tenant_id UUID,
  p_severity  TEXT DEFAULT NULL   -- NULL = all severities
)
RETURNS TABLE (
  defect_id        UUID,
  asset_name       TEXT,
  asset_type       TEXT,
  site_name        TEXT,
  severity         TEXT,
  status           TEXT,
  description      TEXT,
  raised_date      DATE,
  age_days         INT,
  estimated_cost   NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.defect_id,
    a.name                              AS asset_name,
    a.asset_type,
    s.name                              AS site_name,
    d.severity,
    d.status,
    d.description,
    d.raised_date,
    (CURRENT_DATE - d.raised_date)::INT AS age_days,
    d.estimated_cost
  FROM app_data.asset_defects d
  LEFT JOIN app_data.assets a
    ON a.asset_id = d.asset_id AND a.tenant_id = p_tenant_id
  LEFT JOIN app_data.sites s
    ON s.site_id = a.site_id AND s.tenant_id = p_tenant_id
  WHERE d.tenant_id = p_tenant_id
    AND d.status NOT IN ('resolved', 'no_action')
    AND (p_severity IS NULL OR d.severity = p_severity)
  ORDER BY
    CASE d.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
    d.raised_date;
END;
$$;

COMMENT ON FUNCTION app_data.eq_ppm_open_defects IS
  'Returns open defects, sorted by severity then age. '
  'Filter by p_severity (critical/high/medium/low) or pass NULL for all.';

GRANT EXECUTE ON FUNCTION app_data.eq_ppm_open_defects TO authenticated;

-- ── eq_ppm_visit_completion_rate ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_data.eq_ppm_visit_completion_rate(
  p_tenant_id UUID,
  p_from_date DATE DEFAULT (CURRENT_DATE - INTERVAL '90 days')::DATE,
  p_to_date   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  visit_id          UUID,
  site_name         TEXT,
  scheduled_date    DATE,
  status            TEXT,
  client_job_code   TEXT,
  expected_assets   INT,
  tasks_total       INT,
  tasks_completed   INT,
  completion_rate   NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    v.visit_id,
    s.name                                  AS site_name,
    v.scheduled_date,
    v.status,
    v.client_job_code,
    v.expected_assets,
    COUNT(tc.completion_id)::INT            AS tasks_total,
    COUNT(tc.completion_id) FILTER (WHERE tc.completed = true)::INT AS tasks_completed,
    CASE
      WHEN COUNT(tc.completion_id) = 0 THEN 0
      ELSE ROUND(
        100.0 * COUNT(tc.completion_id) FILTER (WHERE tc.completed = true)
             / COUNT(tc.completion_id),
        1
      )
    END                                     AS completion_rate
  FROM app_data.service_visits v
  LEFT JOIN app_data.sites s
    ON s.site_id = v.site_id AND s.tenant_id = p_tenant_id
  LEFT JOIN app_data.service_task_completions tc
    ON tc.visit_id = v.visit_id AND tc.tenant_id = p_tenant_id
  WHERE v.tenant_id     = p_tenant_id
    AND v.scheduled_date BETWEEN p_from_date AND p_to_date
  GROUP BY v.visit_id, s.name, v.scheduled_date, v.status,
           v.client_job_code, v.expected_assets
  ORDER BY v.scheduled_date DESC;
END;
$$;

COMMENT ON FUNCTION app_data.eq_ppm_visit_completion_rate IS
  'Completion rate per service visit in a date range. '
  'Shows how many tasks were ticked off vs total for each visit.';

GRANT EXECUTE ON FUNCTION app_data.eq_ppm_visit_completion_rate TO authenticated;
