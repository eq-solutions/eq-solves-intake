-- =============================================================================
-- Migration 030: Intake observability RPC
--
-- eq_get_intake_health(p_tenant_id)
--   Returns a JSONB snapshot of intake activity for a tenant:
--     - total commits in last 24 h, 7 d, 30 d
--     - total rows committed, flagged, rejected in each window
--     - last commit timestamp
--     - entity breakdown (how many customers / sites / contacts / staff saved)
--     - error rate (rejected / (committed + rejected)) for the last 30 d
--
-- Used by:
--   1. An admin dashboard health card (future EQ Shell module).
--   2. Royce's manual spot-checks: can call this from Supabase Studio.
--   3. A Netlify scheduled function that pings this and sends to PostHog/Sentry
--      if error_rate > 0.1 (future observability pipeline).
--
-- Depends on: app_data.intake_events (created in sql/006 or equivalent).
-- Assumes intake_events has columns:
--   id, tenant_id, created_at, status, entity, committed_count, rejected_count,
--   flagged_count, source_filename.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_data.eq_get_intake_health(
  p_tenant_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now           TIMESTAMPTZ := NOW();
  v_24h           TIMESTAMPTZ := v_now - INTERVAL '24 hours';
  v_7d            TIMESTAMPTZ := v_now - INTERVAL '7 days';
  v_30d           TIMESTAMPTZ := v_now - INTERVAL '30 days';

  v_last_commit   TIMESTAMPTZ;

  v_commits_24h   INT := 0;
  v_commits_7d    INT := 0;
  v_commits_30d   INT := 0;

  v_committed_30d  BIGINT := 0;
  v_flagged_30d    BIGINT := 0;
  v_rejected_30d   BIGINT := 0;

  v_committed_24h  BIGINT := 0;
  v_flagged_24h    BIGINT := 0;
  v_rejected_24h   BIGINT := 0;

  v_error_rate    NUMERIC := 0;

  v_entity_breakdown JSONB := '{}'::JSONB;
  v_recent_files     JSONB := '[]'::JSONB;
BEGIN
  -- ── Last commit ────────────────────────────────────────────────────────────
  SELECT MAX(created_at)
    INTO v_last_commit
    FROM app_data.intake_events
   WHERE tenant_id = p_tenant_id;

  -- ── Commit counts ──────────────────────────────────────────────────────────
  SELECT
    COUNT(*) FILTER (WHERE created_at >= v_24h),
    COUNT(*) FILTER (WHERE created_at >= v_7d),
    COUNT(*) FILTER (WHERE created_at >= v_30d)
  INTO v_commits_24h, v_commits_7d, v_commits_30d
  FROM app_data.intake_events
  WHERE tenant_id = p_tenant_id
    AND status IN ('committed', 'partial');

  -- ── Row-level metrics (30 d) ────────────────────────────────────────────────
  SELECT
    COALESCE(SUM(committed_count), 0),
    COALESCE(SUM(flagged_count),   0),
    COALESCE(SUM(rejected_count),  0)
  INTO v_committed_30d, v_flagged_30d, v_rejected_30d
  FROM app_data.intake_events
  WHERE tenant_id  = p_tenant_id
    AND created_at >= v_30d;

  -- ── Row-level metrics (24 h) ────────────────────────────────────────────────
  SELECT
    COALESCE(SUM(committed_count), 0),
    COALESCE(SUM(flagged_count),   0),
    COALESCE(SUM(rejected_count),  0)
  INTO v_committed_24h, v_flagged_24h, v_rejected_24h
  FROM app_data.intake_events
  WHERE tenant_id  = p_tenant_id
    AND created_at >= v_24h;

  -- ── Error rate (30 d) ───────────────────────────────────────────────────────
  IF (v_committed_30d + v_rejected_30d) > 0 THEN
    v_error_rate := ROUND(
      v_rejected_30d::NUMERIC / (v_committed_30d + v_rejected_30d)::NUMERIC,
      4
    );
  END IF;

  -- ── Entity breakdown (30 d — committed rows per entity) ─────────────────────
  SELECT jsonb_object_agg(entity, total_committed)
    INTO v_entity_breakdown
    FROM (
      SELECT
        entity,
        SUM(committed_count) AS total_committed
      FROM app_data.intake_events
      WHERE tenant_id  = p_tenant_id
        AND created_at >= v_30d
        AND entity IS NOT NULL
      GROUP BY entity
    ) sub;

  -- ── Recent files (last 10 distinct source filenames) ────────────────────────
  SELECT jsonb_agg(row_to_json(sub))
    INTO v_recent_files
    FROM (
      SELECT DISTINCT ON (source_filename)
        source_filename,
        created_at,
        status,
        committed_count,
        rejected_count
      FROM app_data.intake_events
      WHERE tenant_id        = p_tenant_id
        AND source_filename IS NOT NULL
      ORDER BY source_filename, created_at DESC
      LIMIT 10
    ) sub;

  -- ── Assemble result ─────────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'tenant_id',         p_tenant_id,
    'generated_at',      v_now,
    'last_commit_at',    v_last_commit,

    'commits', jsonb_build_object(
      'last_24h', v_commits_24h,
      'last_7d',  v_commits_7d,
      'last_30d', v_commits_30d
    ),

    'rows_24h', jsonb_build_object(
      'committed', v_committed_24h,
      'flagged',   v_flagged_24h,
      'rejected',  v_rejected_24h
    ),

    'rows_30d', jsonb_build_object(
      'committed', v_committed_30d,
      'flagged',   v_flagged_30d,
      'rejected',  v_rejected_30d
    ),

    'error_rate_30d', v_error_rate,

    'entity_breakdown_30d', COALESCE(v_entity_breakdown, '{}'::JSONB),
    'recent_files',         COALESCE(v_recent_files,     '[]'::JSONB)
  );
END;
$$;

COMMENT ON FUNCTION app_data.eq_get_intake_health IS
  'Returns a JSONB health snapshot for a tenant: commit counts, row metrics, '
  'error rate, entity breakdown, and recent file list. '
  'Safe to call from Supabase Studio for manual spot-checks.';

GRANT EXECUTE ON FUNCTION app_data.eq_get_intake_health TO authenticated;
