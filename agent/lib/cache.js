// The agent's local SQLite mirror (docs/venue-control.md §4/§6: "the agent
// holds no unique state" -- Supabase is the source of truth, this is purely
// an offline cache so the box still works through an ISP outage).
//
// Phase 0 only needs a generic key/value store (registration info, the
// pulled site config, sync timestamps) so the agent remembers who it is
// across restarts. Phase 1+ will add real tables here for sources/tvs/etc.
// as those start getting cached locally too.
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.CACHE_DB_PATH || path.join(__dirname, '..', 'agent-cache.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const getStmt = db.prepare('SELECT value FROM kv WHERE key = ?');
const setStmt = db.prepare(`
  INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

function get(key) {
  const row = getStmt.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function set(key, value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  setStmt.run(key, json);
}

module.exports = { get, set };
