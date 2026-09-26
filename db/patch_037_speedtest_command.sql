-- patch_037 — 'speedtest' joins the commands the cloud can queue for a
-- bar's box (Scotto, 2026-09-26: "Test now" on a line's tile in Systems
-- Monitoring). The box runs the gateway's speed test and reports it the
-- same way its scheduled tests do.
ALTER TABLE vc_agent_commands DROP CONSTRAINT vc_agent_commands_type_chk;
ALTER TABLE vc_agent_commands ADD CONSTRAINT vc_agent_commands_type_chk CHECK (type IN ('discovery_scan', 'speedtest'));
