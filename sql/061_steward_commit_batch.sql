-- ============================================================================
-- 061 — eq_steward_commit_batch: the data steward's sanctioned write path
-- ============================================================================
-- The tidy RPC (049) is JWT-scoped and its field whitelist excludes trade and
-- customer_id — right for the browser UI, wrong for a server-side steward.
-- This function is the server-side counterpart:
--
--   * explicit p_tenant_id (server contexts have no JWT to derive from)
--   * per-(table:field) whitelist — tighter than 049's flat field list
--   * full intake-event lifecycle inside the call: creates the event,
--     applies fixes, completes the event with REAL applied counts
--   * every touched row stamped with the intake_id (audit + rollback)
--   * EXECUTE granted to service_role ONLY — no browser/user path
--
-- p_fixes shape (same as eq_tidy_commit_fixes):
--   [ { "table": "staff", "row_id": "<uuid>", "field": "trade",
--       "new_value": "electrical" }, ... ]
-- ============================================================================

CREATE OR REPLACE FUNCTION public.eq_steward_commit_batch(
  p_tenant_id       uuid,
  p_entity          text,      -- event label, singular: 'staff' | 'contact' | ...
  p_source_filename text,      -- steward run id, e.g. 'steward-run-001-2026-07-02'
  p_created_by      uuid,      -- auth user the run is executed on behalf of
  p_fixes           json
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data, shell_control
AS $$
DECLARE
  v_intake_id  uuid := gen_random_uuid();
  v_fix        json;
  v_table      text;
  v_row_id     uuid;
  v_field      text;
  v_new_value  text;
  v_rc         int;
  v_applied    int := 0;
  v_skipped    int := 0;
  -- Whitelist is per table:field pair — a field allowed on one table is NOT
  -- implicitly allowed on another (tighter than 049).
  v_allowed text[] := ARRAY[
    'customers:primary_phone','customers:mobile_phone','customers:email',
    'customers:abn','customers:state','customers:suburb','customers:postcode',
    'sites:state','sites:postcode','sites:site_contact_phone','sites:site_contact_email',
    'contacts:work_phone','contacts:mobile_phone','contacts:email','contacts:customer_id',
    'staff:email','staff:phone','staff:trade',
    'staff:emergency_contact_name','staff:emergency_contact_mobile','staff:emergency_contact_relationship',
    'licences:licence_number','licences:state'
  ];
BEGIN
  IF p_tenant_id IS NULL OR p_created_by IS NULL THEN
    RAISE EXCEPTION 'eq_steward_commit_batch: tenant_id and created_by are required';
  END IF;

  INSERT INTO shell_control.eq_intake_events
    (intake_id, tenant_id, entity, source_kind, source_filename,
     schema_version, status, import_mode, created_by)
  VALUES
    (v_intake_id, p_tenant_id, p_entity, 'remediation', p_source_filename,
     '1.0.0', 'committing', 'upsert', p_created_by);

  FOR v_fix IN SELECT * FROM json_array_elements(p_fixes) LOOP
    v_table     := v_fix ->> 'table';
    v_row_id    := (v_fix ->> 'row_id')::uuid;
    v_field     := v_fix ->> 'field';
    v_new_value := v_fix ->> 'new_value';

    IF NOT (v_table || ':' || v_field = ANY(v_allowed)) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF v_field = 'customer_id' THEN
      -- uuid-typed target column
      EXECUTE format(
        'UPDATE app_data.%1$I SET %2$I = $1::uuid, intake_id = $2, imported_at = now()
         WHERE %3$I = $3 AND tenant_id = $4',
        v_table, v_field,
        CASE v_table WHEN 'customers' THEN 'customer_id' WHEN 'sites' THEN 'site_id'
          WHEN 'contacts' THEN 'contact_id' WHEN 'staff' THEN 'staff_id'
          WHEN 'licences' THEN 'licence_id' END)
      USING v_new_value, v_intake_id, v_row_id, p_tenant_id;
    ELSE
      EXECUTE format(
        'UPDATE app_data.%1$I SET %2$I = $1, intake_id = $2, imported_at = now()
         WHERE %3$I = $3 AND tenant_id = $4',
        v_table, v_field,
        CASE v_table WHEN 'customers' THEN 'customer_id' WHEN 'sites' THEN 'site_id'
          WHEN 'contacts' THEN 'contact_id' WHEN 'staff' THEN 'staff_id'
          WHEN 'licences' THEN 'licence_id' END)
      USING v_new_value, v_intake_id, v_row_id, p_tenant_id;
    END IF;

    GET DIAGNOSTICS v_rc = ROW_COUNT;
    IF v_rc > 0 THEN v_applied := v_applied + v_rc; ELSE v_skipped := v_skipped + 1; END IF;
  END LOOP;

  UPDATE shell_control.eq_intake_events
  SET status = 'completed', rows_committed = v_applied, completed_at = now()
  WHERE intake_id = v_intake_id;

  RETURN json_build_object(
    'intake_id', v_intake_id::text,
    'applied',   v_applied,
    'skipped',   v_skipped
  );
END;
$$;

COMMENT ON FUNCTION public.eq_steward_commit_batch(uuid, text, text, uuid, json) IS
  'Server-side steward write path. Applies whitelisted field-level fixes with '
  'full intake-event lifecycle and per-row lineage stamps. service_role only — '
  'the browser path remains eq_tidy_commit_fixes (JWT-scoped).';

REVOKE ALL ON FUNCTION public.eq_steward_commit_batch(uuid, text, text, uuid, json) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.eq_steward_commit_batch(uuid, text, text, uuid, json) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eq_steward_commit_batch(uuid, text, text, uuid, json) TO service_role;

INSERT INTO app_data._eq_migrations (name, checksum) VALUES ('061_steward_commit_batch', 'eq-intake-lineage')
ON CONFLICT (name) DO NOTHING;
