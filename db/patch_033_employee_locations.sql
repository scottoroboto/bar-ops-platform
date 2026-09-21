-- =====================================================================
-- Patch 033 — employees at more than one location (batch 2b).
--
-- Scotto: "I need to be able to add an employee to more than one
-- location" — and the locations are EQUAL: no home bar, no primary.
-- (Positions and schedules were already many-per-person via
-- employee_positions / employee_schedules in patch_014.)
--
-- 1. employee_locations — one row per bar a person works at. Every
--    "which people can this manager see / act on" rule now means "at
--    any bar the manager works at", and a person is "at" a bar if they
--    have a row here.
--
-- 2. people.location_id STAYS, as a plain mirror of one of the person's
--    rows here (whichever was set first). It is not a home location and
--    the UI never calls it one. It is kept only because server/timeclock.js
--    stamps time_entries.location_id from it and that file is untouched
--    by request (only maintenance staff punch there, and maintenance is
--    dispatched across every bar anyway, so it never mattered which one).
--    server/employees.js keeps it in step whenever the set changes.
--
-- 3. RLS: app.current_location_id (one uuid) becomes
--    app.current_location_ids (comma-separated), read by the new
--    current_location_ids() -> uuid[], and every policy that compared
--    `location_id = current_location_id()` now uses
--    `= ANY(current_location_ids())`. current_location_id() is left in
--    place, and current_location_ids() falls back to it, so nothing
--    breaks in the window between this patch applying and the new
--    server code deploying.
-- =====================================================================

CREATE TABLE employee_locations (
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id),
  added_by    uuid REFERENCES people(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, location_id)
);
CREATE INDEX idx_employee_locations_location ON employee_locations(location_id);

-- Readable by every app-level query (policies on other tables look here
-- to answer "is this person at one of my bars"); membership itself is
-- not sensitive. Writes go through the service connection only.
ALTER TABLE employee_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_locations_select ON employee_locations FOR SELECT USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_locations TO barplatform_app, barplatform_service;

-- Everyone who has a location today works at exactly that one.
INSERT INTO employee_locations (person_id, location_id)
SELECT id, location_id FROM people WHERE location_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- The caller's bars, as a set. Falls back to the old single setting so
-- an older server build still scopes correctly against this schema.
CREATE OR REPLACE FUNCTION current_location_ids() RETURNS uuid[] AS $$
  SELECT COALESCE(
    (SELECT array_agg(x::uuid)
       FROM unnest(string_to_array(NULLIF(current_setting('app.current_location_ids', true), ''), ',')) AS x),
    CASE WHEN NULLIF(current_setting('app.current_location_id', true), '') IS NULL
         THEN ARRAY[]::uuid[]
         ELSE ARRAY[current_setting('app.current_location_id', true)::uuid] END
  );
$$ LANGUAGE sql STABLE;
GRANT EXECUTE ON FUNCTION current_location_ids() TO barplatform_app, barplatform_service;

-- ---- policies: same shapes as before, set-valued ---------------------
DROP POLICY IF EXISTS people_select_manager ON people;
CREATE POLICY people_select_manager ON people FOR SELECT USING (
  current_role_name() = 'owner'
  OR (current_role_name() = 'manager' AND (
       location_id = ANY(current_location_ids())
       OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.person_id = people.id AND el.location_id = ANY(current_location_ids()))
     ))
);

DROP POLICY IF EXISTS employee_certifications_select_manager ON employee_certifications;
CREATE POLICY employee_certifications_select_manager ON employee_certifications FOR SELECT USING (
  current_role_name() = 'manager' AND EXISTS (
    SELECT 1 FROM employee_locations el
    WHERE el.person_id = employee_certifications.person_id AND el.location_id = ANY(current_location_ids())
  )
);

DROP POLICY IF EXISTS time_entries_select_manager ON time_entries;
CREATE POLICY time_entries_select_manager ON time_entries FOR SELECT USING (
  current_role_name() = 'owner' OR (current_role_name() = 'manager' AND location_id = ANY(current_location_ids()))
);
DROP POLICY IF EXISTS time_entries_write_manager ON time_entries;
CREATE POLICY time_entries_write_manager ON time_entries FOR UPDATE
  USING (current_role_name() = 'owner' OR (current_role_name() = 'manager' AND location_id = ANY(current_location_ids())))
  WITH CHECK (current_role_name() = 'owner' OR (current_role_name() = 'manager' AND location_id = ANY(current_location_ids())));
DROP POLICY IF EXISTS time_entries_delete_manager ON time_entries;
CREATE POLICY time_entries_delete_manager ON time_entries FOR DELETE USING (
  current_role_name() = 'owner' OR (current_role_name() = 'manager' AND location_id = ANY(current_location_ids()))
);

DROP POLICY IF EXISTS service_calls_select ON service_calls;
CREATE POLICY service_calls_select ON service_calls FOR SELECT USING (
  current_role_name() IN ('owner','maintenance') OR location_id = ANY(current_location_ids())
);
DROP POLICY IF EXISTS service_calls_insert ON service_calls;
CREATE POLICY service_calls_insert ON service_calls FOR INSERT WITH CHECK (
  created_by = current_person_id() AND (location_id = ANY(current_location_ids()) OR current_role_name() IN ('owner','maintenance'))
);
DROP POLICY IF EXISTS service_calls_update ON service_calls;
CREATE POLICY service_calls_update ON service_calls FOR UPDATE
  USING (current_role_name() IN ('owner','maintenance') OR location_id = ANY(current_location_ids()))
  WITH CHECK (current_role_name() IN ('owner','maintenance') OR location_id = ANY(current_location_ids()));

DROP POLICY IF EXISTS service_call_notes_select ON service_call_notes;
CREATE POLICY service_call_notes_select ON service_call_notes FOR SELECT USING (
  current_role_name() IN ('owner','maintenance')
  OR EXISTS (SELECT 1 FROM service_calls sc WHERE sc.id = service_call_notes.call_id AND sc.location_id = ANY(current_location_ids()))
);
DROP POLICY IF EXISTS service_call_notes_insert ON service_call_notes;
CREATE POLICY service_call_notes_insert ON service_call_notes FOR INSERT WITH CHECK (
  author_id = current_person_id() AND (
    current_role_name() IN ('owner','maintenance')
    OR EXISTS (SELECT 1 FROM service_calls sc WHERE sc.id = service_call_notes.call_id AND sc.location_id = ANY(current_location_ids()))
  )
);

DROP POLICY IF EXISTS monitored_systems_select ON monitored_systems;
CREATE POLICY monitored_systems_select ON monitored_systems FOR SELECT USING (
  current_role_name() = 'owner' OR location_id = ANY(current_location_ids())
);
DROP POLICY IF EXISTS system_status_select ON system_status;
CREATE POLICY system_status_select ON system_status FOR SELECT USING (
  EXISTS (SELECT 1 FROM monitored_systems ms WHERE ms.id = system_status.system_id
          AND (current_role_name() = 'owner' OR ms.location_id = ANY(current_location_ids())))
);
DROP POLICY IF EXISTS system_alerts_select ON system_alerts;
CREATE POLICY system_alerts_select ON system_alerts FOR SELECT USING (
  EXISTS (SELECT 1 FROM monitored_systems ms WHERE ms.id = system_alerts.system_id
          AND (current_role_name() = 'owner' OR ms.location_id = ANY(current_location_ids())))
);
