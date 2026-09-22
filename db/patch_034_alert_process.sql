-- =====================================================================
-- Patch 034 — the alert process, redesigned (Scotto, 2026-09-22).
--
-- After one night of every-15-minute reminders for two switched-off test
-- TVs (32 emails an hour, the email quota gone by 5am, login codes
-- failing): no more reminders, and TVs are handled at the bar first.
--
-- 1. TVs & AV are iPad-first. A TV that stops answering during the bar's
--    TV hours is flagged to the on-site box, which shows it on the TV
--    Staff page with Turn On / Clear / Service call. Nobody is emailed
--    unless the bartender presses Service call, or in the 6am summary.
--      locations.av_hours_start/end — when TVs are expected on.
--      system_alerts.expected_on   — was this opened inside those hours
--                                    (always true for other categories).
--      system_alerts.service_call_id — set when the bar escalates.
--
-- 2. Every other category: one notice after the 3-minute hold (one email
--    even if several things at a bar dropped together), one "recovered".
--    No reminders. The still-down list rides the 6am daily summary.
--
-- 3. Per-person, per-category choice — Off / Right away / Daily summary —
--    in monitoring_notify_settings.prefs (jsonb, category -> mode).
--    Missing = the default: TVs & AV daily, everything else right away.
--
-- 4. monitoring_summary_runs: one row per bar-day the 6am summary ran,
--    so a restart can't send it twice.
-- =====================================================================

ALTER TABLE locations
  ADD COLUMN av_hours_start time NOT NULL DEFAULT '10:00',
  ADD COLUMN av_hours_end   time NOT NULL DEFAULT '02:00';   -- end before start = crosses midnight

ALTER TABLE system_alerts
  ADD COLUMN expected_on     boolean NOT NULL DEFAULT true,
  ADD COLUMN service_call_id uuid REFERENCES service_calls(id);

ALTER TABLE monitoring_notify_settings
  ADD COLUMN prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE monitoring_summary_runs (
  run_date   date PRIMARY KEY,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  sent_count integer NOT NULL DEFAULT 0
);
ALTER TABLE monitoring_summary_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_summary_runs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring_summary_runs TO barplatform_app, barplatform_service;
