-- patch_072 (Oct 2026): each manager's own shift-time presets, shown as
-- chips in the Add shift modal between the time pickers and the day boxes.
CREATE TABLE IF NOT EXISTS shift_presets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id  uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  start_time time NOT NULL,
  end_time   time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, start_time, end_time)
);
