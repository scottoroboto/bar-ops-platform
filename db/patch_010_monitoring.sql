-- =====================================================================
-- SYSTEMS MONITORING — equipment registry + status history + alerts
--
-- Built general-purpose from the start (not network-specific) so sensors
-- (refrigeration, HVAC, power, etc.) slot into the same three tables
-- later instead of forcing a schema rebuild. Phase one only populates
-- `kind`s that start with 'unifi_' (switches/APs/gateways polled via
-- Ubiquiti's Site Manager cloud API from server/monitoring.js) — Ticket 3
-- is being sold and is deliberately never registered here; Ticket 1 is on
-- temporary Linksys gear (no API to poll yet) until real UniFi equipment
-- arrives; Ticket 2's UniFi console is managed by SmartSystems
-- Chattanooga, pending Scotto getting access. Both locations exist in
-- `monitored_systems` as an empty registry until then — this migration
-- doesn't depend on that access.
-- =====================================================================

ALTER TABLE employee_apps DROP CONSTRAINT employee_apps_app_key_check;
ALTER TABLE employee_apps ADD CONSTRAINT employee_apps_app_key_check
  CHECK (app_key IN ('time_clock','service_calls','scheduling','monitoring'));

-- ---------------------------------------------------------------------
-- Equipment registry — one row per monitored thing, at a location.
-- `kind` is free-text on purpose (not a CHECK enum): new sensor/device
-- kinds get added over time as hardware gets chosen, without a migration
-- each time. `config` holds kind-specific settings (e.g. a UniFi device
-- id/site id to match poll results back to this row, or a threshold for
-- a future temperature sensor) so the registry stays generic while each
-- kind's polling code (server/monitoring.js) interprets its own shape.
-- ---------------------------------------------------------------------
CREATE TABLE monitored_systems (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   uuid NOT NULL REFERENCES locations(id),
  category      text NOT NULL CHECK (category IN ('network','hvac','refrigeration','freezer','ice_machine','power','other')),
  kind          text NOT NULL,               -- e.g. 'unifi_switch', 'unifi_ap', 'unifi_gateway'
  name          text NOT NULL,               -- e.g. "Zone 2 Switch"
  external_ref  text,                        -- e.g. the UniFi device id, used to match a poll result to this row
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  active        boolean NOT NULL DEFAULT true,
  added_by      uuid REFERENCES people(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_monitored_systems_location ON monitored_systems(location_id);

-- ---------------------------------------------------------------------
-- Status history — the time-series the drill-down view reads from.
-- One row per poll per system. Written only by the poller (service
-- client — this runs with no logged-in person), so there's no INSERT
-- policy for barplatform_app below, same reasoning as time_entries not
-- existing for locations/positions.
-- ---------------------------------------------------------------------
CREATE TABLE system_status (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id   uuid NOT NULL REFERENCES monitored_systems(id) ON DELETE CASCADE,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL CHECK (status IN ('online','offline','warning','unknown')),
  detail      jsonb
);

CREATE INDEX idx_system_status_system_time ON system_status(system_id, checked_at DESC);

-- ---------------------------------------------------------------------
-- Alerts — opened on a status *transition* to something bad (not on
-- every poll — a switch that's been offline for an hour shouldn't fire
-- 60 emails), closed on recovery. This is also what the notification
-- fan-out in server/monitoring.js keys off of.
-- ---------------------------------------------------------------------
CREATE TABLE system_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id   uuid NOT NULL REFERENCES monitored_systems(id) ON DELETE CASCADE,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  status      text NOT NULL,   -- the bad status that opened this alert, e.g. 'offline'
  message     text NOT NULL
);

CREATE INDEX idx_system_alerts_system ON system_alerts(system_id, opened_at DESC);
CREATE UNIQUE INDEX idx_system_alerts_one_open ON system_alerts(system_id) WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------
-- Per-person notification channel preference for monitoring alerts only
-- (deliberately separate from reminder_settings.notify_channel, which is
-- Time Clock reminders — someone may want those by email but monitoring
-- alerts by SMS+email). Twilio isn't configured yet (see notify.js —
-- everything logs as "simulated" until real credentials land in Render),
-- so 'sms'/'both' are safe to select now and will just start actually
-- sending the moment those credentials exist — no schema change needed
-- when that happens.
-- ---------------------------------------------------------------------
CREATE TABLE monitoring_notify_settings (
  person_id      uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  notify_channel text NOT NULL DEFAULT 'email' CHECK (notify_channel IN ('email','sms','both')),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- RLS — same location-scoped shape as service_calls: owner sees every
-- location, everyone else sees only their own location's systems/
-- history/alerts. All three tables are written exclusively by trusted
-- server code (the poller, or an owner/manager registry edit going
-- through withServiceClient with the role check in the route handler),
-- so — same reasoning as locations/positions/devices — there's no
-- INSERT/UPDATE/DELETE policy for barplatform_app; FORCE closes the
-- owner-role bypass gap the same way it does everywhere else in this file.
-- ---------------------------------------------------------------------
ALTER TABLE monitored_systems ENABLE ROW LEVEL SECURITY;
CREATE POLICY monitored_systems_select ON monitored_systems
  FOR SELECT USING (
    current_role_name() = 'owner'
    OR location_id = current_location_id()
  );
ALTER TABLE monitored_systems FORCE ROW LEVEL SECURITY;

ALTER TABLE system_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY system_status_select ON system_status
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM monitored_systems ms WHERE ms.id = system_status.system_id
        AND (current_role_name() = 'owner' OR ms.location_id = current_location_id())
    )
  );
ALTER TABLE system_status FORCE ROW LEVEL SECURITY;

ALTER TABLE system_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY system_alerts_select ON system_alerts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM monitored_systems ms WHERE ms.id = system_alerts.system_id
        AND (current_role_name() = 'owner' OR ms.location_id = current_location_id())
    )
  );
ALTER TABLE system_alerts FORCE ROW LEVEL SECURITY;

-- monitoring_notify_settings deliberately has no RLS, same as the
-- existing reminder_settings table it mirrors — self-service reads/
-- writes are scoped in the route handler (req.person.id, never a
-- client-supplied id), not at the database layer.

GRANT SELECT, INSERT, UPDATE, DELETE ON monitored_systems, system_status, system_alerts, monitoring_notify_settings
  TO barplatform_app, barplatform_service;
