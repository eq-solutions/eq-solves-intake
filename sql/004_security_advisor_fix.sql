-- ============================================================================
-- EQ INTAKE — Security advisor fix (search_path + privileges)
-- ============================================================================
-- Date authored: 2026-05-19
-- Target Supabase project: eq-demo-canonical (EQ Intake Phase 2 canonical spine)
-- Run AFTER 003_schema_version_columns.sql.
--
-- Origin: Supabase Security Advisor surfaced 17 warnings on this project
-- (0 errors), all on functions created by migrations 001-003. Four categories:
--
--   1. Function Search Path Mutable (8 warnings, 7 unique functions, 1 overload):
--        eq_intake_template_track_outcome, eq_intake_commit_batch (×2),
--        eq_intake_rollback, eq_set_imported_at, eq_schema_registry_one_current,
--        eq_intake_template_track_use, eq_intake_find_template_by_signature
--      -> Mutable search_path enables function hijack via earlier-in-path schemas.
--         Low real risk in default Supabase, trivial to prevent at definition time.
--
--   2. Public Can Execute SECURITY DEFINER (4 warnings):
--        eq_intake_commit_batch (×2 signatures), eq_intake_find_template_by_signature,
--        eq_intake_rollback
--      -> SECURITY DEFINER runs with the owner's privileges. Public-callable means
--         the anon key (unauthenticated requests) can trigger them. Fix: revoke from
--         PUBLIC + anon. These warnings will clear.
--
--   3. Signed-In Users Can Execute SECURITY DEFINER (4 warnings, same fns as #2):
--      -> These RPCs are INTENTIONALLY callable by signed-in users — the intake
--         module calls them client-side via supabase.rpc() with the user's JWT.
--         The security boundary is enforced INSIDE the function body via
--         `auth.jwt() -> 'user_metadata' ->> 'tenant_id'` checks against the
--         p_tenant_id argument (see 003_schema_version_columns.sql:111).
--         These 4 warnings remain after this migration — accepted as by-design.
--         Resolving them would require moving the commit RPC server-side
--         (Netlify Function holding service_role key) AND rewriting the
--         in-function tenant check. Deferred.
--
--   4. Leaked Password Protection Disabled (1 warning, Auth):
--        Not fixable here — toggle in Supabase Dashboard → Authentication → Settings.
--        Documented in eq-context system/lessons.md.
--
-- Strategy:
--   - Iterate via pg_catalog so signature variations don't break the migration.
--   - Idempotent: re-running is safe (ALTER FUNCTION ... SET search_path is harmless
--     on functions that already have it set).
--   - RAISE NOTICE per fix so the dashboard run output makes the changes visible.
--
-- Verification queries at the bottom — run them to confirm the advisor goes green.
-- ============================================================================

set search_path = public;

-- ============================================================================
-- 1. SET search_path ON ALL FLAGGED FUNCTIONS
-- ============================================================================
-- Catches all signatures of overloaded functions automatically.

do $$
declare
  fn record;
  target_functions text[] := array[
    'eq_intake_template_track_outcome',
    'eq_intake_commit_batch',
    'eq_intake_rollback',
    'eq_set_imported_at',
    'eq_schema_registry_one_current',
    'eq_intake_template_track_use',
    'eq_intake_find_template_by_signature'
  ];
begin
  for fn in
    select
      n.nspname as schema_name,
      p.proname as func_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
      p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(target_functions)
    order by p.proname, args
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = public, pg_temp',
      fn.schema_name, fn.func_name, fn.args
    );
    raise notice 'search_path set: %.%(%)',
      fn.schema_name, fn.func_name, fn.args;
  end loop;
end;
$$;

-- ============================================================================
-- 2. REVOKE FROM PUBLIC/ANON + GRANT TO AUTHENTICATED ON SECURITY DEFINER FUNCTIONS
-- ============================================================================
-- Strip the default PUBLIC grant (which leaks execute to the anon role / un-
-- authenticated requests) and explicitly grant to `authenticated`. The intake
-- module calls these RPCs client-side via supabase.rpc() with the user's JWT,
-- so PostgREST resolves the call to the `authenticated` role.
--
-- The tenant-isolation security boundary is enforced INSIDE the function body
-- via `auth.jwt() -> 'user_metadata' ->> 'tenant_id'` checks — see
-- 003_schema_version_columns.sql:111. SECURITY DEFINER + authenticated grant
-- + in-function tenant check is the intended pattern.
--
-- service_role retains EXECUTE implicitly (it bypasses grants via BYPASSRLS).

