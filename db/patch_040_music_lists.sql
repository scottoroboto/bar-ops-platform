-- patch_040 — Music favorites lists (Scotto, 2026-09-29). Each bar's staff
-- can keep a named list of stations (Scott, Mindy, Barry) picked from the
-- Sonos favorites the box plays; lists are per site and never copied
-- between bars. Deleting a list or hiding a station from the main list is
-- soft (deleted_at / a hidden row) so it shows under "Deleted" on the iPad;
-- only the owner empties those for good.
CREATE TABLE IF NOT EXISTS vc_music_lists (
  id          BIGSERIAL PRIMARY KEY,
  site_id     BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  stations    JSONB NOT NULL DEFAULT '[]'::JSONB,   -- [{ uri, title }]
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS vc_music_lists_live_name ON vc_music_lists (site_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS vc_music_lists_site ON vc_music_lists (site_id);

CREATE TABLE IF NOT EXISTS vc_music_hidden_stations (
  id          BIGSERIAL PRIMARY KEY,
  site_id     BIGINT NOT NULL REFERENCES vc_sites(id) ON DELETE CASCADE,
  uri         TEXT NOT NULL,
  title       TEXT,
  hidden_by   TEXT,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id, uri)
);
