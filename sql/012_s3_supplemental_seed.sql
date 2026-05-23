-- S3 supplemental seed — licences + prestart checks + toolbox talks
-- Tenant: core (dcb71d03-858d-488a-b8e6-b76b404d25d6)
-- All rows marked imported_from = 'sprint_s3_seed_2026_05_20'
-- Run idempotently: wrapped in a DO block that checks count first.

DO $$
DECLARE
  v_tenant uuid := 'dcb71d03-858d-488a-b8e6-b76b404d25d6'::uuid;

  -- Staff IDs from the existing seed
  s1 uuid := '07032152-c49c-4766-b44b-1fa61d4d3b08';
  s2 uuid := '32f70d77-6459-468c-9a11-4e65aeaf040f';
  s3 uuid := '953b7d9d-8875-4c53-bcc1-0a2725c140a7';
  s4 uuid := 'a26790b7-d57d-47ed-aa1d-4e8a153214b8';
  s5 uuid := '405d9947-3038-4ec5-b584-a729adb09010';
  s6 uuid := '05f0494d-d149-452b-bca8-f5a3bb089e38';
  s7 uuid := 'da72bced-2140-4e81-9351-dd5fd836e6fb';
  s8 uuid := '281c8b66-41d7-4fce-ba37-6c82cd35da01';
  s9 uuid := '70386902-3ab3-4bc3-8d82-fdcedd49081f';
  s10 uuid := '5ec91478-b772-4946-9e75-6d19cb38d1c8';

  -- Site IDs from the existing seed
  site1 uuid := '02da1614-554f-4b63-a9ff-ab4d75962176';
  site2 uuid := '3f2af1bc-8799-4698-b267-65031dece3c8';
  site3 uuid := '66337cd3-f2ab-4a3b-acde-45fc6c564929';
  site4 uuid := '29ea8586-2ce5-4358-bdac-e892f6917b4e';
  site5 uuid := 'f08cfec2-4274-4b92-be5b-b342c71569f0';
  site6 uuid := '9f4c8613-7a70-495f-8bbb-0a90136e8c2d';

  v_existing_licences int;
  v_existing_prestarts int;
  v_existing_talks int;
