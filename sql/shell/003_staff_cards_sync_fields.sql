-- ============================================================
-- Cards sync fields — employer canonical
-- Target: each employer's canonical Supabase (e.g. sks-canonical)
-- Adds the fields needed to track workers synced from Cards.
-- Idempotent: safe to re-run.
-- ============================================================

-- app_data.staff: record which Cards worker this row was synced from.
-- Unique — one staff row per Cards worker per canonical.
alter table app_data.staff
  add column if not exists cards_worker_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'staff_cards_worker_id_unique'
      and conrelid = 'app_data.staff'::regclass
  ) then
    alter table app_data.staff
      add constraint staff_cards_worker_id_unique unique (cards_worker_id);
  end if;
end $$;

-- app_data.licences: record which Cards credential this row was synced from,
-- and whether the employer has reviewed + confirmed it.
alter table app_data.licences
  add column if not exists cards_credential_id uuid,
  add column if not exists confirmed_by        text,       -- user_id or name of the confirmer
  add column if not exists confirmed_at        timestamptz;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'licences_cards_credential_id_unique'
      and conrelid = 'app_data.licences'::regclass
  ) then
    alter table app_data.licences
      add constraint licences_cards_credential_id_unique unique (cards_credential_id);
  end if;
end $$;

-- Index for looking up all unconfirmed Cards-sourced licences (compliance view).
create index if not exists idx_licences_cards_unconfirmed
  on app_data.licences (staff_id, confirmed_at)
  where cards_credential_id is not null and confirmed_at is null;
