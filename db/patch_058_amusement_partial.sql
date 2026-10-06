-- patch_058: partial collections (Oct 2026)
--
-- A visit can empty some games and leave the rest (Ryan needed quarters,
-- so he did the pool tables and not Golden Tee / Power Putt). For that to
-- report honestly, a game's earning period has to be its own: from the
-- last time THAT game was emptied, not from the location's last visit.
-- Each line now carries its own period_start; existing lines are filled
-- in from the previous line for the same game.
ALTER TABLE amusement_collection_items ADD COLUMN IF NOT EXISTS period_start timestamptz;

UPDATE amusement_collection_items i
   SET period_start = (SELECT max(c2.finalized_at) FROM amusement_collection_items i2
                       JOIN amusement_collections c2 ON c2.id = i2.collection_id AND c2.status = 'final'
                       WHERE i2.game_id = i.game_id AND c2.finalized_at < c.finalized_at)
  FROM amusement_collections c
 WHERE c.id = i.collection_id AND c.status = 'final' AND i.period_start IS NULL;
