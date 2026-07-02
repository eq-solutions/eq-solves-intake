-- 058_quality_upsert_alert_client_grant.sql
-- The intake health dashboard raises licence-expiry alerts through
-- public.eq_quality_upsert_alert using the browser's authenticated client
-- (licence-expiry-check.ts). 053 shipped the function without any GRANT, so
-- on sks-canonical only postgres + service_role could execute it — every
-- dashboard-side upsert failed permission-denied and no alert was ever
-- written (app_data.eq_quality_alerts was empty on 2026-07-02 despite an
-- expired safety-critical licence sitting in app_data.licences).
--
-- Granting authenticated as-is would open a horizontal-authz hole: the
-- function trusted the caller-supplied p_tenant_id outright. So this file
-- first adds the migration-030-style caller-tenant guard (authenticated
-- callers may only act on their own JWT tenant; service_role / non-REST
-- callers such as the quality-guardian edge function are trusted unchanged),
-- then grants EXECUTE to authenticated.
--
-- Idempotent — safe to re-run.

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
  v_id     uuid;
  v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
BEGIN
  -- Authenticated (browser) callers may only raise alerts for their own tenant.
  -- service_role / trusted server contexts bypass (no 'authenticated' role claim).
  IF v_claims ->> 'role' = 'authenticated'
     AND p_tenant_id IS DISTINCT FROM (v_claims -> 'app_metadata' ->> 'tenant_id')::uuid THEN
    RAISE EXCEPTION 'Tenant mismatch: caller may not raise alerts for tenant %', p_tenant_id
      USING ERRCODE = 'EQ010';
  END IF;

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
  'already exists for the same (tenant, type, entity). Callable by the guardian '
  'runner (service_role) and by authenticated clients for their own tenant only.';

REVOKE ALL ON FUNCTION public.eq_quality_upsert_alert(uuid, text, text, uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.eq_quality_upsert_alert(uuid, text, text, uuid, text, text) TO authenticated, service_role;

-- Migration record
INSERT INTO app_data._eq_migrations (name) VALUES ('058_quality_upsert_alert_client_grant')
ON CONFLICT (name) DO NOTHING;
