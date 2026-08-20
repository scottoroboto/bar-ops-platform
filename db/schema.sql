-- =====================================================================
-- Bar Operations Platform — core schema
--
-- This is written to run unchanged on a real Supabase project later —
-- it's plain Postgres + Row Level Security, which is exactly what
-- Supabase is. The only Supabase-specific step when you migrate is
-- pointing this same file at your Supabase project's SQL editor.
--
-- AUTH MODEL: rather than Supabase's built-in email/password auth (which
-- doesn't fit "username + PIN on a shared iPad" well), the backend does
-- its own tiered verification (see server/auth.js) and, for every
-- authenticated request, sets two session-local Postgres settings before
-- running any query:
--   SET LOCAL app.current_person_id = '<uuid>';
--   SET LOCAL app.current_role      = 'staff' | 'maintenance' | 'manager' | 'owner';
-- RLS policies below read those two settings. This works identically
-- whether Postgres is local (like today) or a hosted Supabase project,
-- since Supabase is just Postgres underneath.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

CREATE OR REPLACE FUNCTION current_person_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_person_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_role_name() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.current_role', true), '');
$$ LANGUAGE sql STABLE;

-- Caller's own location, read from a session setting rather than a
-- subquery on people — a policy on `people` that subqueries `people`
-- re-triggers itself and Postgres throws "infinite recursion detected
-- in policy for relation people". The server sets this alongside the
-- two settings above on every authenticated request (see server/db.js).
CREATE OR REPLACE FUNCTION current_location_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_location_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- =====================================================================
-- LOCATIONS
-- =====================================================================
CREATE TABLE locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- POSITIONS — job titles staff apply for / get assigned. Kept as a
-- managed list (not a free-text field) so the "Position Applied for"
-- dropdown on /apply.html and the "Position" dropdown in employee review
-- both draw from the same source. is_management positions are excluded
-- from the public apply.html dropdown (nobody self-applies to be a
-- manager) but still available during manager review.
--
-- Soft-delete only (active flag) — a position can be referenced by
-- historical people.position text values, so hard-deleting a row here
-- would orphan nothing (position is stored as plain text on people, not
-- a foreign key) but would still be surprising for reporting. "Archive"
-- just hides it from future dropdowns.
-- =====================================================================
CREATE TABLE positions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL UNIQUE,
  is_management  boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Starter set — edit/add/archive from Employees → Positions (manager or owner).
INSERT INTO positions (name, is_management) VALUES
  ('Bartender', false),
  ('Server', false),
  ('Barback', false),
  ('Cook', false),
  ('Door / Security', false),
  ('Maintenance', false),
  ('Assistant Manager', true),
  ('Manager', true);

-- =====================================================================
-- PEOPLE — the shared core every app hangs off of
-- =====================================================================
CREATE TABLE people (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('staff','maintenance','manager','owner')),
  location_id           uuid REFERENCES locations(id),

  -- Login
  username              text UNIQUE,          -- everyday lightweight login
  pin_hash              text,                 -- bcrypt hash of the short PIN
  password_hash         text,                 -- full credential, used at first login / step-up (managers+owners; staff use PIN + 2FA instead)
  password_verified_at  timestamptz,          -- set the first time this person's password + one-time code both check out
  email                 text,
  phone                 text,

  -- Owner-gated lifecycle — nobody is usable anywhere until status = 'active'
  status                text NOT NULL DEFAULT 'pending_review'
                          CHECK (status IN ('pending_review','active','inactive')),
  activated_by          uuid REFERENCES people(id),
  activated_at          timestamptz,

  -- Set by a manager during review (not by the employee themselves)
  position              text,
  pay_rate              numeric(10,2),

  -- Reference only — the sensitive submission itself stays encrypted in Jotform
  jotform_submission_id text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_people_location ON people(location_id);
CREATE INDEX idx_people_status ON people(status);

ALTER TABLE people ENABLE ROW LEVEL SECURITY;

-- Everyone can read their own row.
CREATE POLICY people_select_self ON people
  FOR SELECT USING (id = current_person_id());

-- Managers/owners can read active people at their own location; owners read everyone everywhere.
CREATE POLICY people_select_manager ON people
  FOR SELECT USING (
    current_role_name() = 'owner'
    OR (
      current_role_name() = 'manager'
      AND location_id = current_location_id()
    )
  );

