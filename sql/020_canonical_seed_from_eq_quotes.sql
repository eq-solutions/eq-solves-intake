-- ============================================================================
-- 020 — Reseed canonical customers from EQ Quotes (deduplicated)
-- ============================================================================
-- Problem:
--   app_data.customers has 525 rows seeded on 2026-05-23 in two batches:
--   - Batch 1 (7 rows, 20:56 UTC): from EQ Service customers. These are
--     company-level records. EQ Service has canonical_id pointing to these
--     UUIDs — do NOT delete.
--   - Batch 2 (518 rows, 21:31 UTC): from EQ Quotes (sks_quotes_customers).
--     Each row = a SimPRO site, not a company. External IDs are EQ Quotes
--     UUIDs, not SimPRO customer IDs. Heavy duplication (250 Schneider rows,
--     36 Erilyan rows, etc.).
--
-- Fix:
--   1. Delete the 518 site-level rows (created >= 2026-05-23 21:00:00 UTC).
--   2. Insert 118 deduplicated company-level records sourced from EQ Quotes
--      (120 distinct names minus "zz Test Company" and "Equinix Australia
--      Pty Ltd" which already exists in the 7 preserved rows).
--
--   external_id = EQ Quotes UUID (sks_quotes_customers.id) — stable back-
--   reference so EQ Quotes can resolve its canonical_id once that column
--   is added (migration 021).
--
-- After this migration:
--   - 7 EQ Service-sourced rows preserved (EQ Service canonical_id intact)
--   - 118 EQ Quotes-sourced company rows inserted (deduplicated, clean)
--   - Total: 125 customer records
--
-- Target: sks-canonical (ehowgjardagevnrluult)
-- Tenant: SKS Technologies (7dee117c-98bd-4d39-af8c-2c81d02a1e85)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Step 1: Delete the 518 bad site-level rows (second seeding batch)
-- Identified by: created_at >= 2026-05-23 21:00:00 UTC (21:31 batch)
-- The 7 EQ Service rows were created at 20:56 UTC — safely below the cutoff.
-- ----------------------------------------------------------------------------
DELETE FROM app_data.customers
WHERE created_at >= '2026-05-23 21:00:00+00'
  AND intake_id IS NULL;

-- Verify: should delete exactly 518 rows (run count before committing if needed)

-- ----------------------------------------------------------------------------
-- Step 2: Insert 118 deduplicated company records from EQ Quotes
-- Source: DISTINCT ON (name) from nspbmirochztcjijmcrx sks_quotes_customers
-- Ordered by data completeness (contact/email/phone filled) then created_at.
-- external_id = EQ Quotes customer UUID for back-reference.
-- customer_group = market_vertical from EQ Quotes (where set).
-- ----------------------------------------------------------------------------
INSERT INTO app_data.customers (
  customer_id,
  tenant_id,
  external_id,
  company_name,
  email,
  primary_phone,
  customer_group,
  imported_from,
  imported_at,
  active
) VALUES
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '1842d1a8-4443-460f-9b9f-95487a379ac8', '4 Fold Building Services',                           'hector@4fold.com.au',               '0426 688 747',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '9f44dd34-2d3b-4f8b-afd7-0626a1ede256', 'A.G. Coombs (NSW) Pty Ltd',                          'kllewellyn@agcoombs.com.au',        '0439 574 187',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '7c219b99-1e67-4fd3-99ba-7c986ad82d33', 'ABB Australia Pty Ltd',                              'duane.hines@au.abb.com',            '+61 458 486 034', null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '732f291a-8cd2-4cc8-a907-3a677e3dbec2', 'ACIA Electrical',                                    'cameron@aciaelectrical.com.au',     '0416 176 166',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '3c46775d-afa9-40d3-b92a-fb7acb215411', 'ADCO Constructions',                                 'jchan@adcoconstruct.com.au',        '0457647233',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'bed10361-eee7-4c24-afbe-21b56a370a8e', 'Addelec Power Services',                             'todd.rowley@addelec.com.au',        '0429 357 977',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '94cb3ef2-8c61-4b6c-9075-0361d16d9d14', 'Akalan Projects Limited',                            'ostone@akalan.com.au',              '0400298262',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '9974fe84-ca35-43f7-b81b-063fb03f6c59', 'Albury Wodonga Private Hospital',                    null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '1c6f58a7-0508-41fe-8821-baafdc606af6', 'Anthony Vavayis & Associates Pty Ltd',               'steven@avaarchitects.com.au',       null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '8c29c2eb-3780-47db-9dc1-29fe5f897eb1', 'ARA Electrical Engineering Services Pty Ltd',        'alicia.winley@araelect.com.au',     '0404 839 465',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '32f27fb6-3d9e-45c2-bc05-c1cbe79ea8d7', 'AW Edwards',                                         'jfletcher@awedwards.com.au',        null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '619cf1be-9898-4dd5-a372-639f34b6bb30', 'Bang & Olufsen',                                     'danieljames@beostoreadelaide.com',  '0411 035 975',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '77ad672d-efd6-45bb-986c-249134305483', 'Bassrock',                                            'DavisL@bigpond.com',                '0410647086',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'e63dd55a-6be7-44b4-8bf1-ee12f8d01c93', 'BeyondFire',                                         'ben@beyondfire.com.au',             '0451 199 161',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'c3d4dde3-1a64-41cb-838a-b5919adf268b', 'BGIS ANZ PTY LTD',                                   'jacob.brennan@team.telstra.com',    '0409 123 684',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '6a4f7fb3-1ce4-43fa-a02b-c904d36ccf85', 'BGIS Pty Ltd',                                       'Paul.Buttifant@apac.bgis.com',      '0436 672 650',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '4ca59ab9-4e4b-4fbc-acfa-390b73851805', 'Bristow Electrical Pty Ltd',                         'jakebristow@bristowelectrical.com.au','0403563115',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'd4f56278-0d3b-4c6c-8b1d-d8aac276fa00', 'Bundaberg Cardiology Pty Ltd',                       'leanne.toth@genesiscare.com',       '07 3028 2610',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '31a8e4c3-1ecd-4242-83f1-5ead16f2667b', 'Cairns Private Hospital',                            'GeorgeMike@ramsayhealth.com.au',    '0457 183 184',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '6d938f27-c4cd-4bd2-add9-0200dcf3e6c1', 'Calvary John James Hospital',                       'Gary.Craigie@calvarycare.org.au',   '0411 511 075',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '3f07210b-c4df-4dff-ba8f-6d12e33f03b1', 'Chris O''Brien Lifehouse',                           'phill.wenham@lh.org.au',            null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'fc141afd-a481-417b-94ac-5c409142d11b', 'Clear Cut Solar Pty Ltd',                            'nik@clearcutsolar.com.au',          null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '22e6751c-aaf5-4b78-b342-d915c2fa70a1', 'Climatech NSW Pty Ltd',                              null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '8f90d6b5-b3bb-4fb8-98d2-b321c18dc289', 'Convergint Australia PTY LTD',                       'larsonw@prosys.net.au',             '0448 779 199',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'f38fd6d4-db0a-4d21-9511-129d2ed96469', 'Copper and Rose',                                    null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '6f838d86-e969-49bd-865b-62cf2625bc9e', 'D Bennett Plumbing Pty Ltd',                         'wayne.bennettgroup@bigpond.com',    null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '1667bdfa-f9bc-4935-956f-73df1873d282', 'DAL TECH Electrical & Communications PTY LTD',       'michael@daltech.net.au',            '0415 74 39 39',   null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'f29337c9-e201-489f-b96e-7de7fd550f73', 'DCE Contracting Pty Ltd',                            'deian@dce.net.au',                  '0414 488 722',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '03611c61-2c8a-47c7-a46d-795cc2008e5d', 'Dell Technologies',                                  'ashan.ratnasinghe@dellteam.com',    null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '42df0661-c828-4d0f-884c-40ed1ca62825', 'Delta Elcom Pty Ltd',                                null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '45129ce7-42f8-4ac0-a06c-ca5d2596e53c', 'Delta Electronics (Australia) Pty Ltd',              'praneel.prasad@deltaww.com',        '0409 536 144',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '66ce0566-97a0-49c2-ac6a-35a160e0adaf', 'Dexus Wholesale Property Limited',                   null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'a6ed332a-217d-4104-8d25-87413ad49821', 'DigiCo Infrastructure REIT',                         'jfisher@globalswitch.com.au',       '+61 408 504 903', null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '4a4fb5cd-9724-4999-95dc-56edbb7362bc', 'Digital Erskine Park 2 LLC',                         'n.spratt@digitalrealty.com',        '0419 675 548',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'c32c0421-454a-407e-ae80-33b88be5cc3f', 'DL Electrical Group',                                'kieran@dlelectricalgroup.com.au',   '0426791882',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'f5202322-65cd-4b69-b5cd-ff36337fb51b', 'Donald Cant Watts Corke (NSW) Pty Ltd',               'rochelle.prasad@dcwc.com.au',       '0400 074 098',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '3c0ea234-5a30-4955-a1e7-23c1e04b1ee7', 'DP Plumbing',                                        null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'd0b20a15-78f0-4807-82ef-ab50082351f5', 'Dr Kenneth Howison',                                 'khowison@bigpond.com',              null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'd349b166-8023-4299-b0f7-b3a40dd156c5', 'DXN Limited',                                        'Matt.McCormack@alliancesi.com.au',  '0414 704 107',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '1fa27d07-e3f7-4c37-9848-705ef21d18ee', 'DXN Solutions',                                      null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '93d6903f-0920-44bc-9073-7629032a8de6', 'Eaton Industries',                                   null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '4b4a3e32-8120-4ecd-8af5-338099a791cd', 'EcoLab',                                             null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'db87156a-5ede-476f-ae33-265cfc676e4d', 'Electrical Testing Company Pty Ltd',                 null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '2bd5d20b-c49c-4c36-b4c8-9829fc38af07', 'Enel X',                                             null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '0643f9ec-3252-402e-8e52-97ad00504569', 'Energy & Environment Solutions',                     'niall@getsgroup.com',               null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'ee4f202b-abd5-48c8-aab4-f0f51b46a604', 'Equilibrium Air Conditioning Pty Ltd',               null,                                '0431 122 311',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '46b048f2-7862-4b1d-9a8d-63ed086fbd43', 'Equinix Australia National Pty Ltd',                 'bdunn@ap.equinix.com',              '0459 224 434',    'Data Centres','eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '0d30a82a-27ed-41d3-bde9-5dbc250a3cf4', 'Equinix Hyperscale 2 (SY9) Pty Limited',             'rzeng@ap.equinix.com',              null,              'Data Centres','eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'ae6bbcc1-9734-4522-afa5-9c4a7ec74d5c', 'Erilyan Projects',                                   null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'ac424dd2-816d-4074-8629-4c8a531391ef', 'Erilyan Pty Ltd',                                    'jbishop@erilyan.com.au',            '0469274181',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '40f6b64f-8ec5-4430-8530-df02e63f2d04', 'Forward Consulting Group Pty Ltd',                   'brendan@forcon.com.au',             '0451075749',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '1ad92242-a26d-436e-816d-215439cb1f03', 'Fulton Hogan Egis O&M Pty Ltd',                      'Matt.Woods@fheom.com.au',           '0402 571 382',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '27c1d1ba-d2a2-472f-aaa0-dc0103ba2ca3', 'G E Oil Labs',                                       null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '6758a32a-9373-4939-8a7f-2cca7b1c6878', 'Genesis Health',                                     'rpullin@akalan.com.au',             null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'fc09c263-8a8c-4e63-bdf0-39c3d1e68c4d', 'Global Switch Properties Australia Pty Ltd',         'MGoldring@globalswitch.com',        '0437 696 301',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'b19aeb73-643b-49ab-9ddc-92d0c11ef509', 'GRID Electrical Services',                           'dvassallo@gridelectrical.com.au',   '0413 449 385',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'af8b61bf-f0c2-4da5-ba03-07458c52c31b', 'Harbor MSP',                                         null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '644c393f-5ab9-4e3d-a5c8-791010451693', 'Haus construction',                                  null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'e278dffe-8931-4de4-8667-653469568e64', 'Haus Construction & Consulting',                     null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '72f08ddb-387c-405a-a7c7-f6acd4aad850', 'HDI SYD1 Property Holdings Pty Limited',             null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'a71353e2-0232-4575-88c0-f50f108eb5bd', 'Health Infrastructure',                              'ranya.samaan@cbre.com.au',          null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '1970f0c6-e20c-4ba8-9254-89cfaa33b9d8', 'Hutchinson Builders',                                null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '57f71c8f-8448-4300-b666-b6fcde7419f3', 'IPD Group Services Pty Ltd',                         'alvin.villamor@ipd.com.au',         '0455 280 066',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'af595d92-0fc9-4cb1-a9c9-c2ac872accfe', 'J Hutchinson Pty Ltd T/A Hutchinson Builders',       null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '3796e5a1-f8ad-4af7-b7d8-37259a9c8547', 'Jeff Burvill',                                       null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '0d1f8eb5-da2d-4078-8b10-39ca58bf4716', 'JMB Electrical',                                     'kyle@jmbelectrical.com.au',         '0432275432',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'd506301f-4165-40a1-a834-0aa9e38ce310', 'Kempwood Electrical',                                null,                                '0419461860',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '052c8196-91dc-4a6a-800e-c28b809f70dd', 'Kwik Kopy Mascot',                                   null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '42bf0e64-316c-47b3-9cfe-7e22e841fee9', 'Link Mechanical',                                    'john@linkmechanical.com.au',        null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'a9e7751a-6c9c-460b-b3d7-2e5c84aea5fd', 'MacGregor Nominees',                                 'macnoms@gmail.com',                 '0410 698 761',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '5900619d-96db-4803-ba78-47d3e76de808', 'McDonald Strata',                                    null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '31b0aa3f-65b7-45e4-b0b3-33ff9515af9a', 'McMahon Services Australia',                         null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'ffc85203-b6e9-4523-8a07-77bfc458a7df', 'Metronode (NSW)',                                    'iyousuff@ap.equinix.com',           '0422 956 954',    'Data Centres','eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'b8cf5ddd-4eb5-4048-89d9-9618b90a7b59', 'MG Cable Solutions',                                 null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'cb745df5-990e-4be3-bf94-f282d4c7f133', 'MSB Electrical Services',                            'john@msbes.com.au',                 '0425 218 444',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '1039f74e-6de4-46db-91f9-dc34cfa87946', 'North Shore Radiology & Nuclear Medicine',            'ascouler@nsrnm.com.au',             '0404047809',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'ef940180-e27d-4d1d-adbf-c268a1f0dc2b', 'Northern Beaches Cancer Care',                       'jhunter@ccapt.com.au',              '0409 916 334',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'cf24c457-547a-4f0c-aa49-da1ae6bda3b5', 'Northside Clinic',                                   null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '37bb6403-f5ff-423d-b75b-72e59816f772', 'Northside Clinic Cremorne',                          null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'ee42ddad-f969-4273-a8d4-66c2b0f869e1', 'Northside Group - Macarthur Clinic',                 null,                                '0499 272 662',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '353beb1a-aa36-4e34-99ea-3eda7f7cc018', 'Northside Group St Leonards Clinic',                 'NilssonG@ramsayhealth.com.au',      '0418423716',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '86698ff8-efbc-49ad-88c0-1843e096ca07', 'OnConstructions Pty Ltd',                            'lbardis@onconstructions.com.au',    '0418 183 547',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '6a60cb4d-bfe1-4332-b3ba-c077d4812f0e', 'Planet Ark Power',                                   'paul.r@planetarkpower.com',         '0407 152 374',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '6c0eee6c-3d7e-499b-9858-747f0d0a7bbe', 'Platinum Build Pty Ltd',                             null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'e655e58b-1c6e-41df-b27b-90d39a1cb456', 'Project Odeon',                                      'john.moutopoulos@projectodeon.com', '61 400 100 810',  null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '7ac3d904-9476-4bbc-9cc5-d05bfa9f3711', 'Prompcorp',                                          'aaronfoxman@prompcorp.com.au',      '1300 722 306',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '934fe8c8-efc0-4eb2-a577-eae305945eb6', 'Quick Plumbing Group',                               'mariom@quickplumbing.com.au',       null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '56bf4ab1-9bd6-4656-8445-ee41becbb0e7', 'Ramsay Health Care',                                 'ChanH@ramsayhealth.com.au',         '0488 698 408',    'Healthcare',  'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'e527c0e9-37d0-4689-85ea-9dc66da00772', 'Ramsay Health Care Investments',                     'collinsd@ramseyhealth.com.au',      '0422747222',      'Healthcare',  'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '8acda84e-f94e-4500-89f8-3d107ab4c2e5', 'Ramsay Health Care IT',                              'mansjurR@Ramsayhealth.com.au',      null,              'Healthcare',  'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '8686bab0-64c7-4e4b-b3a6-5a0229971b3a', 'Renascent Regional',                                 'GWillatt@renascent.com.au',         '0416 258 214',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'f3382fec-f238-42af-88f9-93d346a1f9a2', 'Richard Crookes Constructions',                      null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '2c1030a3-a9c0-4734-9bfd-24cecbed0070', 'Richard Curtin',                                     null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'd6ae3d88-0d31-438e-9d44-5cc8aeb827d2', 'Riverview Landscapes',                               null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '3151ca21-dbfe-4bca-bde1-e9996658eb7e', 'Rohrig',                                             null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'b8789dc7-765b-4c81-bb53-51fb1c5af283', 'Rohrig (NSW) Pty Ltd',                               'tima@rohrig.com.au',                '0402570274',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '9bedffb4-bfed-4999-8989-590b865c7842', 'SCAR Group',                                         'ron@scargroup.com.au',              null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '54a17fc8-ea34-4d43-8a02-039d0b8d2b63', 'Schneider Electric Australia (SA) Pty Ltd',          'melvin.mathew@se.com',              '0437 760 532',    'Utilities',   'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '4aab19a0-441a-450e-85ad-eb889ba7ef89', 'Schneider Electric Australia Pty Ltd',               'sharon.bonnici@se.com',             '0437 688 226',    'Utilities',   'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '163164ca-0c0d-4a5e-b40e-4f6574ada21f', 'Schneider Electric IT Australia Pty Ltd',            'heidi.korff@se.com',                null,              'Utilities',   'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '9297bd0d-75f4-4658-826b-03736fe126d1', 'Schneider Electric Pty Ltd',                         null,                                null,              'Utilities',   'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '2a64741e-a93c-49c8-9042-7e182d710454', 'Scrap Metal & Recylcling Pty Ltd',                   'scottarofe@gmail.com',              '0402 082 433',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'ed16ec3b-a193-4834-9e6e-8a52f107ecc3', 'Sculpt',                                             'john@kryofix.com.au',               '0474 806 813',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'd444bd80-3ed6-4964-88aa-bbd8ef76465f', 'Securitas',                                          null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'cf31d46d-a595-4824-9156-2a7e7b7f240d', 'Shape',                                              'Tyler.Harrhy@shape.com.au',         '0438 969 347',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '22b29dd7-3203-40a6-80be-85b63d5f3402', 'SMPM NSW Pty Ltd',                                   null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'ec57c048-48a8-4bb6-be4e-94b9dbdb0c2b', 'Steris Australia',                                   'joseph_karren@steris.com',          '0406944839',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '635c26ca-8bea-44b7-9313-664fde8ad7ef', 'Supercharge Batteries',                              null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'ed5bc4bb-6ccc-4fc1-b3fb-640969e7e8e1', 'Sydney Metal Recyclers',                             null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '4d070f8f-0e98-4942-9f63-db997acce646', 'Tennant Australia',                                  null,                                null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '24319d64-19ed-459c-b216-808c9e6b5a90', 'The Cardiology Group',                               'office@thecardiologygroup.com.au',  null,              null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'd811f064-cef8-40d3-b303-e3bda51c1050', 'The Mater Hospital',                                 'dale.wade@svha.org.au',             '0405151381',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '0dee3ae3-9919-49d3-94dd-0d3aa9a11d5c', 'Todae Solar (Solar Installer)',                      'ethan.mewada@todaesolar.com.au',    '0489 901 948',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '74200f38-9e45-47ae-9730-a5ca68c6a35f', 'Transurban Limited',                                 'dpapas@transurban.com',             '0439 354 609',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '3f5c843a-cefc-4678-b133-e63c2bb27fe4', 'Ultegra Pty Ltd',                                    'above@ultegra.com.au',              '0413 909 950',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '8195791e-14d8-472f-b9e0-b8286e1b4d0d', 'V2 Switchboard Solutions',                           'scott@controllingpower.com.au',     '0416 799 100',    null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', 'b839e449-747c-4d14-a78f-141d97f2554b', 'Ventia',                                             'matt.otaran@ventia.com',            '0448240156',      null,          'eq_quotes', now(), true),
  (gen_random_uuid(), '7dee117c-98bd-4d39-af8c-2c81d02a1e85', '0b3083b4-864e-4b75-b01c-0bd496dd8e04', 'Warners Bay Private Hospital',                       null,                                null,              null,          'eq_quotes', now(), true);

-- Migration record
INSERT INTO app_data._eq_migrations (name) VALUES ('020_canonical_seed_from_eq_quotes')
ON CONFLICT (name) DO NOTHING;

COMMIT;

-- ============================================================================
-- POST-MIGRATION VERIFICATION
-- ============================================================================
-- SELECT COUNT(*) FROM app_data.customers;
-- -- Expected: 125 (7 EQ Service + 118 EQ Quotes)
--
-- SELECT imported_from, COUNT(*) FROM app_data.customers GROUP BY imported_from;
-- -- Expected: eq_quotes → 118, null → 7
--
-- SELECT COUNT(*) FROM app_data.customers WHERE intake_id IS NULL AND created_at >= '2026-05-23 21:00:00+00';
-- -- Expected: 0 (deleted rows gone)
--
-- SELECT company_name FROM app_data.customers WHERE customer_group IS NOT NULL ORDER BY customer_group, company_name;
-- -- Expected: Data Centres (3), Healthcare (3), Utilities (4) groups
-- ============================================================================
