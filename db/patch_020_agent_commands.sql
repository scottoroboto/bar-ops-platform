-- =====================================================================
-- Patch 020 — Venue Control: cloud -> agent command queue, for Discovery
-- & Adopt remote trigger (claude/venue-control-gui-reconciliation.md §4,
-- Option B: "cloud proxies discovery calls to the agent over the existing
-- agent-connection channel").
--
-- The agent's connection to the cloud has always been outbound-only
-- (register/config-pull/heartbeat every 30s -- see agent/lib/sync.js).
-- db/patch_016_venue_control.sql's own comment on vc_discovery_runs/
-- vc_discovery_devices already anticipated this: "a general commands/
-- results queue would land once there's something on the agent worth
-- commanding." That's now: an owner needs to trigger a network scan from
-- the cloud admin (potentially from a phone, off the venue's Wi-Fi), and
-- the scan itself can only run on the on-site box against its own LAN.
--
-- This table is deliberately generic (a `type` + jsonb `payload`/`result`)
-- rather than discovery-scan-specific, so a future remote action doesn't
-- need its own table -- same reasoning as vc_activity's shape. Only
-- 'discovery_scan' is a valid type today; the CHECK constraint is meant to
-- be widened (not dropped) when a second command type is added, so a typo
-- in a new type string fails loudly instead of queuing silently.
--
-- Same posture as every other feature-scoped table in this app: RLS
-- ENABLED + FORCED, zero policies, authorization enforced entirely in the
-- Express route handlers (owner session enqueues/reads; the on-site agent
-- claims and reports results via its existing per-site bearer token).
-- =====================================================================

CREATE TABLE vc_agent_commands (
  id            BIGSERIAL PRIMARY KEY,
  site_id       BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::JSONB,
  status        TEXT NOT NULL DEFAULT 'pending',
  result        JSONB,
  error         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked_up_at  TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  CONSTRAINT vc_agent_commands_type_chk CHECK (type IN ('discovery_scan')),
  CONSTRAINT vc_agent_commands_status_chk CHECK (status IN ('pending','running','done','error'))
);
-- Agent's claim query filters (site_id, status='pending'); the admin poll
-- filters (site_id, id) via the primary key alone, so this one index covers
-- both real access patterns.
CREATE INDEX ON vc_agent_commands (site_id, status, created_at);

ALTER TABLE vc_agent_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_agent_commands FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON vc_agent_commands TO barplatform_app, barplatform_service;
