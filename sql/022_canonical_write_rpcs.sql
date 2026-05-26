-- ============================================================================
-- 022 — Canonical write RPCs (upsert by external_id)
-- ============================================================================
-- Idempotent upsert RPCs for creating / updating canonical records from the
-- shell UI (authenticated user JWT path). The canonical-api.ts PUT handler
-- uses the service-role key and does direct table upserts; these RPCs cover
-- the JWT-authenticated path (shell UI, future mobile) where the service-role
-- key is not available.
--
-- All functions:
--   - SECURITY DEFINER — bypass RLS; functions enforce tenant scope themselves
--   - Scope to the calling user's tenant via app_metadata.tenant_id
--   - Upsert on (tenant_id, external_id) — idempotent, safe to call repeatedly
--   - COALESCE merges: incoming non-null fields win; existing non-null fields
--     are preserved if the incoming field is null (additive, never-wipe)
--   - Return the canonical_id (UUID) of the created or matched record
--
-- Depends on: unique partial indexes on (tenant_id, external_id) per table
-- (created below). The ON CONFLICT predicate must match the index condition
-- exactly.
-- ============================================================================

-- ── Unique index guards ──────────────────────────────────────────────────────
-- Partial because external_id is nullable (rows created manually, not via
-- intake, may have no external_id). The constraint only fires when both
-- tenant_id and external_id are present.

CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_external_id_uidx
  ON app_data.customers(tenant_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sites_tenant_external_id_uidx
  ON app_data.sites(tenant_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_external_id_uidx
  ON app_data.contacts(tenant_id, external_id)
  WHERE external_id IS NOT NULL;

-- ── eq_upsert_customer ───────────────────────────────────────────────────────
-- Creates or updates a customer record. All fields except p_external_id are
-- optional — omit any field that hasn't changed.
-- Returns: customer_id UUID.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eq_upsert_customer(
  p_external_id     varchar,
  p_company_name    varchar  DEFAULT NULL,
  p_type            varchar  DEFAULT NULL,
  p_first_name      varchar  DEFAULT NULL,
  p_last_name       varchar  DEFAULT NULL,
  p_salutation      varchar  DEFAULT NULL,
  p_abn             varchar  DEFAULT NULL,
  p_acn             varchar  DEFAULT NULL,
  p_email           varchar  DEFAULT NULL,
  p_primary_phone   varchar  DEFAULT NULL,
  p_mobile_phone    varchar  DEFAULT NULL,
  p_alt_phone       varchar  DEFAULT NULL,
  p_website         varchar  DEFAULT NULL,
  p_street_address  text     DEFAULT NULL,
  p_suburb          text     DEFAULT NULL,
  p_state           text     DEFAULT NULL,
  p_postcode        text     DEFAULT NULL,
  p_country         text     DEFAULT NULL,
  p_customer_group  varchar  DEFAULT NULL,
  p_account_manager varchar  DEFAULT NULL,
  p_currency        varchar  DEFAULT NULL,
  p_active          boolean  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
DECLARE
  v_tenant_id uuid;
  v_id        uuid;
BEGIN
  v_tenant_id := (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;

  INSERT INTO app_data.customers (
    customer_id,    tenant_id,       external_id,
    company_name,   type,
    first_name,     last_name,       salutation,
    abn,            acn,
    email,          primary_phone,   mobile_phone,   alt_phone,    website,
    street_address, suburb,          state,          postcode,     country,
    customer_group, account_manager, currency,
    active
  ) VALUES (
    gen_random_uuid(), v_tenant_id, p_external_id,
    p_company_name, p_type,
    p_first_name, p_last_name, p_salutation,
    p_abn, p_acn,
    p_email, p_primary_phone, p_mobile_phone, p_alt_phone, p_website,
    p_street_address, p_suburb, p_state, p_postcode, COALESCE(p_country, 'AU'),
    p_customer_group, p_account_manager, p_currency,
    COALESCE(p_active, true)
  )
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
    active          = COALESCE(EXCLUDED.active,          customers.active),
    updated_at      = now()
  RETURNING customer_id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION eq_upsert_customer FROM public, anon;
GRANT  EXECUTE ON FUNCTION eq_upsert_customer TO authenticated;

-- ── eq_upsert_site ───────────────────────────────────────────────────────────
-- Creates or updates a site record. p_external_id is the upsert key.
-- p_customer_id: canonical customer UUID (optional; links site to a customer).
-- Returns: site_id UUID.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eq_upsert_site(
  p_external_id          varchar,
  p_name                 varchar  DEFAULT NULL,
  p_code                 varchar  DEFAULT NULL,
  p_client_name          text     DEFAULT NULL,
  p_site_type            varchar  DEFAULT NULL,
  p_customer_id          uuid     DEFAULT NULL,
  p_external_customer_id varchar  DEFAULT NULL,
  p_address_line_1       text     DEFAULT NULL,
  p_address_line_2       text     DEFAULT NULL,
  p_suburb               text     DEFAULT NULL,
  p_state                text     DEFAULT NULL,
  p_postcode             text     DEFAULT NULL,
  p_country              text     DEFAULT NULL,
  p_latitude             numeric  DEFAULT NULL,
  p_longitude            numeric  DEFAULT NULL,
  p_site_contact_name    text     DEFAULT NULL,
  p_site_contact_phone   text     DEFAULT NULL,
  p_site_contact_email   text     DEFAULT NULL,
  p_induction_required   boolean  DEFAULT NULL,
  p_induction_url        text     DEFAULT NULL,
  p_track_hours          boolean  DEFAULT NULL,
  p_budget_hours         numeric  DEFAULT NULL,
  p_active               boolean  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
DECLARE
  v_tenant_id uuid;
  v_id        uuid;
BEGIN
  v_tenant_id := (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;

  INSERT INTO app_data.sites (
    site_id,             tenant_id,            external_id,
    name,                code,                 client_name,           site_type,
    customer_id,         external_customer_id,
    address_line_1,      address_line_2,
    suburb,              state,                postcode,              country,
    latitude,            longitude,
    site_contact_name,   site_contact_phone,   site_contact_email,
    induction_required,  induction_url,
    track_hours,         budget_hours,
    active
  ) VALUES (
    gen_random_uuid(), v_tenant_id, p_external_id,
    p_name, p_code, p_client_name, p_site_type,
    p_customer_id, p_external_customer_id,
    p_address_line_1, p_address_line_2,
    p_suburb, p_state, p_postcode, COALESCE(p_country, 'AU'),
    p_latitude, p_longitude,
    p_site_contact_name, p_site_contact_phone, p_site_contact_email,
    COALESCE(p_induction_required, false), p_induction_url,
    COALESCE(p_track_hours, false), p_budget_hours,
    COALESCE(p_active, true)
  )
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
    updated_at           = now()
  RETURNING site_id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION eq_upsert_site FROM public, anon;
GRANT  EXECUTE ON FUNCTION eq_upsert_site TO authenticated;

-- ── eq_upsert_contact ────────────────────────────────────────────────────────
-- Creates or updates a contact record. p_external_id is the upsert key.
-- Returns: contact_id UUID.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eq_upsert_contact(
  p_external_id                  varchar,
  p_customer_id                  uuid     DEFAULT NULL,
  p_external_customer_id         varchar  DEFAULT NULL,
  p_company_name                 varchar  DEFAULT NULL,
  p_salutation                   varchar  DEFAULT NULL,
  p_first_name                   varchar  DEFAULT NULL,
  p_last_name                    varchar  DEFAULT NULL,
  p_email                        varchar  DEFAULT NULL,
  p_work_phone                   varchar  DEFAULT NULL,
  p_mobile_phone                 varchar  DEFAULT NULL,
  p_position                     varchar  DEFAULT NULL,
  p_department                   varchar  DEFAULT NULL,
  p_is_default_quote_contact     boolean  DEFAULT NULL,
  p_is_default_job_contact       boolean  DEFAULT NULL,
  p_is_default_invoice_contact   boolean  DEFAULT NULL,
  p_is_default_statement_contact boolean  DEFAULT NULL,
  p_active                       boolean  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
DECLARE
  v_tenant_id uuid;
  v_id        uuid;
BEGIN
  v_tenant_id := (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid;

  INSERT INTO app_data.contacts (
    contact_id,                    tenant_id,               external_id,
    customer_id,                   external_customer_id,
    company_name,                  salutation,
    first_name,                    last_name,
    email,                         work_phone,              mobile_phone,
    position,                      department,
    is_default_quote_contact,      is_default_job_contact,
    is_default_invoice_contact,    is_default_statement_contact,
    active
  ) VALUES (
    gen_random_uuid(), v_tenant_id, p_external_id,
    p_customer_id, p_external_customer_id,
    p_company_name, p_salutation,
    p_first_name, p_last_name,
    p_email, p_work_phone, p_mobile_phone,
    p_position, p_department,
    COALESCE(p_is_default_quote_contact,     false),
    COALESCE(p_is_default_job_contact,       false),
    COALESCE(p_is_default_invoice_contact,   false),
    COALESCE(p_is_default_statement_contact, false),
    COALESCE(p_active, true)
  )
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
    updated_at                   = now()
  RETURNING contact_id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION eq_upsert_contact FROM public, anon;
GRANT  EXECUTE ON FUNCTION eq_upsert_contact TO authenticated;

-- Migration record
INSERT INTO app_data._eq_migrations (name)
VALUES ('022_canonical_write_rpcs')
ON CONFLICT (name) DO NOTHING;
