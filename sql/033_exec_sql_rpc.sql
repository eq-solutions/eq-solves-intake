-- =============================================================================
-- Migration 033: eq_exec_sql — raw SQL execution RPC
--
-- Required by scripts/apply-migrations.mjs to apply migrations programmatically.
-- Also useful for Supabase Studio ad-hoc queries from the RPC panel.
--
-- ── Security ──────────────────────────────────────────────────────────────────
-- SECURITY DEFINER runs as the postgres superuser. Access is limited to
-- the service-role key only — anon and authenticated roles are explicitly
-- NOT granted execute. This means:
--   - Only the migration runner (service-role) can call it
--   - Browser clients (anon/authenticated) cannot execute arbitrary SQL
--   - The function cannot be called through the Supabase REST API without
--     the service-role key (which is never sent to the browser)
--
-- If you want additional protection, add an IP-allowlist check here:
--   IF inet_client_addr() NOT IN ('your-runner-ip') THEN RAISE EXCEPTION ...
--
-- ── Alternatives ─────────────────────────────────────────────────────────────
-- If you don't want this RPC, apply migrations via:
--   - Supabase Studio SQL editor (paste each file manually)
--   - `supabase db push` CLI (requires supabase CLI installed)
--   - The Supabase Management API (requires a management API key)
-- =============================================================================

CREATE OR REPLACE FUNCTION app_data.eq_exec_sql(sql TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  EXECUTE sql;
END;
$$;

COMMENT ON FUNCTION app_data.eq_exec_sql IS
  'Execute arbitrary SQL. SECURITY DEFINER — only callable with the service-role key. '
  'Used by scripts/apply-migrations.mjs. Never exposed to browser clients.';

-- Explicitly revoke from roles that must not call this.
REVOKE EXECUTE ON FUNCTION app_data.eq_exec_sql FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_data.eq_exec_sql FROM anon;
REVOKE EXECUTE ON FUNCTION app_data.eq_exec_sql FROM authenticated;

-- Only service_role can call it. service_role bypasses all RLS and GRANT checks
-- because it's the superuser equivalent in Supabase's role hierarchy.
-- No GRANT needed — SECURITY DEFINER + REVOKE from anon/authenticated is sufficient.
