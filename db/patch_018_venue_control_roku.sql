-- Venue Control — Phase 6 (docs/venue-control.md §12: "Roku and spares. ECP
-- driver, app launching, spare slot handling.") No new tables or columns:
-- vc_sources already models Roku generically via `kind` (patch_016's own
-- CHECK already allows 'roku','static','spare' alongside 'directv', and
-- `ip`/`port` already exist for any kind of device) and vc_layout_items'
-- freeform `action` JSONB already accepts a Roku launch action the same way
-- it accepts a DirecTV tune action -- see agent/lib/layouts.js's runOneItem
-- for the {op:'launch', app_id} shape mirroring {op:'tune', major, minor}.
--
-- The one real schema gap: vc_schedules.action_type's CHECK constraint
-- (patch_016) only allowed ('tvs_power','apply_layout','source_tune') --
-- scheduling a Roku app launch (agent/lib/scheduler.js's new
-- runSourceLaunch(), mirroring runSourceTune()) needs 'source_launch' added
-- to that list. Postgres has no ALTER CONSTRAINT for a CHECK's expression,
-- so this drops and recreates it by name rather than ALTER TABLE ... ADD
-- COLUMN-style extension.
--
-- Applied live via mcp__Supabase__apply_migration, then pushed here for the
-- record (same pattern as patch_017).

ALTER TABLE vc_schedules DROP CONSTRAINT vc_sched_action_chk;

ALTER TABLE vc_schedules ADD CONSTRAINT vc_sched_action_chk CHECK (action_type IN
  ('tvs_power','apply_layout','source_tune','source_launch'));
