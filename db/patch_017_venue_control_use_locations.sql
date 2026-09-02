-- Venue Control — reconcile vc_sites with the platform's existing
-- `locations` table (Scotto's explicit call, 2026-09-02: "Run it live.
-- Use current location scheme."), applied before any real vc_sites rows
-- existed (0 rows at the time of this migration — patch_016 had just been
-- applied moments earlier with zero data ever written to these tables).
--
-- Deviates from docs/venue-control.md §5, which modeled vc_sites as its own
-- standalone identity (slug/name), duplicating the platform's existing
-- `locations` concept with no FK between them. That mismatch was flagged as
-- an open question in patch_016's own header comment; this migration is the
-- resolution Scotto chose. docs/venue-control.md is left as an unmodified,
-- verbatim copy of the original uploaded spec — this deviation is recorded
-- here and in claude/project-status.md instead, per the standing "repo wins
-- over spec, log every place they differ" discipline for this feature.
--
-- vc_sites.location_id -> locations(id) is a 1:1 link (UNIQUE): "a Venue
-- Control site is a location," not a separate namespace. locations.id is
-- uuid (see db/schema.sql), unrelated to vc_sites' own bigint PK used by
-- every other vc_* table's FK chain (vc_agents.site_id, vc_zones.site_id,
-- etc.) — those are untouched by this migration; only vc_sites' own
-- identity columns change.
--
-- Also corrects vc_sites.timezone's default from the spec's
-- 'America/Los_Angeles' to this platform's actual business timezone,
-- 'America/Chicago' (see BUSINESS_TZ in server/scheduling.js /
-- server/timeclock.js) — the spec's default never matched this app's real
-- timezone and was never exercised since no site rows existed yet.
--
-- Applied live via mcp__Supabase__apply_migration on 2026-09-02, then
-- pushed here for the record (same pattern as patch_015).

ALTER TABLE vc_sites
  ADD COLUMN location_id uuid REFERENCES locations(id) ON DELETE CASCADE;

ALTER TABLE vc_sites
  ADD CONSTRAINT vc_sites_location_id_unique UNIQUE (location_id);

ALTER TABLE vc_sites
  ALTER COLUMN location_id SET NOT NULL;

ALTER TABLE vc_sites DROP CONSTRAINT vc_sites_slug_key;
ALTER TABLE vc_sites DROP COLUMN slug;
ALTER TABLE vc_sites DROP COLUMN name;

ALTER TABLE vc_sites ALTER COLUMN timezone SET DEFAULT 'America/Chicago';
