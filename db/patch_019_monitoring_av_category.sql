-- =====================================================================
-- Patch 019 — Systems Monitoring: 'av' category (docs/venue-control-
-- gui-reconciliation.md's A9 item: "Add 'av' category support to
-- monitored_systems, have the agent write TV/receiver health to
-- system_status and open/close system_alerts on poll, add a Device
-- Health view in the cloud admin.")
--
-- Venue Control's TVs/receivers are not a separate monitoring system --
-- they slot into the platform's existing monitored_systems/system_status/
-- system_alerts tables (db/patch_010_monitoring.sql) as a new category,
-- reusing the same alert-open/close/notify pipeline (server/monitoring.js's
-- recordStatus()) as network/hvac/refrigeration/etc. See
-- server/monitoring.js's reportAvHealth() and server/index.js's
-- POST /api/venue/agent/health for the write path, and
-- GET /api/monitoring/systems?category=av&locationId=... for the read
-- side (public/venue-control.html's Device Health tab).
--
-- Applied live via mcp__Supabase__apply_migration on 2026-09-03, then
-- pushed here for the record (same pattern as patch_015/patch_017).
-- =====================================================================

ALTER TABLE monitored_systems DROP CONSTRAINT monitored_systems_category_check;
ALTER TABLE monitored_systems ADD CONSTRAINT monitored_systems_category_check
  CHECK (category IN ('network','hvac','refrigeration','freezer','ice_machine','power','av','other'));

ALTER TABLE monitoring_alert_routes DROP CONSTRAINT monitoring_alert_routes_category_check;
ALTER TABLE monitoring_alert_routes ADD CONSTRAINT monitoring_alert_routes_category_check
  CHECK (category IN ('network','hvac','refrigeration','freezer','ice_machine','power','av','other'));
