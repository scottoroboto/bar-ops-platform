-- patch_050 — ID numbers on the light plugs (Scotto, 2026-10-01): T1-001,
-- T1-002, ... per bar, for a sticker on each plug and sign. A plug gets its
-- number when it's named (Find plugs → Blink → name), so plugs set aside as
-- "Not a sign" don't use one up. Numbers count up per bar and aren't reused
-- after a plug is deleted. The owner can retype one in TV Admin → Lights.
--
--   vc_sites.plug_tag_prefix  'T1', 'T2' (from the bar's name)
--   vc_sites.plug_tag_next    the next number to hand out
--   vc_plugs.tag              'T1-001'; unique per bar

ALTER TABLE vc_sites ADD COLUMN IF NOT EXISTS plug_tag_prefix TEXT;
ALTER TABLE vc_sites ADD COLUMN IF NOT EXISTS plug_tag_next INT NOT NULL DEFAULT 1;
UPDATE vc_sites s SET plug_tag_prefix = 'T' || substring(l.name from '(\d+)\s*$')
  FROM locations l
 WHERE l.id = s.location_id AND s.plug_tag_prefix IS NULL AND l.name ~* '^ticket\s*\d+\s*$';

ALTER TABLE vc_plugs ADD COLUMN IF NOT EXISTS tag TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS vc_plugs_site_tag ON vc_plugs (site_id, tag) WHERE tag IS NOT NULL;

-- Plugs already named get numbers in the order they were set up.
WITH numbered AS (
  SELECT p.id, p.site_id,
         (SELECT count(*) FROM vc_plugs t WHERE t.site_id = p.site_id AND t.tag IS NOT NULL)
           + row_number() OVER (PARTITION BY p.site_id ORDER BY p.created_at, p.id) AS n
    FROM vc_plugs p
   WHERE p.tag IS NULL AND p.name IS NOT NULL
)
UPDATE vc_plugs p
   SET tag = COALESCE(s.plug_tag_prefix, 'P') || '-' || lpad(x.n::text, 3, '0')
  FROM numbered x JOIN vc_sites s ON s.id = x.site_id
 WHERE p.id = x.id;

UPDATE vc_sites s
   SET plug_tag_next = GREATEST(s.plug_tag_next,
         (SELECT count(*) + 1 FROM vc_plugs p WHERE p.site_id = s.id AND p.tag IS NOT NULL));
