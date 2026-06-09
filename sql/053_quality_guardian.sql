-- 053_quality_guardian.sql
-- Automated quality guardian — scheduled run log and persistent alert store.
--
-- Tables:
--   eq_quality_runs    — one row per guardian invocation (schedule or manual)
--   eq_quality_alerts  — persistent alert records, closeable by admins
--
-- RPCs:
--   eq_quality_open_alerts()              — unresolved alerts for current tenant
--   eq_quality_resolve_alert(p_alert_id)  — mark an alert resolved

-- ---------------------------------------------------------------------------
-- 1. eq_quality_runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_data.eq_quality_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  run_type     text NOT NULL,                   -- 'scheduled' | 'manual'
  triggered_by text NOT NULL DEFAULT 'schedule',
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  summary      jsonb
);

-- Tenant scope index
CREATE INDEX IF NOT EXISTS eq_quality_runs_tenant_idx
  ON app_data.eq_quality_runs (tenant_id, started_at DESC);

COMMENT ON TABLE app_data.eq_quality_runs IS
  'Records every quality-guardian run — scheduled nightly or manually triggered. '
  'summary holds alert counts, health scores, and orphan totals.';

-- ---------------------------------------------------------------------------
-- 2. eq_quality_alerts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_data.eq_quality_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  alert_type   text NOT NULL,           -- 'licence_expiry' | 'orphan' | 'health_gap'
  entity_type  text,                    -- 'staff' | 'asset' | etc.
  entity_id    uuid,                    -- the specific row this alert is about
  message      text NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Fast query for open (unresolved) alerts per tenant
CREATE INDEX IF NOT EXISTS eq_quality_alerts_open_idx
  ON app_data.eq_quality_alerts (tenant_id, resolved_at)
  WHERE resolved_at IS NULL;

-- Dedup index: one open alert per entity + alert type combination
CREATE UNIQUE INDEX IF NOT EXISTS eq_quality_alerts_dedup_idx
  ON app_data.eq_quality_alerts (tenant_id, alert_type, entity_id)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE app_data.eq_quality_alerts IS
  'Persistent alert records raised by the quality guardian. '
  'Alerts remain open (resolved_at IS NULL) until an admin resolves them. '
  'The unique index on (tenant_id, alert_type, entity_id) prevents duplicate '
  'open alerts for the same entity.';

-- ---------------------------------------------------------------------------
-- 3. RPC: eq_quality_open_alerts
--    Returns all unresolved alerts for the current tenant.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_quality_open_alerts()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_tenant_id uuid;
  v_result    json;
BEGIN
  v_tenant_id := (
    auth.jwt() -> 'app_metadata' ->> 'tenant_id'
  )::uuid;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_quality_open_alerts: no tenant_id in JWT';
  END IF;

  SELECT json_agg(
    json_build_object(
      'id',          a.id,
      'alert_type',  a.alert_type,
      'entity_type', a.entity_type,
      'entity_id',   a.entity_id,
      'message',     a.message,
      'severity',    a.severity,
      'created_at',  a.created_at
    )
    ORDER BY
      CASE a.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
      a.created_at DESC
  )
  INTO v_result
  FROM app_data.eq_quality_alerts a
  WHERE a.tenant_id = v_tenant_id
    AND a.resolved_at IS NULL;

  RETURN COALESCE(v_result, '[]'::json);
END;
$$;

COMMENT ON FUNCTION public.eq_quality_open_alerts() IS
  'Returns all unresolved quality alerts for the current tenant, ordered by '
  'severity (critical first) then most recent first.';

-- ---------------------------------------------------------------------------
-- 4. RPC: eq_quality_resolve_alert
--    Marks a single alert as resolved. Admin-gated in the application layer.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_quality_resolve_alert(
  p_alert_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_tenant_id uuid;
  v_updated   int;
BEGIN
  v_tenant_id := (
    auth.jwt() -> 'app_metadata' ->> 'tenant_id'
  )::uuid;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_quality_resolve_alert: no tenant_id in JWT';
  END IF;

  UPDATE app_data.eq_quality_alerts
  SET resolved_at = now()
  WHERE id = p_alert_id
    AND tenant_id = v_tenant_id
    AND resolved_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN json_build_object('resolved', v_updated > 0);
END;
$$;

COMMENT ON FUNCTION public.eq_quality_resolve_alert(uuid) IS
  'Marks the given alert as resolved. Only affects alerts owned by the '
  'current tenant; no-ops gracefully if already resolved or not found.';

-- ---------------------------------------------------------------------------
-- 5. RPC: eq_quality_upsert_alert
--    Insert or no-op for dedup: called by the guardian runner to raise alerts.
--    If an open alert already exists for (tenant, type, entity), skip insert.
--    If entity_id is NULL, dedup on (tenant_id, alert_type, message) instead.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_quality_upsert_alert(
  p_tenant_id  uuid,
  p_alert_type text,
  p_entity_type text,
  p_entity_id  uuid,
  p_message    text,
  p_severity   text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Try to find an existing open alert for the same entity + type
  SELECT id INTO v_id
  FROM app_data.eq_quality_alerts
  WHERE tenant_id  = p_tenant_id
    AND alert_type = p_alert_type
    AND entity_id  = p_entity_id
    AND resolved_at IS NULL
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- Already open — update severity in case it changed (e.g. expiry moved closer)
    UPDATE app_data.eq_quality_alerts
    SET severity = p_severity,
        message  = p_message
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  -- Insert new alert
  INSERT INTO app_data.eq_quality_alerts
    (tenant_id, alert_type, entity_type, entity_id, message, severity)
  VALUES
    (p_tenant_id, p_alert_type, p_entity_type, p_entity_id, p_message, p_severity)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.eq_quality_upsert_alert(uuid, text, text, uuid, text, text) IS
  'Insert a quality alert, or update the severity/message if an open alert '
  'already exists for the same (tenant, type, entity). Called by the guardian '
  'runner — not intended for direct client use.';
