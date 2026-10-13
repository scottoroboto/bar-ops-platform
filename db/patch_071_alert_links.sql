-- patch_071 (Oct 2026): one-tap Mute / Acknowledge links in alert texts
-- and emails. One row per recipient per alert; the token is the link.
CREATE TABLE IF NOT EXISTS alert_links (
  token      text PRIMARY KEY,
  alert_id   uuid NOT NULL REFERENCES system_alerts(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  action     text
);
