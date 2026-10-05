-- patch_054 — Slow channel typing per TV (Scotto, 2026-10-06). The Pi
-- types a QAM channel like the remote, 0.7s between keys. A few sets (TV 24
-- and TV 27 at T1, in the Booths) only take the first digit at that pace and
-- need 1.2s. Ticked in TV Admin, so the other TVs keep the faster pace.

ALTER TABLE vc_tvs ADD COLUMN IF NOT EXISTS slow_channel_keys BOOLEAN NOT NULL DEFAULT FALSE;

-- The two found in the T1 walkthrough.
UPDATE vc_tvs SET slow_channel_keys = TRUE, updated_at = now()
 WHERE (name, host(ip)) IN (('TV 24', '10.1.40.245'), ('TV 27', '10.1.40.234'));
