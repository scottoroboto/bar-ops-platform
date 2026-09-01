-- Patch 012 — Service Calls: per-call notes (open/pending/closed, all
-- logged), configurable "send to" destinations (replacing the fixed
-- maintenance/manager/both enum), and a refreshed equipment menu.

-- =====================================================================
-- CALL NOTES — append-only audit trail. Any call (open or closed) can
-- get notes; nothing here is ever edited or deleted, so there's no
-- UPDATE/DELETE policy at all, only SELECT + INSERT.
-- =====================================================================
CREATE TABLE service_call_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id    uuid NOT NULL REFERENCES service_calls(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES people(id),
  note       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_call_notes_call ON service_call_notes(call_id);

-- Visibility mirrors service_calls itself (see schema.sql): owner/
-- maintenance see every location's notes; manager/staff only see notes on
-- calls at their own location.
ALTER TABLE service_call_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_call_notes_select ON service_call_notes
  FOR SELECT USING (
    current_role_name() IN ('owner', 'maintenance')
    OR EXISTS (
      SELECT 1 FROM service_calls sc
      WHERE sc.id = service_call_notes.call_id AND sc.location_id = current_location_id()
    )
  );

CREATE POLICY service_call_notes_insert ON service_call_notes
  FOR INSERT WITH CHECK (
    author_id = current_person_id()
    AND (
      current_role_name() IN ('owner', 'maintenance')
      OR EXISTS (
        SELECT 1 FROM service_calls sc
        WHERE sc.id = service_call_notes.call_id AND sc.location_id = current_location_id()
      )
    )
  );

ALTER TABLE service_call_notes FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON service_call_notes TO barplatform_app, barplatform_service;

-- =====================================================================
-- SEND-TO DESTINATIONS — replaces the old assigned_to_role enum
-- ('maintenance'/'manager'/'both') with a manager/owner-editable list of
-- named destinations (e.g. "Maintenance", "Kitchen Manager"), each backed
-- by specific people rather than a person's platform-wide role. This is
-- deliberately NOT a new value on people.role — that field also drives
-- permissions/visibility across Time Clock and everywhere else, so
-- expanding it here would be a much bigger, riskier change than what was
-- actually asked for.
--
-- Same "open reference data, authorization enforced in the Express route
-- handlers" posture as equipment_types/positions/locations (see patch_003)
-- — no RLS on these three tables.
-- =====================================================================
CREATE TABLE service_call_destinations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service_call_destination_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id uuid NOT NULL REFERENCES service_call_destinations(id) ON DELETE CASCADE,
  person_id      uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  UNIQUE (destination_id, person_id)
);
CREATE INDEX idx_scdm_destination ON service_call_destination_members(destination_id);
CREATE INDEX idx_scdm_person ON service_call_destination_members(person_id);

-- A call can go to more than one destination at once — this is what
-- replaces "both" (pick as many destinations as apply, not just one).
CREATE TABLE service_call_recipients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id        uuid NOT NULL REFERENCES service_calls(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES service_call_destinations(id),
  UNIQUE (call_id, destination_id)
);
CREATE INDEX idx_scr_call ON service_call_recipients(call_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON service_call_destinations, service_call_destination_members, service_call_recipients
  TO barplatform_app, barplatform_service;

-- Seed the two destinations that replace the old enum values, carrying
-- forward today's real membership (every currently-active maintenance/
-- manager person) so notifications don't silently go quiet for anyone who
-- was already getting them. Going forward, membership is whatever the
-- owner/manager curates from the new Manage tab — it does not auto-track
-- role changes.
INSERT INTO service_call_destinations (name) VALUES ('Maintenance'), ('Manager');

INSERT INTO service_call_destination_members (destination_id, person_id)
SELECT d.id, p.id FROM service_call_destinations d
JOIN people p ON p.role = 'maintenance' AND p.status = 'active'
WHERE d.name = 'Maintenance';

INSERT INTO service_call_destination_members (destination_id, person_id)
SELECT d.id, p.id FROM service_call_destinations d
JOIN people p ON p.role = 'manager' AND p.status = 'active'
WHERE d.name = 'Manager';

-- Backfill existing calls' recipients from their old assigned_to_role, so
-- history displays correctly under the new model too.
INSERT INTO service_call_recipients (call_id, destination_id)
SELECT sc.id, d.id FROM service_calls sc
JOIN service_call_destinations d ON d.name = 'Maintenance'
WHERE sc.assigned_to_role IN ('maintenance', 'both');

INSERT INTO service_call_recipients (call_id, destination_id)
SELECT sc.id, d.id FROM service_calls sc
JOIN service_call_destinations d ON d.name = 'Manager'
WHERE sc.assigned_to_role IN ('manager', 'both');

-- The column stays (existing rows keep their historical value, cheap to
-- keep, and it's not worth an irreversible DROP COLUMN for this) but new
-- calls no longer set it — service_call_recipients is the live source of
-- truth for "who is this going to" from here on.
ALTER TABLE service_calls ALTER COLUMN assigned_to_role DROP NOT NULL;

-- =====================================================================
-- EQUIPMENT MENU REFRESH — full list requested 2026-09-01. Old types not
-- carried forward are archived (active = false), not deleted — matches
-- how Locations/Positions already handle removal, and means the 3
-- existing service calls that reference an old type (Draft System, Pool
-- Table, Sound System) keep showing the right equipment name. Rows whose
-- name already exists (Ice Machine, Pool Table) are reused rather than
-- duplicated.
-- =====================================================================
UPDATE equipment_types SET active = false
WHERE name IN ('HVAC', 'Toilet / Plumbing', 'Internet / WiFi', 'POS / Register', 'Refrigeration', 'Sound System', 'Lighting', 'Draft System');

INSERT INTO equipment_types (name)
SELECT v.name FROM (VALUES
  ('AC / Heat'), ('Audio'), ('ATM'), ('Basketball'), ('Bathroom-Mens'), ('Bathroom-Womens'),
  ('Beer'), ('Building'), ('Change Machine'), ('Cig Machine'), ('Coke / Syrup'), ('Coolers'),
  ('Credit Cards'), ('Customer Incident'), ('Dart Board'), ('Directv'), ('Dish Washer'), ('Electrical'),
  ('Frosty Machine'), ('Games'), ('Golden Tee'), ('Ice Machine'), ('Internet'), ('Inventory'),
  ('IPad'), ('Pandora'), ('Plumbing'), ('Pool Table'), ('POS'), ('Putt Putt'), ('Soda Gun'),
  ('TV/Directv'), ('WiFi')
) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM equipment_types et WHERE lower(et.name) = lower(v.name));

UPDATE equipment_types SET active = true WHERE lower(name) IN (lower('Ice Machine'), lower('Pool Table'));
