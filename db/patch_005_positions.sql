-- Adds a managed "positions" list, used by:
--   - /apply.html's "Position Applied for" dropdown (management positions
--     excluded — nobody self-applies to be a manager)
--   - the Employees "Review employee" position dropdown (all positions)
--   - the new Positions admin card in Employees (add/archive, manager+owner)
--
-- Soft-delete only (an "active" flag, no hard delete) — position is stored
-- as plain text on people.position (not a foreign key), so archiving a
-- position here never orphans historical employee records; it just hides
-- the position from future dropdowns.
--
-- Run this in Supabase's SQL Editor with "Run without RLS" (same as
-- production_setup.sql and the other patches).

CREATE TABLE IF NOT EXISTS positions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL UNIQUE,
  is_management  boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Starter set — edit/add/archive from Employees → Positions once this is
-- deployed. Safe to run more than once (ON CONFLICT DO NOTHING).
INSERT INTO positions (name, is_management) VALUES
  ('Bartender', false),
  ('Server', false),
  ('Barback', false),
  ('Cook', false),
  ('Door / Security', false),
  ('Maintenance', false),
  ('Assistant Manager', true),
  ('Manager', true)
ON CONFLICT (name) DO NOTHING;

-- Same grants pattern as every other table (see schema.sql) — the app's
-- two Postgres roles both need ordinary CRUD; authorization itself is
-- enforced in the Express route handlers (owner-only for locations,
-- manager+owner for positions), not by RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON positions TO barplatform_app, barplatform_service;
