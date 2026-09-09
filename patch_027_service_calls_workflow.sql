-- Service Calls: three-stage workflow (New / Working / Closed).
--
-- Adds a 'pending' status between 'open' (New) and 'closed' (Working, in
-- the UI — kept as the DB value 'pending' rather than renamed, matching
-- the existing 'open' value staying put so the dashboard badge query
-- (`/api/servicecalls?status=open`, public/dashboard.js) and RLS policies
-- keep working unchanged; only the CHECK constraint and three new columns
-- are added here). Moving New -> Working requires an explanation, tracked
-- the same way closing already tracks closed_by/closed_at/remedy.
--
-- No RLS/policy changes: service_calls_update already allows anyone who
-- can see a call (their own location, or owner/maintenance everywhere) to
-- update it, with "already closed"/"remedy required"/etc. validated in the
-- app layer (server/servicecalls.js) — the same posture the new pending_*
-- columns and the /pending route follow.

ALTER TABLE service_calls DROP CONSTRAINT IF EXISTS service_calls_status_check;
ALTER TABLE service_calls ADD CONSTRAINT service_calls_status_check
  CHECK (status IN ('open', 'pending', 'closed'));

ALTER TABLE service_calls ADD COLUMN IF NOT EXISTS pending_note text;
ALTER TABLE service_calls ADD COLUMN IF NOT EXISTS pending_by   uuid REFERENCES people(id);
ALTER TABLE service_calls ADD COLUMN IF NOT EXISTS pending_at   timestamptz;
