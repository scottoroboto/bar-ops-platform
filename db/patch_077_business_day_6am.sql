-- patch_077: the business day rolls over at 6am (Scotto, 2026-10-18:
-- bartenders stay late for inventory). Sales, punches and the forecast
-- count everything up to 6am toward the night before; the bar's box
-- takes the hour from here (GET /api/venue/agent/kitchen/have).
ALTER TABLE kb_settings ALTER COLUMN day_start_hour SET DEFAULT 6;
UPDATE kb_settings SET day_start_hour = 6;
