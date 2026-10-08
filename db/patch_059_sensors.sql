-- =====================================================================
-- patch_059: cooler temperature sensors (Oct 2026)
--
-- Scott's sensor hardware (docs: BarOps_Systems_Monitoring_Spec v0.4):
-- a battery node per keg cooler reads one or two DS18B20 probes every
-- five minutes and radios them to a gateway plugged into the bar's
-- venue-control Pi. The Pi posts batches to POST /api/venue/agent/sensors
-- with the agent token it already has (the token says which bar).
--
-- Where things live:
--   sensor_gateways / sensor_nodes / sensor_probes  the registry, auto-
--     created on first sight ("NEW 000098" until someone names it)
--   sensor_readings      every probe reading, 90 days (pruned daily)
--   sensor_hourly        min / avg / max per probe per hour, kept
--   sensor_co2_readings  the CO2 units (planned), same ingest call
--   sensor_events        battery swaps, install checks, reboots
--   sensor_settings      per-bar defaults
--
-- Alerts are NOT a new system: every probe, node and gateway also gets a
-- monitored_systems row (category 'refrigeration', kinds sensor_probe /
-- sensor_node / sensor_gateway), so system_status, system_alerts,
-- silencing, routes, SMS/email and the 6am summary all work unchanged.
-- server/sensors.js decides when a probe is "warning" (sustained out of
-- range) and hands it to monitoring.recordStatus like everything else.
--
-- Also here: acknowledging an alert (any category) and a 30-minute
-- reminder for refrigeration alerts nobody has acknowledged.
-- =====================================================================

