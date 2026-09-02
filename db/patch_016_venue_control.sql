-- Venue Control — initial schema (Phase 0/1 prep).
--
-- Copied verbatim from docs/venue-control.md §5 (per the design spec's own
-- instruction: "It has been tested against Postgres; run it as written").
-- Nothing here is wired to any route yet — this just gets the tables in
-- place ahead of the actual agent/discovery build.
--
-- Same posture as every other feature-scoped table in this app: RLS
-- ENABLED + FORCED, zero policies, authorization enforced entirely in the
-- Express route handlers (none exist yet for these tables).
--
-- NOTE for whoever builds Phase 0/1: vc_sites is its own standalone table
-- (slug/name/timezone), not a foreign key onto the platform's existing
-- `locations` table. That's straight out of the spec, not something this
-- migration invented or fixed — flagged here since the two are clearly the
-- same real-world concept (a site *is* a location) and reconciling them
-- (or deliberately keeping them separate, e.g. because a `location` could
-- span buildings differently than a Venue Control `site`) is a design call
-- worth making before Phase 2, not silently guessed at during a schema copy.

-- ============================================================
-- SITES & AGENTS
-- ============================================================

CREATE TABLE vc_sites (
  id                BIGSERIAL PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  timezone          TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  scan_ranges       TEXT[] NOT NULL DEFAULT '{}',
  agent_token_hash  TEXT,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vc_agents (
  id            BIGSERIAL PRIMARY KEY,
  site_id       BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  hostname      TEXT,
  lan_ip        TEXT,
  agent_version TEXT,
  platform      TEXT,
  config_etag   TEXT,
  status        TEXT NOT NULL DEFAULT 'unknown',
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON vc_agents (site_id);

-- ============================================================
-- ZONES  (physical TV groupings; sources are deliberately flat)
-- ============================================================

CREATE TABLE vc_zones (
  id          BIGSERIAL PRIMARY KEY,
  site_id     BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, name)
);

-- ============================================================
-- SOURCES  (the 16 QAM slots)
-- ============================================================

CREATE TABLE vc_sources (
  id              BIGSERIAL PRIMARY KEY,
  site_id         BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  slot            INT NOT NULL,
  qam_channel     TEXT NOT NULL,
  label           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'directv',
  ip              INET,
  port            INT NOT NULL DEFAULT 8080,
  mac             MACADDR,
  receiver_id     TEXT,
  access_card_id  TEXT,
  serial_num      TEXT,
  sw_version      TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INT NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, slot),
  UNIQUE (site_id, qam_channel),
  CONSTRAINT vc_sources_kind_chk
    CHECK (kind IN ('directv','roku','static','spare')),
  CONSTRAINT vc_sources_directv_needs_ip
    CHECK (kind <> 'directv' OR ip IS NOT NULL)
);
CREATE INDEX ON vc_sources (site_id, enabled);

-- ============================================================
-- TVs
-- ============================================================

CREATE TABLE vc_tvs (
  id                  BIGSERIAL PRIMARY KEY,
  site_id             BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  zone_id             BIGINT REFERENCES vc_zones(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  tag                 TEXT,
  brand               TEXT NOT NULL DEFAULT 'samsung',
  model               TEXT,
  ip                  INET,
  mac                 MACADDR,
  control_method      TEXT NOT NULL DEFAULT 'unknown',
  ws_port             INT,
  ws_token            TEXT,
  st_device_id        TEXT,
  wol_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  power_capable       BOOLEAN NOT NULL DEFAULT FALSE,
  channel_capable     BOOLEAN NOT NULL DEFAULT FALSE,
  volume_capable      BOOLEAN NOT NULL DEFAULT FALSE,
  default_source_slot INT,
  last_known_slot     INT,
  last_known_power    TEXT,
  last_contact_at     TIMESTAMPTZ,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order          INT NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vc_tvs_control_chk CHECK (control_method IN
    ('unknown','samsung_ws_token','samsung_ws_plain','samsung_legacy',
     'smartthings','wol_only','none')),
  CONSTRAINT vc_tvs_power_chk CHECK (last_known_power IS NULL
    OR last_known_power IN ('on','standby','off','unreachable'))
);
CREATE INDEX ON vc_tvs (site_id, enabled);
CREATE INDEX ON vc_tvs (site_id, zone_id);
CREATE UNIQUE INDEX ON vc_tvs (site_id, mac) WHERE mac IS NOT NULL;

-- ============================================================
-- FAVORITES  (site_id NULL = shared across all sites)
-- ============================================================

CREATE TABLE vc_favorites (
  id          BIGSERIAL PRIMARY KEY,
  site_id     BIGINT REFERENCES vc_sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  major       INT NOT NULL,
  minor       INT,
  category    TEXT NOT NULL DEFAULT 'Sports',
  color       TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vc_fav_major_chk CHECK (major BETWEEN 1 AND 9999)
);
CREATE INDEX ON vc_favorites (site_id, category, sort_order);

-- ============================================================
-- LAYOUTS  (whole-room presets)
-- ============================================================

CREATE TABLE vc_layouts (
  id          BIGSERIAL PRIMARY KEY,
  site_id     BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, name)
);

