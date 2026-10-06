-- patch_055 — Kitchen board (T2 Kitchen Display spec, Oct 2026; v1: T2
-- kitchen). Near-live kitchen numbers against goal on a TV in the kitchen:
-- food sales, scheduled vs actual hours, who's on the clock, labor %.
--
-- Data: the location's Venue Control box pulls SpotOn's reports site every
-- 5 minutes (agent/lib/kitchen.js) and posts to /api/venue/agent/kitchen/pull.
-- SpotOn already works out each shift's labor $ (regular + overtime), so no
-- pay rates are stored here. Scheduled shifts come from Bar Ops scheduling
-- (the location's "... Kitchen" schedule). Every table is per location so
-- the T2 bar board and T1 drop in later.
--
-- RLS FORCE with zero policies, same posture as cash_handling / scheduling:
-- every read and write goes through server/kitchenboard.js on the service
-- connection, with authorization in the Express routes.

CREATE TABLE IF NOT EXISTS kb_punches (
  id             bigserial PRIMARY KEY,
  location_id    uuid NOT NULL REFERENCES locations(id),
  business_date  date NOT NULL,
  punch_key      text NOT NULL,            -- full_name|clock_in, SpotOn's row identity
  full_name      text NOT NULL,
  role_name      text NOT NULL,
  clock_in       timestamptz NOT NULL,
  clock_out      timestamptz,
  reg_hours      numeric(8,2) NOT NULL DEFAULT 0,
  ot_hours       numeric(8,2) NOT NULL DEFAULT 0,
  labor_total    numeric(10,2) NOT NULL DEFAULT 0,  -- SpotOn's regular + overtime $ for this shift so far
  is_clocked_out boolean NOT NULL DEFAULT false,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, business_date, punch_key)
);
CREATE INDEX IF NOT EXISTS idx_kb_punches_loc_date ON kb_punches(location_id, business_date);

-- One row per pull: the day's sales so far. Food per hour = the difference
-- between snapshots. raw keeps SpotOn's own sales/labor/hourly arrays so a
-- different food line can be picked later without re-pulling.
CREATE TABLE IF NOT EXISTS kb_sales_snapshots (
  id             bigserial PRIMARY KEY,
  location_id    uuid NOT NULL REFERENCES locations(id),
  business_date  date NOT NULL,
  at             timestamptz NOT NULL DEFAULT now(),
  food_net       numeric(12,2),
  total_net      numeric(12,2),
  raw            jsonb
);
CREATE INDEX IF NOT EXISTS idx_kb_snapshots_loc_date_at ON kb_sales_snapshots(location_id, business_date, at);

CREATE TABLE IF NOT EXISTS kb_pulls (
  id             bigserial PRIMARY KEY,
  location_id    uuid NOT NULL REFERENCES locations(id),
  at             timestamptz NOT NULL DEFAULT now(),
  ok             boolean NOT NULL,
  error          text,
  ms             integer,
  punches        integer
);
CREATE INDEX IF NOT EXISTS idx_kb_pulls_loc_at ON kb_pulls(location_id, at DESC);

-- Goals and knobs, one row per location (defaults from the spec).
CREATE TABLE IF NOT EXISTS kb_settings (
  location_id          uuid PRIMARY KEY REFERENCES locations(id),
  kitchen_roles        text[] NOT NULL DEFAULT '{Cook,"Kitchen Manager"}', -- SpotOn job names that count as kitchen
  food_keys            text[] NOT NULL DEFAULT '{Food}',                   -- SpotOn sales lines that count as food
  food_goal_weekday    numeric(10,2) NOT NULL DEFAULT 1050,
  food_goal_weekend    numeric(10,2) NOT NULL DEFAULT 2760,
  labor_goal_weekday   numeric(5,2) NOT NULL DEFAULT 46,
  labor_goal_weekend   numeric(5,2) NOT NULL DEFAULT 35,
  labor_goal_week      numeric(5,2) NOT NULL DEFAULT 45,
  slow_night_line      numeric(10,2) NOT NULL DEFAULT 600,
  rotate_seconds       integer NOT NULL DEFAULT 45,
  day_start_hour       integer NOT NULL DEFAULT 4,   -- business day rolls over at 4am
  show_names           boolean NOT NULL DEFAULT true,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES people(id)
);

-- The kitchen TV opens the board with a device link (like bar iPads,
-- patch_053): a long token, shown once, hashed at rest, removable here.
CREATE TABLE IF NOT EXISTS kb_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL REFERENCES locations(id),
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid REFERENCES people(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES people(id)
);

ALTER TABLE kb_punches         ENABLE ROW LEVEL SECURITY; ALTER TABLE kb_punches         FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_sales_snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE kb_sales_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_pulls           ENABLE ROW LEVEL SECURITY; ALTER TABLE kb_pulls           FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_settings        ENABLE ROW LEVEL SECURITY; ALTER TABLE kb_settings        FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_devices         ENABLE ROW LEVEL SECURITY; ALTER TABLE kb_devices         FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON kb_punches, kb_sales_snapshots, kb_pulls, kb_settings, kb_devices TO barplatform_service;
GRANT USAGE, SELECT ON SEQUENCE kb_punches_id_seq, kb_sales_snapshots_id_seq, kb_pulls_id_seq TO barplatform_service;
