-- ============================================================================
-- 017 — Smoke-test read helpers (shell_control not REST-exposed)
-- ============================================================================
-- PostgREST only exposes 'public' and 'app_data'. Any SELECT from
-- shell_control tables must go through a public-schema SECURITY DEFINER
-- wrapper that the REST client can reach.
-- ============================================================================

-- Returns the status + rolled_back_at for a given intake_id.
-- Used by smoke-test Step 6.
create or replace function eq_get_intake_event_status(
  p_intake_id uuid
)
returns table (status text, rolled_back_at timestamptz)
language sql
security definer
set search_path = shell_control, app_data, public, extensions
as $$
  select status, rolled_back_at
  from shell_control.eq_intake_events
  where intake_id = p_intake_id
  limit 1;
$$;

-- Marks an intake event as rolled_back directly.
-- Used by smoke-test Step 4 fallback when the RPC itself fails.
create or replace function eq_mark_intake_rolled_back(
  p_intake_id uuid,
  p_reason    text
)
returns void
language plpgsql
security definer
set search_path = shell_control, app_data, public, extensions
as $$
begin
  update shell_control.eq_intake_events
  set
    status           = 'rolled_back',
    rolled_back_at   = now(),
    rollback_reason  = p_reason
  where intake_id = p_intake_id;
end;
$$;

-- Lock down access
revoke execute on function eq_get_intake_event_status(uuid) from public, anon;
revoke execute on function eq_mark_intake_rolled_back(uuid, text) from public, anon;
grant execute on function eq_get_intake_event_status(uuid) to authenticated;
grant execute on function eq_mark_intake_rolled_back(uuid, text) to authenticated;

-- Migration record
insert into app_data._eq_migrations (name) values ('017_smoke_test_read_helpers')
on conflict (name) do nothing;
