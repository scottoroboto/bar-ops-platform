-- patch_060: the home screen's "Right now" block per manager (Oct 2026)
--
-- The owner's home shows each bar as one block: NETWORK, a BAR line and a
-- Kitchen line (sales, labor, staff) each ending in a coolers button. A
-- manager gets the same block for their bar, but the owner decides which
-- lines they see: a kitchen manager gets only the Kitchen line. No row =
-- everything on.
CREATE TABLE IF NOT EXISTS home_lines (
  person_id  uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  network    boolean NOT NULL DEFAULT true,
  bar        boolean NOT NULL DEFAULT true,
  kitchen    boolean NOT NULL DEFAULT true,
  coolers    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES people(id)
);
ALTER TABLE home_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE home_lines FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON home_lines TO barplatform_service;
