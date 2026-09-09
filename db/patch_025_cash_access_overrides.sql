-- =====================================================================
-- Patch 025 — Cash Handling Phase 3: owner-editable access (position
-- defaults + per-person overrides) and Manage Cash Sources.
--
-- Replaces the hardcoded POSITION_DEFAULT_TIER map in
-- server/cashhandling.js (Phase 1's placeholder, flagged in its own
-- header comment for exactly this) with real tables the owner can edit
-- from the app: cash_position_defaults sets "what does this Position get
-- by default", cash_access_overrides lets the owner bump one specific
-- person up or down from their position's default (Scotto's original
-- ask: "Until I have a GENERAL MANAGER, I need the ability to allow bar
-- managers to handle the cash flow... elevate and lower permissions" —
-- per-person, owner-only, never a manager). cash_access_change_log is a
-- plain append-only audit trail of every override set/reverted, since
-- this is exactly the kind of thing worth being able to answer "who
-- changed this and when" about later.
--
-- cash_position_defaults keys off positions.id (a real FK, unlike
-- people.position which is free text — see db/schema.sql's own comment
-- on why) and is seeded here by matching each position's NAME
-- case-insensitively, not by assuming fixed ids: Bar Manager/Assistant
-- Bar Manager exist in production today because Scotto added them live
-- through the Positions admin UI, not through any SQL file, so their ids
-- aren't known at migration-authoring time and could differ by
-- environment (this local dev DB's seed positions are an older set with
-- no "Bar Manager" row at all). A position with no matching seed row here
-- simply has no cash_position_defaults row — getEffectiveCashTier()
-- treats "no row" as no_access, same safe-direction default Phase 1's
-- hardcoded map already used for anything unlisted.
--
-- Same zero-policy FORCE RLS posture as every other Cash Handling table
-- — every write to any of these three tables is owner-only, enforced in
-- Express (server/index.js), never by a DB policy.
-- =====================================================================

CREATE TABLE cash_position_defaults (
  position_id   uuid PRIMARY KEY REFERENCES positions(id),
  tier          text NOT NULL CHECK (tier IN ('no_access','own_drawer','drawers_bags','full_authority')),
  updated_by    uuid REFERENCES people(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Absence of a row for a person = "use their position's default" (via
-- cash_position_defaults above). Setting an override upserts here;
-- reverting to the default is a DELETE, not a tier value meaning
-- "default" — keeps getEffectiveCashTier's precedence a plain two-step
-- COALESCE instead of a tri-state column.
CREATE TABLE cash_access_overrides (
  person_id     uuid PRIMARY KEY REFERENCES people(id),
  tier          text NOT NULL CHECK (tier IN ('no_access','own_drawer','drawers_bags','full_authority')),
  set_by        uuid NOT NULL REFERENCES people(id),
  note          text,
  set_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cash_access_change_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES people(id),
  old_tier      text,                                        -- null on a person's very first override
  new_tier      text NOT NULL,                                -- the position default's tier again, on a revert
  changed_by    uuid NOT NULL REFERENCES people(id),
  note          text,
  changed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cash_access_change_log_person ON cash_access_change_log(person_id, changed_at DESC);

ALTER TABLE cash_position_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_position_defaults FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_access_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_access_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_access_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_access_change_log FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON cash_position_defaults, cash_access_overrides, cash_access_change_log
  TO barplatform_app, barplatform_service;

-- Seed today's known defaults by Position name (case-insensitive) — the
-- same four rows Phase 1's POSITION_DEFAULT_TIER map hardcoded, now real
-- data the owner can see and edit instead of a value baked into the JS.
-- Anything that doesn't match an existing position name is simply
-- skipped (e.g. "Manager" may not exist as a distinct Position everywhere
-- if "Bar Manager" replaced it) rather than erroring the whole patch.
INSERT INTO cash_position_defaults (position_id, tier)
SELECT id, 'full_authority' FROM positions WHERE lower(name) IN ('manager', 'bar manager')
ON CONFLICT (position_id) DO NOTHING;

INSERT INTO cash_position_defaults (position_id, tier)
SELECT id, 'drawers_bags' FROM positions WHERE lower(name) = 'assistant bar manager'
ON CONFLICT (position_id) DO NOTHING;

INSERT INTO cash_position_defaults (position_id, tier)
SELECT id, 'own_drawer' FROM positions WHERE lower(name) = 'bartender'
ON CONFLICT (position_id) DO NOTHING;
