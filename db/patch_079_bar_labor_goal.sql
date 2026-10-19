-- patch_079: a bar labor % target next to the kitchen's (Scotto,
-- 2026-10-19: 18% bar, 30% kitchen, both adjustable on the board's
-- settings). The morning summary colors each bar's labor against these.
ALTER TABLE kb_settings ADD COLUMN IF NOT EXISTS bar_labor_goal numeric(5,2) NOT NULL DEFAULT 18;

-- Kitchen goal to the 30% Scotto gave (was 35).
UPDATE kb_settings SET labor_goal_weekday = 30, labor_goal_weekend = 30, labor_goal_week = 30
 WHERE labor_goal_weekday = 35 AND labor_goal_weekend = 35 AND labor_goal_week = 35;
