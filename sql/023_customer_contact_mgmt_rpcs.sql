-- ============================================================================
-- 023 — Customer and contact management RPCs
-- ============================================================================
-- Archive/restore/delete RPCs for customers and contacts. Sites already have
-- equivalent RPCs in migration 021. These close the gap for the other two
-- CRM entities so EntityBrowserPage can offer consistent management actions
-- across all three.
--
-- Soft operations (archive/restore) set active = false/true — safe at any
-- time. Hard delete returns a boolean indicating whether a row was deleted
-- (false if the record didn't exist or belonged to a different tenant).
--
-- All functions:
--   - SECURITY DEFINER — bypass RLS; functions enforce tenant scope
--   - Scope to the calling user's tenant via app_metadata.tenant_id
--   - The Netlify function entity-actions.ts calls these via the RPC client
--     which uses the service-role key (entity-actions passes p_tenant_id
--     explicitly instead of relying on auth.jwt() — see note below).
--
-- NOTE on dual-path calling:
--   These RPCs are written with auth.jwt()-based tenant scoping. When called
--   from entity-actions.ts (service-role key), the function receives no JWT,
--   so auth.jwt() returns null and the WHERE clause's tenant_id cast fails.
--   entity-actions.ts therefore calls them via a user-impersonation path OR
--   uses direct table ops with the service-role client. See entity-actions.ts
--   for the chosen pattern (direct table ops, no RPC — simpler and safe since
--   the Netlify function already verifies the session and resolves the tenant).
-- ============================================================================

-- ── CUSTOMERS ────────────────────────────────────────────────────────────────

-- eq_archive_customer
-- Soft-archive: sets active = false. Scoped to caller's tenant.
CREATE OR REPLACE FUNCTION eq_archive_customer(p_customer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
BEGIN
  UPDATE app_data.customers
  SET    active      = false,
         updated_at  = now()
  WHERE  customer_id = p_customer_id
    AND  tenant_id   = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);
END;
$$;

REVOKE EXECUTE ON FUNCTION eq_archive_customer(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION eq_archive_customer(uuid) TO authenticated;

-- eq_unarchive_customer
-- Restore: sets active = true. Scoped to caller's tenant.
CREATE OR REPLACE FUNCTION eq_unarchive_customer(p_customer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
BEGIN
  UPDATE app_data.customers
  SET    active      = true,
         updated_at  = now()
  WHERE  customer_id = p_customer_id
    AND  tenant_id   = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);
END;
$$;

REVOKE EXECUTE ON FUNCTION eq_unarchive_customer(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION eq_unarchive_customer(uuid) TO authenticated;

-- eq_delete_customer
-- Hard delete. Returns true if a row was deleted.
-- FK note: contacts and sites reference customer_id. If any exist,
-- the delete will raise a FK violation. The caller must archive or
-- reassign dependents first (the UI enforces this).
CREATE OR REPLACE FUNCTION eq_delete_customer(p_customer_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM app_data.customers
  WHERE  customer_id = p_customer_id
    AND  tenant_id   = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION eq_delete_customer(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION eq_delete_customer(uuid) TO authenticated;

-- ── CONTACTS ─────────────────────────────────────────────────────────────────

-- eq_archive_contact
CREATE OR REPLACE FUNCTION eq_archive_contact(p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
BEGIN
  UPDATE app_data.contacts
  SET    active     = false,
         updated_at = now()
  WHERE  contact_id = p_contact_id
    AND  tenant_id  = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);
END;
$$;

REVOKE EXECUTE ON FUNCTION eq_archive_contact(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION eq_archive_contact(uuid) TO authenticated;

-- eq_unarchive_contact
CREATE OR REPLACE FUNCTION eq_unarchive_contact(p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
BEGIN
  UPDATE app_data.contacts
  SET    active     = true,
         updated_at = now()
  WHERE  contact_id = p_contact_id
    AND  tenant_id  = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);
END;
$$;

REVOKE EXECUTE ON FUNCTION eq_unarchive_contact(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION eq_unarchive_contact(uuid) TO authenticated;

-- eq_delete_contact
-- Hard delete. Returns true if a row was deleted.
CREATE OR REPLACE FUNCTION eq_delete_contact(p_contact_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_data, public, extensions
AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM app_data.contacts
  WHERE  contact_id = p_contact_id
    AND  tenant_id  = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION eq_delete_contact(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION eq_delete_contact(uuid) TO authenticated;

-- Migration record
INSERT INTO app_data._eq_migrations (name)
VALUES ('023_customer_contact_mgmt_rpcs')
ON CONFLICT (name) DO NOTHING;
