-- =====================================================================
-- Patch 028 — Inventory Control app ("Stocktake"), Phase 1: liquor
-- counting only.
--
-- Same shape as Cash Handling (patch_023/025): a tiered-access, blind
-- counting app, structured the same way — zero-policy FORCE RLS on
-- every table here, authorization enforced entirely in Express
-- (server/inventorycontrol.js + server/index.js), never by a DB policy.
--
-- Access model: four tiers derived from Position (full_authority / lead
-- / counter / no_access), owner-overridable per person, independent of
-- the coarse people.role column — inventory_position_defaults /
-- inventory_access_overrides / inventory_access_change_log mirror
-- cash_position_defaults / cash_access_overrides / cash_access_change_log
-- exactly, renamed. Unlike patch_025, there is no known prior Position
-- mapping to seed here (Cash Handling already had Scotto's real-world
-- Manager/Assistant-Manager/Bartender split to seed from; Inventory
-- Control doesn't), so inventory_position_defaults starts empty —
-- everyone resolves to no_access until an owner sets defaults from the
-- Manage Access screen, the same safe-direction default
-- getEffectiveInventoryTier() falls back to for any unmapped position.
--
-- Blind counting is structural, not just policy: inventory_count_items
-- (the per-item ledger a Counter actually writes to) has no previous-
-- quantity, variance, or dollar column at all — that data doesn't exist
-- until inventory_count_variances is written, once, by the submit step.
-- Unlike cash_counts.variance (a GENERATED column present on every row
-- from INSERT, just computed), inventory_count_variances rows literally
-- don't exist pre-submit — there's nothing to accidentally leak even
-- with a buggy query.
--
-- Catalog (inventory_items) is deliberately global, not per-location —
-- a bottle of Tito's is the same product platform-wide. Which locations
-- actually stock which items is expressed by inventory_item_areas
-- (item <-> area, and area already carries location_id), not by an
-- item owning a location itself.
--
-- entry_method on inventory_count_item_partials pre-declares
-- 'ble_scale' now even though nothing in Phase 1 code can reach it —
-- there's no chosen Bluetooth scale hardware yet, so every partial this
-- build writes is 'manual_weight' or 'manual_tenths'. Reserving the
-- value now means a future live-scale integration is a code change, not
-- a CHECK-constraint patch — same trick patch_023 used pre-declaring all
-- four cash_counts.context values before Phase 4 existed.
--
-- Fill fraction is snapshotted at count time (inventory_count_item_
-- partials.fill_fraction), never recomputed live from the item's
-- current reference weights — direct analogy to cash_counts.
-- expected_amount. inventory_items.full_weight_g/empty_weight_g are
-- owner/Lead-editable catalog fields; if fill fraction were derived
-- live from an item's *current* weights, correcting a mismeasured
-- bottle's reference weight later would silently rewrite what every
-- past count reported. A later edit only affects counts taken after it.
--
-- inventory_count_variances is period-over-period (this count vs. the
-- previous logged count for the same item, in units and in dollars via
-- the item's unit_cost), the same "checkpoint" idea
-- computeExpectedAmount() uses for cash sources — NOT a true actual-vs-
-- theoretical-usage figure from POS sales, which needs a recipes module
-- and a sales-CSV ingestion mechanism, neither of which exists or has a
-- decided shape yet. That's unscoped future work.
--
-- Seeds the standard 4-area set (Back Bar, Speed Rail, Cellar, Store
-- Room) at every currently-active location, matching the mockup, so
-- Phase 1 is testable end-to-end before a Manage Areas screen exists.
-- =====================================================================

ALTER TABLE employee_apps DROP CONSTRAINT employee_apps_app_key_check;
ALTER TABLE employee_apps ADD CONSTRAINT employee_apps_app_key_check
  CHECK (app_key IN ('time_clock','service_calls','scheduling','monitoring','employees','cash_handling','inventory_control'));

-- ---------------------------------------------------------------------
-- Areas — per-location counting zones.
-- ---------------------------------------------------------------------
CREATE TABLE inventory_areas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL REFERENCES locations(id),
  name         text NOT NULL,
  sort_order   int NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES people(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, name)
);
CREATE INDEX idx_inventory_areas_location ON inventory_areas(location_id) WHERE active;

-- ---------------------------------------------------------------------
-- Catalog.
-- ---------------------------------------------------------------------
CREATE TABLE inventory_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  category        text,                        -- free text, no enum — same philosophy as positions.name being managed but people.position being free
  upc             text,                         -- nullable — a manually-searched item may have none
  size_ml         int,
  abv_pct         numeric(4,2),
  case_size       int NOT NULL DEFAULT 1,       -- units per case, for the sealed stepper's case->unit conversion
  unit_cost       numeric(10,2),                -- nullable ("needs pricing"); NEVER returned to a caller below lead tier
  full_weight_g   numeric(7,2),                 -- reference weight, full bottle
  empty_weight_g  numeric(7,2),                 -- reference weight, empty bottle
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES people(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_inventory_items_upc ON inventory_items(upc) WHERE upc IS NOT NULL;

-- Which items normally live in which area — drives a Full count's
-- per-area target list and the Review screen's skipped-items list.
CREATE TABLE inventory_item_areas (
  item_id  uuid NOT NULL REFERENCES inventory_items(id),
  area_id  uuid NOT NULL REFERENCES inventory_areas(id),
  PRIMARY KEY (item_id, area_id)
);

-- ---------------------------------------------------------------------
-- Count sessions.
-- ---------------------------------------------------------------------
CREATE TABLE inventory_counts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   uuid NOT NULL REFERENCES locations(id),
  name          text NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('full','spot')),
  status        text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted')),
  started_by    uuid NOT NULL REFERENCES people(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  submitted_by  uuid REFERENCES people(id),
  submitted_at  timestamptz
);
CREATE INDEX idx_inventory_counts_location ON inventory_counts(location_id, started_at DESC);

-- Which areas a session covers (from "New count"'s area picker).
CREATE TABLE inventory_count_areas (
  count_id  uuid NOT NULL REFERENCES inventory_counts(id),
  area_id   uuid NOT NULL REFERENCES inventory_areas(id),
  PRIMARY KEY (count_id, area_id)
);

-- The blind counting ledger. One row per item counted or skipped PER
-- AREA within a session — the same item can legitimately appear in two
-- areas of one session (e.g. Tito's in both Back Bar and Speed Rail),
-- so uniqueness is (count_id, area_id, item_id), not (count_id, item_id).
CREATE TABLE inventory_count_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id      uuid NOT NULL REFERENCES inventory_counts(id),
  area_id       uuid NOT NULL REFERENCES inventory_areas(id),
  item_id       uuid NOT NULL REFERENCES inventory_items(id),
  sealed_units  numeric(8,2) NOT NULL DEFAULT 0,   -- case/unit stepper's total, already converted to units client-side
  status        text NOT NULL DEFAULT 'counted' CHECK (status IN ('counted','skipped')),
  skip_reason   text,
  counted_by    uuid NOT NULL REFERENCES people(id),
  counted_at    timestamptz NOT NULL DEFAULT now(),
  note          text,
  UNIQUE (count_id, area_id, item_id)
);
CREATE INDEX idx_inventory_count_items_count ON inventory_count_items(count_id, area_id);
CREATE INDEX idx_inventory_count_items_item ON inventory_count_items(item_id, counted_at DESC);

-- One row per open bottle counted against a count-item row.
CREATE TABLE inventory_count_item_partials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_item_id  uuid NOT NULL REFERENCES inventory_count_items(id) ON DELETE CASCADE,
  weight_grams   numeric(8,2),                 -- null when entry_method='manual_tenths' (no weight taken in that mode)
  spout_on       boolean NOT NULL DEFAULT false,
  entry_method   text NOT NULL CHECK (entry_method IN ('manual_weight','manual_tenths','ble_scale')),
  fill_fraction  numeric(4,3) NOT NULL CHECK (fill_fraction BETWEEN 0 AND 1),  -- snapshotted, see header note
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_count_item_partials_parent ON inventory_count_item_partials(count_item_id);

-- The reveal. Written ONCE, only by submitInventoryCount(), one row per
-- distinct item across the whole session — these rows do not exist at
-- all until submit, which is the blind-counting guarantee.
CREATE TABLE inventory_count_variances (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id             uuid NOT NULL REFERENCES inventory_counts(id),
  item_id              uuid NOT NULL REFERENCES inventory_items(id),
  counted_quantity     numeric(10,2) NOT NULL,
  previous_quantity    numeric(10,2),              -- null if this item has never been counted before
  previous_count_id    uuid REFERENCES inventory_counts(id),
  variance_quantity    numeric(10,2) GENERATED ALWAYS AS (counted_quantity - COALESCE(previous_quantity, counted_quantity)) STORED,
  unit_cost_at_submit  numeric(10,2),              -- snapshot of inventory_items.unit_cost at submit time
  variance_dollars     numeric(10,2) GENERATED ALWAYS AS ((counted_quantity - COALESCE(previous_quantity, counted_quantity)) * unit_cost_at_submit) STORED,
  UNIQUE (count_id, item_id)
);
CREATE INDEX idx_inventory_count_variances_count ON inventory_count_variances(count_id);

-- ---------------------------------------------------------------------
-- Access — exact mirror of cash_position_defaults / cash_access_
-- overrides / cash_access_change_log (patch_025), renamed, four new
-- tier names. No seed rows — see header note.
-- ---------------------------------------------------------------------
CREATE TABLE inventory_position_defaults (
  position_id  uuid PRIMARY KEY REFERENCES positions(id),
  tier         text NOT NULL CHECK (tier IN ('no_access','counter','lead','full_authority')),
  updated_by   uuid REFERENCES people(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_access_overrides (
  person_id  uuid PRIMARY KEY REFERENCES people(id),
  tier       text NOT NULL CHECK (tier IN ('no_access','counter','lead','full_authority')),
  set_by     uuid NOT NULL REFERENCES people(id),
  note       text,
  set_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_access_change_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES people(id),
  old_tier    text,
  new_tier    text NOT NULL,
  changed_by  uuid NOT NULL REFERENCES people(id),
  note        text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_access_change_log_person ON inventory_access_change_log(person_id, changed_at DESC);

-- ---------------------------------------------------------------------
-- RLS + grants — same zero-policy FORCE posture as every table above.
-- ---------------------------------------------------------------------
ALTER TABLE inventory_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_areas FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_item_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_item_areas FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_counts FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_areas FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_items FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_item_partials ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_item_partials FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_variances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_variances FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_position_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_position_defaults FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_access_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_access_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_access_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_access_change_log FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  inventory_areas, inventory_items, inventory_item_areas, inventory_counts,
  inventory_count_areas, inventory_count_items, inventory_count_item_partials,
  inventory_count_variances, inventory_position_defaults, inventory_access_overrides,
  inventory_access_change_log
  TO barplatform_app, barplatform_service;

-- ---------------------------------------------------------------------
-- Seed the standard area set at every active location.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  loc RECORD;
BEGIN
  FOR loc IN SELECT id FROM locations WHERE active LOOP
    INSERT INTO inventory_areas (location_id, name, sort_order)
    VALUES
      (loc.id, 'Back Bar', 1),
      (loc.id, 'Speed Rail', 2),
      (loc.id, 'Cellar', 3),
      (loc.id, 'Store Room', 4);
  END LOOP;
END $$;
