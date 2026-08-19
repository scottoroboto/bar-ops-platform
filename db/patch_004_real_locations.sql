-- Rename the 3 placeholder locations to the real Ticket Sports Bar location
-- names, and remove test pending-review records created while verifying
-- the new-hire intake flows (Jotform webhook + /apply.html).
--
-- Run this in Supabase's SQL Editor with "Run without RLS" (same as
-- production_setup.sql) since it's an admin/setup script, not something a
-- logged-in app user is running.

UPDATE locations SET name = 'Ticket 1' WHERE name = 'Bar One';
UPDATE locations SET name = 'Ticket 2' WHERE name = 'Bar Two';
UPDATE locations SET name = 'Ticket 3' WHERE name = 'Bar Three';

-- Clean up the test webhook submission used to verify the new-hire intake
-- (safe to run even if it's already gone).
DELETE FROM people WHERE jotform_submission_id = 'TESTSUBMISSION123';

-- Clean up the test /apply.html submission used to verify the new self-service
-- onboarding flow end-to-end (safe to run even if it's already gone).
DELETE FROM people WHERE email = 'applytest@example.com' AND status = 'pending';
