-- =====================================================================
-- Patch 024 — Cash Handling Phase 2: transactions (deposits, bank change,
-- transfers, cash drops, adjustments) with optional receipt/deposit-slip
-- photos.
--
-- Money moves between a cash_sources row and either another cash_sources
-- row or the bank ("external"), or is corrected in place via an
-- adjustment. Which combination of from/to is valid for a given `type`
-- (e.g. a deposit always has a source `from` and 'bank' `to`) is
-- deliberately NOT encoded here as a big CHECK — that shape validation
-- lives in server/cashhandling.js (validateTransactionShape), same
-- reasoning as keeping cash_counts' context-specific rules in JS: the
-- rules are about *business meaning*, not just structural validity, and
-- are easier to read/change/test in one place in JS than as a wall of SQL
-- CHECK clauses. What IS enforced here structurally: each side (from/to)
-- is at most one of "a real cash source" or "external (the bank)", never
-- both, and never a source that also claims to be external.
--
-- Same zero-policy FORCE RLS posture as cash_sources/cash_counts —
-- barplatform_app has no policies on this table at all, every access
-- goes through withServiceClient with authorization in Express.
-- =====================================================================

CREATE TABLE cash_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES locations(id),
  type            text NOT NULL
                    CHECK (type IN ('deposit','bank_change','transfer','cash_drop','adjustment')),

  from_source_id  uuid REFERENCES cash_sources(id),
  from_external   text CHECK (from_external IN ('bank')),
  to_source_id    uuid REFERENCES cash_sources(id),
  to_external     text CHECK (to_external IN ('bank')),
  CHECK (from_source_id IS NULL OR from_external IS NULL),
  CHECK (to_source_id IS NULL OR to_external IS NULL),

  amount          numeric(10,2) NOT NULL CHECK (amount > 0),
  reason          text,                                       -- required (in app layer) for 'adjustment'
  receipt_path    text,                                        -- Supabase Storage object path in the cash-receipts
                                                                 -- bucket; never a public URL — see server/storage.js
  performed_by    uuid NOT NULL REFERENCES people(id),
  performed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cash_transactions_location_time ON cash_transactions(location_id, performed_at DESC);
CREATE INDEX idx_cash_transactions_from_source ON cash_transactions(from_source_id) WHERE from_source_id IS NOT NULL;
CREATE INDEX idx_cash_transactions_to_source ON cash_transactions(to_source_id) WHERE to_source_id IS NOT NULL;

ALTER TABLE cash_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_transactions FORCE ROW LEVEL SECURITY;
-- Deliberately zero policies — see header note.

GRANT SELECT, INSERT, UPDATE, DELETE ON cash_transactions TO barplatform_app, barplatform_service;