BEGIN

  SELECT count(*) INTO v_existing_licences
  FROM app_data.licences WHERE tenant_id = v_tenant AND imported_from = 'sprint_s3_seed_2026_05_20';

  SELECT count(*) INTO v_existing_prestarts
  FROM app_data.prestart_checks WHERE tenant_id = v_tenant AND imported_from = 'sprint_s3_seed_2026_05_20';

  SELECT count(*) INTO v_existing_talks
  FROM app_data.toolbox_talks WHERE tenant_id = v_tenant AND imported_from = 'sprint_s3_seed_2026_05_20';

  -- ────────────────────────────────────────────────────────────────
  -- LICENCES (25 rows across 10 staff)
  -- ────────────────────────────────────────────────────────────────
  IF v_existing_licences < 25 THEN
    INSERT INTO app_data.licences (
      licence_id, tenant_id, staff_id, licence_type, licence_number,
      issuing_authority, state, issue_date, expiry_date, active,
      imported_from, created_at, updated_at
    ) VALUES
      (gen_random_uuid(), v_tenant, s1,  'Electrical A Grade',     'EL-A-001234', 'NSW Fair Trading',    'NSW', '2021-03-01', '2026-03-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s1,  'Working at Heights',     'WAH-001234',  'SafeWork NSW',        'NSW', '2023-01-15', '2025-01-15', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s2,  'Electrical A Grade',     'EL-A-002345', 'NSW Fair Trading',    'NSW', '2020-06-10', '2025-06-10', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s2,  'EWP Boom Type',          'EWP-002345',  'SafeWork NSW',        'NSW', '2022-09-01', '2025-09-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s3,  'Electrical A Grade',     'EL-A-003456', 'VIC Energy Safe',     'VIC', '2019-11-20', '2024-11-20', false, 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s3,  'Confined Space Entry',   'CSE-003456',  'SafeWork NSW',        'NSW', '2023-05-01', '2026-05-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s4,  'Electrical B Grade',     'EL-B-004567', 'NSW Fair Trading',    'NSW', '2022-02-01', '2027-02-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s4,  'Forklift LO',            'FL-LO-004567','SafeWork NSW',        'NSW', '2021-07-15', '2024-07-15', false, 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s5,  'Electrical A Grade',     'EL-A-005678', 'NSW Fair Trading',    'NSW', '2018-04-01', '2023-04-01', false, 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s5,  'Working at Heights',     'WAH-005678',  'SafeWork NSW',        'NSW', '2024-01-10', '2026-01-10', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s6,  'Electrical A Grade',     'EL-A-006789', 'NSW Fair Trading',    'NSW', '2022-08-01', '2027-08-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s6,  'EWP Boom Type',          'EWP-006789',  'SafeWork NSW',        'NSW', '2023-03-01', '2026-03-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s7,  'Electrical A Grade',     'EL-A-007890', 'NSW Fair Trading',    'NSW', '2021-05-01', '2026-05-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s7,  'Rigging Basic',          'RIG-B-007890','SafeWork NSW',        'NSW', '2022-11-01', '2025-11-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s8,  'Electrical C Grade',     'EL-C-008901', 'NSW Fair Trading',    'NSW', '2023-07-01', '2028-07-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s8,  'Confined Space Entry',   'CSE-008901',  'SafeWork NSW',        'NSW', '2024-02-01', '2027-02-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s9,  'Electrical A Grade',     'EL-A-009012', 'NSW Fair Trading',    'NSW', '2020-01-01', '2025-01-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s9,  'Dogging',                'DOG-009012',  'SafeWork NSW',        'NSW', '2023-06-15', '2026-06-15', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s10, 'Electrical A Grade',     'EL-A-010123', 'NSW Fair Trading',    'NSW', '2021-10-01', '2026-10-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s10, 'Working at Heights',     'WAH-010123',  'SafeWork NSW',        'NSW', '2023-09-01', '2025-09-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s1,  'Asbestos Awareness',     'ASB-001234',  'SafeWork NSW',        'NSW', '2023-04-01', '2024-04-01', false, 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s2,  'First Aid (Apply)',      'FA-002345',   'St John Ambulance',   'NSW', '2022-12-01', '2025-12-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s3,  'EWP Scissor',            'EWP-S-003456','SafeWork NSW',        'NSW', '2022-05-01', '2025-05-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s4,  'Fire Extinguisher',      'FE-004567',   'SafeWork NSW',        'NSW', '2024-01-01', '2027-01-01', true,  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, s5,  'Rigging Intermediate',   'RIG-I-005678','SafeWork NSW',        'NSW', '2023-08-01', '2026-08-01', true,  'sprint_s3_seed_2026_05_20', now(), now())
    ON CONFLICT DO NOTHING;
    RAISE NOTICE 'Licences seeded.';
  ELSE
    RAISE NOTICE 'Licences already seeded (% rows), skipping.', v_existing_licences;
  END IF;

  -- ────────────────────────────────────────────────────────────────
  -- PRESTART CHECKS (add 22 more, mixed across sites)
  -- ────────────────────────────────────────────────────────────────
  IF v_existing_prestarts < 20 THEN
    INSERT INTO app_data.prestart_checks (
      prestart_id, tenant_id, site_id, date, shift_start, weather,
      completed_by, completed_at, responses, hazards_identified,
      imported_from, created_at, updated_at
    ) VALUES
      (gen_random_uuid(), v_tenant, site1, current_date - 0,  '06:30', 'Fine',     'James Miller',     now() - interval '1 hour',  '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site2, current_date - 0,  '07:00', 'Overcast', 'Sophie Davis',     now() - interval '2 hours', '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site3, current_date - 1,  '06:30', 'Fine',     'Liam Rodriguez',   now() - interval '26 hours','{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site4, current_date - 1,  '07:00', 'Rainy',    'Emily Martinez',   now() - interval '25 hours','{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site5, current_date - 2,  '06:30', 'Fine',     'Noah Hernandez',   now() - interval '50 hours','{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site6, current_date - 2,  '07:00', 'Fine',     'Olivia Lopez',     now() - interval '49 hours','{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site1, current_date - 3,  '06:30', 'Overcast', 'Ethan Gonzalez',   now() - interval '74 hours','{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site2, current_date - 3,  '07:00', 'Fine',     'Charlotte Wilson', now() - interval '73 hours','{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site3, current_date - 4,  '06:30', 'Fine',     'Lucas Anderson',   now() - interval '98 hours','{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site4, current_date - 4,  '07:00', 'Windy',    'Ava Thomas',       now() - interval '97 hours','{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site5, current_date - 5,  '06:30', 'Fine',     'James Miller',     now() - interval '122 hours','{}','[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site6, current_date - 5,  '07:00', 'Fine',     'Sophie Davis',     now() - interval '121 hours','{}','[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site1, current_date - 7,  '06:30', 'Overcast', 'Liam Rodriguez',   now() - interval '7 days',  '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site2, current_date - 7,  '07:00', 'Fine',     'Emily Martinez',   now() - interval '7 days',  '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site3, current_date - 8,  '06:30', 'Fine',     'Noah Hernandez',   now() - interval '8 days',  '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site4, current_date - 8,  '07:00', 'Rainy',    'Olivia Lopez',     now() - interval '8 days',  '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site5, current_date - 9,  '06:30', 'Fine',     'Ethan Gonzalez',   now() - interval '9 days',  '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site6, current_date - 9,  '07:00', 'Fine',     'Charlotte Wilson', now() - interval '9 days',  '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site1, current_date - 10, '06:30', 'Fine',     'Lucas Anderson',   now() - interval '10 days', '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site2, current_date - 10, '07:00', 'Overcast', 'Ava Thomas',       now() - interval '10 days', '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site3, current_date - 11, '06:30', 'Fine',     'James Miller',     now() - interval '11 days', '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site4, current_date - 11, '07:00', 'Fine',     'Sophie Davis',     now() - interval '11 days', '{}', '[]', 'sprint_s3_seed_2026_05_20', now(), now())
    ON CONFLICT DO NOTHING;
    RAISE NOTICE 'Prestart checks seeded.';
  ELSE
    RAISE NOTICE 'Prestart checks already seeded (% rows), skipping.', v_existing_prestarts;
  END IF;

  -- ────────────────────────────────────────────────────────────────
  -- TOOLBOX TALKS (add 14 more across sites + topics)
  -- ────────────────────────────────────────────────────────────────
  IF v_existing_talks < 15 THEN
    INSERT INTO app_data.toolbox_talks (
      talk_id, tenant_id, site_id, topic, category, delivered_by,
      delivered_at, duration_minutes, attendees,
      imported_from, created_at, updated_at
    ) VALUES
      (gen_random_uuid(), v_tenant, site1, 'Electrical Safety — Live Work Controls',   'Electrical',    'James Miller',     now() - interval '1 day',   20, '["James Miller","Sophie Davis","Liam Rodriguez"]',   'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site2, 'Working at Heights — Harness Inspection',  'WAH',           'Sophie Davis',     now() - interval '2 days',  15, '["Sophie Davis","Emily Martinez","Noah Hernandez"]',  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site3, 'Manual Handling Techniques',               'Health & Safety','Liam Rodriguez',  now() - interval '3 days',  20, '["Liam Rodriguez","Olivia Lopez","Ethan Gonzalez"]',  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site4, 'Confined Space Entry Procedures',          'Confined Space','Emily Martinez',   now() - interval '4 days',  30, '["Emily Martinez","Charlotte Wilson","Lucas Anderson"]','sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site5, 'Fire Safety and Evacuation',               'Emergency',     'Noah Hernandez',   now() - interval '5 days',  20, '["Noah Hernandez","Ava Thomas","James Miller"]',      'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site6, 'PPE Selection and Correct Use',            'PPE',           'Olivia Lopez',     now() - interval '6 days',  15, '["Olivia Lopez","Sophie Davis","Liam Rodriguez"]',    'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site1, 'Cable Pulling Safety',                     'Electrical',    'Ethan Gonzalez',   now() - interval '8 days',  20, '["Ethan Gonzalez","Emily Martinez","Noah Hernandez"]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site2, 'Hazardous Chemicals — SDS Awareness',      'Chemicals',     'Charlotte Wilson', now() - interval '9 days',  25, '["Charlotte Wilson","Lucas Anderson","Ava Thomas"]',  'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site3, 'Slips, Trips and Falls Prevention',        'Health & Safety','Lucas Anderson',  now() - interval '10 days', 15, '["Lucas Anderson","James Miller","Sophie Davis"]',    'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site4, 'Lock Out Tag Out (LOTO) Procedure',        'Electrical',    'Ava Thomas',       now() - interval '11 days', 30, '["Ava Thomas","Liam Rodriguez","Emily Martinez"]',    'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site5, 'Heat Stress and Hydration',                'Health & Safety','James Miller',    now() - interval '12 days', 15, '["James Miller","Noah Hernandez","Olivia Lopez"]',    'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site6, 'Site Induction — Visitor Safety',          'Induction',     'Sophie Davis',     now() - interval '13 days', 20, '["Sophie Davis","Ethan Gonzalez","Charlotte Wilson"]', 'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site1, 'Tool and Equipment Pre-Use Checks',        'Equipment',     'Liam Rodriguez',   now() - interval '14 days', 15, '["Liam Rodriguez","Lucas Anderson","Ava Thomas"]',    'sprint_s3_seed_2026_05_20', now(), now()),
      (gen_random_uuid(), v_tenant, site2, 'Incident Reporting — What to Report',      'Emergency',     'Emily Martinez',   now() - interval '15 days', 20, '["Emily Martinez","James Miller","Sophie Davis"]',    'sprint_s3_seed_2026_05_20', now(), now())
    ON CONFLICT DO NOTHING;
    RAISE NOTICE 'Toolbox talks seeded.';
  ELSE
    RAISE NOTICE 'Toolbox talks already seeded (% rows), skipping.', v_existing_talks;
  END IF;

END $$;
