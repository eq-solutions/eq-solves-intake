-- =============================================================================
-- Migration 029: Intake rate limiting
--
-- Provides per-tenant, per-hour rate limiting for the canonical commit RPC
-- to prevent runaway imports from hammering the DB.
--
-- Two RPCs:
--   eq_check_intake_rate_limit(p_tenant_id, p_window_minutes, p_max_calls)
--     → boolean  (true = OK to proceed, false = limit reached)
--
--   eq_increment_intake_rate_limit(p_tenant_id)
--     → void  (call immediately after a successful commit to record it)
--
-- The table is a rolling window store — rows older than the window are
-- irrelevant. A cleanup job (or the check RPC itself) prunes old rows.
-- Not using pg_cron here — keep it dependency-free.
--
-- Default limits (can be overridden per-tenant via eq_intake_rate_limit_overrides
-- if that table is added later):
--   window: 60 minutes
--   max calls per window: 50
--
-- This is a soft guard. A legitimate user won't hit 50 imports/hour.
-- A runaway script will be stopped.
-- =============================================================================

-- ── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_data.eq_intake_rate_limits (
  id          BIGSERIAL       PRIMARY KEY,
  tenant_id   UUID            NOT NULL,
  recorded_at TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS eq_intake_rate_limits_tenant_time_idx
  ON app_data.eq_intake_rate_limits (tenant_id, recorded_at DESC);

-- RLS: each tenant can only see their own records.
ALTER TABLE app_data.eq_intake_rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON app_data.eq_intake_rate_limits;
CREATE POLICY "tenant_isolation"
  ON app_data.eq_intake_rate_limits
  FOR ALL
  USING (
    tenant_id = (
      (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
    )
  );

-- ── Check RPC ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_data.eq_check_intake_rate_limit(
  p_tenant_id      UUID,
  p_window_minutes INT  DEFAULT 60,
  p_max_calls      INT  DEFAULT 50
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_call_count   INT;
BEGIN
  v_window_start := NOW() - (p_window_minutes || ' minutes')::INTERVAL;

  -- Count calls within the rolling window.
  SELECT COUNT(*)
    INTO v_call_count
    FROM app_data.eq_intake_rate_limits
   WHERE tenant_id   = p_tenant_id
     AND recorded_at >= v_window_start;

  -- Prune rows older than 2× the window to keep the table lean.
  DELETE FROM app_data.eq_intake_rate_limits
   WHERE tenant_id   = p_tenant_id
     AND recorded_at < NOW() - ((p_window_minutes * 2) || ' minutes')::INTERVAL;

  RETURN v_call_count < p_max_calls;
END;
$$;

COMMENT ON FUNCTION app_data.eq_check_intake_rate_limit IS
  'Returns true if the tenant has not exceeded p_max_calls in the last '
  'p_window_minutes minutes. Also prunes stale rows as a side-effect.';

-- ── Increment RPC ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_data.eq_increment_intake_rate_limit(
  p_tenant_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO app_data.eq_intake_rate_limits (tenant_id, recorded_at)
  VALUES (p_tenant_id, NOW());
END;
$$;

COMMENT ON FUNCTION app_data.eq_increment_intake_rate_limit IS
  'Record one intake call for the tenant. Call after a successful commit.';

-- ── Grant execute to authenticated role ──────────────────────────────────────

GRANT EXECUTE ON FUNCTION app_data.eq_check_intake_rate_limit   TO authenticated;
GRANT EXECUTE ON FUNCTION app_data.eq_increment_intake_rate_limit TO authenticated;
