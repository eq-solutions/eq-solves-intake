-- ============================================================================
-- 021 — Sites management RPCs for eq-shell
-- ============================================================================
-- eq-shell's Sites module needs to query and mutate app_data.sites, but
-- app_data is not in Supabase's default REST-exposed schemas. These SECURITY
-- DEFINER RPCs expose the four operations the UI needs:
--
--   eq_list_sites       — search + archive-filter read
--   eq_archive_site     — soft-archive (active = false)
--   eq_unarchive_site   — restore (active = true)
--   eq_delete_site      — hard delete
--
-- All functions scope to the calling user's tenant via app_metadata.tenant_id.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- eq_list_sites
-- Returns sites for the caller's tenant, with optional text search and
-- optional inclusion of archived (active = false) rows.
-- ----------------------------------------------------------------------------
create or replace function eq_list_sites(
  p_search        text    default null,
  p_show_archived boolean default false
)
returns table(
  site_id         uuid,
  name            varchar,
  client_name     text,
  suburb          text,
  state           text,
  external_id     varchar,
  imported_from   text,
  active          boolean,
  customer_id     uuid
)
language sql
security definer
set search_path = app_data, public, extensions
as $$
  select
    s.site_id,
    s.name,
    s.client_name,
    s.suburb,
    s.state,
    s.external_id,
    s.imported_from,
    s.active,
    s.customer_id
  from app_data.sites s
  where s.tenant_id = (
    (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
  )
    and (p_show_archived or s.active = true)
    and (
      p_search is null
      or s.name ilike '%' || p_search || '%'
      or s.client_name ilike '%' || p_search || '%'
      or s.suburb ilike '%' || p_search || '%'
      or s.external_id ilike '%' || p_search || '%'
    )
  order by s.name;
$$;

revoke execute on function eq_list_sites(text, boolean) from public, anon;
grant  execute on function eq_list_sites(text, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- eq_archive_site
-- Soft-archives a site (active = false). Scoped to the caller's tenant.
-- ----------------------------------------------------------------------------
create or replace function eq_archive_site(p_site_id uuid)
returns void
language plpgsql
security definer
set search_path = app_data, public, extensions
as $$
begin
  update app_data.sites
  set active     = false,
      updated_at = now()
  where site_id  = p_site_id
    and tenant_id = (
      (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    );
end;
$$;

revoke execute on function eq_archive_site(uuid) from public, anon;
grant  execute on function eq_archive_site(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- eq_unarchive_site
-- Restores an archived site (active = true). Scoped to the caller's tenant.
-- ----------------------------------------------------------------------------
create or replace function eq_unarchive_site(p_site_id uuid)
returns void
language plpgsql
security definer
set search_path = app_data, public, extensions
as $$
begin
  update app_data.sites
  set active     = true,
      updated_at = now()
  where site_id  = p_site_id
    and tenant_id = (
      (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    );
end;
$$;

revoke execute on function eq_unarchive_site(uuid) from public, anon;
grant  execute on function eq_unarchive_site(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- eq_delete_site
-- Hard-deletes a site row. Scoped to the caller's tenant.
-- ----------------------------------------------------------------------------
create or replace function eq_delete_site(p_site_id uuid)
returns void
language plpgsql
security definer
set search_path = app_data, public, extensions
as $$
begin
  delete from app_data.sites
  where site_id  = p_site_id
    and tenant_id = (
      (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    );
end;
$$;

revoke execute on function eq_delete_site(uuid) from public, anon;
grant  execute on function eq_delete_site(uuid) to authenticated;

-- Migration record
insert into app_data._eq_migrations (name)
values ('021_sites_management_rpcs')
on conflict (name) do nothing;
