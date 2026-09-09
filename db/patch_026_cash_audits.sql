-- =====================================================================
-- Patch 026 — Cash Handling app (Phase 4: Weekly Audit, Manual Random
-- Audit, System-Assigned Random Audit).
--
-- Three new tables, all following the same zero-policy FORCE RLS
-- posture as every other Cash Handling table (patches 023-025) —
-- everything goes through withServiceClient, authorization lives
-- entirely in server/cashhandling.js + server/index.js.
--
-- weekly_audits and manual_random_audits are near-identical: a
-- checklist session (status in_progress -> submitted) run interactively
-- by a manager (drawers_bags or full_authority) that blind-counts a set
-- of sources one at a time and reveals every item's match/variance
-- together, only once, at final submit. They differ only in WHICH
-- sources they cover: a Weekly Audit counts every active source with
-- include_weekly_audit = true at the location (the full standing
-- rotation); a Manual Random Audit counts every active source with
-- include_random_audit = true at the location (the same pool
-- System-Assigned Random Audit draws one source from each week) — it's
-- a manager-triggered, on-demand spot-check of that pool, as opposed to
-- the system's own automatic once-a-week single-source pick below.
--
-- system_random_audit_assignments is different in kind: not a
-- checklist a manager opts into, but one auto-generated row per
-- location per week (UNIQUE(location_id, week_start) makes the
-- generator idempotent — re-running it for a week that's already been
-- assigned is a no-op) naming exactly one source and exactly one
-- eligible, on-schedule person who is NOT that source's regular
-- handler. due_at is the day their shift falls on — the day they're
-- actually on-site to do it. status moves assigned -> completed (they
-- submitted their one blind count) or -> missed (a sweep marks it once
-- due_at has passed with no count).
--
-- cash_counts gets three new nullable FK columns, one per audit flavor,
-- so a single count row always says exactly which context produced it
-- (or none, for an ordinary cash_out) without overloading `context`
-- (text) as the only signal — the FK is also how a checklist knows
-- which of its items are already counted (patch_023's `context` column
-- already allows all four values, so no CHECK rewrite is needed here).
-- =====================================================================

CREATE TABLE weekly_audits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL REFERENCES locations(id),
  run_by       uuid NOT NULL REFERENCES people(id),
  status       text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz
);
CREATE INDEX idx_weekly_audits_location ON weekly_audits(location_id, started_at DESC);

CREATE TABLE manual_random_audits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL REFERENCES locations(id),
  run_by       uuid NOT NULL REFERENCES people(id),
  status       text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz
);
CREATE INDEX idx_manual_random_audits_location ON manual_random_audits(location_id, started_at DESC);

CREATE TABLE system_random_audit_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         uuid NOT NULL REFERENCES locations(id),
  source_id           uuid NOT NULL REFERENCES cash_sources(id),
  assigned_person_id  uuid NOT NULL REFERENCES people(id),
  week_start          date NOT NULL,          -- the Saturday this assignment's week begins (matches Scheduling's Sat-Fri week)
  due_at              date NOT NULL,           -- the day of the assigned person's on-schedule shift this was generated against
  status              text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','completed','missed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  UNIQUE (location_id, week_start)
);
CREATE INDEX idx_system_random_audit_person ON system_random_audit_assignments(assigned_person_id, status);

ALTER TABLE cash_counts ADD COLUMN weekly_audit_id      uuid REFERENCES weekly_audits(id);
ALTER TABLE cash_counts ADD COLUMN manual_audit_id      uuid REFERENCES manual_random_audits(id);
ALTER TABLE cash_counts ADD COLUMN random_assignment_id uuid REFERENCES system_random_audit_assignments(id);
CREATE INDEX idx_cash_counts_weekly_audit ON cash_counts(weekly_audit_id) WHERE weekly_audit_id IS NOT NULL;
CREATE INDEX idx_cash_counts_manual_audit ON cash_counts(manual_audit_id) WHERE manual_audit_id IS NOT NULL;
CREATE INDEX idx_cash_counts_random_assignment ON cash_counts(random_assignment_id) WHERE random_assignment_id IS NOT NULL;

ALTER TABLE weekly_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_audits FORCE ROW LEVEL SECURITY;
ALTER TABLE manual_random_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_random_audits FORCE ROW LEVEL SECURITY;
ALTER TABLE system_random_audit_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_random_audit_assignments FORCE ROW LEVEL SECURITY;
-- Deliberately zero policies on all three — see header note.

GRANT SELECT, INSERT, UPDATE, DELETE ON weekly_audits, manual_random_audits, system_random_audit_assignments TO barplatform_app, barplatform_service;
