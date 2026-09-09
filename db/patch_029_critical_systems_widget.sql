-- =====================================================================
-- CRITICAL SYSTEMS WIDGET — per-employee, per-location visibility
--
-- A small "Critical Systems" panel on the Apps Home dashboard shows a
-- live green/red dot for WAN, LAN, and WAP at each bar (T1/T2/T3).
-- It reuses Systems Monitoring's own registry (patch_010_monitoring.sql)
-- rather than new equipment/status tables: monitored_systems rows with
-- category = 'network' and kind IN ('unifi_gateway','unifi_switch',
-- 'unifi_ap') map to WAN/LAN/WAP respectively (see
-- server/monitoring.js's getCriticalSystemsStatus). Nothing new to
-- store for the status itself.
--
-- What IS new here is *who sees which bar's row*. Per Scotto: one
-- on/off per bar per employee — T1 managers see T1 only, T2 managers
-- see T2 only, T3 managers see T3 only, and he and maintenance see all
-- three. This is deliberately its own small table, not folded into
-- employee_apps (that's per-app, this is per-(person, location)) and
-- deliberately NOT derived from monitored_systems' own location-scoped
-- RLS (a person's own assigned location) — Scotto wants an explicit,
-- ownerable toggle he sets by hand per person, same as every other
-- access grid in this app, not an automatic default.
--
-- Zero-policy, auth-in-Express — same posture as cash_handling/
-- inventory_control's access tables (server/employees.js's
-- getNetworkAccessForPerson/setNetworkAccess own all reads/writes,
-- owner-gated at the route layer in server/index.js), not the older
-- RLS-policy shape monitored_systems itself uses.
--
-- Also: Ticket 3 was excluded from Systems Monitoring registration
-- (see patch_010's header comment) because it was being sold. Per
-- Scotto, that sale is off and Ticket 3 is being activated again — the
-- exclusion is being removed from server/monitoring.js and
-- public/monitoring.js in this same change. No schema change needed
-- for that; noted here since this patch is what re-enables a T3 row
-- on this widget.
-- =====================================================================

CREATE TABLE network_status_access (
  person_id    uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT false,
  updated_by   uuid REFERENCES people(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, location_id)
);

ALTER TABLE network_status_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_status_access FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON network_status_access TO barplatform_app, barplatform_service;