CREATE TABLE vc_layout_items (
  id           BIGSERIAL PRIMARY KEY,
  layout_id    BIGINT NOT NULL REFERENCES vc_layouts(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL,
  target_id    BIGINT NOT NULL,
  action       JSONB NOT NULL,
  step_order   INT NOT NULL DEFAULT 0,
  CONSTRAINT vc_layout_target_chk CHECK (target_type IN ('source','tv'))
);
CREATE INDEX ON vc_layout_items (layout_id, step_order);

-- ============================================================
-- SCHEDULES
-- ============================================================

CREATE TABLE vc_schedules (
  id            BIGSERIAL PRIMARY KEY,
  site_id       BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  cron_expr     TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::JSONB,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  last_result   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vc_sched_action_chk CHECK (action_type IN
    ('tvs_power','apply_layout','source_tune'))
);
CREATE INDEX ON vc_schedules (site_id, enabled);

-- ============================================================
-- DISCOVERY
-- ============================================================

CREATE TABLE vc_discovery_runs (
  id           BIGSERIAL PRIMARY KEY,
  site_id      BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  ranges       TEXT[] NOT NULL DEFAULT '{}',
  host_count   INT,
  summary      JSONB,
  started_by   TEXT
);
CREATE INDEX ON vc_discovery_runs (site_id, started_at DESC);

CREATE TABLE vc_discovery_devices (
  id              BIGSERIAL PRIMARY KEY,
  run_id          BIGINT NOT NULL REFERENCES vc_discovery_runs(id) ON DELETE CASCADE,
  ip              INET NOT NULL,
  mac             MACADDR,
  oui_vendor      TEXT,
  hostname        TEXT,
  open_ports      INT[] NOT NULL DEFAULT '{}',
  classified_as   TEXT NOT NULL DEFAULT 'unknown',
  confidence      TEXT NOT NULL DEFAULT 'low',
  identity        JSONB NOT NULL DEFAULT '{}'::JSONB,
  control_methods JSONB NOT NULL DEFAULT '[]'::JSONB,
  test_results    JSONB NOT NULL DEFAULT '{}'::JSONB,
  adopted_type    TEXT,
  adopted_id      BIGINT
);
CREATE INDEX ON vc_discovery_devices (run_id);

-- ============================================================
-- ACTIVITY LOG
-- ============================================================

CREATE TABLE vc_activity (
  id           BIGSERIAL PRIMARY KEY,
  site_id      BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor        TEXT,
  origin       TEXT NOT NULL DEFAULT 'local',
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    BIGINT,
  detail       JSONB NOT NULL DEFAULT '{}'::JSONB,
  result       TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX ON vc_activity (site_id, ts DESC);

-- ============================================================
-- BACKUPS
-- ============================================================

CREATE TABLE vc_backups (
  id          BIGSERIAL PRIMARY KEY,
  site_id     BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'auto',
  label       TEXT,
  payload     JSONB NOT NULL,
  checksum    TEXT NOT NULL,
  item_counts JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vc_backups_kind_chk CHECK (kind IN ('auto','manual','pre_restore'))
);
CREATE INDEX ON vc_backups (site_id, created_at DESC);

-- ============================================================
-- RLS — enabled + forced, zero policies, matching every other
-- feature-scoped table in this app. Authorization lives in the Express
-- route handlers (none written yet).
-- ============================================================

ALTER TABLE vc_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_sites FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_zones FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_tvs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_tvs FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_favorites FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_layouts FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_layout_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_layout_items FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_discovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_discovery_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_discovery_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_discovery_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_activity FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_backups FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  vc_sites, vc_agents, vc_zones, vc_sources, vc_tvs, vc_favorites,
  vc_layouts, vc_layout_items, vc_schedules, vc_discovery_runs,
  vc_discovery_devices, vc_activity, vc_backups
  TO barplatform_app, barplatform_service;
