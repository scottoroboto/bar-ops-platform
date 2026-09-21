-- =====================================================================
-- Patch 032 — Systems Monitoring: alert damping + silencing (batch 2c).
--
-- Scotto's two asks (2026-09-21): "so I don't get 20 notifications for a
-- TV not connecting" and "so I can silence a piece of equipment or a
-- system if needed". Until now one bad poll notified instantly, a
-- flapping device sent down/up every minute, and nothing could be muted.
--
-- 1. Damping lives on system_alerts. An alert row is still opened on the
--    first bad poll (so the dashboard goes red immediately), but nobody
--    is told until it has stayed bad for DOWN_BEFORE_NOTIFY (3 min) —
--    notified_at records when that first notice went out (NULL = never;
--    a blip that recovers inside 3 min closes silently). While it stays
--    down, one reminder per REALERT_INTERVAL (15 min), tracked by
--    last_notified_at / reminder_count. Both constants are in
--    server/monitoring.js.
--
-- 2. Silencing lives on monitored_systems: silenced_until > now() means
--    "keep tracking status, keep it red on the dashboard, but send
--    nothing for this one". 'infinity' = until someone turns it back on.
--    A "silence the whole system" (all TVs at Ticket 1, all network gear
--    at Ticket 2) is just the same stamp applied to every row in that
--    location + category, so there is no second table to keep in sync.
-- =====================================================================

ALTER TABLE monitored_systems
  ADD COLUMN silenced_until timestamptz,
  ADD COLUMN silenced_at    timestamptz,
  ADD COLUMN silenced_by    uuid REFERENCES people(id);

ALTER TABLE system_alerts
  ADD COLUMN notified_at      timestamptz,             -- first "it's down" notice; NULL = nobody told (yet, or ever)
  ADD COLUMN last_notified_at timestamptz,             -- most recent notice or reminder, for the 15-min spacing
  ADD COLUMN reminder_count   integer NOT NULL DEFAULT 0;

-- Alerts already open when this ships were notified the moment they
-- opened (old behaviour); say so, otherwise they'd be re-announced.
UPDATE system_alerts SET notified_at = opened_at, last_notified_at = opened_at WHERE closed_at IS NULL;
