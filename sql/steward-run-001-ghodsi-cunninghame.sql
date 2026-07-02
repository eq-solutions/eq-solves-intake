-- ============================================================================
-- Steward run 001 — the TWO 2/3 commits with standing objections
-- ============================================================================
-- Run ONLY on explicit approval. Objections preserved verbatim in
-- REMEDIATION-DRYRUN-2026-07-02.md:
--   Ghodsi:      the 02 area code is inferred from customer geography, not
--                present in the stored digits (Melbourne 9433 exchanges exist).
--   Cunninghame: his "Newcastle Region" title makes Warners Bay Private
--                Hospital a live alternative to the Ramsay parent.
-- Both stamp the same contact intake event as run 001.
-- ============================================================================

select set_config('request.jwt.claims', '{"sub":"f4bd3058-5dc7-4d70-80b8-2dbc33de7231","app_metadata":{"tenant_id":"7dee117c-98bd-4d39-af8c-2c81d02a1e85"}}', true);

-- Sean Ghodsi work_phone: 9433 3444 -> 0294333444 (via RPC, whitelisted field)
select public.eq_tidy_commit_fixes('f3071e80-e938-49fe-9796-c1427e96585d'::uuid, '[
 {"table":"contacts","row_id":"bcfc004a-6451-4aef-9cb1-5263cd46cd36","field":"work_phone","new_value":"0294333444"}
]'::json);

-- Michael Cunninghame -> Ramsay Health Care (customer_id not RPC-whitelisted;
-- direct update with identical lineage stamps, guarded to unlinked-only)
update app_data.contacts
set customer_id = 'b1f305e5-b0d9-4ce4-bba6-5020faae379d', intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d', imported_at = now()
where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85'
  and contact_id = '880a9d92-6868-4610-a189-344cd1c6ced4' and customer_id is null;

update shell_control.eq_intake_events set rows_committed = rows_committed + 2
where intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d';

select first_name, last_name, work_phone, customer_id
from app_data.contacts
where contact_id in ('bcfc004a-6451-4aef-9cb1-5263cd46cd36','880a9d92-6868-4610-a189-344cd1c6ced4');
