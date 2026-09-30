-- patch_045 — ATM ledger (Scotto, 2026-09-30).
--
-- An ATM isn't a drawer: customers take cash out that the app never
-- sees, so "expected" from counts and transactions is meaningless. The
-- only numbers that matter are the ones the machine prints:
--
--   load       a manager/staff member adds $20s brought from the bank.
--              Receipt before (balance_before), amount keyed in
--              (amount_added), receipt after (balance_after), a photo of
--              each receipt.
--   balance    a balance receipt on its own (month-end, spot check, and
--              every cassette audit), balance_after + photo.
--   statement  the owner's monthly processor statement: period and total
--              withdrawn, photo of the statement. Reconciled on read
--              against the balance receipts nearest the period edges.
--
-- The tile shows the latest receipt balance and never over/short. Only a
-- cassette audit (cash_counts, expected = that moment's receipt balance)
-- can show a variance.
--
-- RLS: ENABLE + FORCE with no policies, like every cash table; access
-- goes through withServiceClient and is enforced in the route handlers.

CREATE TABLE IF NOT EXISTS cash_atm_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      uuid NOT NULL REFERENCES cash_sources(id),
  location_id    uuid NOT NULL REFERENCES locations(id),
  kind           text NOT NULL CHECK (kind IN ('load', 'balance', 'statement')),
  balance_before numeric(12,2),
  amount_added   numeric(12,2),
  balance_after  numeric(12,2),
  period_start   date,
  period_end     date,
  withdrawn      numeric(12,2),
  photo_path     text,
  photo2_path    text,
  note           text,
  count_id       uuid REFERENCES cash_counts(id),  -- set when a cassette audit produced this balance reading
  entered_by     uuid NOT NULL REFERENCES people(id),
  entered_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'load' OR (balance_before IS NOT NULL AND amount_added > 0 AND balance_after IS NOT NULL)),
  CHECK (kind <> 'balance' OR balance_after IS NOT NULL),
  CHECK (kind <> 'statement' OR (period_start IS NOT NULL AND period_end >= period_start AND withdrawn >= 0))
);
CREATE INDEX IF NOT EXISTS cash_atm_entries_source_idx ON cash_atm_entries (source_id, entered_at DESC);

ALTER TABLE cash_atm_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_atm_entries FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON cash_atm_entries TO barplatform_app, barplatform_service;

-- Any cash-out count already logged on an ATM (patch_044's short-lived
-- flow: T2's first $280) becomes that ATM's first balance reading.
INSERT INTO cash_atm_entries (source_id, location_id, kind, balance_after, photo_path, note, entered_by, entered_at)
SELECT cc.source_id, cs.location_id, 'balance', cc.counted_amount, cc.receipt_path, cc.note, cc.counted_by, cc.counted_at
FROM cash_counts cc JOIN cash_sources cs ON cs.id = cc.source_id
WHERE cs.is_atm AND cc.context = 'cash_out'
  AND NOT EXISTS (SELECT 1 FROM cash_atm_entries e WHERE e.source_id = cc.source_id AND e.entered_at = cc.counted_at);
