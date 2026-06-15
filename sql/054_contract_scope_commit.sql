-- 054_contract_scope_commit.sql
--
-- Open the service-domain Intake commit door for contract_scopes.
--
-- Until now eq_intake_commit_batch_service accepted only 'assets'. This adds a
-- 'contract_scopes' branch so the canonical contract-scope entity
-- (app_data.contract_scopes, created by the eq-shell tenant-migration
-- 0123_contract_scope_canonical) can be committed through the standard Intake
-- pipeline (provenance via _eq_intake_apply_metadata, eq_intake_events audit).
--
-- Semantics for contract_scopes:
--   • import_mode 'append'  → plain insert.
--   • import_mode 'replace' → SITE + financial_year scoped wipe (mirrors the legacy
--     wipe_and_replace_contract_scopes: clears existing scope for each distinct
--     (customer_id, site_id, financial_year) present in the batch) then insert.
--     Requires p_confirm_replace = true.
--   • import_mode 'upsert'  → NOT supported (contract_scopes has no natural import key).
--
-- contract_scopes rows are new (no scope_id from the source sheet), and
-- _eq_intake_apply_metadata does not mint a PK, so this branch generates scope_id
-- per row before the populate-record insert (otherwise the PK would insert NULL).
--
-- The 'assets' branch is reproduced verbatim from the prior definition — no change.
-- Idempotent: CREATE OR REPLACE.

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

  -- ── replace pre-delete ────────────────────────────────────────────────
  IF p_import_mode = 'replace' THEN
    IF NOT p_confirm_replace THEN RAISE EXCEPTION 'replace requires p_confirm_replace=true'; END IF;

    IF p_table = 'assets' THEN
      EXECUTE format('DELETE FROM app_data.%I WHERE tenant_id = $1 AND imported_from = $2', p_table)
        USING p_tenant_id, p_source_sig;

    ELSIF p_table = 'contract_scopes' THEN
      -- Site + year scoped wipe — clears existing scope for each distinct
      -- (customer_id, site_id, financial_year) present in the batch.
      DELETE FROM app_data.contract_scopes cs
      USING (
        SELECT DISTINCT
          (r ->> 'customer_id')::uuid          AS customer_id,
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

  -- ── per-row insert ────────────────────────────────────────────────────
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
      -- New rows have no scope_id; mint one (the base record nulls it otherwise,
      -- overriding the column default and violating the PK).
      IF NULLIF(v_row ->> 'scope_id', '') IS NULL THEN
        v_row := v_row || jsonb_build_object('scope_id', gen_random_uuid());
      END IF;
      -- append + replace both land as inserts (replace pre-deleted above).
      INSERT INTO app_data.contract_scopes
        SELECT * FROM jsonb_populate_record(NULL::app_data.contract_scopes, v_row)
        RETURNING scope_id INTO v_id;
    END IF;

    IF v_id IS NOT NULL THEN
      v_count := v_count + 1;
      v_ids   := array_append(v_ids, v_id);
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_count, v_ids;
END
$function$;
