-- patch_038 — 'tv_identify' command (Scotto, 2026-09-27: "how do I name a
-- TV when there are 25"). TV Admin's Identify button asks the bar's box
-- to nudge one TV's volume up and back down so its on-screen bar shows
-- and the person in the room can see which set it is.
ALTER TABLE vc_agent_commands DROP CONSTRAINT vc_agent_commands_type_chk;
ALTER TABLE vc_agent_commands ADD CONSTRAINT vc_agent_commands_type_chk CHECK (type IN ('discovery_scan', 'speedtest', 'tv_identify'));
