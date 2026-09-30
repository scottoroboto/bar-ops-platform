-- patch_049 — Lights: Kasa smart plugs on the neon signs, and light
-- routines (Scotto, 2026-09-30). The Pi at each bar finds the plugs,
-- polls them, and runs the routines itself, so signs switch on schedule
-- with the internet down. Everything here is per site, like the TVs.
--
--   vc_plugs            one per Kasa plug, keyed by MAC (IPs move with
--                       DHCP; the Pi reports new ones). A plug the Pi finds
--                       that nobody has named yet has name NULL: that's the
--                       "Unnamed plugs" list in TV Admin, where Blink finds
--                       which sign it is. A plug can be pre-registered by
--                       MAC (name first, found later).
--   vc_light_routines   named on/off times for a set of plugs: fixed time,
--                       or sunrise/sunset/dawn/dusk plus or minus minutes,
--                       on chosen days. A plug follows one routine, has its
--                       own on/off times (same options), or no schedule.
--
-- Days are 0 = Sunday .. 6 = Saturday, and name the day the lights come
-- ON; an OFF time earlier than the ON time is the next morning (2:15 AM
-- closing).
--
-- Also: each site's latitude/longitude for the sun times. T1 (32504) and
-- T2 (32534) are both Pensacola.

ALTER TABLE vc_sites ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION;
ALTER TABLE vc_sites ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
UPDATE vc_sites s SET latitude = 30.4827, longitude = -87.1936
  FROM locations l WHERE l.id = s.location_id AND l.name = 'Ticket 1' AND s.latitude IS NULL;
UPDATE vc_sites s SET latitude = 30.5313, longitude = -87.2780
  FROM locations l WHERE l.id = s.location_id AND l.name = 'Ticket 2' AND s.latitude IS NULL;

CREATE TABLE IF NOT EXISTS vc_light_routines (
  id              BIGSERIAL PRIMARY KEY,
  site_id         BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  days            SMALLINT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  on_kind         TEXT NOT NULL DEFAULT 'time' CHECK (on_kind IN ('time','sunrise','sunset','dawn','dusk','none')),
  on_time         TIME,
  on_offset_min   INT NOT NULL DEFAULT 0,
  off_kind        TEXT NOT NULL DEFAULT 'time' CHECK (off_kind IN ('time','sunrise','sunset','dawn','dusk','none')),
  off_time        TIME,
  off_offset_min  INT NOT NULL DEFAULT 0,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (on_kind <> 'time' OR on_time IS NOT NULL),
  CHECK (off_kind <> 'time' OR off_time IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS vc_light_routines_site ON vc_light_routines (site_id);

CREATE TABLE IF NOT EXISTS vc_plugs (
  id                  BIGSERIAL PRIMARY KEY,
  site_id             BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  mac                 TEXT NOT NULL,                 -- lowercase aa:bb:cc:dd:ee:ff
  name                TEXT,                          -- NULL until someone names it
  group_name          TEXT,
  ip                  TEXT,
  model               TEXT,
  protocol            TEXT,                          -- 'klap' | 'xor', what last worked
  http_port           INT,
  schedule_mode       TEXT NOT NULL DEFAULT 'none' CHECK (schedule_mode IN ('routine','own','none')),
  routine_id          BIGINT REFERENCES vc_light_routines(id) ON DELETE SET NULL,
  own_days            SMALLINT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  own_on_kind         TEXT NOT NULL DEFAULT 'time' CHECK (own_on_kind IN ('time','sunrise','sunset','dawn','dusk','none')),
  own_on_time         TIME,
  own_on_offset_min   INT NOT NULL DEFAULT 0,
  own_off_kind        TEXT NOT NULL DEFAULT 'time' CHECK (own_off_kind IN ('time','sunrise','sunset','dawn','dusk','none')),
  own_off_time        TIME,
  own_off_offset_min  INT NOT NULL DEFAULT 0,
  sort_order          INT NOT NULL DEFAULT 0,
  last_on             BOOLEAN,
  last_watts          NUMERIC(8,1),
  last_seen_at        TIMESTAMPTZ,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, mac)
);
CREATE INDEX IF NOT EXISTS vc_plugs_site ON vc_plugs (site_id);

ALTER TABLE vc_light_routines ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_light_routines FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_plugs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_plugs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON vc_light_routines, vc_plugs TO barplatform_app, barplatform_service;
GRANT USAGE, SELECT ON SEQUENCE vc_light_routines_id_seq, vc_plugs_id_seq TO barplatform_app, barplatform_service;

-- Two new box jobs from TV Admin → Lights: find plugs now, and blink one.
ALTER TABLE vc_agent_commands DROP CONSTRAINT IF EXISTS vc_agent_commands_type_chk;
ALTER TABLE vc_agent_commands ADD CONSTRAINT vc_agent_commands_type_chk
  CHECK (type IN ('discovery_scan', 'speedtest', 'tv_identify', 'kasa_scan', 'kasa_blink'));
