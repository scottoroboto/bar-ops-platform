-- =====================================================================
-- Patch 014 — Scheduling app (v1).
--
-- Ported from the shape of the old Google Apps Script "TSB Scheduling"
-- system (reviewed directly out of script.google.com on 2026-09-02), per
-- Scotto's explicit sign-off to keep the same shift model, same
-- availability model, draft-then-publish workflow, and same time-off
-- setup. Two things are deliberately NOT ported: shift-swap requests
-- (never existed in the old system either) and any Time-Clock conflict
-- checking (the old system had no time clock to check against, and
-- Scotto confirmed this build doesn't need that link).
--
-- Ticket 3 is explicitly IN SCOPE for Scheduling, unlike Systems
-- Monitoring / Service Calls (which exclude it because it's being sold)
-- — Scotto asked to leave it in the loop for now. Don't copy the T3
-- exclusion pattern from monitoring.js/servicecalls into this app.
--
-- Model:
--   schedules            — a named roster/crew under one location (NOT a
--                           time concept — e.g. could be "Bar" vs "Kitchen"
--                           within one location). Distinct from `locations`.
--   employee_schedules    — which schedules a person is checked into
--                           (many-to-many; a shift can only be assigned on
--                           a schedule the person is checked into).
--   employee_positions    — which positions a person is qualified for, for
--                           SCHEDULING purposes (many-to-many). Deliberately
--                           separate from people.position (free-text, used
--                           elsewhere for pay/admin) — additive, doesn't
--                           touch that column.
--   manager_schedules     — which schedules a person (role='manager') can
--                           manage. Scoped per-schedule, same as the old
--                           system — NOT the same thing as people.role,
--                           which still drives platform-wide permissions
--                           elsewhere. role='owner' can manage every
--                           schedule regardless of this table (enforced in
--                           the route handler, same pattern as isAdmin_ in
--                           the old system).
--   shifts                — the live schedule.
--   shift_drafts           — staging table; nothing in `shifts` changes,
--                           and no notification goes out, until a manager
--                           publishes their own pending drafts.
--   time_off_requests      — date-range requests, manager-scoped approval.
--   availability            — self-service "I can't work this window" rows,
--                           soft-blocks conflicting shifts (overridable).
--
-- Conflict-checking (hard: not qualified for schedule, not qualified for
-- position, overlaps another active shift anywhere; soft, overridable
-- with a logged reason: overlaps approved time off, overlaps self-marked
-- unavailability) lives in server/scheduling.js, not the database — same
-- posture as every other business-rule table on this platform. Overlap
-- math should reuse server/timeclock.js's zonedTimeToUtc/toUtcInstant
-- bar-timezone helpers rather than re-deriving it.
--
-- RLS: same posture as pay_rate_requests/credential_reset_requests/
-- owner_notes — ENABLE + FORCE with zero policies on every table below,
-- so nothing reaches them except through withServiceClient, and
-- authorization is enforced in the Express route handlers.
-- =====================================================================

CREATE TABLE schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employee_schedules (
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, schedule_id)
);

CREATE TABLE employee_positions (
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, position_id)
);

CREATE TABLE manager_schedules (
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, schedule_id)
);

CREATE TABLE shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES people(id),
  schedule_id     uuid NOT NULL REFERENCES schedules(id),
  position_id     uuid NOT NULL REFERENCES positions(id),
  shift_date      date NOT NULL,
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  created_by      uuid REFERENCES people(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  override_reason text
);
CREATE INDEX idx_shifts_person_date ON shifts(person_id, shift_date);
CREATE INDEX idx_shifts_schedule_date ON shifts(schedule_id, shift_date);

CREATE TABLE shift_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action          text NOT NULL CHECK (action IN ('create','update','cancel')),
  target_shift_id uuid REFERENCES shifts(id) ON DELETE CASCADE,
  person_id       uuid NOT NULL REFERENCES people(id),
  schedule_id     uuid NOT NULL REFERENCES schedules(id),
  position_id     uuid NOT NULL REFERENCES positions(id),
  shift_date      date NOT NULL,
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  created_by      uuid NOT NULL REFERENCES people(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  override_reason text
);
CREATE INDEX idx_shift_drafts_created_by ON shift_drafts(created_by);

CREATE TABLE time_off_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES people(id),
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  all_day       boolean NOT NULL DEFAULT true,
  message       text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  reviewed_by   uuid REFERENCES people(id),
  reviewed_at   timestamptz,
  requested_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_time_off_requests_person ON time_off_requests(person_id);
CREATE INDEX idx_time_off_requests_status ON time_off_requests(status);

CREATE TABLE availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  day_of_week text NOT NULL CHECK (day_of_week IN ('Sun','Mon','Tue','Wed','Thu','Fri','Sat')),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  note        text
);
CREATE INDEX idx_availability_person ON availability(person_id);

ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_positions FORCE ROW LEVEL SECURITY;
ALTER TABLE manager_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE manager_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
ALTER TABLE shift_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE time_off_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability FORCE ROW LEVEL SECURITY;
-- Deliberately zero policies on all eight tables — see header note.

GRANT SELECT, INSERT, UPDATE, DELETE ON schedules, employee_schedules, employee_positions,
  manager_schedules, shifts, shift_drafts, time_off_requests, availability
  TO barplatform_app, barplatform_service;
