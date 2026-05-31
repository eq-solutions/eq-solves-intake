-- ============================================================================
-- 025 — status column for prestart_checks and toolbox_talks
-- ============================================================================
-- Applies to: sks-canonical (ehowgjardagevnrluult) and eq-canonical.
--
-- Adds a workflow status column to both safety-record tables.
-- Status flow: draft → submitted → approved → rejected
--
-- draft     = captured on device / imported, not yet reviewed
-- submitted = submitted for supervisor sign-off
-- approved  = supervisor approved
-- rejected  = supervisor rejected (needs re-capture)
--
-- Defaults to 'draft' on all existing rows (additive, non-breaking).
-- RLS policies are unchanged — tenant isolation already covered by
-- the existing tenant_id CHECK constraints from migrations 001-015.
-- ============================================================================

-- ── Create the status enum type ───────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE safety_record_status AS ENUM ('draft', 'submitted', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── prestart_checks ───────────────────────────────────────────────────────────

ALTER TABLE app_data.prestart_checks
  ADD COLUMN IF NOT EXISTS status safety_record_status NOT NULL DEFAULT 'draft';

COMMENT ON COLUMN app_data.prestart_checks.status IS
  'Workflow status: draft → submitted → approved → rejected.';

-- Index for supervisor dashboard queries: "show me all submitted prestarts".
CREATE INDEX IF NOT EXISTS prestart_checks_status_idx
  ON app_data.prestart_checks(tenant_id, status);

-- ── toolbox_talks ─────────────────────────────────────────────────────────────

ALTER TABLE app_data.toolbox_talks
  ADD COLUMN IF NOT EXISTS status safety_record_status NOT NULL DEFAULT 'draft';

COMMENT ON COLUMN app_data.toolbox_talks.status IS
  'Workflow status: draft → submitted → approved → rejected.';

CREATE INDEX IF NOT EXISTS toolbox_talks_status_idx
  ON app_data.toolbox_talks(tenant_id, status);

-- ── RPC: approve_safety_record ────────────────────────────────────────────────
-- Single RPC handles both entity types to avoid code duplication in the
-- application layer. table_name must be one of the two allowed values
-- (hard-coded in the CASE, not passed raw — no SQL injection vector).

CREATE OR REPLACE FUNCTION app_data.approve_safety_record(
  p_tenant_id  uuid,
  p_record_id  uuid,
  p_table_name text    -- 'prestart_checks' or 'toolbox_talks'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data
AS $$
BEGIN
  IF p_table_name = 'prestart_checks' THEN
    UPDATE app_data.prestart_checks
      SET status = 'approved'
    WHERE prestart_id = p_record_id
      AND tenant_id   = p_tenant_id
      AND status      = 'submitted';

  ELSIF p_table_name = 'toolbox_talks' THEN
    UPDATE app_data.toolbox_talks
      SET status = 'approved'
    WHERE talk_id   = p_record_id
      AND tenant_id = p_tenant_id
      AND status    = 'submitted';

  ELSE
    RAISE EXCEPTION 'Unknown table: %', p_table_name;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Record not found or not in submitted state: % %', p_table_name, p_record_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_data.approve_safety_record(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_data.approve_safety_record(uuid, uuid, text) TO authenticated;

-- ── RPC: submit_safety_record ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_data.submit_safety_record(
  p_tenant_id  uuid,
  p_record_id  uuid,
  p_table_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data
AS $$
BEGIN
  IF p_table_name = 'prestart_checks' THEN
    UPDATE app_data.prestart_checks
      SET status = 'submitted'
    WHERE prestart_id = p_record_id
      AND tenant_id   = p_tenant_id
      AND status      = 'draft';

  ELSIF p_table_name = 'toolbox_talks' THEN
    UPDATE app_data.toolbox_talks
      SET status = 'submitted'
    WHERE talk_id   = p_record_id
      AND tenant_id = p_tenant_id
      AND status    = 'draft';

  ELSE
    RAISE EXCEPTION 'Unknown table: %', p_table_name;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Record not found or not in draft state: % %', p_table_name, p_record_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_data.submit_safety_record(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_data.submit_safety_record(uuid, uuid, text) TO authenticated;
