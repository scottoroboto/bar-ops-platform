-- Morning summary (Oct 2026). One per manager, built from the data the app
-- already has: SpotOn sales snapshots and punches (kitchen board), the Bar
-- Ops schedule, cash counts, cooler sensors, service calls, applicants,
-- network and AV status. The owner switches it on per manager and picks the
-- sections; the manager picks email/text/both and the hour (5-9am).
--
-- Single statements only: Supabase's SQL runner hangs on multi-statement
-- batches, so run these one at a time.

CREATE TABLE IF NOT EXISTS morning_summary_settings (
  person_id        uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT false,            -- owner's switch, off until flipped
  channel          text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms','both')),
  send_hour        integer NOT NULL DEFAULT 6 CHECK (send_hour BETWEEN 5 AND 9),
  sections         jsonb NOT NULL DEFAULT '{}'::jsonb,        -- { sales: true, ... } owner's checkboxes; missing = default
  day_night_cutoff integer NOT NULL DEFAULT 19 CHECK (day_night_cutoff BETWEEN 12 AND 23),
  late_after_min   integer NOT NULL DEFAULT 5 CHECK (late_after_min BETWEEN 1 AND 60),
  updated_by       uuid REFERENCES people(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Every summary that went out (or was sent as a test), with the rendered
-- page, so the link in the text opens exactly what the email showed.
CREATE TABLE IF NOT EXISTS morning_summary_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  location_id   uuid REFERENCES locations(id),
  for_date      date NOT NULL,                                 -- the business day the summary is about (yesterday)
  send_date     date NOT NULL,                                 -- the morning it went out
  token         text NOT NULL UNIQUE,
  is_test       boolean NOT NULL DEFAULT false,
  html          text NOT NULL,
  text_body     text NOT NULL,
  model         jsonb,
  email_status  text,
  sms_status    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_morning_summary_sends_person_date ON morning_summary_sends(person_id, send_date DESC);

-- Bar / kitchen routing. Equipment and service calls carry a zone so the
-- right manager hears about them; applicants carry the department the
-- hiring manager puts them in (scheduling will use the same field).
ALTER TABLE monitored_systems ADD COLUMN IF NOT EXISTS zone text CHECK (zone IN ('bar','kitchen','both'));

ALTER TABLE service_calls ADD COLUMN IF NOT EXISTS zone text CHECK (zone IN ('bar','kitchen','both'));

ALTER TABLE people ADD COLUMN IF NOT EXISTS department text CHECK (department IN ('bar','kitchen','both'));

-- Today's and tomorrow's My Teams games, pushed by the bar's box so the
-- cloud can list them without its own ESPN pull.
ALTER TABLE vc_sites ADD COLUMN IF NOT EXISTS big_games jsonb;
