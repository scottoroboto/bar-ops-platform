-- patch_076: sales forecast for the kitchen board (Scotto, 2026-10-17).
--
-- sales_daily      one row per bar per business day, kept for good.
--                  kb_sales_snapshots (every 5 minutes, with SpotOn's raw
--                  report) is pruned at 60 days, which also threw away
--                  every night's history backfill; this is the permanent
--                  record the forecast learns from. bar = total - food.
--                  final: the Pi's after-close read (live pulls stop at
--                  1:30am, so a live row can miss the last sales).
--                  excluded: the owner's call — true = leave this day out
--                  of the forecast (hurricane, private party), false =
--                  keep it even if it looks odd, null = let the app judge.
-- sports_games     game days for the teams that fill the bars (ESPN's
--                  public schedules), past and upcoming.
-- sales_forecasts  what the forecast said, kept so it can be graded
--                  against what happened.
CREATE TABLE IF NOT EXISTS sales_daily (
  location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  business_date   date NOT NULL,
  food_net        numeric(12,2),
  total_net       numeric(12,2),
  final           boolean NOT NULL DEFAULT false,
  source          text NOT NULL DEFAULT 'live',
  read_attempts   int NOT NULL DEFAULT 0,
  excluded        boolean,
  excluded_reason text,
  excluded_by     uuid REFERENCES people(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, business_date)
);

CREATE TABLE IF NOT EXISTS sports_games (
  espn_id      text NOT NULL,
  team_key     text NOT NULL,
  game_date    date NOT NULL,
  kickoff      timestamptz,
  time_tbd     boolean NOT NULL DEFAULT false,
  opponent     text,
  home_away    text,
  season       int,
  season_type  int,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (espn_id, team_key)  -- Alabama vs FSU is one ESPN game, two rows
);
CREATE INDEX IF NOT EXISTS idx_sports_games_date ON sports_games(game_date);

CREATE TABLE IF NOT EXISTS sales_forecasts (
  location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  made_on       date NOT NULL,
  food_fc       numeric(12,2),
  bar_fc        numeric(12,2),
  detail        jsonb,
  PRIMARY KEY (location_id, business_date, made_on)
);

-- How far back the bar's box reads SpotOn history (it asks each night).
ALTER TABLE kb_settings ADD COLUMN IF NOT EXISTS history_from date NOT NULL DEFAULT '2022-01-01';

-- Server-only tables: row security on, forced, no policies (patch_015's
-- pattern); the app reaches them through the bypass role.
ALTER TABLE sales_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE sports_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE sports_games FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_forecasts FORCE ROW LEVEL SECURITY;

-- Seed from what the board has collected so far: each day's last snapshot.
INSERT INTO sales_daily (location_id, business_date, food_net, total_net, final, source)
SELECT DISTINCT ON (location_id, business_date) location_id, business_date, food_net, total_net, false, 'seed'
  FROM kb_sales_snapshots
 WHERE total_net IS NOT NULL
 ORDER BY location_id, business_date, at DESC
ON CONFLICT (location_id, business_date) DO NOTHING;

-- Scotto: the $1,300 Friday at T2 was a half day for the hurricane.
UPDATE sales_daily SET excluded = true, excluded_reason = 'Hurricane — half day', final = true
 WHERE business_date = '2026-10-09' AND location_id = (SELECT id FROM locations WHERE name = 'Ticket 2');
