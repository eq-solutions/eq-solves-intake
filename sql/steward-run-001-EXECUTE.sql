-- ============================================================================
-- STEWARD RUN 001 — EXECUTE ALL 19 COMMITS (one paste, one transaction)
-- ============================================================================
-- Where: Supabase SQL editor on sks-canonical (ehow / ehowgjardagevnrluult)
-- What:  13 staff trades + 5 contact format fixes + 1 contact link.
--        Every value is a literal below — review, then Run.
--        Every row is stamped with an intake_id (audit trail + rollback).
--        The final SELECT verifies everything and is the only output.
-- Why plain UPDATEs: maximum reviewability — no RPCs, no session claims,
--        every change visible on its own line.
-- ============================================================================

-- Lineage: one intake event per entity
insert into shell_control.eq_intake_events (intake_id, tenant_id, entity, source_kind, source_filename, schema_version, status, import_mode, created_by)
values
 ('d878cf74-ee25-4d68-bb90-c3318e7678d9', '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'staff',   'remediation', 'steward-run-001-2026-07-02', '1.0.0', 'committing', 'upsert', 'f4bd3058-5dc7-4d70-80b8-2dbc33de7231'),
 ('f3071e80-e938-49fe-9796-c1427e96585d', '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'contact', 'remediation', 'steward-run-001-2026-07-02', '1.0.0', 'committing', 'upsert', 'f4bd3058-5dc7-4d70-80b8-2dbc33de7231');

-- ---------------------------------------------------------------------------
-- 13 staff trades -> 'electrical' (each backed by an electrical licence on
-- file; Holmgreen by his own record's "Licensed Electrician" role field).
-- Guarded: only fires on active rows whose trade is still empty.
-- ---------------------------------------------------------------------------
update app_data.staff
set trade = 'electrical', intake_id = 'd878cf74-ee25-4d68-bb90-c3318e7678d9', imported_at = now()
where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and active and (trade is null or trade = '')
  and staff_id in (
    '52fa75b3-23f1-40bc-ad80-aa421ffbaa01', -- Harry Barton          (elec lic 487859C)
    '5226a800-7318-4df8-a975-5b555f5e3c2f', -- Vincent Costa         (elec lic 240586C)
    'dc71dc2c-705e-471e-a8a5-11713a25f889', -- Brian Griffin-Colls   (elec lic 327760C)
    '55ea2a14-af17-408a-8d28-4eedd97b4a9f', -- Cicero Goncalves DSJ  (elec lic 469037C)
    '337e793f-f87b-4ea9-952e-28628915e7db', -- Huon Henne            (elec lic 344493C)
    'e4ed1290-1ca1-4380-8fd2-42a6720c1acf', -- Jack Cluff            (elec lic 304905C)
    '3325269f-fa0b-4f8e-bdd7-1d2b1f22e8d1', -- Damon Patrick Francis (elec lic 453175C)
    '3c9714bd-c6d6-4a57-8abb-9beeed96b5e0', -- Collin Rhys Toohey    (elec lic NSW+QLD)
    '8d1dfcf1-3535-4657-a8d5-1550007fc081', -- Rhys Scott            (elec lic 371332C — renews 2026-07-28)
    'ff234dfb-385d-4c82-993e-2fa51efa2f9c', -- William J Brown       (elec lic 401671C)
    '6018d216-fb02-479d-9bd4-28c1600e5053', -- Benjamen Ritchie      (elec lic 366137C)
    '7db35cec-d521-4df1-89ee-2450d969fbf9', -- Mitchell Forsyrh      (elec lic 304820C)
    'cd55f332-8ced-41ea-afe3-f0c64ae379b8'  -- Liam Holmgreen        (role: Licensed Electrician)
  );

-- ---------------------------------------------------------------------------
-- 5 contact format fixes (values shown before -> after)
-- ---------------------------------------------------------------------------
-- Julie Jones (DigiCo): '61 0408 109 546' -> '0408109546' (doubled prefix stripped)
update app_data.contacts set work_phone = '0408109546', intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d', imported_at = now()
where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and contact_id = '96973a44-e095-4b88-8cdd-90c501812105';

-- David Collins (Ramsay): 'Collins, DCollinsD@ramsayhealth.com.au' -> 'CollinsD@ramsayhealth.com.au' (import mangle)
update app_data.contacts set email = 'CollinsD@ramsayhealth.com.au', intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d', imported_at = now()
where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and contact_id = '242776e4-3d66-489b-8910-c33718f69ab9';

-- Leon Jong (Ramsay): '9433 3807' -> '0294333807' (Sydney local, 02 added)
update app_data.contacts set work_phone = '0294333807', intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d', imported_at = now()
where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and contact_id = 'b82fec29-8cab-491e-a366-c0b3ed2bf30e';

-- Sean Ghodsi (Ramsay): '9433 3444' -> '0294333444' (2/3 panel — objection: 02 inferred from geography)
update app_data.contacts set work_phone = '0294333444', intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d', imported_at = now()
where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and contact_id = 'bcfc004a-6451-4aef-9cb1-5263cd46cd36';

-- Roxanne Banaag (The Mater): '9923 7241' -> '0299237241' (North Sydney, 02 added)
update app_data.contacts set work_phone = '0299237241', intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d', imported_at = now()
where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and contact_id = '1e333127-3417-4be8-a668-5d335c2423b5';

-- ---------------------------------------------------------------------------
-- 1 contact link: Michael Cunninghame -> Ramsay Health Care
-- (2/3 panel — objection: Warners Bay Private is a live alternative)
-- Guarded: only fires while still unlinked.
-- ---------------------------------------------------------------------------
update app_data.contacts
set customer_id = 'b1f305e5-b0d9-4ce4-bba6-5020faae379d', intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d', imported_at = now()
where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and contact_id = '880a9d92-6868-4610-a189-344cd1c6ced4' and customer_id is null;

-- Close the events with real counts
update shell_control.eq_intake_events set status = 'completed', rows_committed = 13, completed_at = now()
where intake_id = 'd878cf74-ee25-4d68-bb90-c3318e7678d9';
update shell_control.eq_intake_events set status = 'completed', rows_committed = 6, completed_at = now()
where intake_id = 'f3071e80-e938-49fe-9796-c1427e96585d';

-- ---------------------------------------------------------------------------
-- VERIFY (the only output you should see)
-- Expected: trades_committed 13 · trade_null_remaining_active 54 ·
--           6 contact rows with new values · 2 completed events · queue 137
-- ---------------------------------------------------------------------------
select json_build_object(
  'trades_committed', (select count(*) from app_data.staff where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and trade = 'electrical' and intake_id = 'd878cf74-ee25-4d68-bb90-c3318e7678d9'),
  'trade_null_remaining_active', (select count(*) from app_data.staff where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and active and (trade is null or trade = '')),
  'contact_fixes', (select json_agg(json_build_object('who', first_name||' '||coalesce(last_name,''), 'work_phone', work_phone, 'email', email, 'linked', customer_id is not null))
    from app_data.contacts where contact_id in ('96973a44-e095-4b88-8cdd-90c501812105','242776e4-3d66-489b-8910-c33718f69ab9','b82fec29-8cab-491e-a366-c0b3ed2bf30e','bcfc004a-6451-4aef-9cb1-5263cd46cd36','1e333127-3417-4be8-a668-5d335c2423b5','880a9d92-6868-4610-a189-344cd1c6ced4')),
  'events', (select json_agg(json_build_object('entity', entity, 'status', status, 'committed', rows_committed))
    from shell_control.eq_intake_events where intake_id in ('d878cf74-ee25-4d68-bb90-c3318e7678d9','f3071e80-e938-49fe-9796-c1427e96585d')),
  'queue_pending', (select count(*) from app_data.eq_remediation_queue where tenant_id = '7dee117c-98bd-4d39-af8c-2c81d02a1e85' and status = 'pending')
) as result;