do $$
declare
  fn record;
  secdef_functions text[] := array[
    'eq_intake_commit_batch',
    'eq_intake_find_template_by_signature',
    'eq_intake_rollback'
  ];
begin
  for fn in
    select
      n.nspname as schema_name,
      p.proname as func_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
      p.prosecdef as is_security_definer
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(secdef_functions)
      and p.prosecdef = true
    order by p.proname, args
  loop
    -- Revoke from PUBLIC (the default-everyone grant)
    execute format(
      'revoke execute on function %I.%I(%s) from public',
      fn.schema_name, fn.func_name, fn.args
    );
    -- Revoke from anon (unauthenticated PostgREST requests)
    -- Wrapped in safe block: anon may not have an explicit grant after the
    -- PUBLIC revoke above.
    begin
      execute format(
        'revoke execute on function %I.%I(%s) from anon',
        fn.schema_name, fn.func_name, fn.args
      );
    exception when others then
      raise notice 'no anon grant to revoke on %.%(%) — skipping',
        fn.schema_name, fn.func_name, fn.args;
    end;
    -- Grant to authenticated (signed-in users via their JWT)
    execute format(
      'grant execute on function %I.%I(%s) to authenticated',
      fn.schema_name, fn.func_name, fn.args
    );
    raise notice 'SECURITY DEFINER restricted to authenticated: %.%(%)',
      fn.schema_name, fn.func_name, fn.args;
  end loop;
end;
$$;

-- ============================================================================
-- VERIFICATION (run as separate queries after the migration applies)
-- ============================================================================

-- (a) Confirm search_path is set on every flagged function.
-- Expect: every row's `config` column contains 'search_path=public, pg_temp'.
--
--   select
--     p.proname,
--     pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
--     p.proconfig as config,
--     p.prosecdef as is_security_definer
--   from pg_catalog.pg_proc p
--   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and (
--       p.proname like 'eq_intake_%'
--       or p.proname in ('eq_set_imported_at', 'eq_schema_registry_one_current')
--     )
--   order by p.proname, args;

-- (b) Confirm privileges on SECURITY DEFINER functions.
-- Expect: `authenticated` appears as grantee, PUBLIC + anon are absent.
-- service_role is implicit (bypasses grants).
--
--   select
--     routine_schema,
--     routine_name,
--     grantee,
--     privilege_type
--   from information_schema.routine_privileges
--   where routine_schema = 'public'
--     and routine_name in (
--       'eq_intake_commit_batch',
--       'eq_intake_find_template_by_signature',
--       'eq_intake_rollback'
--     )
--   order by routine_name, grantee;

-- (c) Expected Security Advisor state after applying this migration:
--     - "Function Search Path Mutable" warnings (8): CLEARED to 0.
--     - "Public Can Execute SECURITY DEFINER" warnings (4): CLEARED to 0.
--     - "Signed-In Users Can Execute SECURITY DEFINER" warnings (4): REMAIN.
--       These are by-design — see header notes section. The function-internal
--       auth.jwt() tenant check is the enforcement boundary.
--     - "Leaked Password Protection Disabled" (1, Auth): manual dashboard toggle.
--
-- Net: 17 warnings → 5 expected residual (4 by-design + 1 dashboard click).

-- ============================================================================
-- POST-APPLY ACTIONS (manual — not SQL):
--   1. Supabase Dashboard → Authentication → Settings → enable
--      "Leaked password protection" (HaveIBeenPwned check)
--   2. Re-run Security Advisor → confirm 0 warnings / 0 errors
--   3. Log applied state in eq/changelog/eq-context.md (or wherever Intake's
--      production-state log lives once it has one)
-- ============================================================================
