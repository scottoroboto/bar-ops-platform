-- patch_066: the Critical Systems widget is gone (Oct 2026). The home
-- screen's Network widget (home_lines.network) replaced it for the owner,
-- managers and maintenance, so the per-bar grants it used are no longer
-- read anywhere. Scotto runs the DROP in the Supabase SQL editor.
DROP TABLE IF EXISTS network_status_access;
