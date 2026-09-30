-- patch_047 — Drawer counts per bar and the bank bag's name (Scotto,
-- 2026-09-30): "T1 has 3 cash drawers, T2 has 5 cash drawers, each have
-- 1 bank bag."
--
-- T1: Cash Drawer 4 retired (never counted; Manage sources can bring it
--     back). T2: Cash Drawer 5 added, same $400 start and audit pools as
--     the others. Every bar's single bag (patch_046's "Change Bag") is
--     the Bank Bag, and it rides the weekly audit like the old bags did.

UPDATE cash_sources s SET active = false
FROM locations l
WHERE l.id = s.location_id AND l.name = 'Ticket 1' AND s.kind = 'drawer' AND s.name = 'Cash Drawer 4' AND s.active;

INSERT INTO cash_sources (location_id, name, kind, target_amount, sort_order, include_weekly_audit, include_random_audit)
SELECT l.id, 'Cash Drawer 5', 'drawer', 400, 15, true, true
FROM locations l WHERE l.name = 'Ticket 2'
ON CONFLICT (location_id, name) DO UPDATE SET active = true;

UPDATE cash_sources SET name = 'Bank Bag', include_weekly_audit = true
WHERE kind = 'backup_bag' AND name = 'Change Bag';
