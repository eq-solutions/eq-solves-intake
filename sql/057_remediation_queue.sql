-- ============================================================================
-- 057 — Remediation review queue (data steward agent)
-- ============================================================================
-- DRAFT — NOT APPLIED. Apply only on Royce's explicit go (One Pipe rule).
--
-- Holds every remediation the autonomous data steward could NOT defensibly
-- auto-commit: the suggested value (when one exists), the evidence, and the
-- one-line reason a human needs to make the call. One row per (record, field).
--
-- Companion to the steward's commit path (eq_tidy_commit_fixes, migration 049)
-- which stamps intake_id on committed fixes — this table is the *other* half
-- of the steward's contract: "commit it, or queue it with a reason".
--
-- Conventions follow 053_quality_guardian.sql (app_data schema, RLS via
-- auth.jwt() -> 'app_metadata' ->> 'tenant_id' — the sks-canonical JWT path).
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_data.eq_remediation_queue (
  queue_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  run_id            text,                        -- steward run that produced this entry
  entity            text NOT NULL,               -- 'staff' | 'customers' | 'sites' | 'contacts' | 'licences'
  record_id         text NOT NULL,               -- PK of the affected row
  record_label      text NOT NULL,               -- human-readable ("Harry Barton")
  field             text NOT NULL,               -- affected column ('trade', 'email', 'customer_id', ...)
  category          text NOT NULL,               -- 'trade' | 'emergency_contact' | 'email' | 'format' | 'link' | 'duplicate'
  current_value     text,
  suggested_value   text,                        -- nullable — some gaps have no defensible suggestion
  confidence        text NOT NULL DEFAULT 'low',
  reason            text NOT NULL,               -- one line: why this needs a human
  evidence          text,                        -- what the data shows, for the reviewer
  status            text NOT NULL DEFAULT 'pending',
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid,
  resolution_note   text,

  CHECK (confidence IN ('high','medium','low')),
  CHECK (status IN ('pending','approved','dismissed','committed')),
  CHECK (category IN ('trade','emergency_contact','email','format','link','duplicate')),
  UNIQUE (tenant_id, entity, record_id, field, run_id)
);

CREATE INDEX IF NOT EXISTS idx_eq_remediation_queue_pending
  ON app_data.eq_remediation_queue (tenant_id, status, category)
  WHERE status = 'pending';

COMMENT ON TABLE app_data.eq_remediation_queue IS
  'Review queue written by the data remediation steward. Every flagged record the steward could not defensibly auto-fix lands here with a reason. Humans approve/dismiss; approved rows are committed via eq_tidy_commit_fixes so intake_id lineage still applies.';

ALTER TABLE app_data.eq_remediation_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eq_remediation_queue_select ON app_data.eq_remediation_queue;
CREATE POLICY eq_remediation_queue_select ON app_data.eq_remediation_queue
  FOR SELECT USING (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

DROP POLICY IF EXISTS eq_remediation_queue_update ON app_data.eq_remediation_queue;
CREATE POLICY eq_remediation_queue_update ON app_data.eq_remediation_queue
  FOR UPDATE USING (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  );

-- No INSERT policy for authenticated users: only the steward (service role,
-- which bypasses RLS) writes queue entries. Humans read + resolve.

-- Migration record
INSERT INTO app_data._eq_migrations (name) VALUES ('057_remediation_queue')
ON CONFLICT (name) DO NOTHING;
