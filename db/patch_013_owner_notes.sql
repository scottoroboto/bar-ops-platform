-- =====================================================================
-- Patch 013 — Owner notes (a small owner-editable memo box), first used
-- next to Pay rate requests: "a memo directing managers not to discuss
-- raises with employees until submitting requests. Or a text box next to
-- it I can make my own memos." A text box the owner controls covers both
-- asks and is reusable anywhere else a short standing note is useful, so
-- it's a generic key/body table rather than a pay-rate-specific column.
--
-- Written exclusively through withServiceClient with the role check in
-- the Express route handler (read: manager/owner; write: owner only) —
-- same reasoning as monitoring_alert_routes/monitoring_notify_settings,
-- so FORCE + zero policies for barplatform_app.
-- =====================================================================
CREATE TABLE owner_notes (
  note_key    text PRIMARY KEY,
  body        text NOT NULL DEFAULT '',
  updated_by  uuid REFERENCES people(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE owner_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_notes FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON owner_notes TO barplatform_app, barplatform_service;

-- Seed the pay-rate-requests memo with a sensible default so managers see
-- something useful on day one, before the owner has had a chance to write
-- their own wording.
INSERT INTO owner_notes (note_key, body)
VALUES ('pay_rate_requests', 'Please don''t discuss a raise with an employee until after you''ve submitted the request here and it''s been decided.');
