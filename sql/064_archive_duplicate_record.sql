-- ============================================================================
-- 064 — eq_archive_duplicate_record: one-click archive from the Remediation
-- Queue's "Other duplicate flags" list
-- ============================================================================
-- Royce, looking at that list: "can we just identify and fix in one screen?"
-- Today the only action is Dismiss, which just clears the flag — the actual
-- archive happens on the Staff/Contacts pages in eq-shell, a different app.
--
-- Traced what "archive" does there (eq-shell's entityActions.ts / entity-patch
-- + entity-actions Netlify functions): a plain boolean flip, session-cookie
-- authenticated, no cascade — staff sets active=false AND on_roster=false in
-- the same call (a hand-maintained convention, not enforced elsewhere);
-- contacts sets active=false only. Two DB triggers fire automatically on
-- either table regardless of write path (staff_guard_reactivation, 0209;
-- staff_stamp_deactivated_at, 0210) — nothing special needed here.
--
-- This RPC replicates that exact field set so eq-intake's Remediation Queue
-- can archive a flagged duplicate directly, tenant-JWT scoped like every
-- other RPC in this file — not a raw table update from the client, and not
-- reusing eq-shell's session-cookie path (a different app can't reuse it).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.eq_archive_duplicate_record(
  p_table   text,
  p_row_id  uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_tenant_id uuid;
  v_rc        int;
BEGIN
  v_tenant_id := (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_archive_duplicate_record: no tenant_id in JWT';
  END IF;

  IF p_table = 'staff' THEN
    UPDATE app_data.staff
    SET active = false, on_roster = false, updated_at = now()
    WHERE staff_id = p_row_id AND tenant_id = v_tenant_id;
  ELSIF p_table = 'contacts' THEN
    UPDATE app_data.contacts
    SET active = false, updated_at = now()
    WHERE contact_id = p_row_id AND tenant_id = v_tenant_id;
  ELSE
    RAISE EXCEPTION 'eq_archive_duplicate_record: table "%" is not allowed', p_table;
  END IF;

  GET DIAGNOSTICS v_rc = ROW_COUNT;

  RETURN json_build_object('applied', v_rc);
END;
$$;

COMMENT ON FUNCTION public.eq_archive_duplicate_record(text, uuid) IS
  'Archives a flagged duplicate staff or contact record (active=false; staff also on_roster=false) '
  'directly from the Remediation Queue, without leaving eq-intake for the Staff/Contacts page. '
  'JWT tenant-scoped, whitelisted to staff/contacts only.';

GRANT EXECUTE ON FUNCTION public.eq_archive_duplicate_record(text, uuid) TO authenticated;

INSERT INTO app_data._eq_migrations (name, checksum) VALUES ('064_archive_duplicate_record', 'eq-intake-lineage')
ON CONFLICT (name) DO NOTHING;
