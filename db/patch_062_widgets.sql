-- patch_062: the home screen's widgets per manager (Oct 2026)
-- home_lines (patch_060) grows from the four lines of the bar block to
-- every widget on the home: the alerts button and the Needs you items too.
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS alerts boolean NOT NULL DEFAULT true;
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS applicants boolean NOT NULL DEFAULT true;
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS games boolean NOT NULL DEFAULT true;
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS service_calls boolean NOT NULL DEFAULT true;
