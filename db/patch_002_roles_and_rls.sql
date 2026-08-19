-- =====================================================================
-- Patch 002 — real two-role split + fixes found while first wiring up
-- the server against this schema.
--
-- What was wrong:
-- 1. people_select_manager and time_entries_select_manager looked up the
--    caller's own location with `SELECT location_id FROM people WHERE
--    id = current_person_id()` — a subquery on `people` INSIDE a policy
--    ON `people` (and, for time_entries, a policy that still touches
--    people's own policies). Evaluating that subquery re-triggers the
--    same policy, forever: "infinite recursion detected in policy for
--    relation people". Fix: the caller's location now comes from a
--    session setting (app.current_location_id), set once per request by
--    the server, never from a self-referencing subquery.
-- 2. There was only ever one DB role (`barplatform`), which also owns
--    every table. FORCE ROW LEVEL SECURITY (added earlier) makes RLS
--    apply to that owning role too — which is what we want for normal
--    request traffic, but it also blocked the server's own trusted
--    "service" operations (owner activation, Jotform intake, etc, all
--    written against withServiceClient) that are supposed to run with
--    RLS bypassed, the same way a Supabase service_role key would. One
--    role can't be both "always RLS-checked" and "always bypasses RLS".
--    Fix: two real login roles — barplatform_app (RLS enforced, used for
--    every logged-in request) and barplatform_service (BYPASSRLS, used
--    only by trusted server-side code, mirroring Supabase's own
--    anon/authenticated vs service_role split).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Location without recursion
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_location_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_location_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

DROP POLICY IF EXISTS people_select_manager ON people;
CREATE POLICY people_select_manager ON people
  FOR SELECT USING (
    current_role_name() = 'owner'
    OR (
      current_role_name() = 'manager'
      AND location_id = current_location_id()
    )
  );

DROP POLICY IF EXISTS time_entries_select_manager ON time_entries;
CREATE POLICY time_entries_select_manager ON time_entries
  FOR SELECT USING (
    current_role_name() = 'owner'
    OR (
      current_role_name() = 'manager'
      AND location_id = current_location_id()
    )
  );

-- ---------------------------------------------------------------------
-- 2. time_entries was missing INSERT/UPDATE/DELETE policies entirely —
--    with RLS enabled and no policy for a command, that command is
--    denied outright, for everyone. Time Clock punches (insert own),
--    clock-out (update own open row), and manager/owner edits/deletes
--    (punch corrections) all need explicit policies.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS time_entries_insert_self ON time_entries;
CREATE POLICY time_entries_insert_self ON time_entries
  FOR INSERT WITH CHECK (person_id = current_person_id());

DROP POLICY IF EXISTS time_entries_update_self ON time_entries;
CREATE POLICY time_entries_update_self ON time_entries
  FOR UPDATE USING (person_id = current_person_id())
             WITH CHECK (person_id = current_person_id());

DROP POLICY IF EXISTS time_entries_write_manager ON time_entries;
CREATE POLICY time_entries_write_manager ON time_entries
  FOR UPDATE USING (
    current_role_name() = 'owner'
    OR (current_role_name() = 'manager' AND location_id = current_location_id())
  ) WITH CHECK (
    current_role_name() = 'owner'
    OR (current_role_name() = 'manager' AND location_id = current_location_id())
  );

DROP POLICY IF EXISTS time_entries_delete_manager ON time_entries;
CREATE POLICY time_entries_delete_manager ON time_entries
  FOR DELETE USING (
    current_role_name() = 'owner'
    OR (current_role_name() = 'manager' AND location_id = current_location_id())
  );

-- ---------------------------------------------------------------------
-- 3. Two real roles.
-- ---------------------------------------------------------------------
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
