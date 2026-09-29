-- =====================================================================
-- Patch 041 — Diamond Amusement collections (coin-op route).
--
-- Scotto's second business: coin-operated games (pool tables, Golden
-- Tee, Putt Putt, shuffleboard, basketball, pinball) placed in the bars.
-- Roughly every two weeks someone (Scotto or Ryan) empties every game at
-- a location, weighs the quarters, counts the bills, and the location's
-- total gets rung into that bar's SpotOn POS as an "Amusement" sale.
--
-- Shape, in the platform's usual style:
--   amusement_locations       where games live (a bar, or the shop/
--                             storage). Optionally linked to a platform
--                             `locations` row so reports and the POS
--                             hand-off know which bar it is.
--   amusement_games           the machines. A game is at exactly one
--                             amusement location at a time
--                             (current_location_id) and carries a short
--                             tag_code (DA-0007) printed as a QR sticker
--                             on the cabinet — scanning it opens the
--                             game's weigh screen.
--   amusement_game_placements the move history, so a game's earnings
--                             follow it between bars in reports.
--   amusement_collections     one visit to one location: draft while
--                             games are being weighed, final once
--                             submitted, then pos_status tracks whether
--                             the total has been rung into SpotOn.
--   amusement_collection_items one row per game per collection: the
--                             scale reading (gross, tare, unit), the
--                             quarter-weight constant used, the derived
--                             coin count / dollars, bill counts, the
--                             optional coin meter, condition + note, and
--                             the photo of the scale display that the
--                             reading came from.
--   amusement_settings        one row: quarter weight, default tare,
--                             preferred unit.
--
-- Conversion is stored, never recomputed: each item keeps the weights
-- and the quarter_weight_g in force at the time, so a later settings
-- change never rewrites history.
--
-- Photos (scale display, scale-check roll) go to a private Supabase
-- Storage bucket, `amusement-photos`, same posture as cash-receipts /
-- people-photos: service-role only, handed to a browser as a short-lived
-- signed URL. See server/storage.js.
--
-- Access: the 'amusement' app-key toggle on employee_apps (collectors),
-- owner always. Games / locations / settings / reports are owner-only,
-- enforced in server/index.js. Every table here: RLS ENABLE + FORCE with
-- zero policies, reached only through withServiceClient — same posture as
-- cash_* and inventory_* (patch_023 / patch_028).
-- =====================================================================

ALTER TABLE employee_apps DROP CONSTRAINT employee_apps_app_key_check;
ALTER TABLE employee_apps ADD CONSTRAINT employee_apps_app_key_check
  CHECK (app_key IN ('time_clock','service_calls','scheduling','monitoring','employees','cash_handling','inventory_control','tv_staff','amusement'));

