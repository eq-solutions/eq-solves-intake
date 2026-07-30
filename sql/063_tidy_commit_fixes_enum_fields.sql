-- ============================================================================
-- 063 — eq_tidy_commit_fixes: whitelist the two enum fields that gate real gaps
-- ============================================================================
-- Royce, looking at the Customers Tidy tab: "Type" gaps show "company" is not
-- a recognised value. Allowed: lead, prospect, active, churned" — but there
-- was no way to actually save a fix for it. Traced live (062's whitelist,
-- confirmed via pg_get_functiondef, not just the sql/ file) and found
-- customers.type and sites.site_type are both closed-enum fields the tidy
-- scan already flags as gaps (customer.schema.json / site.schema.json), but
-- neither was ever added to eq_tidy_commit_fixes' per-(table:field)
-- whitelist — every Edit/Suggest fix on either field silently no-ops
-- (v_skipped++, applied stays 0), independent of the frontend.
--
-- Companion client fix (eq-solves-intake, same session): the Tidy tab's
-- gap-row Edit/Suggest actions were also never wired to commitTidyFixes at
-- all (local React state only) — that part is fixed client-side. This
-- migration is the other half: without it, the wiring would just surface
-- "server rejected this field" for these two fields specifically.
--
-- No other schema enum fields are missing — staff.employment_type and
-- licence.state are already whitelisted (062).
-- ============================================================================

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
    'customers:postcode','customers:country','customers:type',
    'sites:name','sites:address_line_1','sites:address_line_2','sites:suburb','sites:state',
    'sites:postcode','sites:country','sites:site_contact_phone','sites:site_contact_email',
    'sites:site_type',
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

GRANT EXECUTE ON FUNCTION public.eq_tidy_commit_fixes(uuid, json) TO authenticated;

INSERT INTO app_data._eq_migrations (name, checksum) VALUES ('063_tidy_commit_fixes_enum_fields', 'eq-intake-lineage')
ON CONFLICT (name) DO NOTHING;
