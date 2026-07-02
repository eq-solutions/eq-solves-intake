-- 059_quality_guardian_service_context.sql
-- The quality-guardian Edge Function runs with the service-role key, but the
-- tenant-scoped read RPCs (eq_tidy_read_entity, eq_tidy_orphan_check) resolve
-- tenant strictly from auth.jwt() app_metadata.tenant_id. A bare service-role
-- call carries no tenant claim, so every per-tenant read raised
-- 'no tenant_id in JWT' — the x-tenant-id HTTP header the function sent was
-- never read by anything. app_data.eq_quality_runs and eq_quality_alerts were
-- both empty on sks-canonical as of 2026-07-02: the guardian has never
-- completed a run.
--
-- This migration gives the guardian a proper server-side tenant context:
--
--   eq_quality_list_tenants()                      — tenants that hold canonical rows
--   eq_quality_start_run(p_tenant_id, p_run_type, p_triggered_by) — open a run row
--   eq_quality_complete_run(p_run_id, p_summary)   — stamp completed_at + summary
--   eq_tidy_read_entity_admin(p_tenant_id, p_table)
--   eq_tidy_orphan_check_admin(p_tenant_id)
--
-- The *_admin variants do NOT duplicate the tidy logic. They set the
-- request.jwt.claim / request.jwt.claims GUCs transaction-locally to a
-- synthetic service-role claim carrying app_metadata.tenant_id, then delegate
-- to the existing JWT-scoped functions — auth.jwt() reads those GUCs (singular
-- first, then plural, per the live auth.jwt() on sks-canonical), so the
-- originals run unchanged and cannot drift from their admin twins.
--
-- The run RPCs also replace the function's broken bookkeeping: supabase-js
-- `.from('app_data.eq_quality_runs')` addressed a non-existent public-schema
-- table, so run rows could never be written even when checks succeeded.
--
-- Access: EXECUTE revoked from public/anon/authenticated on all five; granted
-- to service_role only. Each function additionally self-guards on the caller's
-- ORIGINAL claims (read before the override): a role claim other than
-- service_role is rejected. No role claim at all (direct DB session: psql,
-- pg_cron, migrations) is trusted.
--
-- Idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. eq_quality_list_tenants
--    Tenants that actually hold canonical rows — exactly the set the
--    per-tenant checks can act on. Avoids depending on a tenant registry
--    table (app_data.tenants does not exist on sks-canonical; the tenant
--    registry there is service.tenants, which intake does not own).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_quality_list_tenants()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_role   text := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role';
  v_result json;
BEGIN
  IF v_role IS NOT NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'eq_quality_list_tenants: service_role only' USING ERRCODE = '42501';
  END IF;

  SELECT json_agg(u.tenant_id ORDER BY u.tenant_id)
  INTO v_result
  FROM (
    SELECT tenant_id FROM app_data.customers
    UNION SELECT tenant_id FROM app_data.sites
    UNION SELECT tenant_id FROM app_data.contacts
    UNION SELECT tenant_id FROM app_data.staff
    UNION SELECT tenant_id FROM app_data.licences
    UNION SELECT tenant_id FROM app_data.assets
  ) u
  WHERE u.tenant_id IS NOT NULL;

  RETURN COALESCE(v_result, '[]'::json);
END;
$$;

COMMENT ON FUNCTION public.eq_quality_list_tenants() IS
  'Distinct tenant_ids present in the canonical entity tables. Service-role '
  'only — used by the quality-guardian edge function to enumerate tenants.';

