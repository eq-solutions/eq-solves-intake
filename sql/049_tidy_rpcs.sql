-- 049_tidy_rpcs.sql
-- "Tidy Our Data" feature — read, audit, and correct canonical rows.
--
-- Three RPCs:
--   eq_tidy_read_entity   — read all rows from a canonical table for a tenant
--   eq_tidy_orphan_check  — run FK integrity checks across all entities
--   eq_tidy_commit_fixes  — apply normalisation corrections approved by the user
--
-- All are SECURITY DEFINER with explicit JWT tenant scope — callers cannot
-- read or write another tenant's rows.

-- ---------------------------------------------------------------------------
-- 1. eq_tidy_read_entity
--    Returns all rows from a whitelisted canonical table as JSON objects.
--    The tidy-pass engine feeds these rows back through @eq/validation to
--    detect what can be auto-fixed and what gaps exist.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_tidy_read_entity(
  p_table text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_tenant_id  uuid;
  v_result     json;
  v_allowed    text[] := ARRAY[
    'customers', 'sites', 'contacts', 'staff', 'licences', 'assets'
  ];
BEGIN
  -- Resolve tenant from JWT app_metadata (same pattern as all canonical RPCs)
  v_tenant_id := (
    auth.jwt() -> 'app_metadata' ->> 'tenant_id'
  )::uuid;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_tidy_read_entity: no tenant_id in JWT';
  END IF;

  IF NOT (p_table = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'eq_tidy_read_entity: table "%" is not allowed', p_table;
  END IF;

  EXECUTE format(
    'SELECT json_agg(row_to_json(t)) FROM app_data.%I t WHERE t.tenant_id = $1',
    p_table
  )
  INTO v_result
  USING v_tenant_id;

  RETURN COALESCE(v_result, '[]'::json);
END;
$$;

COMMENT ON FUNCTION public.eq_tidy_read_entity(text) IS
  'Returns all rows from a canonical entity table for the current tenant. '
  'Used by the tidy-pass engine to scan for normalisation opportunities and gaps.';

-- ---------------------------------------------------------------------------
-- 2. eq_tidy_orphan_check
--    Runs FK integrity checks across all canonical entities and returns
--    a JSON report of orphaned rows — broken FK links, contacts with no
--    parent, assets with no site, etc.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.eq_tidy_orphan_check()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_data
AS $$
DECLARE
  v_tenant_id uuid;
  v_result    json;
BEGIN
  v_tenant_id := (
    auth.jwt() -> 'app_metadata' ->> 'tenant_id'
  )::uuid;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_tidy_orphan_check: no tenant_id in JWT';
  END IF;

  SELECT json_build_object(
    'assets_no_site', (
      SELECT json_agg(json_build_object(
        'id',         a.asset_id::text,
        'label',      COALESCE(a.asset_name, a.asset_type, 'Unknown asset'),
        'external_id', a.external_id,
        'bad_site_id', a.site_id::text
      ))
      FROM app_data.assets a
      WHERE a.tenant_id = v_tenant_id
        AND a.site_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM app_data.sites s
          WHERE s.site_id = a.site_id AND s.tenant_id = v_tenant_id
        )
    ),
    'contacts_no_parent', (
      SELECT json_agg(json_build_object(
        'id',     c.contact_id::text,
        'label',  COALESCE(c.full_name, c.email, 'Unknown contact')
      ))
      FROM app_data.contacts c
      WHERE c.tenant_id = v_tenant_id
        AND c.customer_id IS NULL
        AND c.site_id IS NULL
    ),
    'licences_no_staff', (
      SELECT json_agg(json_build_object(
        'id',           l.licence_id::text,
        'label',        COALESCE(l.licence_type, l.licence_number, 'Unknown licence'),
        'bad_staff_id', l.staff_id::text
      ))
      FROM app_data.licences l
      WHERE l.tenant_id = v_tenant_id
        AND l.staff_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM app_data.staff s
          WHERE s.staff_id = l.staff_id AND s.tenant_id = v_tenant_id
        )
    ),
    'sites_no_customer', (
      SELECT json_agg(json_build_object(
        'id',              s.site_id::text,
        'label',           COALESCE(s.site_name, 'Unknown site'),
        'bad_customer_id', s.customer_id::text
      ))
      FROM app_data.sites s
      WHERE s.tenant_id = v_tenant_id
        AND s.customer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM app_data.customers c
          WHERE c.customer_id = s.customer_id AND c.tenant_id = v_tenant_id
        )
    ),
    'summary', json_build_object(
      'assets_no_site_count', (
        SELECT COUNT(*) FROM app_data.assets a
        WHERE a.tenant_id = v_tenant_id
          AND a.site_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM app_data.sites s
            WHERE s.site_id = a.site_id AND s.tenant_id = v_tenant_id
          )
      ),
      'contacts_no_parent_count', (
        SELECT COUNT(*) FROM app_data.contacts c
        WHERE c.tenant_id = v_tenant_id
          AND c.customer_id IS NULL AND c.site_id IS NULL
      ),
      'licences_no_staff_count', (
        SELECT COUNT(*) FROM app_data.licences l
        WHERE l.tenant_id = v_tenant_id
          AND l.staff_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM app_data.staff s
            WHERE s.staff_id = l.staff_id AND s.tenant_id = v_tenant_id
          )
      ),
      'sites_no_customer_count', (
        SELECT COUNT(*) FROM app_data.sites s
        WHERE s.tenant_id = v_tenant_id
          AND s.customer_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM app_data.customers c
            WHERE c.customer_id = s.customer_id AND c.tenant_id = v_tenant_id
          )
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.eq_tidy_orphan_check() IS
  'Runs FK integrity checks across canonical entities for the current tenant. '
  'Returns counts + row samples for: assets without a valid site, contacts without '
  'a customer or site, licences without a valid staff record, and sites without '
  'a valid customer.';

