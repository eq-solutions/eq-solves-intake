-- ============================================================================
-- 019 — Intake event lifecycle RPCs (finish + customer FK read-back)
-- ============================================================================
-- commit-canonical.ts calls supabase.from("eq_intake_events") to both INSERT
-- (create event) and UPDATE (finalise event). It also calls
-- supabase.from("customers") to read back customer_id → external_id pairs for
-- FK resolution when committing sites/contacts.
--
-- Both fail in the browser because:
--   - shell_control is not in the Supabase exposed-schemas list (INSERT/UPDATE
--     of eq_intake_events returns "Invalid schema: shell_control")
--   - app_data.customers is not accessible via the default public schema
--     without explicit .schema('app_data') chaining, which the structural
--     SupabaseLikeClient interface doesn't support
--
-- Migration 016 already added eq_create_intake_event (the INSERT wrapper).
-- This migration adds the two remaining wrappers:
--
--   eq_finish_intake_event  — finalises status/counts/error on eq_intake_events
--   eq_read_customers_by_intake — reads (customer_id, external_id) from
--                                  app_data.customers for a given intake_id,
--                                  used to build the FK map before committing
--                                  sites and contacts.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- eq_finish_intake_event
-- Called by commit-canonical.ts after each entity batch completes or fails.
-- ----------------------------------------------------------------------------
create or replace function eq_finish_intake_event(
  p_intake_id      uuid,
  p_status         text,
  p_rows_committed int,
  p_rows_flagged   int,
  p_rows_rejected  int,
  p_error_message  text default null
)
returns void
language plpgsql
security definer
set search_path = shell_control, app_data, public, extensions
as $$
begin
  update shell_control.eq_intake_events
  set
    status          = p_status,
    rows_committed  = p_rows_committed,
    rows_flagged    = p_rows_flagged,
    rows_rejected   = p_rows_rejected,
    completed_at    = now(),
    error_message   = p_error_message
  where intake_id = p_intake_id;
end;
$$;

revoke execute on function eq_finish_intake_event(uuid, text, int, int, int, text) from public, anon;
grant execute on function eq_finish_intake_event(uuid, text, int, int, int, text) to authenticated;

-- ----------------------------------------------------------------------------
-- eq_read_customers_by_intake
-- Returns (customer_id, external_id) pairs for all customers committed under
-- a given intake_id. Used by buildCustomerIdMap in commit-canonical.ts.
-- ----------------------------------------------------------------------------
create or replace function eq_read_customers_by_intake(
  p_intake_id uuid
)
returns table(customer_id uuid, external_id text)
language sql
security definer
set search_path = app_data, shell_control, public, extensions
as $$
  select customer_id, external_id
  from app_data.customers
  where intake_id = p_intake_id;
$$;

revoke execute on function eq_read_customers_by_intake(uuid) from public, anon;
grant execute on function eq_read_customers_by_intake(uuid) to authenticated;

-- Migration record
insert into app_data._eq_migrations (name) values ('019_intake_event_rpc_helpers')
on conflict (name) do nothing;
