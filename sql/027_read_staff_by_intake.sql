-- ============================================================================
-- 027 — eq_read_staff_by_intake RPC
-- ============================================================================
-- Mirrors eq_read_customers_by_intake (migration 019) for staff.
-- Called by the canonical commit bridge after committing a staff batch to
-- build an (external_id → staff_id) lookup map used to resolve licence FK.
--
-- Returns staff rows for a given intake_id so commit-canonical.ts can stamp
-- staff_id on licence rows before they hit validate().
--
-- Security: SECURITY DEFINER runs as the function owner (usually postgres or
-- a privileged role). RLS on app_data.staff is bypassed inside the function;
-- the tenant_id filter provides the isolation equivalent.
-- ============================================================================

CREATE OR REPLACE FUNCTION eq_read_staff_by_intake(p_intake_id uuid)
RETURNS TABLE (staff_id uuid, external_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = app_data, shell_control, public, extensions
AS $$
  SELECT s.staff_id, s.external_id
  FROM   app_data.staff s
  WHERE  s.intake_id = p_intake_id
    AND  s.external_id IS NOT NULL;
$$;
