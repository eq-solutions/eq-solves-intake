-- 060_quality_guardian_cron_sks.sql
-- Registers the nightly pg_cron job that invokes the quality-guardian Edge
-- Function. Written for sks-canonical (ehowgjardagevnrluult) — the Functions
-- URL below is project-specific, so each tenant plane registers its own copy
-- of this file with its own ref.
--
-- The header comment quality-guardian originally shipped with relied on
-- current_setting('app.edge_function_base_url') and
-- current_setting('app.service_role_key') — neither GUC was ever set on
-- sks-canonical, so the job it described was never registerable as written.
-- This file follows the pattern of the existing eq-quotes-embed-quotes job
-- instead: the Authorization secret lives in Vault and is read at fire time,
-- so key rotation is a vault.update_secret, not a cron change.
--
-- ── Prerequisite (one-time, manual — never commit the key) ─────────────────
--   select vault.create_secret('<service_role key from the dashboard>',
--                              'edge_service_role_key');
--
-- ── Apply order ─────────────────────────────────────────────────────────────
--   058 (alert grant) → 059 (service-context RPCs) → deploy Edge Function
--   → vault secret → this file.
--
-- Re-running replaces the job in place (cron.schedule upserts by jobname).
-- 01:00 UTC = 11:00 AEST / 12:00 AEDT.

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'edge_service_role_key') THEN
    RAISE EXCEPTION USING MESSAGE =
      '060_quality_guardian_cron_sks: vault secret "edge_service_role_key" is missing. '
      'Create it first (Supabase dashboard -> SQL editor): '
      'select vault.create_secret(''<service_role key>'', ''edge_service_role_key'');';
  END IF;
END
$guard$;

SELECT cron.schedule(
  'quality-guardian-nightly',
  '0 1 * * *',
  $job$
  SELECT net.http_post(
    url     := 'https://ehowgjardagevnrluult.supabase.co/functions/v1/quality-guardian',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'edge_service_role_key'
      )
    ),
    body    := '{"triggered_by":"schedule"}'::jsonb
  );
  $job$
);

-- Migration record
INSERT INTO app_data._eq_migrations (name) VALUES ('060_quality_guardian_cron_sks')
ON CONFLICT (name) DO NOTHING;
