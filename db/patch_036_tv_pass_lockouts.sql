-- =====================================================================
-- patch_036 — TV Staff passes, timed grants, sign-in lockouts
-- (Scotto, 2026-09-22: "there really shouldn't be a pin at all").
--
-- 1. employee_apps.expires_at — a timed grant: the switch turns itself
--    off at this time. NULL = permanent, as every existing row is.
-- 2. people.* lock columns — five wrong PINs lock the PIN (self-serve:
--    sign in with the password, set a new PIN); five wrong passwords
--    lock the account until the owner resets it. The owner's own account
--    only cools down for 15 minutes so nobody can lock the owner out.
-- The TV Staff pass length lives in owner_notes ('tv_pass_length'), no
-- column needed.
-- =====================================================================
ALTER TABLE employee_apps ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS pin_failed_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_at         timestamptz,
  ADD COLUMN IF NOT EXISTS password_failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS password_locked_at    timestamptz;
