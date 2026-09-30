-- patch_048 — Ticket 3 leaves the platform (Scotto, 2026-09-30): "I won't
-- be needing Ticket 3 in any of the apps. I am buying T1 and T2 and Todd
-- is keeping T3. He won't be using my app."
--
-- Archived, not deleted: every row stays, so history is intact and the
-- owner can restore the location (Employees → Locations → Restore) and
-- flip these flags back.
--   locations              active = false (drops out of every picker)
--   vc_sites               enabled = false (no Pi ever connected to it)
--   monitored_systems      active = false (no polling, no outage alerts)
--   network_status_access  enabled = false
--   schedules              active = false
--   cash_sources           active = false
--   inventory_areas        active = false
--   amusement_locations    already inactive, no games there
--   employee_locations     T3 removed from the two people linked to it
--                          (the owner, and Apply Test Person, who stays
--                          at T1 and T2). The only rows actually deleted.

DO $$
DECLARE t3 uuid;
BEGIN
  SELECT id INTO t3 FROM locations WHERE name = 'Ticket 3';
  IF t3 IS NULL THEN RETURN; END IF;
  UPDATE locations SET active = false WHERE id = t3;
  UPDATE vc_sites SET enabled = false WHERE location_id = t3;
  UPDATE monitored_systems SET active = false WHERE location_id = t3;
  UPDATE network_status_access SET enabled = false WHERE location_id = t3;
  UPDATE schedules SET active = false WHERE location_id = t3;
  UPDATE cash_sources SET active = false WHERE location_id = t3;
  UPDATE inventory_areas SET active = false WHERE location_id = t3;
  UPDATE amusement_locations SET active = false WHERE location_id = t3;
  DELETE FROM employee_locations WHERE location_id = t3;
END $$;
