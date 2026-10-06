-- patch_057: kitchen board for managers is the owner's call (Oct 2026)
--
-- Managers get the board itself (the same screen as the kitchen TV), not
-- its settings; the owner turns that on or off per location here. The
-- settings page and TV links are owner-only from now on.
ALTER TABLE kb_settings ADD COLUMN IF NOT EXISTS managers_can_view boolean NOT NULL DEFAULT true;
