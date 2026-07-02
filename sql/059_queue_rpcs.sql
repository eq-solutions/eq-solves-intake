-- ============================================================================
-- 059 — Review-queue RPCs + tidy whitelist extension
-- ============================================================================
-- Gives the dashboard's Queue tab a browser-safe surface over
-- app_data.eq_remediation_queue (app_data is not PostgREST-exposed, so all
-- access goes through SECURITY DEFINER RPCs, JWT-tenant-scoped like 049).
--
--   eq_queue_list()          -> pending queue rows for the caller's tenant
--   eq_queue_open_event(...) -> creates an eq_intake_events row, returns id
--   eq_queue_close_event(..) -> completes the event with real counts
--   eq_queue_resolve(...)    -> marks a queue row approved/dismissed/committed
--
-- Also: eq_tidy_commit_fixes is re-created with a per-(table:field) whitelist
-- that now includes staff:trade and contacts:customer_id (uuid-cast branch),
-- aligning the browser path with 058's tighter design. Run-001 lesson: trade
-- fixes previously had no sanctioned browser path at all.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- eq_queue_list
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eq_queue_list()
RETURNS SETOF app_data.eq_remediation_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
  SELECT * FROM app_data.eq_remediation_queue
  WHERE tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    AND status = 'pending'
  ORDER BY category, record_label;
$$;

-- ----------------------------------------------------------------------------
-- eq_queue_open_event — browser-safe intake-event creation (tenant + user
-- derived from the JWT, never passed by the client)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eq_queue_open_event(p_entity text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data, shell_control
AS $$
DECLARE
  v_tenant uuid := (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;
  v_user   uuid := (auth.jwt() ->> 'sub')::uuid;
  v_id     uuid := gen_random_uuid();
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'eq_queue_open_event: tenant_id and sub required in JWT';
  END IF;
  INSERT INTO shell_control.eq_intake_events
    (intake_id, tenant_id, entity, source_kind, source_filename,
     schema_version, status, import_mode, created_by)
  VALUES
    (v_id, v_tenant, p_entity, 'remediation', 'queue-approval',
     '1.0.0', 'committing', 'upsert', v_user);
  RETURN v_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- eq_queue_close_event
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eq_queue_close_event(p_intake_id uuid, p_committed int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, shell_control
AS $$
DECLARE
  v_tenant uuid := (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;
BEGIN
  UPDATE shell_control.eq_intake_events
  SET status = 'completed', rows_committed = p_committed, completed_at = now()
  WHERE intake_id = p_intake_id AND tenant_id = v_tenant;
END;
$$;

-- ----------------------------------------------------------------------------
-- eq_queue_resolve
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eq_queue_resolve(
  p_queue_id uuid,
  p_status   text,
  p_note     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_tenant uuid := (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;
  v_user   uuid := (auth.jwt() ->> 'sub')::uuid;
BEGIN
  IF p_status NOT IN ('approved','dismissed','committed') THEN
    RAISE EXCEPTION 'eq_queue_resolve: invalid status %', p_status;
  END IF;
  UPDATE app_data.eq_remediation_queue
  SET status = p_status, resolved_at = now(), resolved_by = v_user,
      resolution_note = p_note
  WHERE queue_id = p_queue_id AND tenant_id = v_tenant AND status = 'pending';
END;
$$;

-- ----------------------------------------------------------------------------
-- eq_tidy_commit_fixes — re-created with per-(table:field) whitelist
-- (adds staff:trade + contacts:customer_id; signature unchanged)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eq_tidy_commit_fixes(
  p_intake_id  uuid,
  p_fixes      json
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data, shell_control
AS $$
DECLARE
  v_tenant_id   uuid;
  v_fix         json;
  v_table       text;
  v_row_id      uuid;
  v_field       text;
  v_new_value   text;
  v_rc          int;
  v_applied     int  := 0;
  v_skipped     int  := 0;
  v_allowed text[] := ARRAY[
    'customers:primary_phone','customers:mobile_phone','customers:alt_phone','customers:email',
    'customers:abn','customers:acn','customers:company_name','customers:state','customers:suburb',
    'customers:postcode','customers:country',
    'sites:name','sites:address_line_1','sites:address_line_2','sites:suburb','sites:state',
    'sites:postcode','sites:country','sites:site_contact_phone','sites:site_contact_email',
    'contacts:first_name','contacts:last_name','contacts:work_phone','contacts:mobile_phone',
    'contacts:email','contacts:customer_id',
    'staff:first_name','staff:last_name','staff:email','staff:phone','staff:employment_type',
    'staff:address_state','staff:address_suburb','staff:address_postcode','staff:trade',
    'staff:emergency_contact_name','staff:emergency_contact_mobile','staff:emergency_contact_relationship',
    'licences:licence_number','licences:licence_type','licences:state',
    'assets:name','assets:asset_type','assets:make','assets:model','assets:serial_number'
  ];
BEGIN
  v_tenant_id := (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_tidy_commit_fixes: no tenant_id in JWT';
  END IF;

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
      EXECUTE format(
        'UPDATE app_data.%1$I SET %2$I = $1::uuid, intake_id = $2, imported_at = now()
         WHERE %3$I = $3 AND tenant_id = $4',
        v_table, v_field,
        CASE v_table WHEN 'customers' THEN 'customer_id' WHEN 'sites' THEN 'site_id'
          WHEN 'contacts' THEN 'contact_id' WHEN 'staff' THEN 'staff_id'
          WHEN 'licences' THEN 'licence_id' WHEN 'assets' THEN 'asset_id' END)
      USING v_new_value, p_intake_id, v_row_id, v_tenant_id;
    ELSE
      EXECUTE format(
        'UPDATE app_data.%1$I SET %2$I = $1, intake_id = $2, imported_at = now()
         WHERE %3$I = $3 AND tenant_id = $4',
        v_table, v_field,
        CASE v_table WHEN 'customers' THEN 'customer_id' WHEN 'sites' THEN 'site_id'
          WHEN 'contacts' THEN 'contact_id' WHEN 'staff' THEN 'staff_id'
          WHEN 'licences' THEN 'licence_id' WHEN 'assets' THEN 'asset_id' END)
      USING v_new_value, p_intake_id, v_row_id, v_tenant_id;
    END IF;

    GET DIAGNOSTICS v_rc = ROW_COUNT;
    IF v_rc > 0 THEN v_applied := v_applied + v_rc; ELSE v_skipped := v_skipped + 1; END IF;
  END LOOP;

  RETURN json_build_object(
    'applied', v_applied,
    'skipped', v_skipped,
    'intake_id', p_intake_id::text
  );
END;
$$;

COMMENT ON FUNCTION public.eq_tidy_commit_fixes(uuid, json) IS
  'Applies user-approved field fixes (tidy pass + review queue). Per-(table:field) '
  'whitelist; stamps intake_id for audit/rollback. JWT tenant-scoped.';

REVOKE EXECUTE ON FUNCTION public.eq_queue_list() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.eq_queue_open_event(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.eq_queue_close_event(uuid, int) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.eq_queue_resolve(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eq_queue_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.eq_queue_open_event(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.eq_queue_close_event(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.eq_queue_resolve(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.eq_tidy_commit_fixes(uuid, json) TO authenticated;

INSERT INTO app_data._eq_migrations (name) VALUES ('059_queue_rpcs')
ON CONFLICT (name) DO NOTHING;