-- ---------------------------------------------------------------------------
-- 2. eq_quality_start_run
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_quality_start_run(
  p_tenant_id    uuid,
  p_run_type     text,
  p_triggered_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role';
  v_id   uuid;
BEGIN
  IF v_role IS NOT NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'eq_quality_start_run: service_role only' USING ERRCODE = '42501';
  END IF;

  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_quality_start_run: p_tenant_id is required';
  END IF;

  IF p_run_type NOT IN ('scheduled', 'manual') THEN
    RAISE EXCEPTION 'eq_quality_start_run: p_run_type must be scheduled or manual, got "%"', p_run_type;
  END IF;

  INSERT INTO app_data.eq_quality_runs (tenant_id, run_type, triggered_by)
  VALUES (p_tenant_id, p_run_type, COALESCE(p_triggered_by, p_run_type))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.eq_quality_start_run(uuid, text, text) IS
  'Opens an eq_quality_runs row for a guardian run. Service-role only.';

-- ---------------------------------------------------------------------------
-- 3. eq_quality_complete_run
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_quality_complete_run(
  p_run_id  uuid,
  p_summary jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_role    text := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role';
  v_updated int;
BEGIN
  IF v_role IS NOT NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'eq_quality_complete_run: service_role only' USING ERRCODE = '42501';
  END IF;

  UPDATE app_data.eq_quality_runs
  SET completed_at = now(),
      summary      = p_summary
  WHERE id = p_run_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

COMMENT ON FUNCTION public.eq_quality_complete_run(uuid, jsonb) IS
  'Stamps completed_at + summary on an eq_quality_runs row. Service-role only.';

-- ---------------------------------------------------------------------------
-- 4. eq_tidy_read_entity_admin
--    Service-role variant of eq_tidy_read_entity: takes the tenant explicitly,
--    injects it as a transaction-local JWT claim, delegates to the original.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_tidy_read_entity_admin(
  p_tenant_id uuid,
  p_table     text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_role   text := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role';
  v_claims text;
BEGIN
  IF v_role IS NOT NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'eq_tidy_read_entity_admin: service_role only' USING ERRCODE = '42501';
  END IF;

  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_tidy_read_entity_admin: p_tenant_id is required';
  END IF;

  -- Transaction-local synthetic claim; auth.jwt() inside the delegate reads
  -- request.jwt.claim (singular) before request.jwt.claims, so set both.
  v_claims := json_build_object(
    'role',         'service_role',
    'app_metadata', json_build_object('tenant_id', p_tenant_id)
  )::text;
  PERFORM set_config('request.jwt.claim',  v_claims, true);
  PERFORM set_config('request.jwt.claims', v_claims, true);

  RETURN public.eq_tidy_read_entity(p_table);
END;
$$;

COMMENT ON FUNCTION public.eq_tidy_read_entity_admin(uuid, text) IS
  'Service-role variant of eq_tidy_read_entity for the quality-guardian edge '
  'function: explicit tenant instead of JWT resolution. Delegates to the '
  'original after setting a transaction-local tenant claim.';

-- ---------------------------------------------------------------------------
-- 5. eq_tidy_orphan_check_admin
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_tidy_orphan_check_admin(
  p_tenant_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_role   text := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role';
  v_claims text;
BEGIN
  IF v_role IS NOT NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'eq_tidy_orphan_check_admin: service_role only' USING ERRCODE = '42501';
  END IF;

  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_tidy_orphan_check_admin: p_tenant_id is required';
  END IF;

  v_claims := json_build_object(
    'role',         'service_role',
    'app_metadata', json_build_object('tenant_id', p_tenant_id)
  )::text;
  PERFORM set_config('request.jwt.claim',  v_claims, true);
  PERFORM set_config('request.jwt.claims', v_claims, true);

  RETURN public.eq_tidy_orphan_check();
END;
$$;

COMMENT ON FUNCTION public.eq_tidy_orphan_check_admin(uuid) IS
  'Service-role variant of eq_tidy_orphan_check for the quality-guardian edge '
  'function: explicit tenant instead of JWT resolution. Delegates to the '
  'original after setting a transaction-local tenant claim.';

-- ---------------------------------------------------------------------------
-- 6. Grants — service_role only, on all five
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.eq_quality_list_tenants()                     FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.eq_quality_start_run(uuid, text, text)       FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.eq_quality_complete_run(uuid, jsonb)         FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.eq_tidy_read_entity_admin(uuid, text)        FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.eq_tidy_orphan_check_admin(uuid)             FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.eq_quality_list_tenants()                 TO service_role;
GRANT EXECUTE ON FUNCTION public.eq_quality_start_run(uuid, text, text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.eq_quality_complete_run(uuid, jsonb)      TO service_role;
GRANT EXECUTE ON FUNCTION public.eq_tidy_read_entity_admin(uuid, text)     TO service_role;
GRANT EXECUTE ON FUNCTION public.eq_tidy_orphan_check_admin(uuid)          TO service_role;

-- Migration record
INSERT INTO app_data._eq_migrations (name) VALUES ('059_quality_guardian_service_context')
ON CONFLICT (name) DO NOTHING;
