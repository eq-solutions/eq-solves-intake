-- ============================================================
-- Shell control plane — Worker profile tables
-- Target: eq-shell-control Supabase (hxwitoveffxhcgjvubbd)
-- Idempotent: safe to re-run
-- ============================================================

-- ── ENUMS ──────────────────────────────────────────────────

do $$ begin
  create type worker_rtw_type as enum (
    'citizen', 'permanent_resident', 'visa'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type worker_credential_type as enum (
    'electrical_licence',
    'white_card',
    'first_aid',
    'ewp',
    'working_at_heights',
    'confined_space',
    'asbestos_awareness'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type worker_credential_status as enum (
    'active', 'expired', 'pending_renewal'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type worker_induction_type as enum (
    'site_general', 'emergency', 'swms', 'client_specific'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type worker_assignment_status as enum (
    'pending', 'active', 'revoked'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type worker_invite_via as enum (
    'qr', 'link', 'code'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type worker_revoked_by as enum (
    'worker', 'employer'
  );
exception when duplicate_object then null; end $$;


-- ── WORKERS ────────────────────────────────────────────────

create table if not exists workers (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,

  -- Identity
  first_name                  text not null,
  last_name                   text not null,
  preferred_name              text,
  date_of_birth               date not null,

  -- Contact
  phone                       text not null,
  email                       text not null,

  -- Emergency contact
  emergency_contact_name      text not null,
  emergency_contact_phone     text not null,
  emergency_contact_relationship text,

  -- Right to work (optional at signup)
  right_to_work_type          worker_rtw_type,
  right_to_work_expiry        date,           -- null for citizens
  right_to_work_doc_ref       uuid,           -- → attachments

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint workers_user_id_unique unique (user_id)
);

-- Worker can only see and edit their own row
alter table workers enable row level security;

drop policy if exists "workers: owner read"   on workers;
drop policy if exists "workers: owner write"  on workers;
drop policy if exists "workers: owner update" on workers;

create policy "workers: owner read"
  on workers for select
  using (auth.uid() = user_id);

create policy "workers: owner write"
  on workers for insert
  with check (auth.uid() = user_id);

create policy "workers: owner update"
  on workers for update
  using (auth.uid() = user_id);


-- ── WORKER CREDENTIALS ─────────────────────────────────────

create table if not exists worker_credentials (
  id                  uuid primary key default gen_random_uuid(),
  worker_id           uuid not null references workers(id) on delete cascade,

  credential_type     worker_credential_type not null,
  licence_number      text,                   -- some certs have no number
  issuing_body        text not null,
  state_territory     text,                   -- null for national certs
  issue_date          date,                   -- optional — not always on the document
  expiry_date         date,                   -- null where credential doesn't expire
  document_ref        uuid,                   -- → attachments (photo)
  status              worker_credential_status not null default 'active',

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table worker_credentials enable row level security;

drop policy if exists "worker_credentials: owner read"   on worker_credentials;
drop policy if exists "worker_credentials: owner write"  on worker_credentials;
drop policy if exists "worker_credentials: owner update" on worker_credentials;
drop policy if exists "worker_credentials: owner delete" on worker_credentials;

create policy "worker_credentials: owner read"
  on worker_credentials for select
  using (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));

create policy "worker_credentials: owner write"
  on worker_credentials for insert
  with check (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));

create policy "worker_credentials: owner update"
  on worker_credentials for update
  using (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));

create policy "worker_credentials: owner delete"
  on worker_credentials for delete
  using (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));


-- ── WORKER INDUCTIONS ──────────────────────────────────────

create table if not exists worker_inductions (
  id                  uuid primary key default gen_random_uuid(),
  worker_id           uuid not null references workers(id) on delete cascade,

  site_name           text not null,          -- string, can't FK cross-Supabase
  tenant_id           uuid not null,          -- which company ran the induction
  induction_type      worker_induction_type not null,
  completed_date      date not null,
  expiry_date         date,
  document_ref        uuid,                   -- → attachments

  created_at          timestamptz not null default now()
);

alter table worker_inductions enable row level security;

drop policy if exists "worker_inductions: owner read"   on worker_inductions;
drop policy if exists "worker_inductions: owner write"  on worker_inductions;
drop policy if exists "worker_inductions: owner update" on worker_inductions;
drop policy if exists "worker_inductions: owner delete" on worker_inductions;

create policy "worker_inductions: owner read"
  on worker_inductions for select
  using (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));

create policy "worker_inductions: owner write"
  on worker_inductions for insert
  with check (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));

create policy "worker_inductions: owner update"
  on worker_inductions for update
  using (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));

create policy "worker_inductions: owner delete"
  on worker_inductions for delete
  using (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));


-- ── WORKER ASSIGNMENTS ─────────────────────────────────────
-- Worker initiates. Employer approves via service role / edge function.

create table if not exists worker_assignments (
  id                    uuid primary key default gen_random_uuid(),
  worker_id             uuid not null references workers(id) on delete cascade,

  tenant_id             uuid not null,
  tenant_name           text not null,        -- denormalised for display
  tenant_supabase_ref   text not null,        -- where to sync the staff row

  status                worker_assignment_status not null default 'pending',
  invited_via           worker_invite_via not null,

  invited_at            timestamptz not null default now(),
  accepted_at           timestamptz,
  revoked_at            timestamptz,
  revoked_by            worker_revoked_by,

  constraint worker_assignments_unique
    unique (worker_id, tenant_id)
);

alter table worker_assignments enable row level security;

drop policy if exists "worker_assignments: owner read"   on worker_assignments;
drop policy if exists "worker_assignments: owner write"  on worker_assignments;
drop policy if exists "worker_assignments: owner update" on worker_assignments;

create policy "worker_assignments: owner read"
  on worker_assignments for select
  using (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));

create policy "worker_assignments: owner write"
  on worker_assignments for insert
  with check (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));

create policy "worker_assignments: owner update"
  on worker_assignments for update
  using (exists (
    select 1 from workers w
    where w.id = worker_id and w.user_id = auth.uid()
  ));

-- Note: employer approval (pending → active) must go through a service-role
-- edge function — employers do not have direct auth on this Supabase.
-- See: sql/shell/002_assignment_edge_function.sql (TODO)


-- ── INDEXES ────────────────────────────────────────────────

create index if not exists idx_workers_user_id
  on workers(user_id);

create index if not exists idx_worker_credentials_worker_id
  on worker_credentials(worker_id);

create index if not exists idx_worker_credentials_status
  on worker_credentials(worker_id, status);

create index if not exists idx_worker_inductions_worker_id
  on worker_inductions(worker_id);

create index if not exists idx_worker_inductions_tenant_id
  on worker_inductions(tenant_id);

create index if not exists idx_worker_assignments_worker_id
  on worker_assignments(worker_id);

create index if not exists idx_worker_assignments_tenant_id
  on worker_assignments(tenant_id);

create index if not exists idx_worker_assignments_status
  on worker_assignments(tenant_id, status);


-- ── UPDATED_AT TRIGGER ─────────────────────────────────────

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workers_updated_at           on workers;
drop trigger if exists worker_credentials_updated_at on worker_credentials;

create trigger workers_updated_at
  before update on workers
  for each row execute function set_updated_at();

create trigger worker_credentials_updated_at
  before update on worker_credentials
  for each row execute function set_updated_at();
