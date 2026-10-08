-- patch_061: how many devices are on the bar's network right now
-- (Oct 2026). The venue-control box asks its Dream Machine once a minute
-- and reports it with the WAN links; the home screen's NETWORK row shows
-- it next to latency and packet loss.
ALTER TABLE vc_sites ADD COLUMN IF NOT EXISTS net_clients integer;
ALTER TABLE vc_sites ADD COLUMN IF NOT EXISTS net_clients_at timestamptz;
