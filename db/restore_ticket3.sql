-- NOT a patch. Undoes patch_048 exactly, if Ticket 3 ever comes back:
-- turns back on only the rows that were on when it was archived
-- (snapshot taken 2026-09-30, before patch_048 ran).

UPDATE locations SET active = true WHERE id = '2d43060e-79c7-46b9-b9c8-8a0b92e07ff9';
UPDATE vc_sites SET enabled = true WHERE id = 1;
UPDATE monitored_systems SET active = true WHERE id IN (
  '5a7f9975-7cf2-4d6e-a9b6-abcdcb25fdb1','1c7b0654-bcb7-4cec-9958-c96f8740df94','59ef1491-d5c4-475b-a4f7-6e6ec6031ae4',
  '15ba3ee4-dd73-4668-a20c-b5b429ce2090','20f6f639-2a70-4b65-a2ee-cb8ae5c9a6bb','15fa090d-2905-400f-94b3-13449416db5e',
  '7d01fa9e-1f83-401b-b32b-deb93814b460','0617979b-3822-4bf8-9cc5-4fc5ba1c8efe');
UPDATE network_status_access SET enabled = true
  WHERE location_id = '2d43060e-79c7-46b9-b9c8-8a0b92e07ff9'
    AND person_id IN ('fec46269-4bd9-445e-87b1-ecc916824e0a','44ca4be3-35c0-408a-808e-3d55233c82de');
UPDATE schedules SET active = true WHERE id = 'ae970b05-0ad0-4068-ba16-0074f2963b64';
UPDATE cash_sources SET active = true WHERE id IN (
  'e3073add-53a2-4c5b-a334-9de5f355363d','21ed76aa-979a-4695-b7d7-6f62049513e1','ec26ad5f-8030-4100-9295-bbc33caf4670',
  'b95e1d20-0133-42c4-afdd-6924252195a2','3f4942c6-35ad-449e-9d57-0026b69a0a0e','23e263f6-149c-484a-adf0-c61160f60c0a',
  '6f1b2c77-603c-49df-8257-901ec356b03b','bfdab0a3-8a2b-4b26-bcd5-3d13703c0b17','d77fa17e-b1bc-4ba9-ac68-c40f346eb486');
UPDATE inventory_areas SET active = true WHERE id IN (
  '750ea4ab-7eee-476c-bc62-2881d6157cb0','5f133861-e102-4667-baec-0e78ef6293f1',
  '9e269c92-356f-4400-8e7e-1e29ab1f95de','7bccb053-448e-492a-97fa-0034195b441c');
INSERT INTO employee_locations (person_id, location_id, added_by, added_at) VALUES
  ('248d6bef-c444-4a09-bc17-80d1be0b866a', '2d43060e-79c7-46b9-b9c8-8a0b92e07ff9', 'e3b149c7-88af-4589-8541-142d1bc1241d', '2026-09-21T23:15:05.474791+00:00'),
  ('44ca4be3-35c0-408a-808e-3d55233c82de', '2d43060e-79c7-46b9-b9c8-8a0b92e07ff9', 'e3b149c7-88af-4589-8541-142d1bc1241d', '2026-09-22T15:52:50.445977+00:00')
ON CONFLICT DO NOTHING;
