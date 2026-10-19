-- patch_080: the Sales Board (Scotto, 2026-10-19). The kitchen board
-- becomes one board per bar and side: T1 Kitchen, T1 Bar, T2 Kitchen,
-- T2 Bar. Each side has its own labor goal (kitchen labor_goal_*, bar
-- bar_labor_goal from patch_079), TV links and daily targets.
--
-- sales_targets  the owner's override of a day's target for one side
--                (a private party, a closed day). Without a row the
--                target is the forecast. The board, Scheduling and the
--                morning summary all read it.
ALTER TABLE kb_devices ADD COLUMN IF NOT EXISTS side text NOT NULL DEFAULT 'kitchen' CHECK (side IN ('kitchen', 'bar'));

CREATE TABLE IF NOT EXISTS sales_targets (
  location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  side          text NOT NULL CHECK (side IN ('kitchen', 'bar')),
  business_date date NOT NULL,
  amount        numeric(12,2) NOT NULL CHECK (amount >= 0),
  note          text,
  set_by        uuid REFERENCES people(id),
  set_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, side, business_date)
);
ALTER TABLE sales_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_targets FORCE ROW LEVEL SECURITY;
