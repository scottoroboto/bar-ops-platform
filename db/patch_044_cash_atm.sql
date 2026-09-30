-- patch_044 — ATM counts (Scotto, 2026-09-30, first T2 ATM count).
-- 1. An ATM is a fixed cash point that only holds $20s and prints a
--    balance receipt; is_atm drives a $20-only counter and a required
--    photo of that receipt on every cash-out count.
-- 2. The receipt photo rides on the count itself (cash_counts.receipt_path,
--    same cash-receipts bucket and <location>/<id>.<ext> layout as
--    transaction receipts).
ALTER TABLE cash_sources ADD COLUMN IF NOT EXISTS is_atm boolean NOT NULL DEFAULT false;
ALTER TABLE cash_counts  ADD COLUMN IF NOT EXISTS receipt_path text;
UPDATE cash_sources SET is_atm = true WHERE kind = 'fixed_point' AND name ILIKE '%atm%';
