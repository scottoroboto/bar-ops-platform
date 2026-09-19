-- =====================================================================
-- Venue Control — record the public IP each on-site box's heartbeats
-- arrive from, so the cloud can tell whether the person opening TV Staff
-- (or looking at a box in TV Admin) is on that bar's internet connection.
--
-- A browser can't see its own LAN address, but the cloud sees two public
-- IPs it CAN compare: the one the agent heartbeats from (the bar's WAN)
-- and the one the person's phone/iPad request comes from. Same address
-- means they're behind the same connection and the box's LAN URL will
-- load; different means they're on cellular / at home / at another bar
-- and it won't — which is exactly the dead-link case Scotto asked to
-- have explained rather than silently failing (2026-09-19).
--
-- Heuristic, not a lock: a bar with dual-WAN, or a carrier that rotates
-- addresses, can fool it. The UI words it as a warning accordingly.
-- =====================================================================

ALTER TABLE vc_agents ADD COLUMN public_ip text;
