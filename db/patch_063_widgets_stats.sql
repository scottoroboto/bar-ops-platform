-- patch_063: every number on the home is its own widget (Oct 2026):
-- sales, labor and staff for the bar and for the kitchen, each switchable
-- per manager. The older bar / kitchen columns stay but are no longer read.
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS bar_sales boolean NOT NULL DEFAULT true;
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS bar_labor boolean NOT NULL DEFAULT true;
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS bar_staff boolean NOT NULL DEFAULT true;
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS kitchen_sales boolean NOT NULL DEFAULT true;
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS kitchen_labor boolean NOT NULL DEFAULT true;
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS kitchen_staff boolean NOT NULL DEFAULT true;
