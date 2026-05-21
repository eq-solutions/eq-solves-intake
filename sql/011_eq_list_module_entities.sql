-- ============================================================================
-- 011 — eq_list_module_entities helper RPC (canonical-readiness Unit 7)
-- ============================================================================
-- Used by Unit 7's per-domain landing pages (eq-shell DomainLanding.tsx) to
-- list registered entities for a given module via PostgREST RPC (avoids
-- the PostgREST schema-exposure dance for shell_control.eq_schema_registry).
--
-- Idempotent — CREATE OR REPLACE.
-- ============================================================================

create or replace function eq_list_module_entities(p_module text)
returns table (entity text, version text, description text)
language sql security definer set search_path = app_data, shell_control, public, extensions stable
as $$
  select r.entity, r.version, r.description
  from shell_control.eq_schema_registry r
  where r.module = p_module and r.is_current = true
  order by r.entity;
$$;

grant execute on function eq_list_module_entities(text) to authenticated;
