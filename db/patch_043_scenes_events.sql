-- =====================================================================
-- Patch 043 — Venue Control: Scenes and Events (Scotto, 2026-09-29).
--
-- Two ideas, one rule staff can remember: scenes are how the bar normally
-- looks, events are what's on tonight.
--
-- SCENES are whole-room presets (vc_layouts, renamed in the UI only — the
-- table keeps its name). A scene can now run by itself at a daily time
-- (Open at 10:45, Close at 1:30) or be tapped by hand, and a scene can be
-- the built-in "every TV off" without anyone having to capture a dark
-- room (kind = 'all_off').
--
-- EVENTS are a temporary override on part of the room: the manager
-- highlights the TVs that matter on the box's TVs tab, taps Capture
-- event, and the box saves those TVs' slots/power and their sources'
-- channel/app as vc_event_items. Nothing changes at capture time. An
-- event is applied when its start time comes (kind 'once' with a date,
-- 'weekly' with days) or when someone taps Apply (any kind, including
-- 'manual' with no time at all). When it ends — end time, or End tapped —
-- the after_mode says what happens to those TVs: put back how they were
-- (a snapshot the box took at start), leave them, or go to a scene.
--
-- The box is the only thing that applies or ends events; the cloud holds
-- the rows so a dead box loses nothing, and TV Admin edits times /
-- deletes. Running state (running_since + the restore snapshot) is
-- written up by the box so a box restart mid-event can still end it
-- properly from the config it pulls back down.
-- =====================================================================

ALTER TABLE vc_layouts
  ADD COLUMN daily_time text,                                   -- 'HH:MM' bar-local; NULL = manual only
  ADD COLUMN enabled    boolean NOT NULL DEFAULT true,          -- a disabled scene keeps its items but never fires
  ADD COLUMN kind       text NOT NULL DEFAULT 'captured' CHECK (kind IN ('captured','all_off'));

CREATE TABLE vc_events (
  id               BIGSERIAL PRIMARY KEY,
  site_id          BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  note             TEXT,                                        -- "Prime, Chiefs at Bills, sound on wall"
  kind             TEXT NOT NULL CHECK (kind IN ('manual','once','weekly')),
  event_date       DATE,                                        -- kind = once
  days             INT[] NOT NULL DEFAULT '{}',                 -- kind = weekly, 0 = Sunday
  start_time       TEXT,                                        -- 'HH:MM' bar-local (once / weekly)
  end_time         TEXT,                                        -- 'HH:MM' bar-local; earlier than start = next day
  after_mode       TEXT NOT NULL DEFAULT 'restore' CHECK (after_mode IN ('restore','leave','scene')),
  after_layout_id  BIGINT REFERENCES vc_layouts(id) ON DELETE SET NULL,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- written by the box
  running_since    TIMESTAMPTZ,
  running_snapshot JSONB,                                       -- items to replay for after_mode = restore
  last_run_at      TIMESTAMPTZ,
  last_ended_at    TIMESTAMPTZ,
  last_result      TEXT
);
CREATE INDEX ON vc_events (site_id, enabled);

CREATE TABLE vc_event_items (
  id           BIGSERIAL PRIMARY KEY,
  event_id     BIGINT NOT NULL REFERENCES vc_events(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('source','tv')),
  target_id    BIGINT NOT NULL,
  action       JSONB NOT NULL,
  step_order   INT NOT NULL DEFAULT 0
);
CREATE INDEX ON vc_event_items (event_id, step_order);

ALTER TABLE vc_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_events FORCE ROW LEVEL SECURITY;
ALTER TABLE vc_event_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_event_items FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON vc_events, vc_event_items TO barplatform_app, barplatform_service;
GRANT USAGE, SELECT ON SEQUENCE vc_events_id_seq, vc_event_items_id_seq TO barplatform_app, barplatform_service;
