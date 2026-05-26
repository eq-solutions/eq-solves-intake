-- ============================================================================
-- 016 — Smoke-test helper: eq_create_intake_event
-- ============================================================================
-- shell_control is not in the Supabase exposed-schemas list, so the
-- PostgREST REST client cannot INSERT directly into shell_control tables.
-- This thin SECURITY DEFINER wrapper lives in public (always exposed) and
-- writes into shell_control.eq_intake_events on behalf of the caller.
--
-- Used only by smoke-test.mjs and similar test scripts.
-- Protected: REVOKE from public/anon; GRANT to authenticated only.
-- ============================================================================

create or replace function eq_create_intake_event(
  p_intake_id      uuid,
  p_tenant_id      uuid,
  p_entity         text,
  p_source_kind    text,
  p_source_subkind text    default null,
  p_source_filename text   default null,
  p_schema_version text    default '1.0.0',
  p_status         text    default 'committing',
  p_import_mode    text    default 'append',
  p_created_by     uuid    default '00000000-0000-0000-0000-000000000000'
)
returns void
language plpgsql
security definer
set search_path = shell_control, app_data, public, extensions
as $$
begin
  insert into shell_control.eq_intake_events (
    intake_id,
    tenant_id,
    entity,
    source_kind,
    source_subkind,
    source_filename,
    schema_version,
    status,
    import_mode,
    created_by
  ) values (
    p_intake_id,
    p_tenant_id,
    p_entity,
    p_source_kind,
    p_source_subkind,
    p_source_filename,
    p_schema_version,
    p_status,
    p_import_mode,
    p_created_by
  );
end;
$$;

-- Lock down access — anon must never call this
revoke execute on function eq_create_intake_event(uuid, uuid, text, text, text, text, text, text, text, uuid) from public, anon;
grant execute on function eq_create_intake_event(uuid, uuid, text, text, text, text, text, text, text, uuid) to authenticated;

-- Migration record
insert into app_data._eq_migrations (name) values ('016_smoke_test_helper')
on conflict (name) do nothing;