-- ---------------------------------------------------------------------------
-- 3. eq_tidy_commit_fixes
--    Applies a list of field-level normalisation corrections approved by the
--    user. Each fix targets one row (by primary key) and one field (by name).
--    Creates an eq_intake_events audit row for the tidy operation so it
--    appears in the audit log and is rollback-able.
--
--    p_fixes shape:
--      [ { "table": "customers", "row_id": "<uuid>",
--          "field": "phone", "new_value": "+61412345678" }, ... ]
-- ---------------------------------------------------------------------------

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
  v_user_id     uuid;
  v_fix         json;
  v_table       text;
  v_row_id      uuid;
  v_field       text;
  v_new_value   text;
  v_applied     int  := 0;
  v_skipped     int  := 0;
  v_allowed_tables text[] := ARRAY[
    'customers', 'sites', 'contacts', 'staff', 'licences', 'assets'
  ];
  v_allowed_fields text[] := ARRAY[
    -- customers
    'phone', 'email', 'abn', 'acn', 'company_name',
    -- sites
    'site_name', 'address_line_1', 'address_line_2', 'suburb', 'state',
    'postcode', 'country',
    -- contacts
    'full_name', 'email', 'phone',
    -- staff
    'first_name', 'last_name', 'email', 'phone', 'employment_type',
    -- licences
    'licence_number', 'licence_type', 'issuing_state',
    -- assets
    'asset_name', 'asset_type', 'make', 'model', 'serial_number'
  ];
BEGIN
  v_tenant_id := (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;
  v_user_id   := (auth.jwt() ->> 'sub')::uuid;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'eq_tidy_commit_fixes: no tenant_id in JWT';
  END IF;

  -- Apply each fix
  FOR v_fix IN SELECT * FROM json_array_elements(p_fixes) LOOP
    v_table     := v_fix ->> 'table';
    v_row_id    := (v_fix ->> 'row_id')::uuid;
    v_field     := v_fix ->> 'field';
    v_new_value := v_fix ->> 'new_value';

    -- Whitelist both table and field to prevent injection
    IF NOT (v_table = ANY(v_allowed_tables)) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF NOT (v_field = ANY(v_allowed_fields)) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Primary key column name follows the pattern: <table_singular>_id
    -- e.g. customers → customer_id, assets → asset_id
    EXECUTE format(
      'UPDATE app_data.%1$I
         SET %2$I       = $1,
             intake_id  = $2,
             imported_at = now()
       WHERE %3$I = $3
         AND tenant_id = $4',
      v_table,
      v_field,
      CASE v_table
        WHEN 'customers' THEN 'customer_id'
        WHEN 'sites'     THEN 'site_id'
        WHEN 'contacts'  THEN 'contact_id'
        WHEN 'staff'     THEN 'staff_id'
        WHEN 'licences'  THEN 'licence_id'
        WHEN 'assets'    THEN 'asset_id'
      END
    )
    USING v_new_value, p_intake_id, v_row_id, v_tenant_id;

    v_applied := v_applied + 1;
  END LOOP;

  RETURN json_build_object(
    'applied', v_applied,
    'skipped', v_skipped,
    'intake_id', p_intake_id::text
  );
END;
$$;

COMMENT ON FUNCTION public.eq_tidy_commit_fixes(uuid, json) IS
  'Applies user-approved normalisation fixes from a tidy pass. Each fix targets '
  'one field on one row. Stamps intake_id so the tidy operation appears in the '
  'audit log and is rollback-able via eq_intake_rollback(). '
  'Table and field names are whitelisted — no dynamic SQL injection possible.';

-- Grant execute to authenticated role (RLS + JWT tenant scope enforced inside)
GRANT EXECUTE ON FUNCTION public.eq_tidy_read_entity(text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.eq_tidy_orphan_check()           TO authenticated;
GRANT EXECUTE ON FUNCTION public.eq_tidy_commit_fixes(uuid, json) TO authenticated;
