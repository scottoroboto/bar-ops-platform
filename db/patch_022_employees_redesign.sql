-- =====================================================================
-- Patch 022 — Employees app redesign (tabs, roster, employee data card)
--
-- Three additive changes, none of them touch existing data or behavior:
--
-- 1. 'employees' joins employee_apps' app_key CHECK constraint, same
--    pattern as patch_010 adding 'monitoring'. This is the "employees
--    (only managers)" toggle from the new roster row design — it's
--    tracked per-person like the other four, but (see server/employees.js)
--    is only ever offered for people with role = 'manager', and does NOT
--    yet gate access to this app itself the way the other four gate their
--    own apps (that would default every existing manager to locked-out
--    the moment this patch runs, since the toggle starts unset for
--    everyone). It's data-and-UI only for now, wired up for real the day
--    someone actually asks for that enforcement.
--
-- 2. people.address — new. The employee data card's "Contact" section
--    shows a mobile number and an address; a mobile number already has a
--    home (the existing `phone` column — this app never distinguished
--    mobile from any other phone, and one text field is enough), but
--    there was nowhere to put a street address until now.
--
-- 3. employee_certifications — new table. A person can hold more than one
--    certification (ServeSafe Server, Food Service Manager, ...), each
--    with its own acquired date, so this is a child table rather than
--    columns on people — same shape/reasoning as pay_rate_requests.
--    RLS mirrors employee_apps exactly (self can read their own,
--    owner reads everyone, manager reads their own location's people),
--    since it's shown on the same employee data card as app access.
-- =====================================================================

ALTER TABLE employee_apps DROP CONSTRAINT employee_apps_app_key_check;
ALTER TABLE employee_apps ADD CONSTRAINT employee_apps_app_key_check
  CHECK (app_key IN ('time_clock','service_calls','scheduling','monitoring','employees'));

ALTER TABLE people ADD COLUMN address text;

CREATE TABLE employee_certifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name          text NOT NULL,
  acquired_on   date,
  added_by      uuid REFERENCES people(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_employee_certifications_person ON employee_certifications(person_id);

ALTER TABLE employee_certifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY employee_certifications_select_self ON employee_certifications
  FOR SELECT USING (person_id = current_person_id());

CREATE POLICY employee_certifications_select_owner ON employee_certifications
  FOR SELECT USING (current_role_name() = 'owner');

CREATE POLICY employee_certifications_select_manager ON employee_certifications
  FOR SELECT USING (
    current_role_name() = 'manager'
    AND EXISTS (
      SELECT 1 FROM people p WHERE p.id = employee_certifications.person_id
        AND p.location_id = current_location_id()
    )
  );

CREATE POLICY employee_certifications_write_owner_only ON employee_certifications
  FOR ALL USING (current_role_name() = 'owner')
  WITH CHECK (current_role_name() = 'owner');

ALTER TABLE employee_certifications FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_certifications TO barplatform_app, barplatform_service;