-- Only an owner can move someone into 'active' (the go-live gate) or change their app access.
CREATE POLICY people_update_owner_only_status ON people
  FOR UPDATE USING (current_role_name() = 'owner')
  WITH CHECK (current_role_name() = 'owner');

-- A manager may update position/location/pay_rate on people at their own location while still pending_review
-- (enforced in application code — see server/employees.js — RLS here just scopes visibility for direct reads)

-- pay_rate is sensitive: exposed only to manager/owner via server-side field filtering (server/employees.js),
-- never returned to a 'staff' or 'maintenance' caller regardless of which row they're allowed to see.

-- =====================================================================
-- EMPLOYEE APP ACCESS — owner-only per-person, per-app toggles
-- =====================================================================
CREATE TABLE employee_apps (
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  app_key     text NOT NULL CHECK (app_key IN ('time_clock','service_calls','scheduling')),
  enabled     boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES people(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, app_key)
);

ALTER TABLE employee_apps ENABLE ROW LEVEL SECURITY;

CREATE POLICY employee_apps_select_self ON employee_apps
  FOR SELECT USING (person_id = current_person_id());

CREATE POLICY employee_apps_select_owner ON employee_apps
  FOR SELECT USING (current_role_name() = 'owner');

CREATE POLICY employee_apps_write_owner_only ON employee_apps
  FOR ALL USING (current_role_name() = 'owner')
  WITH CHECK (current_role_name() = 'owner');

-- =====================================================================
-- DEVICES — shared bar iPads. Trusted once by a manager/owner; after
-- that, individual staff identify themselves on it with name + PIN only
-- (no 2FA per-use — see server/auth.js for the reasoning).
-- =====================================================================
CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL REFERENCES locations(id),
  label        text NOT NULL,           -- e.g. "Bar iPad - Downtown"
  device_token text NOT NULL UNIQUE,    -- long random token stored on the iPad itself, not typed by staff
  trusted_by   uuid REFERENCES people(id),
  trusted_at   timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- SESSIONS — both the one-time verification codes (2FA / step-up) and
-- the resulting session tokens (full or light).
-- =====================================================================
CREATE TABLE verification_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('email','sms')),
  purpose     text NOT NULL CHECK (purpose IN ('first_login','step_up')),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  session_tier text NOT NULL CHECK (session_tier IN ('light','full')),
  token_hash   text NOT NULL UNIQUE,
  device_id    uuid REFERENCES devices(id), -- set when minted for a shared iPad rather than a personal phone
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_sessions_person ON auth_sessions(person_id);

-- =====================================================================
-- TIME CLOCK
-- =====================================================================
CREATE TABLE time_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES people(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  clock_in        timestamptz NOT NULL,
  clock_out       timestamptz,
  memo            text,
  auto_clock_out  boolean NOT NULL DEFAULT false,
  device_id       uuid REFERENCES devices(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_time_entries_person ON time_entries(person_id, clock_in);

ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY time_entries_select_self ON time_entries
  FOR SELECT USING (person_id = current_person_id());

CREATE POLICY time_entries_select_manager ON time_entries
  FOR SELECT USING (
    current_role_name() = 'owner'
    OR (
      current_role_name() = 'manager'
      AND location_id = current_location_id()
    )
  );

-- Insert/update/delete were missing entirely at first — with RLS on and
-- no policy for a command, that command is denied outright for everyone.
CREATE POLICY time_entries_insert_self ON time_entries
  FOR INSERT WITH CHECK (person_id = current_person_id());

CREATE POLICY time_entries_update_self ON time_entries
  FOR UPDATE USING (person_id = current_person_id())
             WITH CHECK (person_id = current_person_id());

CREATE POLICY time_entries_write_manager ON time_entries
  FOR UPDATE USING (
    current_role_name() = 'owner'
    OR (current_role_name() = 'manager' AND location_id = current_location_id())
  ) WITH CHECK (
    current_role_name() = 'owner'
    OR (current_role_name() = 'manager' AND location_id = current_location_id())
  );

CREATE POLICY time_entries_delete_manager ON time_entries
  FOR DELETE USING (
    current_role_name() = 'owner'
    OR (current_role_name() = 'manager' AND location_id = current_location_id())
  );

CREATE TABLE punch_edits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time_entry_id  uuid NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  edited_by      uuid NOT NULL REFERENCES people(id),
  edited_at      timestamptz NOT NULL DEFAULT now(),
  old_values     jsonb NOT NULL,
  new_values     jsonb,              -- null on a delete
  reason         text
);

CREATE TABLE reminder_settings (
  person_id          uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  notify_channel     text NOT NULL DEFAULT 'email' CHECK (notify_channel IN ('email','sms','both')),
  clock_in_enabled   boolean NOT NULL DEFAULT false,
  clock_in_days      text,      -- comma-separated day abbreviations, blank = every day
  clock_in_time      time,
  clock_out_enabled  boolean NOT NULL DEFAULT false,
  clock_out_days     text,
  clock_out_mode     text NOT NULL DEFAULT 'time' CHECK (clock_out_mode IN ('time','hours')),
  clock_out_time     time,
  clock_out_hours    numeric(4,1)
);

CREATE TABLE reminder_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  reminder_type text NOT NULL CHECK (reminder_type IN ('clock_in','clock_out')),
  sent_for_date date NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, reminder_type, sent_for_date)
);

