-- Seed data for local development/testing.
-- Replace the 3 placeholder location names with your real bar names whenever you're ready.

INSERT INTO locations (name) VALUES
  ('Bar One'),
  ('Bar Two'),
  ('Bar Three');

-- One owner account so there's a way into the system at all. In real use you'd set
-- a real password via the app's setup flow; for local dev, the bootstrap script
-- (server/bootstrap-owner.js) sets a known password and prints it to the console.
INSERT INTO people (name, role, status, username)
VALUES ('Owner', 'owner', 'active', 'owner');

-- Starter equipment types for the Service Calls app — edit/add freely from
-- the app later; "Other" always exists as an implicit fallback (the form
-- lets staff type a free-text equipment_other instead of picking one).
INSERT INTO equipment_types (name) VALUES
  ('HVAC'),
  ('Toilet / Plumbing'),
  ('Pool Table'),
  ('Internet / WiFi'),
  ('POS / Register'),
  ('Ice Machine'),
  ('Draft System'),
  ('Lighting'),
  ('Refrigeration'),
  ('Sound System');
