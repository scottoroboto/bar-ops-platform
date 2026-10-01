-- =====================================================================
-- Patch 044 — Games: coin-less games and the collection screen (Scotto,
-- 2026-10-01).
--
-- Golden Tee takes bills only, and it (like Power Putt, which also takes
-- quarters) has an on-screen collection report the collector has to
-- photograph each visit, then clear, before counting the bills. So:
--
--   amusement_games.accepts_coins          — off for Golden Tee: no weighing step
--   amusement_games.has_collection_screen  — on for Golden Tee / Power Putt:
--                                            photo the screen, then "did you
--                                            clear it?", then count bills
--   amusement_collection_items.screen_photo_path / screen_total /
--     screen_cleared                        — what was captured per line
-- =====================================================================

ALTER TABLE amusement_games
  ADD COLUMN accepts_coins          boolean NOT NULL DEFAULT true,
  ADD COLUMN has_collection_screen  boolean NOT NULL DEFAULT false;

ALTER TABLE amusement_collection_items
  ADD COLUMN screen_photo_path text,                 -- photo of the game's collection screen
  ADD COLUMN screen_total      numeric(10,2),        -- the total the screen showed (read from the photo, or typed)
  ADD COLUMN screen_cleared    boolean;              -- collector's answer to "did you clear the collection screen?"

-- Which bills the acceptor takes (Scotto: "takes bills — if yes, what
-- denominations up to 20"). The collector's sheet only shows those
-- columns. Default: all four.
ALTER TABLE amusement_games
  ADD COLUMN bill_denoms int[] NOT NULL DEFAULT '{1,5,10,20}';
