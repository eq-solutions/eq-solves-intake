-- ============================================================================
-- 013 — Security hardening: REVOKE PUBLIC/anon + search_path locking
-- ============================================================================
-- Resolves HIGH and MEDIUM findings from the 2026-05-26 SECURITY DEFINER audit.
--
-- CONTEXT
-- -------
-- Migrations 008, 009, 010b, and 011 create new SECURITY DEFINER functions and
-- issue GRANT EXECUTE TO authenticated — but never issue REVOKE EXECUTE FROM
-- PUBLIC first. In Postgres, new functions are executable by PUBLIC by default.
-- Supabase also explicitly grants to `anon` on every new function. Combined,
-- this means the anon role (unauthenticated requests with just the anon key)
-- can call all intake commit and rollback RPCs without authentication.
--
-- Additionally, superseded overloads from earlier migrations (4-arg, 5-arg,
-- 8-arg) remain live in the database and were never revoked.
--
-- This migration:
--   A. REVOKE EXECUTE FROM PUBLIC + anon on all overloads of the 8 affected
--      RPCs (router, 5 per-domain commits, rollback, list-entities helper)
--   B. Recreates _eq_intake_apply_metadata with SET search_path (was missing
--      despite being called from SECURITY DEFINER callers)
--   C. Recreates app_data._set_updated_at() trigger function with SET
--      search_path to match the hardening pattern used elsewhere
--
-- Applied in two steps on sks-canonical:
--   Step 013  — 6-arg/2-arg/1-arg signatures, revoke from public
--   Step 013b — all overloads, revoke from public + anon
-- Both are idempotent and safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. REVOKE EXECUTE FROM PUBLIC + anon on all overloads
-- ----------------------------------------------------------------------------
-- Supabase grants anon explicitly on every new function, separate from PUBLIC.
-- All superseded overloads (4-arg, 5-arg, 8-arg) are dead code but callable.

-- eq_intake_commit_batch — all 3 overloads
revoke execute on function eq_intake_commit_batch(uuid, uuid, text, jsonb) from public, anon;
revoke execute on function eq_intake_commit_batch(uuid, uuid, text, jsonb, boolean) from public, anon;
revoke execute on function eq_intake_commit_batch(uuid, uuid, text, jsonb, boolean, text) from public, anon;

-- Per-domain commit RPCs — both overloads each (8-arg old, 6-arg current)
revoke execute on function eq_intake_commit_batch_core(uuid, uuid, text, jsonb, text, text, text, boolean) from public, anon;
revoke execute on function eq_intake_commit_batch_core(uuid, uuid, text, jsonb, boolean, text) from public, anon;

revoke execute on function eq_intake_commit_batch_field(uuid, uuid, text, jsonb, text, text, text, boolean) from public, anon;
revoke execute on function eq_intake_commit_batch_field(uuid, uuid, text, jsonb, boolean, text) from public, anon;

revoke execute on function eq_intake_commit_batch_cards(uuid, uuid, text, jsonb, text, text, text, boolean) from public, anon;
revoke execute on function eq_intake_commit_batch_cards(uuid, uuid, text, jsonb, boolean, text) from public, anon;

revoke execute on function eq_intake_commit_batch_quotes(uuid, uuid, text, jsonb, text, text, text, boolean) from public, anon;
revoke execute on function eq_intake_commit_batch_quotes(uuid, uuid, text, jsonb, boolean, text) from public, anon;

revoke execute on function eq_intake_commit_batch_service(uuid, uuid, text, jsonb, text, text, text, boolean) from public, anon;
revoke execute on function eq_intake_commit_batch_service(uuid, uuid, text, jsonb, boolean, text) from public, anon;

-- Rollback RPC
revoke execute on function eq_intake_rollback(uuid, text) from public, anon;

-- List module entities helper
revoke execute on function eq_list_module_entities(text) from public, anon;

-- Confirm authenticated still has access on current signatures (idempotent)
grant execute on function eq_intake_commit_batch(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_core(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_field(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_cards(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_quotes(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_commit_batch_service(uuid, uuid, text, jsonb, boolean, text) to authenticated;
grant execute on function eq_intake_rollback(uuid, text) to authenticated;
grant execute on function eq_list_module_entities(text) to authenticated;

-- ----------------------------------------------------------------------------
-- B. _eq_intake_apply_metadata — add SET search_path
-- ----------------------------------------------------------------------------
-- Kept immutable (pure jsonb transformation, no DB access).
-- Adding SET search_path for defense-in-depth.

create or replace function _eq_intake_apply_metadata(
  p_row             jsonb,
  p_tenant_id       uuid,
  p_intake_id       uuid,
  p_source_sig      text,
  p_schema_version  text
)
returns jsonb
language sql
immutable
set search_path = app_data, shell_control, public, extensions
as $$
  select p_row
    || jsonb_build_object('tenant_id', p_tenant_id)
    || jsonb_build_object('intake_id', p_intake_id)
    || jsonb_build_object('imported_at', to_jsonb(now()))
    || jsonb_build_object('imported_from', to_jsonb(p_source_sig))
    || jsonb_build_object('schema_version', to_jsonb(p_schema_version));
$$;

-- ----------------------------------------------------------------------------
-- C. app_data._set_updated_at() — add SET search_path
-- ----------------------------------------------------------------------------
-- Trigger function from migration 009 was missing SET search_path.
-- Existing triggers on quote, quote_line_item, scope_template, rate_library
-- pick up the new body automatically — no need to re-create them.

create or replace function app_data._set_updated_at()
returns trigger
language plpgsql
set search_path = app_data, public, extensions
as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- Migration record
-- ----------------------------------------------------------------------------
insert into app_data._eq_migrations (name) values ('013_security_revoke_fix')
on conflict (name) do nothing;
