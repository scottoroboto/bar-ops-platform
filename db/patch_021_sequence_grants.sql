-- Fixes a permission gap that predates this round: the ALTER DEFAULT
-- PRIVILEGES set up early in this project (see db/schema.sql's "TWO
-- APP-LEVEL ROLES" section) granted barplatform_app/barplatform_service
-- SELECT/INSERT/UPDATE/DELETE on future TABLES, but the matching default
-- grant for future SEQUENCES only ever covered postgres/service_role --
-- so every BIGSERIAL id column's sequence in this schema has been
-- missing USAGE for the app's own roles. Table-level INSERT still needs
-- sequence USAGE to satisfy a column's nextval() default, so any INSERT
-- that lets the id column default (i.e. doesn't supply an id explicitly)
-- has been failing with "permission denied for sequence ..." the whole
-- time this app has run those roles.
--
-- This went unnoticed because most INSERT paths in this project were
-- verified through the mock harness (sample data, no live write) rather
-- than a real write against production -- discovered only now because
-- venue-control-preview's agent made this project's first-ever live
-- POST /api/venue/agent/register call, which INSERTs into vc_agents.
-- The same gap would have silently broken this round's own
-- vc_agent_commands INSERT the first time "Scan network" was clicked.
--
-- Two parts: backfill USAGE on every sequence that's missing it today,
-- and fix the default-privilege rule so every table created after this
-- one keeps working without needing this patch repeated.

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO barplatform_app, barplatform_service;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO barplatform_app, barplatform_service;
