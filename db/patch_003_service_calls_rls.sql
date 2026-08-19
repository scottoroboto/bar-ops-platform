-- =====================================================================
-- Patch 003 — RLS for service_calls (equipment_types stays open, same
-- posture as locations: non-sensitive reference data).
--
-- Visibility mirrors the time_entries pattern already in place:
--   owner       — everywhere
--   maintenance — everywhere (they get dispatched across all 3 bars)
--   manager     — their own location only
--   staff       — their own location only (this is also what lets staff
--                 "see the list so they don't submit repeat calls")
-- =====================================================================

ALTER TABLE service_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_calls_select ON service_calls
  FOR SELECT USING (
    current_role_name() IN ('owner', 'maintenance')
    OR location_id = current_location_id()
  );

CREATE POLICY service_calls_insert ON service_calls
  FOR INSERT WITH CHECK (
    created_by = current_person_id()
    AND (location_id = current_location_id() OR current_role_name() IN ('owner', 'maintenance'))
  );

-- Anyone who can see a call can close it (staff closing their own fix,
-- maintenance/manager closing after a dispatch, owner anywhere) — the
-- "already closed" and "remedy required" checks live in the app layer.
CREATE POLICY service_calls_update ON service_calls
  FOR UPDATE USING (
    current_role_name() IN ('owner', 'maintenance')
    OR location_id = current_location_id()
  ) WITH CHECK (
    current_role_name() IN ('owner', 'maintenance')
    OR location_id = current_location_id()
  );

ALTER TABLE service_calls FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON service_calls, equipment_types TO barplatform_app, barplatform_service;
