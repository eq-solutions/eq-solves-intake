-- =============================================================================
-- Migration 032: API intake audit log
--
-- Extends the intake audit trail to capture API surface calls separately
-- from browser Import calls. This lets Royce answer "which external system
-- sent these rows and when?" from Supabase Studio without reading the
-- application logs.
--
-- ── What it adds ─────────────────────────────────────────────────────────────
-- The existing `intake_events` table records every commit. This migration
-- adds `api_intake_calls` — a lighter table that records every call to the
-- api-intake edge function BEFORE the commit, so:
--   - Rate limit window calculations have a persistent source of truth
--     (in addition to eq_intake_rate_limits which prunes old rows)
--   - Failed calls (validation rejections, auth errors) are visible
--   - Source system identity is captured for each call
--
-- Each row records: caller identity, entity, row count, response status,
-- committed / rejected counts, call timestamp.
--
-- ── Why separate from intake_events? ─────────────────────────────────────────
-- intake_events is populated by the RPC (after a successful commit).
-- api_intake_calls is populated by the edge function (before/after commit,
-- including failures). They complement each other:
--   intake_events → "what was committed and when"
--   api_intake_calls → "who called the API and what happened"
-- =============================================================================

CREATE TABLE IF NOT EXISTS app_data.api_intake_calls (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID            NOT NULL,
  called_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  -- Caller identity — from the JWT and the request body "source" field
  caller_user_id  UUID,               -- auth.uid() of the calling JWT, if available
  caller_source   TEXT,               -- request body "source" field (e.g. "my-integration")

  -- Request details
  entity          TEXT            NOT NULL,
  row_count_in    INT             NOT NULL DEFAULT 0,
  dry_run         BOOLEAN         NOT NULL DEFAULT false,

  -- Response details
  http_status     INT,                -- 200, 400, 422, 429, 500
  committed_count INT             NOT NULL DEFAULT 0,
  rejected_count  INT             NOT NULL DEFAULT 0,
  flagged_count   INT             NOT NULL DEFAULT 0,
  error_message   TEXT,               -- populated if http_status >= 400

  -- Link back to intake_events if the commit succeeded
  intake_event_id UUID,               -- FK to app_data.intake_events.id (nullable)

  -- Duration for performance tracking
  duration_ms     INT
);

-- Tenant isolation — callers can read their own call log, not others'.
ALTER TABLE app_data.api_intake_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON app_data.api_intake_calls;
CREATE POLICY "tenant_isolation"
  ON app_data.api_intake_calls
  FOR ALL
  USING (
    tenant_id = (
      (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::uuid
    )
  );

-- Index for the most common query: "recent calls for this tenant"
CREATE INDEX IF NOT EXISTS api_intake_calls_tenant_time_idx
  ON app_data.api_intake_calls (tenant_id, called_at DESC);

-- Index for "calls from a specific source system"
CREATE INDEX IF NOT EXISTS api_intake_calls_source_idx
  ON app_data.api_intake_calls (tenant_id, caller_source, called_at DESC);

-- ── RPC: record a call ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_data.eq_record_api_intake_call(
  p_tenant_id       UUID,
  p_caller_user_id  UUID        DEFAULT NULL,
  p_caller_source   TEXT        DEFAULT 'api',
  p_entity          TEXT        DEFAULT '',
  p_row_count_in    INT         DEFAULT 0,
  p_dry_run         BOOLEAN     DEFAULT false,
  p_http_status     INT         DEFAULT 200,
  p_committed_count INT         DEFAULT 0,
  p_rejected_count  INT         DEFAULT 0,
  p_flagged_count   INT         DEFAULT 0,
  p_error_message   TEXT        DEFAULT NULL,
  p_intake_event_id UUID        DEFAULT NULL,
  p_duration_ms     INT         DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO app_data.api_intake_calls (
    tenant_id, caller_user_id, caller_source, entity, row_count_in, dry_run,
    http_status, committed_count, rejected_count, flagged_count,
    error_message, intake_event_id, duration_ms
  )
  VALUES (
    p_tenant_id, p_caller_user_id, p_caller_source, p_entity, p_row_count_in, p_dry_run,
    p_http_status, p_committed_count, p_rejected_count, p_flagged_count,
    p_error_message, p_intake_event_id, p_duration_ms
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION app_data.eq_record_api_intake_call IS
  'Records one api-intake edge function call to the audit log. '
  'Called by the edge function after every request (success or failure). '
  'Returns the inserted row ID.';

GRANT EXECUTE ON FUNCTION app_data.eq_record_api_intake_call TO authenticated;

-- ── RPC: recent calls for a tenant (Studio-friendly) ─────────────────────────

CREATE OR REPLACE FUNCTION app_data.eq_get_api_call_log(
  p_tenant_id   UUID,
  p_limit       INT  DEFAULT 50,
  p_offset      INT  DEFAULT 0
)
RETURNS TABLE (
  id              UUID,
  called_at       TIMESTAMPTZ,
  caller_source   TEXT,
  entity          TEXT,
  row_count_in    INT,
  dry_run         BOOLEAN,
  http_status     INT,
  committed_count INT,
  rejected_count  INT,
  error_message   TEXT,
  duration_ms     INT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.called_at,
    c.caller_source,
    c.entity,
    c.row_count_in,
    c.dry_run,
    c.http_status,
    c.committed_count,
    c.rejected_count,
    c.error_message,
    c.duration_ms
  FROM app_data.api_intake_calls c
  WHERE c.tenant_id = p_tenant_id
  ORDER BY c.called_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION app_data.eq_get_api_call_log IS
  'Returns recent api-intake calls for a tenant. Useful from Supabase Studio '
  'to diagnose what an external integration is sending and whether it succeeds.';

GRANT EXECUTE ON FUNCTION app_data.eq_get_api_call_log TO authenticated;
