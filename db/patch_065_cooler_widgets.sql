-- patch_065: the coolers widget is per side (Oct 2026): a kitchen manager
-- can get the kitchen's cooler button without the bar's.
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS bar_coolers boolean NOT NULL DEFAULT false;
ALTER TABLE home_lines ADD COLUMN IF NOT EXISTS kitchen_coolers boolean NOT NULL DEFAULT false;
UPDATE home_lines SET bar_coolers = coolers, kitchen_coolers = coolers;
