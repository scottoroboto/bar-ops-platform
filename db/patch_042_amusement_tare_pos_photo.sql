-- =====================================================================
-- Patch 042 — Diamond Amusement follow-ups (Scotto, 2026-09-29):
--
-- 1. Per-game coin-box tare. The QR sticker goes on each game's coin
--    box, and the box is what sits on the scale, so the app deducts
--    THAT box's weight rather than one default bucket. Set once by
--    weighing the empty box (photo or typed), kept on the game with
--    the photo it came from. amusement_settings.default_tare_g stays
--    as the fallback for a game whose box hasn't been weighed yet.
-- 2. A proper calibration weight. amusement_settings gains
--    calibration_weight_g: when set (a certified 500 g / 1 kg test
--    weight), the start-of-visit scale check expects that instead of
--    the $10 roll. Each collection now records what it expected
--    (scale_check_expected_g) so the history reads correctly after a
--    settings change.
-- 3. Photo of the SpotOn ticket on "Mark posted", so a finalized
--    collection carries proof at both ends.
-- =====================================================================

ALTER TABLE amusement_games
  ADD COLUMN tare_g         numeric(8,2),                 -- this game's empty coin box, grams; NULL = use settings default
  ADD COLUMN tare_photo_path text,
  ADD COLUMN tare_set_by    uuid REFERENCES people(id),
  ADD COLUMN tare_set_at    timestamptz;

ALTER TABLE amusement_settings
  ADD COLUMN calibration_weight_g numeric(8,2);          -- NULL = check with the $10 roll (scale_check_roll_g)

ALTER TABLE amusement_collections
  ADD COLUMN scale_check_expected_g numeric(8,2),
  ADD COLUMN pos_photo_path text;

-- Backfill what existing checks were measured against.
UPDATE amusement_collections SET scale_check_expected_g = (SELECT scale_check_roll_g FROM amusement_settings WHERE id = 1)
 WHERE scale_check_g IS NOT NULL;
