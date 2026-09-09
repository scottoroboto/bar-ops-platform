-- =====================================================================
-- Patch 023 — Cash Handling app (Phase 1: sources + blind cash-out).
--
-- Scope: cash_sources (the registry — ATM/Change Machine/Safe as
-- 'fixed_point', Cash Drawer N as 'drawer' paired 1:1 with its own
-- 'backup_bag' via linked_source_id) and cash_counts (the ledger —
-- every blind count of a source, whatever the reason). Access
-- overrides, transactions, and both audit flavors are later patches
-- (024-026) per the phased build plan; cash_counts.context already
-- lists all four values it will ever take so those patches don't need
-- to touch this CHECK constraint.
--
-- Access model (enforced entirely in server/cashhandling.js +
-- server/index.js, NOT in RLS — see below): four tiers derived from
-- Position (full_authority / drawers_bags / own_drawer / no_access),
-- owner-overridable per person, independent of the coarse people.role
-- column. That mapping table (cash_position_defaults) and the override
-- table land in patch_025 — Phase 1 has no owner/manager tier table
-- yet, so getEffectiveCashTier() falls back to a small hardcoded map
-- keyed on positions.name until patch_025 lands, matching the
-- Position defaults already agreed with Scotto (Manager/Bar Manager ->
-- full_authority, Assistant Bar Manager -> drawers_bags, Bartender ->
-- own_drawer, anything else -> no_access).
--
-- RLS: same posture as scheduling/monitoring (patch_014/patch_010) —
-- ENABLE + FORCE with zero policies on both tables, so nothing reaches
-- them except through withServiceClient, and every authorization
-- decision is made in the Express route handler / cashhandling.js.
--
-- Seeds the standard 7-source set (ATM, Change Machine, Safe, Drawers
-- 1-4 each with its own Backup Bag) at every currently-active location,
-- matching the mockup exactly, so Phase 1 is testable end-to-end before
-- the Manage Cash Sources screen (patch_025/Phase 3) exists to add more.
-- Both audit-inclusion flags start true here (unlike sources added
-- later through Manage Cash Sources, which start false) since these
-- are the real, already-in-use sources Scotto described on day one,
-- not brand-new/temporary ones.
-- =====================================================================

ALTER TABLE employee_apps DROP CONSTRAINT employee_apps_app_key_check;
ALTER TABLE employee_apps ADD CONSTRAINT employee_apps_app_key_check
  CHECK (app_key IN ('time_clock','service_calls','scheduling','monitoring','employees','cash_handling'));

CREATE TABLE cash_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id           uuid NOT NULL REFERENCES locations(id),
  name                  text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('drawer','backup_bag','fixed_point')),
  linked_source_id      uuid REFERENCES cash_sources(id),   -- a drawer's paired bag, or vice versa; set symmetrically
  assigned_person_id    uuid REFERENCES people(id),         -- drawer's "regular handler" — drives own_drawer access
                                                              -- and random-audit self-check exclusion (patch_026)
  target_amount         numeric(10,2) NOT NULL DEFAULT 0,   -- baseline expected balance before any count exists
  active                boolean NOT NULL DEFAULT true,      -- soft-delete = "retire" (Manage Cash Sources, Phase 3)
  include_weekly_audit  boolean NOT NULL DEFAULT false,
  include_random_audit  boolean NOT NULL DEFAULT false,
  sort_order            int NOT NULL DEFAULT 0,
  created_by            uuid REFERENCES people(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, name)
);
CREATE INDEX idx_cash_sources_location ON cash_sources(location_id) WHERE active;

CREATE TABLE cash_counts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES cash_sources(id),
  counted_by      uuid NOT NULL REFERENCES people(id),
  on_behalf_of    uuid REFERENCES people(id),               -- set when a manager cashes out someone else's drawer
  context         text NOT NULL DEFAULT 'cash_out'
                    CHECK (context IN ('cash_out','weekly_audit','manual_random_audit','system_random_audit')),
  counted_amount  numeric(10,2) NOT NULL CHECK (counted_amount >= 0),
  expected_amount numeric(10,2) NOT NULL,                   -- snapshot at submit time — see computeExpectedAmount()
  variance        numeric(10,2) GENERATED ALWAYS AS (counted_amount - expected_amount) STORED,
  note            text,
  counted_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cash_counts_source_time ON cash_counts(source_id, counted_at DESC);

ALTER TABLE cash_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_counts FORCE ROW LEVEL SECURITY;
-- Deliberately zero policies on both tables — see header note.

GRANT SELECT, INSERT, UPDATE, DELETE ON cash_sources, cash_counts TO barplatform_app, barplatform_service;

-- ---------------------------------------------------------------------
-- Seed the standard source set at every active location.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  loc RECORD;
  drawer_id uuid;
  bag_id uuid;
  i int;
BEGIN
  FOR loc IN SELECT id FROM locations WHERE active LOOP
    INSERT INTO cash_sources (location_id, name, kind, sort_order, include_weekly_audit, include_random_audit)
    VALUES
      (loc.id, 'ATM', 'fixed_point', 1, true, true),
      (loc.id, 'Change Machine', 'fixed_point', 2, true, true),
      (loc.id, 'Safe', 'fixed_point', 3, true, true);

    FOR i IN 1..4 LOOP
      INSERT INTO cash_sources (location_id, name, kind, sort_order, include_weekly_audit, include_random_audit)
      VALUES (loc.id, 'Cash Drawer ' || i, 'drawer', 10 + i, true, true)
      RETURNING id INTO drawer_id;

      INSERT INTO cash_sources (location_id, name, kind, linked_source_id, sort_order, include_weekly_audit, include_random_audit)
      VALUES (loc.id, 'Backup Bag ' || i, 'backup_bag', drawer_id, 20 + i, true, false)
      RETURNING id INTO bag_id;

      UPDATE cash_sources SET linked_source_id = bag_id WHERE id = drawer_id;
    END LOOP;
  END LOOP;
END $$;
