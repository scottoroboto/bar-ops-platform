-- Security fix: service_call_destinations, service_call_destination_members,
-- and service_call_recipients had RLS fully disabled (relrowsecurity = false),
-- unlike every other "open reference data" table in this app (schedules,
-- shifts, owner_notes, monitoring_alert_routes, equipment_types, locations,
-- etc.), which all use the established pattern of RLS ENABLED + FORCED with
-- zero policies (deny-all to anon/authenticated; the app's own
-- barplatform_service role has BYPASSRLS and is unaffected either way).
--
-- Flagged by Supabase's own security advisor (get_advisors, 2026-09-02) and
-- confirmed directly via pg_class.relrowsecurity. Since barplatform_service
-- (used by server/servicecalls.js for all three tables) has BYPASSRLS=true,
-- this migration is purely a security tightening with zero effect on app
-- behavior -- it only closes the gap for Supabase's own anon/authenticated
-- roles, which this app's Express layer never uses for these tables anyway.
--
-- Applied live via mcp__Supabase__apply_migration on 2026-09-02; this file is
-- the on-disk record of that change, per this repo's db/patch_0NN_*.sql
-- convention (each patch is additive/idempotent-in-spirit, matching prior
-- patches).

ALTER TABLE public.service_call_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_call_destinations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.service_call_destination_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_call_destination_members FORCE ROW LEVEL SECURITY;

ALTER TABLE public.service_call_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_call_recipients FORCE ROW LEVEL SECURITY;
