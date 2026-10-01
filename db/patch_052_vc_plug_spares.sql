-- patch_052 — Spare plugs (Scotto, 2026-10-01). A spare has its ID number
-- and is known to the box, but isn't on a sign yet: it's left off the iPad
-- Lights page, ALL ON / ALL OFF, and routines, so one sitting in a drawer
-- doesn't show up as NO ANSWER. TV Admin can still Blink it. Untick Spare
-- (and name it) when it goes on a sign.

ALTER TABLE vc_plugs ADD COLUMN IF NOT EXISTS spare BOOLEAN NOT NULL DEFAULT FALSE;

-- The two set up today as "Spare" (T1-016, T1-017).
UPDATE vc_plugs SET spare = TRUE, schedule_mode = 'none', routine_id = NULL, updated_at = now()
 WHERE lower(trim(name)) = 'spare' AND NOT spare;
