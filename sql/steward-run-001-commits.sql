-- ============================================================================
-- Steward run 001 — the 17 unanimously-upheld commits (3/3 adversarial lenses)
-- ============================================================================
-- Target: sks-canonical (ehow, ehowgjardagevnrluult), tenant SKS Technologies.
-- Every row is stamped with an intake_id -> visible in the audit trail,
-- rollback-able. Run as one batch (single transaction) in the Supabase SQL
-- editor, or approve the identical execute_sql call in-session.
--
-- Companion: steward-run-001-ghodsi-cunninghame.sql (the two 2/3 commits with
-- standing objections — run only if explicitly approved).
-- ============================================================================

select set_config('request.jwt.claims', '{"sub":"f4bd3058-5dc7-4d70-80b8-2dbc33de7231","app_metadata":{"tenant_id":"7dee117c-98bd-4d39-af8c-2c81d02a1e85"}}', true);

-- Lineage: one intake event per entity
insert into shell_control.eq_intake_events (intake_id, tenant_id, entity, source_kind, source_filename, schema_version, status, import_mode, created_by)
values
 ('d878cf74-ee25-4d68-bb90-c3318e7678d9', '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'staff',   'remediation', 'steward-run-001-2026-07-02', '1.0.0', 'committing', 'upsert', 'f4bd3058-5dc7-4d70-80b8-2dbc33de7231'),
 ('f3071e80-e938-49fe-9796-c1427e96585d', '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'contact', 'remediation', 'steward-run-001-2026-07-02', '1.0.0', 'committing', 'upsert', 'f4bd3058-5dc7-4d70-80b8-2dbc33de7231');

-- 4 contact format fixes via the sanctioned RPC (whitelisted fields)
select public.eq_tidy_commit_fixes('f3071e80-e938-49fe-9796-c1427e96585d'::uuid, '[
 {"table":"contacts","row_id":"96973a44-e095-4b88-8cdd-90c501812105","field":"work_phone","new_value":"0408109546"},
 {"table":"contacts","row_id":"242776e4-3d66-489b-8910-c33718f69ab9","field":"email","new_value":"CollinsD@ramsayhealth.com.au"},
 {"table":"contacts","row_id":"b82fec29-8cab-491e-a366-c0b3ed2bf30e","field":"work_phone","new_value":"0294333807"},
 {"table":"contacts","row_id":"1e333127-3417-4be8-a668-5d335c2423b5","field":"work_phone","new_value":"0299237241"}
]'::json);

-- 13 staff trades (trade is not in the RPC field whitelist — direct update
-- with identical lineage stamps; guarded to null-trade active rows only)
update app_data.staff
set trade = 'electrical', intake_id = 'd878cf74-ee25-4d68-bb90-c3318e7678d9', imported_at = now()
where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and active and (trade is null or trade = '')
  and staff_id in (
    '52fa75b3-23f1-40bc-ad80-aa421ffbaa01', -- Harry Barton         (elec lic 487859C)
    '5226a800-7318-4df8-a975-5b555f5e3c2f', -- Vincent Costa        (elec lic 240586C)
    'dc71dc2c-705e-471e-a8a5-11713a25f889', -- Brian Griffin-Colls  (elec lic 327760C)
    '55ea2a14-af17-408a-8d28-4eedd97b4a9f', -- Cicero Goncalves DSJ (elec lic 469037C)
    '337e793f-f87b-4ea9-952e-28628915e7db', -- Huon Henne           (elec lic 344493C)
    'e4ed1290-1ca1-4380-8fd2-42a6720c1acf', -- Jack Cluff           (elec lic 304905C)
    '3325269f-fa0b-4f8e-bdd7-1d2b1f22e8d1', -- Damon Patrick Francis(elec lic 453175C)
    '3c9714bd-c6d6-4a57-8abb-9beeed96b5e0', -- Collin Rhys Toohey   (elec lic x2 NSW+QLD)
    '8d1dfcf1-3535-4657-a8d5-1550007fc081', -- Rhys Scott           (elec lic 371332C)
    'ff234dfb-385d-4c82-993e-2fa51efa2f9c', -- William J Brown      (elec lic 401671C)
    '6018d216-fb02-479d-9bd4-28c1600e5053', -- Benjamen Ritchie     (elec lic 366137C)
    '7db35cec-d521-4df1-89ee-2450d969fbf9', -- Mitchell Forsyrh     (elec lic 304820C)
    'cd55f332-8ced-41ea-afe3-f0c64ae379b8'  -- Liam Holmgreen       (role: Licensed Electrician)
  );

-- Close the events with real counts
update shell_control.eq_intake_events set status = 'completed', rows_committed = 13, completed_at = now()
where intake_id = 'd878cf74-ee25-4d68-bb90-c3318e7678d9';
update shell_control.eq_intake_events set status = 'completed', rows_committed = 4, completed_at = now()
where intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d';

-- Verify
select json_build_object(
  'trades_committed', (select count(*) from app_data.staff where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and trade = 'electrical' and intake_id = 'd878cf74-ee25-4d68-bb90-c3318e7678d9'),
  'trade_null_remaining_active', (select count(*) from app_data.staff where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and active and (trade is null or trade = '')),
  'contact_fixes', (select json_agg(json_build_object('who', first_name||' '||coalesce(last_name,''), 'work_phone', work_phone, 'email', email))
    from app_data.contacts where contact_id in ('96973a44-e095-4b88-8cdd-90c501812105','242776e4-3d66-489b-8910-c33718f69ab9','b82fec29-8cab-491e-a366-c0b3ed2bf30e','1e333127-3417-4be8-a668-5d335c2423b5')),
  'events', (select json_agg(json_build_object('entity', entity, 'status', status, 'committed', rows_committed))
    from shell_control.eq_intake_events where intake_id in ('d878cf74-ee25-4d68-bb90-c3318e7678d9','f3071e80-e938-49fe-9796-c1427e96585d'))
) as result;
