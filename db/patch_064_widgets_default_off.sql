-- patch_064: a manager's widgets start OFF; the owner turns on what each
-- one should see (Scotto, Oct 2026). The owner's own home always shows all.
ALTER TABLE home_lines ALTER COLUMN alerts SET DEFAULT false, ALTER COLUMN network SET DEFAULT false, ALTER COLUMN bar SET DEFAULT false, ALTER COLUMN kitchen SET DEFAULT false,
  ALTER COLUMN coolers SET DEFAULT false, ALTER COLUMN applicants SET DEFAULT false, ALTER COLUMN games SET DEFAULT false, ALTER COLUMN service_calls SET DEFAULT false,
  ALTER COLUMN bar_sales SET DEFAULT false, ALTER COLUMN bar_labor SET DEFAULT false, ALTER COLUMN bar_staff SET DEFAULT false,
  ALTER COLUMN kitchen_sales SET DEFAULT false, ALTER COLUMN kitchen_labor SET DEFAULT false, ALTER COLUMN kitchen_staff SET DEFAULT false;
