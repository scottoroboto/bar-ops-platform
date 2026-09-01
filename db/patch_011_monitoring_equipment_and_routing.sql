-- =====================================================================
-- Patch 011 — Systems Monitoring: equipment identity fields, and
-- responsibility-based alert routing (notify a specific person for a
-- category/location, not just self-service opt-in + the owner).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Equipment identity — make/model/serial, alongside the location this
-- already had. All nullable: registering a system shouldn't be blocked on
-- having a nameplate in hand yet, and server/monitoring.js gets an
-- updateSystem() to fill these in later.
-- ---------------------------------------------------------------------
ALTER TABLE monitored_systems ADD COLUMN make text;
ALTER TABLE monitored_systems ADD COLUMN model text;
ALTER TABLE monitored_systems ADD COLUMN serial_number text;

-- ---------------------------------------------------------------------
-- 2. Alert routing — lets a manager/owner say "notify this person about
-- refrigeration alerts at Ticket 1" (location_id + category), independent
-- of that person's own Monitoring dashboard access or self-service
-- notify-channel opt-in (monitoring_notify_settings). A NULL location_id
-- means every location; a NULL category means every category — same
-- "NULL = unrestricted" convention as monitored_systems_select's
-- owner-sees-everything RLS policy. server/monitoring.js's recipientsFor()
-- unions this table with the existing owner+opted-in-employee set.
--
-- Written exclusively through withServiceClient with the role check in
-- the Express route handler (manager/owner only) — same reasoning as
-- monitored_systems itself, so FORCE + zero policies for barplatform_app.
-- ---------------------------------------------------------------------
CREATE TABLE monitoring_alert_routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  location_id   uuid REFERENCES locations(id) ON DELETE CASCADE,
  category      text CHECK (category IN ('network','hvac','refrigeration','freezer','ice_machine','power','other')),
  added_by      uuid REFERENCES people(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_monitoring_alert_routes_person ON monitoring_alert_routes(person_id);

ALTER TABLE monitoring_alert_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_alert_routes FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring_alert_routes TO barplatform_app, barplatform_service;

-- ---------------------------------------------------------------------
-- 3. Close the one remaining RLS-disabled advisory: monitoring_notify_settings
-- shipped without RLS on the (now stale) assumption that it mirrored
-- reminder_settings, which has since had RLS enabled. This table is only
-- ever touched through withServiceClient (getNotifySettings/setNotifyChannel
-- in server/monitoring.js, both scoped to req.person.id in the route
-- handler, never a client-supplied id), so locking it down here is a
-- no-op for the app and closes a real anon/authenticated exposure.
-- ---------------------------------------------------------------------
ALTER TABLE monitoring_notify_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_notify_settings FORCE ROW LEVEL SECURITY;
