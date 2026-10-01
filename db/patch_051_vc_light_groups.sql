-- patch_051 — Saved light-plug groups (Scotto, 2026-10-01). Each bar keeps
-- the groups it has used (Main Bar, Entry, Front Windows, ...) so TV Admin
-- offers them in a list when naming or editing a plug, with "New group…"
-- to add one. A group stays on the list after its last plug moves out,
-- until it's removed from the list in TV Admin.

ALTER TABLE vc_sites ADD COLUMN IF NOT EXISTS light_groups TEXT[] NOT NULL DEFAULT '{}';

UPDATE vc_sites s
   SET light_groups = (
     SELECT COALESCE(array_agg(g ORDER BY lower(g)), '{}')
       FROM (SELECT DISTINCT unnest(s.light_groups) AS g
             UNION
             SELECT DISTINCT p.group_name FROM vc_plugs p WHERE p.site_id = s.id AND p.group_name IS NOT NULL) x
   );
