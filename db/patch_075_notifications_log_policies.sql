-- patch_075: notifications_log had row-level security switched on (and
-- forced) with no policies at all, so any INSERT from an ordinary signed-in
-- request was rejected. Every notification that is sent inside a request's
-- own transaction (service call opened / Working / closed, …) then aborted
-- that transaction and the real change rolled back with it — a closed
-- service call quietly stayed New (Scotto, 2026-10-17). Background jobs
-- use the bypass role and never noticed.
CREATE POLICY notifications_log_insert ON notifications_log
  FOR INSERT WITH CHECK (NULLIF(current_setting('app.current_person_id', true), '') IS NOT NULL);
CREATE POLICY notifications_log_select ON notifications_log
  FOR SELECT USING (current_role_name() IN ('owner','manager'));
