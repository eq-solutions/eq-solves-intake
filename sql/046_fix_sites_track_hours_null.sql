-- 046_fix_sites_track_hours_null.sql
--
-- Problem: eq_intake_commit_batch_core uses jsonb_populate_record() to INSERT
-- into app_data.sites. When the incoming payload (e.g. a SimPRO export) omits
-- `track_hours`, jsonb_populate_record() supplies an explicit NULL — which
-- violates the NOT NULL constraint even though the column has DEFAULT false.
-- PostgreSQL only applies column defaults when a column is absent from the
-- INSERT column list; an explicit NULL bypasses the default.
--
-- Fix: prepend {"track_hours": false} to v_row before jsonb_populate_record()
-- using jsonb_build_object(...) || v_row.  The || operator gives the right
-- operand (v_row) priority, so any track_hours value already in the payload
-- wins; the default only kicks in when the key is absent.
--
-- Also guards induction_required (boolean NOT NULL DEFAULT false) for the same
-- reason — SimPRO exports don't include it either.

CREATE OR REPLACE FUNCTION public.eq_intake_commit_batch_core(
  p_intake_id        uuid,
  p_tenant_id        uuid,
  p_table            text,
  p_rows             jsonb,
  p_confirm_replace  boolean DEFAULT false,
  p_intake_mode      text    DEFAULT 'strict'
)
RETURNS TABLE (committed_count int, committed_ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, shell_control, public, extensions
AS $$
DECLARE
  v_count          int    := 0;
  v_ids            uuid[] := ARRAY[]::uuid[];
  v_row            jsonb;
  v_id             uuid;
  v_source_sig     text;
  v_import_mode    text;
  v_schema_version text;
  v_source_app     text;
  v_intake_mode    text;
  v_replace_count  int;
BEGIN
  PERFORM _eq_intake_check_tenant_match(p_tenant_id);

  IF p_table NOT IN ('customers','contacts','sites') THEN
    RAISE EXCEPTION 'table % is not a core-domain entity (expected: customers/contacts/sites)', p_table;
  END IF;

  SELECT source_signature, import_mode, schema_version, source_app, intake_mode
  INTO   v_source_sig, v_import_mode, v_schema_version, v_source_app, v_intake_mode
  FROM   _eq_intake_load_event_meta(p_intake_id, p_tenant_id);

  IF v_source_sig IS NULL THEN
    RAISE EXCEPTION 'intake_id % not found for tenant', p_intake_id;
  END IF;

  IF v_import_mode = 'replace' THEN
    IF NOT p_confirm_replace THEN
      RAISE EXCEPTION 'replace mode requires p_confirm_replace = true (destructive)';
    END IF;
    EXECUTE format('DELETE FROM app_data.%I WHERE tenant_id = $1 AND imported_from = $2', p_table)
      USING p_tenant_id, v_source_sig;
    GET DIAGNOSTICS v_replace_count = ROW_COUNT;
    RAISE NOTICE 'replace mode: deleted % prior rows from app_data.%', v_replace_count, p_table;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_row := _eq_intake_apply_metadata(v_row, p_tenant_id, p_intake_id, v_source_sig, v_schema_version);

    -- Generate UUID PKs when not supplied (SimPRO exports don't carry UUID keys)
    IF p_table = 'customers' AND ((v_row->>'customer_id') IS NULL OR (v_row->>'customer_id') = '') THEN
      v_row := v_row || jsonb_build_object('customer_id', gen_random_uuid()::text);
    ELSIF p_table = 'contacts' AND ((v_row->>'contact_id') IS NULL OR (v_row->>'contact_id') = '') THEN
      v_row := v_row || jsonb_build_object('contact_id', gen_random_uuid()::text);
    ELSIF p_table = 'sites' AND ((v_row->>'site_id') IS NULL OR (v_row->>'site_id') = '') THEN
      v_row := v_row || jsonb_build_object('site_id', gen_random_uuid()::text);
    END IF;

    -- Apply NOT NULL defaults for columns SimPRO exports omit.
    -- jsonb_build_object(...) || v_row: v_row wins on key collision, so any
    -- value already present in the payload is preserved unchanged.
    IF p_table = 'sites' THEN
      v_row := jsonb_build_object(
        'track_hours',       false,
        'induction_required', false
      ) || v_row;
    END IF;

    CASE p_table
      WHEN 'customers' THEN
        IF v_import_mode = 'upsert' THEN
          INSERT INTO app_data.customers SELECT * FROM jsonb_populate_record(NULL::app_data.customers, v_row)
          ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
          DO UPDATE SET
            company_name    = COALESCE(EXCLUDED.company_name,    customers.company_name),
            type            = COALESCE(EXCLUDED.type,            customers.type),
            first_name      = COALESCE(EXCLUDED.first_name,      customers.first_name),
            last_name       = COALESCE(EXCLUDED.last_name,       customers.last_name),
            salutation      = COALESCE(EXCLUDED.salutation,      customers.salutation),
            abn             = COALESCE(EXCLUDED.abn,             customers.abn),
            acn             = COALESCE(EXCLUDED.acn,             customers.acn),
            email           = COALESCE(EXCLUDED.email,           customers.email),
            primary_phone   = COALESCE(EXCLUDED.primary_phone,   customers.primary_phone),
            mobile_phone    = COALESCE(EXCLUDED.mobile_phone,    customers.mobile_phone),
            alt_phone       = COALESCE(EXCLUDED.alt_phone,       customers.alt_phone),
            website         = COALESCE(EXCLUDED.website,         customers.website),
            street_address  = COALESCE(EXCLUDED.street_address,  customers.street_address),
            suburb          = COALESCE(EXCLUDED.suburb,          customers.suburb),
            state           = COALESCE(EXCLUDED.state,           customers.state),
            postcode        = COALESCE(EXCLUDED.postcode,        customers.postcode),
            country         = COALESCE(EXCLUDED.country,         customers.country),
            customer_group  = COALESCE(EXCLUDED.customer_group,  customers.customer_group),
            account_manager = COALESCE(EXCLUDED.account_manager, customers.account_manager),
            currency        = COALESCE(EXCLUDED.currency,        customers.currency),
            notes           = COALESCE(EXCLUDED.notes,           customers.notes),
            active          = COALESCE(EXCLUDED.active,          customers.active),
            imported_at     = EXCLUDED.imported_at,
            imported_from   = EXCLUDED.imported_from,
            intake_id       = EXCLUDED.intake_id,
            schema_version  = EXCLUDED.schema_version,
            updated_at      = now()
          RETURNING customer_id INTO v_id;
        ELSE
          INSERT INTO app_data.customers SELECT * FROM jsonb_populate_record(NULL::app_data.customers, v_row) RETURNING customer_id INTO v_id;
        END IF;

      WHEN 'contacts' THEN
        IF v_import_mode = 'upsert' THEN
          INSERT INTO app_data.contacts SELECT * FROM jsonb_populate_record(NULL::app_data.contacts, v_row)
          ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
          DO UPDATE SET
            customer_id                  = COALESCE(EXCLUDED.customer_id,                  contacts.customer_id),
            external_customer_id         = COALESCE(EXCLUDED.external_customer_id,         contacts.external_customer_id),
            company_name                 = COALESCE(EXCLUDED.company_name,                 contacts.company_name),
            salutation                   = COALESCE(EXCLUDED.salutation,                   contacts.salutation),
            first_name                   = COALESCE(EXCLUDED.first_name,                   contacts.first_name),
            last_name                    = COALESCE(EXCLUDED.last_name,                    contacts.last_name),
            email                        = COALESCE(EXCLUDED.email,                        contacts.email),
            work_phone                   = COALESCE(EXCLUDED.work_phone,                   contacts.work_phone),
            mobile_phone                 = COALESCE(EXCLUDED.mobile_phone,                 contacts.mobile_phone),
            position                     = COALESCE(EXCLUDED.position,                     contacts.position),
            department                   = COALESCE(EXCLUDED.department,                   contacts.department),
            is_default_quote_contact     = COALESCE(EXCLUDED.is_default_quote_contact,     contacts.is_default_quote_contact),
            is_default_job_contact       = COALESCE(EXCLUDED.is_default_job_contact,       contacts.is_default_job_contact),
            is_default_invoice_contact   = COALESCE(EXCLUDED.is_default_invoice_contact,   contacts.is_default_invoice_contact),
            is_default_statement_contact = COALESCE(EXCLUDED.is_default_statement_contact, contacts.is_default_statement_contact),
            active                       = COALESCE(EXCLUDED.active,                       contacts.active),
            imported_at                  = EXCLUDED.imported_at,
            imported_from                = EXCLUDED.imported_from,
            intake_id                    = EXCLUDED.intake_id,
            schema_version               = EXCLUDED.schema_version,
            updated_at                   = now()
          RETURNING contact_id INTO v_id;
        ELSE
          INSERT INTO app_data.contacts SELECT * FROM jsonb_populate_record(NULL::app_data.contacts, v_row) RETURNING contact_id INTO v_id;
        END IF;

      WHEN 'sites' THEN
        IF v_import_mode = 'upsert' THEN
          INSERT INTO app_data.sites SELECT * FROM jsonb_populate_record(NULL::app_data.sites, v_row)
          ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
          DO UPDATE SET
            name                 = COALESCE(EXCLUDED.name,                 sites.name),
            code                 = COALESCE(EXCLUDED.code,                 sites.code),
            client_name          = COALESCE(EXCLUDED.client_name,          sites.client_name),
            site_type            = COALESCE(EXCLUDED.site_type,            sites.site_type),
            customer_id          = COALESCE(EXCLUDED.customer_id,          sites.customer_id),
            external_customer_id = COALESCE(EXCLUDED.external_customer_id, sites.external_customer_id),
            address_line_1       = COALESCE(EXCLUDED.address_line_1,       sites.address_line_1),
            address_line_2       = COALESCE(EXCLUDED.address_line_2,       sites.address_line_2),
            suburb               = COALESCE(EXCLUDED.suburb,               sites.suburb),
            state                = COALESCE(EXCLUDED.state,                sites.state),
            postcode             = COALESCE(EXCLUDED.postcode,             sites.postcode),
            country              = COALESCE(EXCLUDED.country,              sites.country),
            latitude             = COALESCE(EXCLUDED.latitude,             sites.latitude),
            longitude            = COALESCE(EXCLUDED.longitude,            sites.longitude),
            site_contact_name    = COALESCE(EXCLUDED.site_contact_name,    sites.site_contact_name),
            site_contact_phone   = COALESCE(EXCLUDED.site_contact_phone,   sites.site_contact_phone),
            site_contact_email   = COALESCE(EXCLUDED.site_contact_email,   sites.site_contact_email),
            induction_required   = COALESCE(EXCLUDED.induction_required,   sites.induction_required),
            induction_url        = COALESCE(EXCLUDED.induction_url,        sites.induction_url),
            track_hours          = COALESCE(EXCLUDED.track_hours,          sites.track_hours),
            budget_hours         = COALESCE(EXCLUDED.budget_hours,         sites.budget_hours),
            active               = COALESCE(EXCLUDED.active,               sites.active),
            imported_at          = EXCLUDED.imported_at,
            imported_from        = EXCLUDED.imported_from,
            intake_id            = EXCLUDED.intake_id,
            schema_version       = EXCLUDED.schema_version,
            updated_at           = now()
          RETURNING site_id INTO v_id;
        ELSE
          INSERT INTO app_data.sites SELECT * FROM jsonb_populate_record(NULL::app_data.sites, v_row) RETURNING site_id INTO v_id;
        END IF;
    END CASE;

    IF v_id IS NOT NULL THEN
      v_count := v_count + 1;
      v_ids   := array_append(v_ids, v_id);
    END IF;
  END LOOP;

  PERFORM _eq_intake_record_committed(p_intake_id, v_count);
  RETURN QUERY SELECT v_count, v_ids;
END $$;

INSERT INTO app_data._eq_migrations (name) VALUES ('046_fix_sites_track_hours_null')
ON CONFLICT (name) DO NOTHING;
