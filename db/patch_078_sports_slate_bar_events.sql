-- patch_078: the Scheduling page's "Games/Events" for a day (Scotto,
-- 2026-10-19).
-- sports_slate  every game on ESPN's scoreboards for the next 3 weeks:
--               NFL, college football (ESPN's top games), NBA, NHL, MLB,
--               men's college basketball (top games). Refreshed every 6
--               hours; slate_date is the ESPN date it was fetched under,
--               game_date the bar-time day it's played.
-- bar_events    local events an owner or manager adds for a bar and day
--               (concert, festival, private party).
CREATE TABLE IF NOT EXISTS sports_slate (
  league      text NOT NULL,
  espn_id     text NOT NULL,
  slate_date  date NOT NULL,
  game_date   date NOT NULL,
  kickoff     timestamptz,
  time_tbd    boolean NOT NULL DEFAULT false,
  away        text,
  home        text,
  away_rank   int,
  home_rank   int,
  network     text,
  tracked     text,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league, espn_id)
);
CREATE INDEX IF NOT EXISTS idx_sports_slate_date ON sports_slate(game_date);

CREATE TABLE IF NOT EXISTS bar_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  event_date  date NOT NULL,
  start_time  text,
  name        text NOT NULL,
  added_by    uuid REFERENCES people(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bar_events_loc_date ON bar_events(location_id, event_date);

ALTER TABLE sports_slate ENABLE ROW LEVEL SECURITY;
ALTER TABLE sports_slate FORCE ROW LEVEL SECURITY;
ALTER TABLE bar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE bar_events FORCE ROW LEVEL SECURITY;
