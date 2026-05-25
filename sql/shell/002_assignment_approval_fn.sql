-- ============================================================
-- Shell control plane — Assignment approval RPC
-- Target: eq-canonical-internal (zaapmfdkgedqupfjtchl)
-- Called by the employer-side edge function using service role.
-- Workers cannot call this directly — no RLS policy grants it.
-- ============================================================

-- approve_worker_assignment(assignment_id)
-- Flips status pending → active and stamps accepted_at.
-- Returns the updated row.

create or replace function approve_worker_assignment(
  p_assignment_id uuid
)
returns worker_assignments
language plpgsql
security definer        -- runs as the function owner (postgres), bypasses RLS
set search_path = public
as $$
declare
  v_row worker_assignments;
begin
  update worker_assignments
  set
    status      = 'active',
    accepted_at = now()
  where id = p_assignment_id
    and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'assignment % not found or already processed', p_assignment_id;
  end if;

  return v_row;
end;
$$;

-- revoke_worker_assignment(assignment_id, revoked_by)
-- Flips status active → revoked regardless of who initiated.
-- p_revoked_by must be 'worker' or 'employer'.

create or replace function revoke_worker_assignment(
  p_assignment_id uuid,
  p_revoked_by    worker_revoked_by
)
returns worker_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row worker_assignments;
begin
  update worker_assignments
  set
    status     = 'revoked',
    revoked_at = now(),
    revoked_by = p_revoked_by
  where id = p_assignment_id
    and status = 'active'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'assignment % not found or not active', p_assignment_id;
  end if;

  return v_row;
end;
$$;

-- Grant exec to service_role only.
-- Anon / authenticated cannot call these.
revoke execute on function approve_worker_assignment(uuid)                       from public, anon, authenticated;
revoke execute on function revoke_worker_assignment(uuid, worker_revoked_by)     from public, anon, authenticated;
grant  execute on function approve_worker_assignment(uuid)                       to service_role;
grant  execute on function revoke_worker_assignment(uuid, worker_revoked_by)     to service_role;
