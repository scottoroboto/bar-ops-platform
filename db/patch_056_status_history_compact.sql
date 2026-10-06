-- patch_056: compact monitoring history (Oct 2026)
--
-- system_status grew to 1.4 million rows / 455 MB in a month: the AV boxes
-- report every TV and source every 30 seconds and each report became a
-- row. server/monitoring.js now keeps one row per system per hour plus a
-- row at every change, and drops rows older than 14 days. This brings the
-- existing table in line in one pass: rebuild it from the rows that scheme
-- would have kept (last 2 days: every change, newest row of each hour) so
-- the disk space comes back right away, which a DELETE would not do.
BEGIN;

CREATE TABLE system_status_new (LIKE system_status INCLUDING DEFAULTS INCLUDING CONSTRAINTS);

INSERT INTO system_status_new (id, system_id, checked_at, status, detail)
SELECT id, system_id, checked_at, status, detail FROM (
  SELECT s.*,
         lag(status) OVER (PARTITION BY system_id ORDER BY checked_at) AS prev_status,
         row_number() OVER (PARTITION BY system_id, date_trunc('hour', checked_at) ORDER BY checked_at DESC) AS rn_in_hour
  FROM system_status s
  WHERE checked_at >= now() - interval '2 days'
) x
WHERE prev_status IS DISTINCT FROM status OR rn_in_hour = 1;

-- In production this was done as a rename (the old table kept as
-- system_status_old, then dropped by hand) because the migration tool
-- would not run DROP; the effect is the same.
DROP TABLE system_status;
ALTER TABLE system_status_new RENAME TO system_status;

ALTER TABLE system_status ADD CONSTRAINT system_status_pkey PRIMARY KEY (id);
ALTER TABLE system_status ADD CONSTRAINT system_status_system_id_fkey
  FOREIGN KEY (system_id) REFERENCES monitored_systems(id) ON DELETE CASCADE;
CREATE INDEX idx_system_status_system_time ON system_status(system_id, checked_at DESC);

ALTER TABLE system_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_status FORCE ROW LEVEL SECURITY;
CREATE POLICY system_status_select ON system_status FOR SELECT USING (
  EXISTS (SELECT 1 FROM monitored_systems ms WHERE ms.id = system_status.system_id
          AND (current_role_name() = 'owner' OR ms.location_id = ANY(current_location_ids())))
);
GRANT SELECT, INSERT, UPDATE, DELETE ON system_status TO barplatform_app, barplatform_service;

COMMIT;
