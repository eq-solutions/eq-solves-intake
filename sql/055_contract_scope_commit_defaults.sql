-- 055_contract_scope_commit_defaults.sql
--
-- Forward-fix of 054: the contract_scopes commit branch nulled NOT-NULL columns
-- that have defaults. jsonb_populate_record(NULL::app_data.contract_scopes, v_row)
-- fills every column absent from the source row with NULL, OVERRIDING the column
-- DEFAULT — so a sparse import row hit `null value in column "lifecycle_status"
-- violates not-null constraint` (and would equally null cycle_costs/year_totals/
-- due_years/labour_hours_per_asset, has_bundled_scope/commercial_gap, is_included, active).
--
-- Fix: merge canonical defaults into v_row before the insert (v_row keys win where
-- present). Already applied to ehow directly (via MCP, when apply-migrations creds
-- were unavailable); this lands the same correction in the source so a fleet
-- apply-migrations run does not regress it. Idempotent CREATE OR REPLACE; the assets
-- branch is unchanged from 054.

CREATE OR REPLACE FUNCTION public.eq_intake_commit_batch_service(
  p_intake_id      uuid,
  p_tenant_id      uuid,
  p_table          text,
  p_rows           jsonb,
  p_source_sig     text,
  p_schema_version text,
  p_import_mode    text DEFAULT 'append'::text,
  p_confirm_replace boolean DEFAULT false
)
RETURNS TABLE(committed_count integer, committed_ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app_data', 'shell_control', 'public', 'extensions'
AS $function$
DECLARE
  v_count int := 0;
  v_ids   uuid[] := ARRAY[]::uuid[];
  v_row   jsonb;
  v_id    uuid;
BEGIN
  IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'p_tenant_id is required'; END IF;
  IF p_intake_id IS NULL THEN RAISE EXCEPTION 'p_intake_id is required'; END IF;
  IF p_table NOT IN ('assets', 'contract_scopes') THEN
    RAISE EXCEPTION 'table % not service-domain (supported: assets, contract_scopes)', p_table;
  END IF;
  IF p_import_mode NOT IN ('append', 'upsert', 'replace') THEN
    RAISE EXCEPTION 'invalid import_mode: % (expected append | upsert | replace)', p_import_mode;
  END IF;
  IF p_table = 'contract_scopes' AND p_import_mode = 'upsert' THEN
    RAISE EXCEPTION 'upsert not supported for contract_scopes (no natural import key) — use append or replace';
  END IF;

  PERFORM _eq_intake_check_tenant_match(p_tenant_id);

  IF p_import_mode = 'replace' THEN
    IF NOT p_confirm_replace THEN RAISE EXCEPTION 'replace requires p_confirm_replace=true'; END IF;

    IF p_table = 'assets' THEN
      EXECUTE format('DELETE FROM app_data.%I WHERE tenant_id = $1 AND imported_from = $2', p_table)
        USING p_tenant_id, p_source_sig;

    ELSIF p_table = 'contract_scopes' THEN
      DELETE FROM app_data.contract_scopes cs
      USING (
        SELECT DISTINCT
          NULLIF(r ->> 'customer_id', '')::uuid AS customer_id,
          NULLIF(r ->> 'site_id', '')::uuid     AS site_id,
          r ->> 'financial_year'                AS financial_year
        FROM jsonb_array_elements(p_rows) AS r
      ) k
      WHERE cs.tenant_id      = p_tenant_id
        AND cs.customer_id    = k.customer_id
        AND cs.financial_year = k.financial_year
        AND cs.site_id IS NOT DISTINCT FROM k.site_id;
    END IF;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_row := _eq_intake_apply_metadata(v_row, p_tenant_id, p_intake_id, p_source_sig, p_schema_version);

    IF p_table = 'assets' THEN
      IF p_import_mode = 'upsert' THEN
        INSERT INTO app_data.assets
          SELECT * FROM jsonb_populate_record(NULL::app_data.assets, v_row)
          ON CONFLICT (asset_id) DO UPDATE SET
            external_id            = EXCLUDED.external_id,
            site_id                = EXCLUDED.site_id,
            parent_asset_id        = EXCLUDED.parent_asset_id,
            asset_type             = EXCLUDED.asset_type,
            name                   = EXCLUDED.name,
            make                   = EXCLUDED.make,
            model                  = EXCLUDED.model,
            serial_number          = EXCLUDED.serial_number,
            rating                 = EXCLUDED.rating,
            install_date           = EXCLUDED.install_date,
            warranty_expires       = EXCLUDED.warranty_expires,
            criticality            = EXCLUDED.criticality,
            condition              = EXCLUDED.condition,
            service_schedule_id    = EXCLUDED.service_schedule_id,
            ppm_frequency          = EXCLUDED.ppm_frequency,
            last_service_date      = EXCLUDED.last_service_date,
            next_service_due       = EXCLUDED.next_service_due,
            location_in_site       = EXCLUDED.location_in_site,
            barcode                = EXCLUDED.barcode,
            active                 = EXCLUDED.active,
            defects_summary        = EXCLUDED.defects_summary,
            client_classification  = EXCLUDED.client_classification,
            notes                  = EXCLUDED.notes,
            imported_at            = EXCLUDED.imported_at,
            imported_from          = EXCLUDED.imported_from,
            intake_id              = EXCLUDED.intake_id,
            schema_version         = EXCLUDED.schema_version
          RETURNING asset_id INTO v_id;
      ELSE
        INSERT INTO app_data.assets
          SELECT * FROM jsonb_populate_record(NULL::app_data.assets, v_row)
          RETURNING asset_id INTO v_id;
      END IF;

    ELSIF p_table = 'contract_scopes' THEN
      -- Apply canonical defaults for NOT NULL columns absent from the source row
      -- (v_row keys override the defaults below where present).
      v_row := jsonb_build_object(
        'lifecycle_status',       'committed',
        'is_included',            true,
        'active',                 true,
        'billing_basis',          'fixed',
        'cycle_costs',            '{}'::jsonb,
        'year_totals',            '{}'::jsonb,
        'due_years',              '{}'::jsonb,
        'labour_hours_per_asset', '{}'::jsonb,
        'has_bundled_scope',      false,
        'commercial_gap',         false
      ) || v_row;
      -- New rows have no scope_id; mint one (populate_record would null the PK otherwise).
      IF NULLIF(v_row ->> 'scope_id', '') IS NULL THEN
        v_row := v_row || jsonb_build_object('scope_id', gen_random_uuid());
      END IF;
      INSERT INTO app_data.contract_scopes
        SELECT * FROM jsonb_populate_record(NULL::app_data.contract_scopes, v_row)
        RETURNING scope_id INTO v_id;
    END IF;

    IF v_id IS NOT NULL THEN
      v_count := v_count + 1;
      v_ids   := array_append(v_ids, v_id);
    END IF;
  END LOOP;

  PERFORM _eq_intake_record_committed(p_intake_id, v_count);
  RETURN QUERY SELECT v_count, v_ids;
END
$function$;

GRANT EXECUTE ON FUNCTION public.eq_intake_commit_batch_service(uuid, uuid, text, jsonb, text, text, text, boolean) TO authenticated;
