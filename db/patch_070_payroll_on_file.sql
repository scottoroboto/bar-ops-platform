-- Payroll gate (Oct 2026). Current staff already have their W-4 and direct
-- deposit on file, so they are not nagged to fill the payroll form; new
-- hires see a "finish payroll setup" card on My Account and a banner on
-- their home screen until the owner flips this on for them.
ALTER TABLE people ADD COLUMN IF NOT EXISTS payroll_on_file boolean NOT NULL DEFAULT false;

-- Everyone active at the time of the patch is a current employee.
UPDATE people SET payroll_on_file = true WHERE status = 'active';