-- =====================================================================
-- SERVICE CALLS (rebuilt from the earlier prototype onto this shared core)
-- =====================================================================
CREATE TABLE equipment_types (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name    text NOT NULL UNIQUE,
  active  boolean NOT NULL DEFAULT true
);

CREATE TABLE service_calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES locations(id),
  equipment_type_id  uuid REFERENCES equipment_types(id),
  equipment_other    text,
  description        text NOT NULL,
  created_by         uuid NOT NULL REFERENCES people(id),
  assigned_to_role   text NOT NULL CHECK (assigned_to_role IN ('maintenance','manager','both')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by          uuid REFERENCES people(id),
  closed_at          timestamptz,
  remedy             text
);

-- Visibility mirrors time_entries: owner and maintenance see every
-- location (maintenance gets dispatched across all 3 bars); manager and
-- staff see only their own location's calls — this is also what lets
-- staff "see the list so they don't submit repeat calls".
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

-- =====================================================================
-- NOTIFICATIONS LOG — shared across every app (email / sms / push)
-- =====================================================================
CREATE TABLE notifications_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  related_table  text NOT NULL,
  related_id     uuid NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('email','sms','push')),
  recipient      text NOT NULL,
  status         text NOT NULL,   -- sent / simulated / failed / not_configured
  detail         text,
  sent_at        timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- FORCE RLS ON THE APP'S OWN ROLE
--
-- Postgres does not apply RLS policies to a table's owning role by
-- default (only to other roles). Locally, our single dev Postgres user
-- owns every table it created, so without this, RLS would silently pass
-- even for a broken policy — FORCE closes that gap. On a real Supabase
-- project the app normally connects as `authenticated`/`anon`, which
-- already isn't the owner, so this line is redundant there but harmless.
-- =====================================================================
ALTER TABLE people FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_apps FORCE ROW LEVEL SECURITY;
ALTER TABLE time_entries FORCE ROW LEVEL SECURITY;

-- =====================================================================
-- TWO APP-LEVEL ROLES — mirrors Supabase's own anon/authenticated vs
-- service_role split, and is what actually makes RLS meaningful here:
--
--   barplatform_app     — every logged-in request (server/db.js
--                          withAuthedClient). Ordinary role, no bypass —
--                          RLS policies above are what scope its access.
--   barplatform_service — trusted server-side code only (server/db.js
--                          withServiceClient): Jotform intake, owner
--                          activation, session/login lookups before any
--                          person context exists. BYPASSRLS, same as a
--                          Supabase service_role key. Authorization for
--                          these operations is enforced in the Express
--                          route handlers instead (role checks before
--                          calling into server/employees.js etc).
--
-- On a real Supabase project you'd typically reuse the built-in
-- `service_role` for the second one instead of creating a new role.
-- =====================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barplatform_app') THEN
    CREATE ROLE barplatform_app LOGIN PASSWORD 'barplatform_app_dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barplatform_service') THEN
    CREATE ROLE barplatform_service LOGIN PASSWORD 'barplatform_service_dev' BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO barplatform_app, barplatform_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO barplatform_app, barplatform_service;
ALTER DEFAULT PRIVILEGES FOR ROLE barplatform IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO barplatform_app, barplatform_service;
GRANT EXECUTE ON FUNCTION current_person_id() TO barplatform_app, barplatform_service;
GRANT EXECUTE ON FUNCTION current_role_name() TO barplatform_app, barplatform_service;
GRANT EXECUTE ON FUNCTION current_location_id() TO barplatform_app, barplatform_service;