CREATE TABLE IF NOT EXISTS sensor_settings (
  location_id             uuid PRIMARY KEY REFERENCES locations(id),
  default_high_c          numeric(6,2) NOT NULL DEFAULT 4.44,    -- 40 F
  default_low_c           numeric(6,2) NOT NULL DEFAULT -1.11,   -- 30 F
  default_alert_after_min integer NOT NULL DEFAULT 15,
  node_silent_min_min     integer NOT NULL DEFAULT 15,           -- floor for "3 x interval"
  battery_low_mv          integer NOT NULL DEFAULT 3400,
  renotify_min            integer NOT NULL DEFAULT 30,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensor_gateways (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   uuid NOT NULL REFERENCES locations(id),
  gateway_mac   text NOT NULL UNIQUE,
  label         text,
  last_seen_at  timestamptz,
  last_uptime_s integer,
  fw_version    text,
  system_id     uuid REFERENCES monitored_systems(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensor_nodes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id             uuid NOT NULL REFERENCES locations(id),
  node_mac                text NOT NULL UNIQUE,
  kind                    text NOT NULL DEFAULT 'temp' CHECK (kind IN ('temp','co2','hvac')),
  label                   text NOT NULL,                        -- 'Box 45F0' until renamed
  last_seen_at            timestamptz,
  last_rssi               integer,
  last_batt_mv            integer,
  prev_batt_mv            integer,                              -- the report before, for the 2-in-a-row rules
  last_seq                integer,
  last_interval_s         integer,                              -- what the node says it is doing
  last_mode               text,                                 -- normal | troubleshoot | install
  fw_version              text,
  fw_last_result          text,
  report_interval_s       integer NOT NULL DEFAULT 300 CHECK (report_interval_s IN (60,120,300,600,900)),
  troubleshoot_until      timestamptz,
  troubleshoot_interval_s integer NOT NULL DEFAULT 30,
  troubleshoot_duration_s integer NOT NULL DEFAULT 900,
  install_until           timestamptz,
  is_test_node            boolean NOT NULL DEFAULT false,
  no_probe_run            integer NOT NULL DEFAULT 0,           -- consecutive reports with no probe found
  co2_state               text,                                 -- CO2 units: normal | warning | alarm | fault
  battery_low             boolean NOT NULL DEFAULT false,
  signal_weak             boolean NOT NULL DEFAULT false,
  silent                  boolean NOT NULL DEFAULT false,
  system_id               uuid REFERENCES monitored_systems(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensor_probes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_id        text NOT NULL UNIQUE,                         -- the DS18B20's own 16-hex id
  location_id     uuid NOT NULL REFERENCES locations(id),
  node_id         uuid REFERENCES sensor_nodes(id) ON DELETE SET NULL,  -- last box it reported through
  display_name    text NOT NULL,                                -- 'Draft 3', 'Walk-in'; 'NEW 000098' until named
  area            text CHECK (area IN ('bar','kitchen','other')),       -- NULL = not assigned yet
  position        text,                                         -- 'left' / 'right' on a two-probe cooler
  assigned        boolean NOT NULL DEFAULT false,
  high_c          numeric(6,2) NOT NULL DEFAULT 4.44,
  low_c           numeric(6,2) NOT NULL DEFAULT -1.11,
  alert_after_min integer NOT NULL DEFAULT 15,
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  last_seen_at    timestamptz,
  last_c          numeric(6,2),
  -- the state machine (server/sensors.js): what the probe is doing now
  state           text NOT NULL DEFAULT 'unknown' CHECK (state IN ('normal','high','low','error','silent','unknown')),
  state_since     timestamptz,
  cond            text,                                         -- the raw condition of the newest reading: normal/high/low/error
  cond_since      timestamptz,                                  -- when that condition started (sustain timer)
  clear_since     timestamptz,                                  -- when it first read back inside the band (5-min clear timer)
  error_run       integer NOT NULL DEFAULT 0,                   -- consecutive failed reads
  system_id       uuid REFERENCES monitored_systems(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensor_probes_location ON sensor_probes(location_id, area, sort_order);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id           bigserial PRIMARY KEY,
  reading_uuid uuid NOT NULL,                                    -- the Pi's, one per node report
  probe_id     text NOT NULL,
  node_id      uuid REFERENCES sensor_nodes(id) ON DELETE SET NULL,
  location_id  uuid NOT NULL REFERENCES locations(id),
  read_at      timestamptz NOT NULL,
  temp_c       numeric(6,2),                                     -- NULL = the probe failed to read
  rssi         integer,
  batt_mv      integer,
  seq          integer,
  UNIQUE (reading_uuid, probe_id)                                -- resends are harmless
);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_probe_time ON sensor_readings(probe_id, read_at DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_location_time ON sensor_readings(location_id, read_at DESC);

CREATE TABLE IF NOT EXISTS sensor_hourly (
  probe_id text NOT NULL,
  hour     timestamptz NOT NULL,
  min_c    numeric(6,2) NOT NULL,
  max_c    numeric(6,2) NOT NULL,
  sum_c    numeric(10,2) NOT NULL,
  n        integer NOT NULL,
  PRIMARY KEY (probe_id, hour)
);

CREATE TABLE IF NOT EXISTS sensor_co2_readings (
  id           bigserial PRIMARY KEY,
  reading_uuid uuid NOT NULL UNIQUE,
  node_id      uuid REFERENCES sensor_nodes(id) ON DELETE SET NULL,
  location_id  uuid NOT NULL REFERENCES locations(id),
  read_at      timestamptz NOT NULL,
  ppm          integer,
  temp_c       numeric(6,2),
  rh           numeric(5,1),
  state        text,                                             -- normal | warning | alarm | fault (decided on the device)
  muted        boolean
);
CREATE INDEX IF NOT EXISTS idx_sensor_co2_node_time ON sensor_co2_readings(node_id, read_at DESC);

CREATE TABLE IF NOT EXISTS sensor_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id),
  node_id     uuid REFERENCES sensor_nodes(id) ON DELETE CASCADE,
  probe_id    text,
  kind        text NOT NULL,                                     -- battery_swap | reboot | install_check | probe_moved | fw_update
  at          timestamptz NOT NULL DEFAULT now(),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_sensor_events_node ON sensor_events(node_id, at DESC);

-- Acknowledge (any category) and the refrigeration reminder cadence.
ALTER TABLE system_alerts ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE system_alerts ADD COLUMN IF NOT EXISTS acknowledged_by uuid REFERENCES people(id);

-- Written only by the server (service client); nobody reads these tables
-- as themselves, the API shapes what each role sees.
ALTER TABLE sensor_settings     ENABLE ROW LEVEL SECURITY; ALTER TABLE sensor_settings     FORCE ROW LEVEL SECURITY;
ALTER TABLE sensor_gateways     ENABLE ROW LEVEL SECURITY; ALTER TABLE sensor_gateways     FORCE ROW LEVEL SECURITY;
ALTER TABLE sensor_nodes        ENABLE ROW LEVEL SECURITY; ALTER TABLE sensor_nodes        FORCE ROW LEVEL SECURITY;
ALTER TABLE sensor_probes       ENABLE ROW LEVEL SECURITY; ALTER TABLE sensor_probes       FORCE ROW LEVEL SECURITY;
ALTER TABLE sensor_readings     ENABLE ROW LEVEL SECURITY; ALTER TABLE sensor_readings     FORCE ROW LEVEL SECURITY;
ALTER TABLE sensor_hourly       ENABLE ROW LEVEL SECURITY; ALTER TABLE sensor_hourly       FORCE ROW LEVEL SECURITY;
ALTER TABLE sensor_co2_readings ENABLE ROW LEVEL SECURITY; ALTER TABLE sensor_co2_readings FORCE ROW LEVEL SECURITY;
ALTER TABLE sensor_events       ENABLE ROW LEVEL SECURITY; ALTER TABLE sensor_events       FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON sensor_settings, sensor_gateways, sensor_nodes, sensor_probes, sensor_readings,
  sensor_hourly, sensor_co2_readings, sensor_events TO barplatform_service;
GRANT USAGE, SELECT ON SEQUENCE sensor_readings_id_seq, sensor_co2_readings_id_seq TO barplatform_service;
