-- patch_081: late clock-in alerts for scheduling managers (Scotto,
-- 2026-10-20). A manager switches it on for themselves, picks how late
-- (5 to 30 minutes, in 5s) and how (text, email, both). server/latealerts.js
-- checks every minute: a published shift on a schedule they manage whose
-- start + their minutes has passed with no clock-in (SpotOn punch or the
-- Bar Ops time clock) sends one alert per shift per manager.
CREATE TABLE IF NOT EXISTS late_alert_settings (
  person_id  uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT false,
  minutes    int NOT NULL DEFAULT 10 CHECK (minutes BETWEEN 5 AND 30 AND minutes % 5 = 0),
  channel    text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email', 'both')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS late_alerts_sent (
  shift_id     uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shift_id, recipient_id)
);

ALTER TABLE late_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE late_alert_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE late_alerts_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE late_alerts_sent FORCE ROW LEVEL SECURITY;
