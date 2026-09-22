-- =====================================================================
-- patch_035 — "TV Staff" becomes an app-access toggle (Scotto, 2026-09-22:
-- "It really should only go on the location's iPad and maybe manager").
--
-- Until now the TV Staff tile showed for every manager and owner plus the
-- bar's trusted iPad. Now: the owner always; the trusted iPad always (it
-- is the bar's shared device); everyone else only when 'tv_staff' is
-- switched on for them in Employees — same switch as every other app.
-- Off for everyone to start with, so nobody gains access by this patch.
-- =====================================================================
ALTER TABLE employee_apps DROP CONSTRAINT employee_apps_app_key_check;
ALTER TABLE employee_apps ADD CONSTRAINT employee_apps_app_key_check
  CHECK (app_key IN ('time_clock','service_calls','scheduling','monitoring','employees','cash_handling','inventory_control','tv_staff'));
