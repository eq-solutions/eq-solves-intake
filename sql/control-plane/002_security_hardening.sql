-- control-plane/002_security_hardening.sql
-- Applied to eq-canonical (jvknxcmbtrfnxfrwfimn) 2026-06-01.
--
-- 1. Enable RLS on 4 shell_control tables that had RLS completely disabled.
--    These tables hold sensitive data (security groups, platform config) and
--    must be inaccessible to anon/authenticated roles. All access goes through
--    SECURITY DEFINER RPCs which bypass RLS.
--
-- 2. Revoke anon execute on Cards RPCs, auth helpers, and intake helpers.
--    All these functions use auth.uid() internally — calling them without a
--    session would return null/error results. Anon access is unintentional.
--
-- 3. Revoke all direct REST access to trigger functions (log_*, lock_*).
--    These are called by PostgreSQL triggers, not via the REST API.
--
-- Note: 5 tables have RLS enabled with no explicit policies
-- (audit_log, cards_field_approvals, pin_reset_tokens, rate_limit_buckets,
--  tenant_routing). This is intentional — with no policies, PostgreSQL denies
--  all access for anon/authenticated. These tables are only ever touched by
--  SECURITY DEFINER functions (which bypass RLS). No change needed.
--
-- Note: eq-canonical-internal has zero security warnings — no action needed.

ALTER TABLE shell_control.security_groups       ENABLE ROW LEVEL SECURITY;
ALTER TABLE shell_control.security_group_perms  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shell_control.user_security_groups  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shell_control.platform_config       ENABLE ROW LEVEL SECURITY;

-- Cards RPCs
REVOKE EXECUTE ON FUNCTION public.eq_cards_delete_my_credential(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_cards_delete_my_credential(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.eq_cards_list_my_credentials() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_cards_list_my_credentials() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.eq_cards_upsert_my_worker(text,text,text,text,date,text,text,text,text,text,text,text,text,worker_rtw_type,date) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_cards_upsert_my_worker(text,text,text,text,date,text,text,text,text,text,text,text,text,worker_rtw_type,date) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.eq_cards_upsert_my_credential(worker_credential_type,text,uuid,text,text,date,date,text,text,text,jsonb) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_cards_upsert_my_credential(worker_credential_type,text,uuid,text,text,date,date,text,text,text,jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.eq_cards_upsert_my_licence(jsonb) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_cards_upsert_my_licence(jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.eq_cards_upsert_my_licence(text,text,date,jsonb,uuid,date,text,text,text,text,text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_cards_upsert_my_licence(text,text,date,jsonb,uuid,date,text,text,text,text,text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.eq_cards_upsert_my_profile(jsonb) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_cards_upsert_my_profile(jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.eq_cards_upsert_my_profile(text,date,text,text,text,text,text,text,text,text,text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_cards_upsert_my_profile(text,date,text,text,text,text,text,text,text,text,text) TO authenticated;

-- Auth helpers
REVOKE EXECUTE ON FUNCTION public.has_pin()              FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.has_pin()              TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_org_admin(uuid)     FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.is_org_admin(uuid)     TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_org_admin_of(uuid)  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.is_org_admin_of(uuid)  TO authenticated;

REVOKE EXECUTE ON FUNCTION public.verify_pin(text)       FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.verify_pin(text)       TO authenticated;

REVOKE EXECUTE ON FUNCTION public.eq_recent_auth_events(integer) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.eq_recent_auth_events(integer) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.link_pending_invites() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.link_pending_invites() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.check_and_increment_rate_limit(text,integer,integer,integer) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.check_and_increment_rate_limit(text,integer,integer,integer) TO authenticated;

-- Trigger functions: no REST access needed
REVOKE EXECUTE ON FUNCTION public.log_licence_change()         FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_membership_change()      FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_profile_change()         FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lock_invite_accept_columns() FROM public, anon, authenticated;

-- Intake private helpers
REVOKE EXECUTE ON FUNCTION public._eq_intake_check_tenant_match(uuid)    FROM public, anon;
GRANT  EXECUTE ON FUNCTION public._eq_intake_check_tenant_match(uuid)    TO authenticated;

REVOKE EXECUTE ON FUNCTION public._eq_intake_load_event_meta(uuid,uuid)  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public._eq_intake_load_event_meta(uuid,uuid)  TO authenticated;

REVOKE EXECUTE ON FUNCTION public._eq_intake_record_committed(uuid,int)  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public._eq_intake_record_committed(uuid,int)  TO authenticated;
