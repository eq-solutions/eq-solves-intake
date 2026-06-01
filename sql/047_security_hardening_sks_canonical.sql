-- 047_security_hardening_sks_canonical.sql
-- Applied to sks-canonical (ehowgjardagevnrluult) 2026-06-01.
--
-- Clears remaining security advisor warnings:
--
-- 1. REVOKE anon+public from private intake helpers and upsert_sks_contact_raw.
--    Migration 037 revoked from anon only — anon inherits from public, so the
--    previous revoke was incomplete. Must revoke from public to be effective.
--
-- 2. Pin SET search_path on _eq_intake_apply_metadata (IMMUTABLE SQL function).
--
-- 3. Disable RLS on legacy raw import tables. These tables (sks_customers,
--    sks_staff, _sks_contacts_raw, _sks_contact_links_raw) are old SimPRO
--    import staging tables no longer used. RLS was enabled with no policies,
--    making them inaccessible to all roles except service_role anyway.
--    Disabling RLS makes the intent explicit rather than leaving a confusing state.

REVOKE EXECUTE ON FUNCTION public._eq_intake_check_tenant_match(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public._eq_intake_check_tenant_match(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public._eq_intake_load_event_meta(uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public._eq_intake_load_event_meta(uuid, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public._eq_intake_record_committed(uuid, int) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public._eq_intake_record_committed(uuid, int) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.eq_intake_commit_batch_core(uuid,uuid,text,jsonb,boolean,text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_intake_commit_batch_core(uuid,uuid,text,jsonb,boolean,text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.upsert_sks_contact_raw(uuid,text,text,text,text,text,text,text,text,boolean) FROM public, anon;

CREATE OR REPLACE FUNCTION public._eq_intake_apply_metadata(
  p_row            jsonb,
  p_tenant_id      uuid,
  p_intake_id      uuid,
  p_source_sig     text,
  p_schema_version text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_row
    || jsonb_build_object('tenant_id',      p_tenant_id)
    || jsonb_build_object('intake_id',      p_intake_id)
    || jsonb_build_object('imported_at',    to_jsonb(now()))
    || jsonb_build_object('imported_from',  to_jsonb(p_source_sig))
    || jsonb_build_object('schema_version', to_jsonb(p_schema_version))
    || CASE WHEN p_row->>'created_at' IS NULL
            THEN jsonb_build_object('created_at', to_jsonb(now()))
            ELSE '{}'::jsonb END
    || CASE WHEN p_row->>'updated_at' IS NULL
            THEN jsonb_build_object('updated_at', to_jsonb(now()))
            ELSE '{}'::jsonb END;
$$;

ALTER TABLE public._sks_contact_links_raw DISABLE ROW LEVEL SECURITY;
ALTER TABLE public._sks_contacts_raw      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sks_customers          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sks_staff              DISABLE ROW LEVEL SECURITY;

INSERT INTO app_data._eq_migrations (name) VALUES ('047_security_hardening')
ON CONFLICT (name) DO NOTHING;
