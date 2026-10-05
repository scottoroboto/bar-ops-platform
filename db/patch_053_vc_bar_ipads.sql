-- patch_053 — Bar iPads (Scotto, 2026-10-05). The iPad behind the bar stays
-- signed in to the TV pages for good: no daily trip through Bar Ops. The
-- owner sets one up from TV Admin on the iPad itself; it gets a permanent
-- pass (signed with the site's agent token hash like every TV pass) that
-- carries this row's id. Removing it here sends the id down to the box in
-- the agent config, and the box refuses that pass from then on.
-- Activity shows the iPad's name ("T1-Main Bar"). Cash Out still asks each
-- person for their PIN. Regenerating the agent token also ends every pass.

CREATE TABLE IF NOT EXISTS vc_bar_ipads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  revoked_by  TEXT
);
CREATE INDEX IF NOT EXISTS vc_bar_ipads_site ON vc_bar_ipads (site_id);

ALTER TABLE vc_bar_ipads ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_bar_ipads FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON vc_bar_ipads TO barplatform_app, barplatform_service;