-- ---------------------------------------------------------------------
-- Settings — one row, id fixed at 1.
-- ---------------------------------------------------------------------
CREATE TABLE amusement_settings (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  quarter_weight_g   numeric(6,3) NOT NULL DEFAULT 5.670,   -- US Mint spec for a clad quarter
  default_tare_g     numeric(8,2) NOT NULL DEFAULT 0,       -- the bucket / tray the quarters sit in
  weight_unit        text NOT NULL DEFAULT 'g' CHECK (weight_unit IN ('g','lb')),
  scale_check_roll_g numeric(7,2) NOT NULL DEFAULT 226.80,  -- a $10 roll: 40 quarters x 5.670 g
  scale_check_tolerance_g numeric(6,2) NOT NULL DEFAULT 4,  -- +/- allowed on the roll check before we warn
  updated_by         uuid REFERENCES people(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO amusement_settings (id) VALUES (1);

-- ---------------------------------------------------------------------
-- Locations.
-- ---------------------------------------------------------------------
CREATE TABLE amusement_locations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL UNIQUE,
  location_id        uuid REFERENCES locations(id),         -- the bar this is, when it is one of ours
  pos_department     text NOT NULL DEFAULT 'Amusement',     -- what the sale is rung in as on SpotOn
  collect_every_days int NOT NULL DEFAULT 14,
  is_storage         boolean NOT NULL DEFAULT false,        -- shop / storage: holds games, never collected
  active             boolean NOT NULL DEFAULT true,
  sort_order         int NOT NULL DEFAULT 0,
  created_by         uuid REFERENCES people(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Seed: one amusement location per active bar (owner archives any that
-- has no games) plus the shop. Names mirror the bars so the two lists
-- read the same.
INSERT INTO amusement_locations (name, location_id, sort_order)
SELECT name, id, row_number() OVER (ORDER BY name) FROM locations WHERE active = true;
INSERT INTO amusement_locations (name, is_storage, sort_order) VALUES ('Storage / shop', true, 99);

-- ---------------------------------------------------------------------
-- Games.
-- ---------------------------------------------------------------------
CREATE TABLE amusement_games (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,                        -- "Pool table 1", "Golden Tee"
  game_type           text NOT NULL DEFAULT 'other',        -- pool | video | pinball | shuffleboard | basketball | putt_putt | other (free text on purpose)
  make                text,
  model               text,
  serial              text,
  price_per_play      numeric(6,2) NOT NULL DEFAULT 1.00,
  accepts_bills       boolean NOT NULL DEFAULT false,
  tag_code            text NOT NULL UNIQUE,                 -- DA-0001 ... printed as the QR sticker
  current_location_id uuid REFERENCES amusement_locations(id),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  notes               text,
  sort_order          int NOT NULL DEFAULT 0,
  created_by          uuid REFERENCES people(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  retired_at          timestamptz
);
CREATE INDEX idx_amusement_games_location ON amusement_games(current_location_id) WHERE status = 'active';

CREATE TABLE amusement_game_placements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id      uuid NOT NULL REFERENCES amusement_games(id),
  location_id  uuid NOT NULL REFERENCES amusement_locations(id),
  from_at      timestamptz NOT NULL DEFAULT now(),
  to_at        timestamptz,                                  -- NULL = where it is now
  moved_by     uuid REFERENCES people(id)
);
CREATE INDEX idx_amusement_placements_game ON amusement_game_placements(game_id, from_at DESC);

-- ---------------------------------------------------------------------
-- Collections.
-- ---------------------------------------------------------------------
CREATE TABLE amusement_collections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES amusement_locations(id),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  started_by      uuid NOT NULL REFERENCES people(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  period_start    timestamptz,                               -- the previous final collection at this location
  finalized_by    uuid REFERENCES people(id),
  finalized_at    timestamptz,
  quarters_total  numeric(10,2) NOT NULL DEFAULT 0,
  bills_total     numeric(10,2) NOT NULL DEFAULT 0,
  total           numeric(10,2) NOT NULL DEFAULT 0,
  pos_status      text CHECK (pos_status IN ('queued','posted')),  -- NULL while draft
  pos_posted_by   uuid REFERENCES people(id),
  pos_posted_at   timestamptz,
  pos_reference   text,                                      -- SpotOn ticket / check number, if they note it
  scale_check_g   numeric(7,2),                              -- what the $10 roll weighed at the start of this visit
  scale_check_ok  boolean,
  scale_check_photo_path text,
  note            text
);
CREATE INDEX idx_amusement_collections_location ON amusement_collections(location_id, started_at DESC);
-- Only one open draft per location at a time.
CREATE UNIQUE INDEX idx_amusement_collections_one_draft ON amusement_collections(location_id) WHERE status = 'draft';

CREATE TABLE amusement_collection_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id       uuid NOT NULL REFERENCES amusement_collections(id) ON DELETE CASCADE,
  game_id             uuid NOT NULL REFERENCES amusement_games(id),
  -- what the scale said
  gross_weight        numeric(9,3),                          -- as read, in weight_unit
  tare_weight         numeric(9,3) NOT NULL DEFAULT 0,       -- in weight_unit
  weight_unit         text NOT NULL DEFAULT 'g' CHECK (weight_unit IN ('g','lb')),
  net_weight_g        numeric(9,2),                          -- derived, always grams
  quarter_weight_g    numeric(6,3) NOT NULL,                 -- snapshot of amusement_settings at the time
  quarter_count       int NOT NULL DEFAULT 0,
  quarters_amount     numeric(10,2) NOT NULL DEFAULT 0,
  -- bills
  bills_1             int NOT NULL DEFAULT 0,
  bills_5             int NOT NULL DEFAULT 0,
  bills_10            int NOT NULL DEFAULT 0,
  bills_20            int NOT NULL DEFAULT 0,
  bills_flat_amount   numeric(10,2),                         -- typed total, used when no per-bill counts were entered
  bills_amount        numeric(10,2) NOT NULL DEFAULT 0,
  total               numeric(10,2) NOT NULL DEFAULT 0,
  -- extras
  meter_reading       bigint,
  condition           text NOT NULL DEFAULT 'ok' CHECK (condition IN ('ok','issue')),
  note                text,
  -- the photo the reading came from (nullable: typed entry)
  weight_photo_path   text,
  weight_read_value   numeric(9,3),                          -- what the reader saw in the photo, before any correction
  weight_read_unit    text,
  weight_confirmed_by uuid REFERENCES people(id),
  entered_by          uuid NOT NULL REFERENCES people(id),
  entered_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, game_id)
);
CREATE INDEX idx_amusement_items_game ON amusement_collection_items(game_id);

-- ---------------------------------------------------------------------
-- RLS posture + grants — see header.
-- ---------------------------------------------------------------------
ALTER TABLE amusement_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE amusement_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE amusement_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE amusement_locations FORCE ROW LEVEL SECURITY;
ALTER TABLE amusement_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE amusement_games FORCE ROW LEVEL SECURITY;
ALTER TABLE amusement_game_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE amusement_game_placements FORCE ROW LEVEL SECURITY;
ALTER TABLE amusement_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE amusement_collections FORCE ROW LEVEL SECURITY;
ALTER TABLE amusement_collection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE amusement_collection_items FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  amusement_settings, amusement_locations, amusement_games, amusement_game_placements,
  amusement_collections, amusement_collection_items
  TO barplatform_app, barplatform_service;

-- ---------------------------------------------------------------------
-- Storage bucket for the scale photos. Same shape as patch_031's
-- people-photos: private, images only, service-role access only. The
-- IF guards the local-dev case where there is no storage schema.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'amusement-photos', 'amusement-photos', false,
      10485760,
      ARRAY['image/jpeg','image/png','image/heic','image/webp']
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
