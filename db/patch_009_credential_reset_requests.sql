-- =====================================================================
-- Patch 009 — self-service password/PIN reset (owner-mediated fallback).
--
-- Context: server/auth.js had no recovery path at all — the only fix for
-- a forgotten password/PIN was a direct DB update (see the owner reset
-- Scotto had done manually on 2026-08-25). Real email/SMS delivery isn't
-- configured in production (notify.js logs to notifications_log instead
-- of actually sending), so a code-based self-service reset would just
-- strand people the same way the first-login flow already can. Instead:
-- an employee files a request from the login screen (no auth required —
-- they can't log in, that's the whole point), it lands in front of the
-- owner in Employees admin, and approving it generates a brand-new temp
-- password/PIN that the owner hands over directly (in person / by call) —
-- the same trusted-channel pattern already used for activateEmployee and
-- bootstrap-owner.js. No SMTP/Twilio dependency, ships today.
--
-- Same posture as pay_rate_requests/devices/locations: RLS FORCE with no
-- policies at all, so every touch goes through the barplatform_service
-- role (withServiceClient) and authorization is enforced in the Express
-- route handlers, not the database.
--
-- Run this in Supabase's SQL Editor with "Run without RLS" (same as the
-- other patches), or via the Supabase MCP's apply_migration.
-- =====================================================================

CREATE TABLE IF NOT EXISTS credential_reset_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  request_type  text NOT NULL CHECK (request_type IN ('password','pin','both')),
  note          text,                    -- optional context from the employee (e.g. "lost my phone")
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES people(id),
  decided_at    timestamptz,
  decision_note text                     -- optional owner note, e.g. reason for a denial
);

CREATE INDEX IF NOT EXISTS idx_credential_reset_requests_status ON credential_reset_requests(status);

ALTER TABLE credential_reset_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_reset_requests FORCE ROW LEVEL SECURITY;
-- Deliberately zero policies — see header note. Nothing reaches this
-- table except through withServiceClient.

GRANT SELECT, INSERT, UPDATE, DELETE ON credential_reset_requests TO barplatform_app, barplatform_service;
