-- patch_046 — Shift counts from the bar iPad (Scotto, 2026-09-30).
--
-- "Cash Out" on the bar's trusted iPad: a bartender picks their name,
-- enters their PIN, and logs an opening or closing count. Nothing is
-- shown back to them except, at closing, how much to drop.
--
--   opening   every drawer counted and entered. Checked against the
--             drawer's ledger balance (last count + transactions since).
--   closing   pre-close stations are balanced to their $400 start and
--             entered (checked against $400); the change bag is counted
--             down to tonight's amount (checked against it); the closing
--             station, which holds every station's excess or shortage
--             after the POS transfer, is counted whole. Over $400, the
--             excess is logged as a cash drop into the Drop Safe with the
--             POS cash-out report. Under $400 it just stays short until a
--             manager tops it up (a normal transfer).
--
-- A count off by more than the alert threshold notifies the bar's
-- managers and the owner and shows on the dashboard.
--
-- RLS: ENABLE + FORCE with no policies on the new tables, like every cash
-- table; everything goes through withServiceClient.

-- Counts logged from the iPad carry their own contexts.
ALTER TABLE cash_counts DROP CONSTRAINT IF EXISTS cash_counts_context_check;
ALTER TABLE cash_counts ADD CONSTRAINT cash_counts_context_check
  CHECK (context IN ('cash_out','weekly_audit','manual_random_audit','system_random_audit','opening','closing'));

-- Bills a source holds, when it's not everything (the change bag: $5s
-- and $1s). NULL = any denomination.
ALTER TABLE cash_sources ADD COLUMN IF NOT EXISTS denominations numeric(8,2)[];
-- The change bag's amount by business day, Sunday first (7 entries).
-- NULL or a missing/zero entry falls back to target_amount.
ALTER TABLE cash_sources ADD COLUMN IF NOT EXISTS day_targets numeric(10,2)[];

-- One-off bag amounts for special events, by business date.
CREATE TABLE IF NOT EXISTS cash_bag_event_targets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid NOT NULL REFERENCES cash_sources(id),
  business_date date NOT NULL,
  amount        numeric(10,2) NOT NULL CHECK (amount >= 0),
  label         text,
  created_by    uuid REFERENCES people(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, business_date)
);

-- One opening or closing submitted from the iPad.
CREATE TABLE IF NOT EXISTS cash_shift_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         uuid NOT NULL REFERENCES locations(id),
  kind                text NOT NULL CHECK (kind IN ('opening', 'closing')),
  person_id           uuid NOT NULL REFERENCES people(id),
  device_id           uuid REFERENCES devices(id),
  business_date       date NOT NULL,             -- before 6am counts as the night before
  closing_source_id   uuid REFERENCES cash_sources(id),
  drop_amount         numeric(10,2),
  drop_transaction_id uuid REFERENCES cash_transactions(id),
  flagged_count       int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_shift_sessions_location_idx ON cash_shift_sessions (location_id, created_at DESC);

ALTER TABLE cash_counts ADD COLUMN IF NOT EXISTS shift_session_id uuid REFERENCES cash_shift_sessions(id);
-- 'opening' | 'pre_close' | 'bag' | 'closing_station'
ALTER TABLE cash_counts ADD COLUMN IF NOT EXISTS shift_role text;

-- One row: how far off a shift count may be before managers hear about it.
CREATE TABLE IF NOT EXISTS cash_shift_settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  alert_threshold numeric(10,2) NOT NULL DEFAULT 5 CHECK (alert_threshold >= 0),
  updated_by      uuid REFERENCES people(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cash_shift_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE cash_bag_event_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_bag_event_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_shift_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_shift_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE cash_shift_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_shift_settings FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON cash_bag_event_targets, cash_shift_sessions, cash_shift_settings
  TO barplatform_app, barplatform_service;

-- ---------------------------------------------------------------------
-- Data (every bar that has drawers).
-- ---------------------------------------------------------------------
-- Drawers start every shift at $400.
UPDATE cash_sources SET target_amount = 400 WHERE kind = 'drawer' AND target_amount = 0;

-- One change bag per bar ($5s and $1s) replaces the per-drawer backup
-- bags. The old bags are retired, not deleted (Manage sources can bring
-- them back).
INSERT INTO cash_sources (location_id, name, kind, denominations, sort_order)
SELECT DISTINCT d.location_id, 'Change Bag', 'backup_bag', ARRAY[5, 1]::numeric(8,2)[], 50
FROM cash_sources d
WHERE d.kind = 'drawer'
ON CONFLICT (location_id, name) DO NOTHING;
UPDATE cash_sources SET active = false WHERE kind = 'backup_bag' AND name <> 'Change Bag' AND active;

-- Where closing drops go: the slotted drop safe, with the POS report.
INSERT INTO cash_sources (location_id, name, kind, sort_order)
SELECT DISTINCT d.location_id, 'Drop Safe', 'fixed_point', 60
FROM cash_sources d
WHERE d.kind = 'drawer'
ON CONFLICT (location_id, name) DO NOTHING;
