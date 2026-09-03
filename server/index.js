require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { pool, withServiceClient } = require('./db');
const auth = require('./auth');
const employees = require('./employees');
const timeclock = require('./timeclock');
const servicecalls = require('./servicecalls');
const monitoring = require('./monitoring');
const scheduling = require('./scheduling');
const notify = require('./notify');
const jotform = require('./jotform');
const resetRequests = require('./resetRequests');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------------- Status ----------------
app.get('/api/status', (req, res) => {
res.json({ ok: true, emailConfigured: notify.emailConfigured(), smsConfigured: notify.smsConfigured() });
});

app.get('/api/locations', async (req, res) => {
const { rows } = await pool.query('SELECT * FROM locations WHERE active = true ORDER BY name');
res.json(rows);
});

// Admin view — includes archived locations too, so the owner can restore
// one. Everyday reads (apply.html, review dropdowns, etc.) use the public
// active-only route above instead.
app.get('/api/locations/admin', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await pool.query('SELECT * FROM locations ORDER BY active DESC, name');
res.json(rows);
});

// Locations are owner-only to add/rename/archive — per Scotto: the owner
// is the one who decides what counts as a real location. Managers manage
// positions instead (below).
// Writes below go through withServiceClient (bypasses RLS via the
// barplatform_service role) rather than the plain pool. locations/positions
// only have an open SELECT policy for barplatform_app — reads work fine
// through the ordinary pool, but RLS is FORCE-enabled with no INSERT/
// UPDATE/DELETE policy, so a write on the plain app connection is silently
// rejected (or matches zero rows). Authorization is still enforced right
// here in the handler, same as everywhere else service-client writes are used.
app.post('/api/locations', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can add a location.' });
const name = (req.body.name || '').trim();
if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
try {
const location = await withServiceClient(async (client) => {
const { rows } = await client.query('INSERT INTO locations (name) VALUES ($1) RETURNING *', [name]);
return rows[0];
});
res.json({ ok: true, location });
} catch (e) {
if (e.code === '23505') return res.status(400).json({ ok: false, error: 'A location with that name already exists.' });
throw e;
}
});

app.post('/api/locations/:id/update', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can rename a location.' });
const name = (req.body.name || '').trim();
if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
try {
const location = await withServiceClient(async (client) => {
const { rows } = await client.query('UPDATE locations SET name = $1 WHERE id = $2 RETURNING *', [name, req.params.id]);
return rows[0];
});
if (!location) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, location });
} catch (e) {
if (e.code === '23505') return res.status(400).json({ ok: false, error: 'A location with that name already exists.' });
throw e;
}
});

// Archive/restore rather than delete — a location can be referenced by
// years of time-clock and service-call history; hard-deleting it would
// either cascade-destroy that history or fail on the foreign key. Archived
// locations just drop out of the active dropdowns everywhere else.
app.post('/api/locations/:id/archive', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can archive a location.' });
const location = await withServiceClient(async (client) => {
const { rows } = await client.query('UPDATE locations SET active = false WHERE id = $1 RETURNING *', [req.params.id]);
return rows[0];
});
if (!location) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, location });
});

app.post('/api/locations/:id/restore', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can restore a location.' });
const location = await withServiceClient(async (client) => {
const { rows } = await client.query('UPDATE locations SET active = true WHERE id = $1 RETURNING *', [req.params.id]);
return rows[0];
});
if (!location) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, location });
});

// ---------------- Positions ----------------
// Public, active-only — used by /apply.html's "Position Applied for"
// dropdown (?excludeManagement=true, nobody self-applies to be a manager)
// and by the Review employee dropdown (no filter, managers can review
// someone straight into a management position).
app.get('/api/positions', async (req, res) => {
const excludeManagement = req.query.excludeManagement === 'true';
const { rows } = await pool.query(
`SELECT * FROM positions WHERE active = true ${excludeManagement ? 'AND is_management = false' : ''} ORDER BY name`
);
res.json(rows);
});

// Admin view — includes archived positions too, so a manager/owner can
// restore one.
app.get('/api/positions/admin', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const { rows } = await pool.query('SELECT * FROM positions ORDER BY active DESC, name');
res.json(rows);
});

// Positions are manager+owner — per Scotto, managers should be able to
// add positions themselves (this'll likely move into the Scheduling app
// once that exists; for now it lives here in Employees admin).
app.post('/api/positions', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const name = (req.body.name || '').trim();
if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
try {
const position = await withServiceClient(async (client) => {
const { rows } = await client.query(
'INSERT INTO positions (name, is_management) VALUES ($1,$2) RETURNING *',
[name, !!req.body.isManagement]
);
return rows[0];
});
res.json({ ok: true, position });
} catch (e) {
if (e.code === '23505') return res.status(400).json({ ok: false, error: 'A position with that name already exists.' });
throw e;
}
});

app.post('/api/positions/:id/update', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const name = (req.body.name || '').trim();
if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
try {
const position = await withServiceClient(async (client) => {
const { rows } = await client.query(
'UPDATE positions SET name = $1, is_management = $2 WHERE id = $3 RETURNING *',
[name, !!req.body.isManagement, req.params.id]
);
return rows[0];
});
if (!position) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, position });
} catch (e) {
if (e.code === '23505') return res.status(400).json({ ok: false, error: 'A position with that name already exists.' });
throw e;
}
});

// Archive/restore rather than delete — position is stored as plain text
// on people.position (not a foreign key), so archiving never orphans a
// historical employee record; it just drops the position out of future
// dropdowns.
app.post('/api/positions/:id/archive', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const position = await withServiceClient(async (client) => {
const { rows } = await client.query('UPDATE positions SET active = false WHERE id = $1 RETURNING *', [req.params.id]);
return rows[0];
});
if (!position) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, position });
});

app.post('/api/positions/:id/restore', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const position = await withServiceClient(async (client) => {
const { rows } = await client.query('UPDATE positions SET active = true WHERE id = $1 RETURNING *', [req.params.id]);
return rows[0];
});
if (!position) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, position });
});

// ---------------- Auth ----------------
app.post('/api/auth/login-password', async (req, res) => {
const result = await auth.loginWithPassword(req.body);
res.json(result);
});
app.post('/api/auth/verify-code', async (req, res) => {
const result = await auth.verifyFirstLoginCode(req.body);
res.json(result);
});
app.post('/api/auth/login-pin', async (req, res) => {
const result = await auth.loginWithPin(req.body);
res.json(result);
});
app.post('/api/auth/step-up', async (req, res) => {
const result = await auth.stepUp(req.body);
res.json(result);
});
app.post('/api/auth/set-pin', auth.requireSession('full'), async (req, res) => {
const result = await auth.setPin({ personId: req.person.id, pin: req.body.pin });
res.json(result);
});
// Self-service password change — same trust boundary as set-pin above,
// just for the full credential instead of the everyday one. requireSession
// already forces a fresh full login or step-up before this is reachable,
// so no separate "current password" field is needed on the client side.
app.post('/api/auth/set-password', auth.requireSession('full'), async (req, res) => {
const password = req.body.password || '';
if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password needs to be at least 8 characters.' });
const result = await auth.setPassword({ personId: req.person.id, password });
res.json(result);
});
app.get('/api/auth/me', auth.requireSession('light'), async (req, res) => {
const access = await req.withAuthedClient(async (client) => {
const { rows } = await client.query('SELECT app_key, enabled FROM employee_apps WHERE person_id = $1', [req.person.id]);
return rows;
});
res.json({ person: req.person, appAccess: access });
});

// Public, unauthenticated — the whole point is this works for someone who
// can't log in. Owner-mediated fallback: files a request, the owner
// reviews and approves it from Employees admin, no email/SMS required.
// See server/resetRequests.js and db/patch_009 for the full reasoning.
app.post('/api/auth/request-reset', async (req, res) => {
const result = await resetRequests.requestReset(req.body);
res.json(result);
});

// Owner-only — same trust boundary as activation/credential issuance.
app.get('/api/reset-requests', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
res.json(await resetRequests.listResetRequests({ status: req.query.status || 'pending' }));
});

// Full session required — approving mints a brand-new password/PIN, same
// sensitivity tier as employee activation.
app.post('/api/reset-requests/:id/decide', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const result = await resetRequests.decideReset({ requestId: req.params.id, approve: !!req.body.approve, decidedBy: req.person.id, note: req.body.note });
res.json(result);
});

// ---------------- Devices (shared bar iPads) ----------------
app.post('/api/devices', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const { locationId, label } = req.body;
const token = crypto.randomBytes(24).toString('base64url');
// devices has RLS FORCE-enabled with no policy at all for barplatform_app,
// so this insert has to go through the service role — same reasoning as
// the locations/positions writes above.
await withServiceClient((client) => client.query(
'INSERT INTO devices (location_id, label, device_token, trusted_by) VALUES ($1,$2,$3,$4)',
[locationId, label, token, req.person.id]
));
res.json({ ok: true, deviceToken: token });
});

// Lets a page check "is THIS BROWSER a trusted device" independent of who's
// logged in — e.g. Venue Control's Apps Home tile, which should show up on
// the location's trusted iPad for whoever's using it, not just for a
// specific role. requireSession('light') because every caller is already
// logged in by the time they check this; the token itself carries no
// permissions on its own, it just says which location this browser was
// trusted for.
app.get('/api/devices/mine', auth.requireSession('light'), async (req, res) => {
const token = req.query.deviceToken;
if (!token) return res.json({ trusted: false });
const { rows } = await withServiceClient((client) => client.query(
`SELECT d.id, d.label, d.location_id, l.name AS location_name
   FROM devices d JOIN locations l ON l.id = d.location_id
   WHERE d.device_token = $1`,
[token]
));
if (!rows[0]) return res.json({ trusted: false });
res.json({
trusted: true,
deviceId: rows[0].id,
label: rows[0].label,
locationId: rows[0].location_id,
locationName: rows[0].location_name,
});
});

// ---------------- Venue Control — per-site enable/disable (owner-only) ----------------
// This is separate from the device-trust check above: that gate controls
// WHO can even open the Venue Control ("TV") page/tile. This controls
// WHICH locations have Venue Control turned on at all — e.g. Ticket 3,
// which stays inactive platform-wide (locations.active = false) but can
// still be individually turned on here per Scotto's request. One vc_sites
// row per location (see db/patch_017_venue_control_use_locations.sql);
// a location with no row yet just hasn't been added to Venue Control.
// Owner-only regardless of device trust — this is setup/config, not
// day-to-day TV control, so a trusted shared iPad should not be able to
// flip it.
app.get('/api/venue-control/sites', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient((client) => client.query(
`SELECT l.id AS location_id, l.name AS location_name, l.active AS location_active,
        vs.id AS site_id, vs.enabled AS site_enabled,
        vs.agent_token_hash IS NOT NULL AS has_agent_token,
        va.hostname AS agent_hostname, va.status AS agent_status, va.last_seen_at AS agent_last_seen_at
   FROM locations l
   LEFT JOIN vc_sites vs ON vs.location_id = l.id
   LEFT JOIN LATERAL (
     SELECT hostname, status, last_seen_at FROM vc_agents
      WHERE site_id = vs.id ORDER BY last_seen_at DESC NULLS LAST, created_at DESC LIMIT 1
   ) va ON true
   ORDER BY l.name`
));
res.json(rows);
});

app.post('/api/venue-control/sites/:locationId/set-enabled', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const enabled = !!req.body.enabled;
const site = await withServiceClient(async (client) => {
const { rows } = await client.query(
`INSERT INTO vc_sites (location_id, enabled) VALUES ($1, $2)
   ON CONFLICT (location_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
   RETURNING id, location_id, enabled`,
[req.params.locationId, enabled]
);
return rows[0];
});
res.json({ ok: true, site });
});

// ---------------- Venue Control — agent tokens + agent-facing API (Phase 0) ----------------
// docs/venue-control.md §12, Phase 0: "Registration, config pull, SQLite
// cache, heartbeat, local UI shell, admin PIN. Proves the cloud<->agent path
// with nothing at risk." Nothing here talks to a TV or receiver -- that
// starts at Phase 2. This just proves the on-site box and the cloud can find
// each other and stay in sync.
//
// Deviation from the spec's §8.1 agent-facing routes, logged here since
// docs/venue-control.md itself stays an unmodified copy of the original
// spec: registration no longer takes a site_slug, because patch_017 dropped
// vc_sites.slug/name when vc_sites was reconciled with locations (see that
// migration). The per-site bearer token IS the site identity for every
// agent-facing call below -- one less thing to keep in sync by hand, and
// still matches §11's "authenticates with a per-site bearer token."
//
// Token is generated here (owner-only, full session), shown to Scotto
// exactly once in the response, and stored only as a SHA-256 hash in
// vc_sites.agent_token_hash -- same "shown once, hashed at rest" shape as
// every temp-password/reset flow elsewhere in this app. Regenerating
// immediately invalidates whatever token was issued before, since the
// column only ever holds the current hash.
app.post('/api/venue-control/sites/:locationId/agent-token', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const token = crypto.randomBytes(32).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const site = await withServiceClient(async (client) => {
const { rows } = await client.query(
`UPDATE vc_sites SET agent_token_hash = $1, updated_at = now()
   WHERE location_id = $2
   RETURNING id, location_id`,
[tokenHash, req.params.locationId]
);
return rows[0];
});
if (!site) return res.status(404).json({ error: 'Turn Venue Control on for this location before generating an agent token.' });
res.json({ ok: true, agentToken: token });
});

// Every /api/venue/agent/* route below is called by the on-site agent box,
// not by a logged-in person -- so it's gated by the per-site bearer token
// instead of auth.requireSession. Looks up the site by the token's hash;
// vc_sites has RLS FORCE with zero policies like every other feature-scoped
// table in this app, so this goes through withServiceClient same as
// everywhere else.
function requireAgentAuth() {
return async (req, res, next) => {
const header = req.get('authorization') || '';
const token = header.startsWith('Bearer ') ? header.slice(7) : null;
if (!token) return res.status(401).json({ error: 'Missing agent bearer token.' });
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const { rows } = await withServiceClient((client) => client.query(
`SELECT vs.id AS site_id, vs.location_id, vs.timezone, vs.scan_ranges, vs.enabled, l.name AS location_name
   FROM vc_sites vs JOIN locations l ON l.id = vs.location_id
   WHERE vs.agent_token_hash = $1`,
[tokenHash]
));
if (!rows[0]) return res.status(401).json({ error: 'Invalid agent token.' });
if (!rows[0].enabled) return res.status(403).json({ error: 'Venue Control is turned off for this location.' });
req.vcSite = rows[0];
next();
};
}

// docs/venue-control.md §11: "All destructive admin actions write to
// vc_activity with actor and origin." Phase 5 (§12: "...activity log").
// Takes an already-connected client so callers can fold the write into the
// same transaction as the action itself -- every call site below already
// has one open (withServiceClient). Used both by admin-session routes
// (origin: 'cloud', actor: the owner's name/email) and by the agent-facing
// activity batch route further down (origin: 'local', actor: whatever the
// agent tagged the local action with -- see agent/lib/activity.js).
async function recordActivity(client, siteId, { actor, origin, action, targetType, targetId, detail, result }) {
await client.query(
`INSERT INTO vc_activity (site_id, actor, origin, action, target_type, target_id, detail, result)
   VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'{}'::JSONB),COALESCE($8,'ok'))`,
[siteId, actor || null, origin || 'local', action, targetType || null, targetId || null, detail ? JSON.stringify(detail) : null, result || null]
);
}

// ---------------- Venue Control — backup/restore helpers (Phase 5) ----------------
// docs/venue-control.md §6: "checksum is SHA-256 over canonicalized payload
// JSON, so a corrupt or truncated snapshot is rejected rather than
// restored." Sorted object keys make the same logical payload hash the
// same way regardless of the order Postgres happened to return columns in.
function canonicalJson(value) {
if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
if (value && typeof value === 'object') {
const keys = Object.keys(value).sort();
return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
return JSON.stringify(value === undefined ? null : value);
}

// Builds a full snapshot straight from Postgres -- §6: "The agent holds no
// unique state... lives in Supabase." Because Supabase is already the sole
// source of truth for every table in here, a backup never needs the agent
// to send its own state up; the agent-facing POST /api/venue/agent/backup
// route further down just pings this on a schedule. Raw DB rows (with
// their live ids) are kept in the payload deliberately, not the trimmed
// public shape GET /api/venue/agent/config sends -- performRestore below
// needs those original ids to remap cross-references (tv.zone_id,
// layout_items.target_id, schedule payloads) after a restore reassigns
// fresh ones.
async function buildBackupPayload(client, siteId) {
const { rows: siteRows } = await client.query(
`SELECT vs.location_id, vs.timezone, l.name
   FROM vc_sites vs JOIN locations l ON l.id = vs.location_id WHERE vs.id = $1`,
[siteId]
);
if (!siteRows[0]) throw Object.assign(new Error('No Venue Control site found for that id.'), { status: 404 });
const { rows: zones } = await client.query('SELECT * FROM vc_zones WHERE site_id = $1 ORDER BY sort_order, name', [siteId]);
const { rows: sources } = await client.query('SELECT * FROM vc_sources WHERE site_id = $1 ORDER BY slot', [siteId]);
const { rows: tvs } = await client.query('SELECT * FROM vc_tvs WHERE site_id = $1 ORDER BY sort_order, name', [siteId]);
// Site-scoped favorites only -- shared favorites (site_id IS NULL) belong
// to every site at once, so no single site's backup/restore ever touches
// them (see performRestore's own comment on this same point).
const { rows: favorites } = await client.query('SELECT * FROM vc_favorites WHERE site_id = $1 ORDER BY category, sort_order, name', [siteId]);
const { rows: layouts } = await client.query('SELECT * FROM vc_layouts WHERE site_id = $1 ORDER BY sort_order, name', [siteId]);
const { rows: layoutItems } = layouts.length
? await client.query('SELECT * FROM vc_layout_items WHERE layout_id = ANY($1::bigint[]) ORDER BY layout_id, step_order', [layouts.map((l) => l.id)])
: { rows: [] };
const { rows: schedules } = await client.query('SELECT * FROM vc_schedules WHERE site_id = $1 ORDER BY name', [siteId]);
return {
schema_version: 1,
site: { location_id: siteRows[0].location_id, name: siteRows[0].name, timezone: siteRows[0].timezone },
zones, sources, tvs, favorites, layouts, layout_items: layoutItems, schedules,
};
}

async function insertBackup(client, siteId, kind, label, createdBy) {
const payload = await buildBackupPayload(client, siteId);
const checksum = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
const itemCounts = {
zones: payload.zones.length, sources: payload.sources.length, tvs: payload.tvs.length,
favorites: payload.favorites.length, layouts: payload.layouts.length, schedules: payload.schedules.length,
};
const { rows } = await client.query(
`INSERT INTO vc_backups (site_id, kind, label, payload, checksum, item_counts, created_by)
   VALUES ($1,$2,$3,$4,$5,$6,$7)
   RETURNING id, site_id, kind, label, payload, checksum, item_counts, created_by, created_at`,
[siteId, kind, label || null, JSON.stringify(payload), checksum, JSON.stringify(itemCounts), createdBy || null]
);
// §6: "Retention: keep 30 auto, all manual, all pre_restore."
if (kind === 'auto') {
await client.query(
`DELETE FROM vc_backups WHERE site_id = $1 AND kind = 'auto' AND id NOT IN (
     SELECT id FROM vc_backups WHERE site_id = $1 AND kind = 'auto' ORDER BY created_at DESC LIMIT 30
   )`,
[siteId]
);
}
return rows[0];
}

// Remaps a schedule's JSONB payload after a restore reassigns fresh ids to
// zones/tvs/layouts -- a tvs_power schedule's zone_id/tv_ids and an
// apply_layout schedule's layout_id all point at the OLD ids captured in
// the backup, and would silently target nothing (or the wrong thing) post-
// restore without this. source_tune's slot/slots are untouched -- slots
// are stable numbers, not database ids.
function remapSchedulePayload(payload, { zoneIdMap, tvIdMap, layoutIdMap }) {
const p = { ...(payload || {}) };
if (p.zone_id != null) p.zone_id = zoneIdMap.get(p.zone_id) ?? null;
if (Array.isArray(p.tv_ids)) p.tv_ids = p.tv_ids.map((id) => tvIdMap.get(id)).filter((id) => id != null);
if (p.layout_id != null) p.layout_id = layoutIdMap.get(p.layout_id) ?? null;
return p;
}

// Replaces zones/sources/tvs/favorites/layouts/layout_items/schedules for
// one site with what's in a backup payload, inside the caller's own
// transaction. §6: "Matching is by natural key (slot for sources, mac for
// TVs) so IDs staying stable isn't required" -- rather than upserting row
// by row against those natural keys (awkward here: vc_sources also has a
// UNIQUE(site_id, qam_channel) constraint that a naive upsert can
// transiently violate if channel assignments were reshuffled between the
// backup and now), this does a full delete-then-reinsert for the site and
// rebuilds old-id -> new-id maps as it goes, which every downstream
// cross-reference (tv.zone_id, layout_items.target_id, schedule payloads)
// is remapped through. Delete order respects the one real FK among these
// tables (vc_tvs.zone_id -> vc_zones, ON DELETE SET NULL) plus vc_layouts
// -> vc_layout_items's ON DELETE CASCADE. Activity log and discovery
// history are never touched here, per §6's own words -- callers add
// exactly one recordActivity entry for the restore action itself.
async function performRestore(client, siteId, payload) {
await client.query('DELETE FROM vc_tvs WHERE site_id = $1', [siteId]);
await client.query('DELETE FROM vc_zones WHERE site_id = $1', [siteId]);
await client.query('DELETE FROM vc_sources WHERE site_id = $1', [siteId]);
await client.query('DELETE FROM vc_favorites WHERE site_id = $1', [siteId]); // site-scoped only; shared favorites (site_id IS NULL) are untouched
await client.query('DELETE FROM vc_layouts WHERE site_id = $1', [siteId]); // cascades vc_layout_items
await client.query('DELETE FROM vc_schedules WHERE site_id = $1', [siteId]);

const zoneIdMap = new Map();
for (const z of payload.zones || []) {
const { rows } = await client.query(
'INSERT INTO vc_zones (site_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id',
[siteId, z.name, z.sort_order || 0]
);
zoneIdMap.set(z.id, rows[0].id);
}

const sourceIdMap = new Map();
for (const s of payload.sources || []) {
const { rows } = await client.query(
`INSERT INTO vc_sources (site_id, slot, qam_channel, label, kind, ip, port, mac, receiver_id, access_card_id, serial_num, sw_version, enabled, sort_order, notes)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
[siteId, s.slot, s.qam_channel, s.label, s.kind, s.ip, s.port, s.mac, s.receiver_id, s.access_card_id, s.serial_num, s.sw_version, s.enabled, s.sort_order, s.notes]
);
sourceIdMap.set(s.id, rows[0].id);
}

const tvIdMap = new Map();
for (const t of payload.tvs || []) {
const newZoneId = t.zone_id != null ? (zoneIdMap.get(t.zone_id) ?? null) : null;
const { rows } = await client.query(
`INSERT INTO vc_tvs (site_id, zone_id, name, tag, brand, model, ip, mac, control_method, ws_port, ws_token, st_device_id,
     wol_enabled, power_capable, channel_capable, volume_capable, default_source_slot, last_known_slot, last_known_power,
     enabled, sort_order, notes)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
[siteId, newZoneId, t.name, t.tag, t.brand, t.model, t.ip, t.mac, t.control_method, t.ws_port, t.ws_token, t.st_device_id,
 t.wol_enabled, t.power_capable, t.channel_capable, t.volume_capable, t.default_source_slot, t.last_known_slot, t.last_known_power,
 t.enabled, t.sort_order, t.notes]
);
tvIdMap.set(t.id, rows[0].id);
}

let favoriteCount = 0;
for (const f of payload.favorites || []) {
if (f.site_id == null) continue; // shared favorites are never part of a per-site restore
await client.query(
`INSERT INTO vc_favorites (site_id, name, major, minor, category, color, sort_order, enabled)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
[siteId, f.name, f.major, f.minor, f.category, f.color, f.sort_order, f.enabled]
);
favoriteCount++;
}

const layoutIdMap = new Map();
for (const l of payload.layouts || []) {
const { rows } = await client.query(
'INSERT INTO vc_layouts (site_id, name, description, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
[siteId, l.name, l.description, l.sort_order || 0]
);
layoutIdMap.set(l.id, rows[0].id);
}

for (const it of payload.layout_items || []) {
const newLayoutId = layoutIdMap.get(it.layout_id);
if (!newLayoutId) continue; // the layout this item belonged to wasn't restored (shouldn't happen, but never fail the whole restore over one orphaned item)
const newTargetId = it.target_type === 'source' ? sourceIdMap.get(it.target_id) : it.target_type === 'tv' ? tvIdMap.get(it.target_id) : null;
if (!newTargetId) continue; // the source/tv this item pointed at isn't in the restored set
await client.query(
'INSERT INTO vc_layout_items (layout_id, target_type, target_id, action, step_order) VALUES ($1,$2,$3,$4,$5)',
[newLayoutId, it.target_type, newTargetId, JSON.stringify(it.action), it.step_order || 0]
);
}

for (const s of payload.schedules || []) {
const remappedPayload = remapSchedulePayload(s.payload, { zoneIdMap, tvIdMap, layoutIdMap });
await client.query(
`INSERT INTO vc_schedules (site_id, name, cron_expr, action_type, payload, enabled, last_run_at, last_result)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
[siteId, s.name, s.cron_expr, s.action_type, JSON.stringify(remappedPayload), s.enabled, s.last_run_at, s.last_result]
);
}

return {
zones: (payload.zones || []).length,
sources: (payload.sources || []).length,
tvs: (payload.tvs || []).length,
favorites: favoriteCount,
layouts: (payload.layouts || []).length,
schedules: (payload.schedules || []).length,
};
}

// Agent calls this on every boot. Keeps exactly one vc_agents row current
// per site (updates the most-recently-seen row if one exists) rather than
// growing a new row every restart -- a site normally has one agent box.
app.post('/api/venue/agent/register', requireAgentAuth(), async (req, res) => {
const { hostname, agentVersion, platform, lanIp } = req.body || {};
const agent = await withServiceClient(async (client) => {
const { rows: existing } = await client.query(
'SELECT id FROM vc_agents WHERE site_id = $1 ORDER BY last_seen_at DESC NULLS LAST, created_at DESC LIMIT 1',
[req.vcSite.site_id]
);
if (existing[0]) {
const { rows } = await client.query(
`UPDATE vc_agents SET hostname=$1, lan_ip=$2, agent_version=$3, platform=$4, status='online', last_seen_at=now()
   WHERE id=$5 RETURNING id`,
[hostname, lanIp, agentVersion, platform, existing[0].id]
);
return rows[0];
}
const { rows } = await client.query(
`INSERT INTO vc_agents (site_id, hostname, lan_ip, agent_version, platform, status, last_seen_at)
   VALUES ($1,$2,$3,$4,$5,'online', now()) RETURNING id`,
[req.vcSite.site_id, hostname, lanIp, agentVersion, platform]
);
return rows[0];
});
res.json({ ok: true, agentId: agent.id, siteId: req.vcSite.site_id, locationName: req.vcSite.location_name, timezone: req.vcSite.timezone });
});

// Phase 0 config was just the site shell (name/timezone/scan_ranges).
// Phase 2 (docs/venue-control.md §12) joins in the receiver inventory and
// favorites list -- this is how the DirecTV driver/poller and the local
// Sources API (agent/lib/poller.js, agent/server.js) learn what receivers
// exist without the agent ever talking to Supabase directly (§6: "the agent
// holds no unique state" -- it's a cached mirror of what's here). Disabled
// sources/favorites are left out entirely rather than sent with a flag, so
// the agent never has to re-derive "is this usable" from more than one
// field. ETag keeps the 30s poll near-free when nothing changed.
app.get('/api/venue/agent/config', requireAgentAuth(), async (req, res) => {
const { rows: sources } = await withServiceClient((client) => client.query(
'SELECT * FROM vc_sources WHERE site_id = $1 AND enabled = true ORDER BY slot',
[req.vcSite.site_id]
));
const { rows: favorites } = await withServiceClient((client) => client.query(
'SELECT * FROM vc_favorites WHERE (site_id = $1 OR site_id IS NULL) AND enabled = true ORDER BY category, sort_order, name',
[req.vcSite.site_id]
));
// Phase 3 (docs/venue-control.md §12) joins in zones, the TV inventory,
// and cron schedules -- same "cached mirror, disabled rows left out
// entirely" shape as sources/favorites above. lib/tv-poller.js,
// lib/scheduler.js, and agent/server.js's TV routes all read these off
// this same config object, never Postgres directly.
const { rows: zones } = await withServiceClient((client) => client.query(
'SELECT * FROM vc_zones WHERE site_id = $1 ORDER BY sort_order, name',
[req.vcSite.site_id]
));
const { rows: tvs } = await withServiceClient((client) => client.query(
'SELECT * FROM vc_tvs WHERE site_id = $1 AND enabled = true ORDER BY sort_order, name',
[req.vcSite.site_id]
));
const { rows: schedules } = await withServiceClient((client) => client.query(
'SELECT * FROM vc_schedules WHERE site_id = $1 AND enabled = true ORDER BY name',
[req.vcSite.site_id]
));
// Phase 5 (docs/venue-control.md §12): layouts + their items, so
// lib/layouts.js (staff "apply" and the scheduler's apply_layout action)
// can execute a layout without the agent ever talking to Supabase
// directly -- same cached-mirror shape as everything else in this config.
// Unlike sources/tvs/schedules there's no `enabled` flag on layouts to
// filter by; every layout for the site is always current here.
const { rows: layouts } = await withServiceClient((client) => client.query(
'SELECT * FROM vc_layouts WHERE site_id = $1 ORDER BY sort_order, name',
[req.vcSite.site_id]
));
const { rows: layoutItems } = layouts.length
? await withServiceClient((client) => client.query(
  'SELECT * FROM vc_layout_items WHERE layout_id = ANY($1::bigint[]) ORDER BY layout_id, step_order',
  [layouts.map((l) => l.id)]
))
: { rows: [] };
const config = {
schema_version: 5,
site: {
location_id: req.vcSite.location_id,
name: req.vcSite.location_name,
timezone: req.vcSite.timezone,
scan_ranges: req.vcSite.scan_ranges,
},
sources: sources.map((s) => ({
// id added in Phase 5 -- vc_layout_items.target_id (target_type "source")
// points at a source's actual row id, not its slot (§5's own example:
// { "target_type": "source", "target_id": 4, ... }), so lib/layouts.js
// needs it to resolve a layout item back to a slot/qam_channel. Every
// route through Phase 4 keyed sources purely off "slot" instead, which is
// why this was never sent down before now.
id: s.id, slot: s.slot, qam_channel: s.qam_channel, label: s.label, kind: s.kind,
ip: s.ip, port: s.port, mac: s.mac, receiver_id: s.receiver_id,
access_card_id: s.access_card_id, serial_num: s.serial_num, sw_version: s.sw_version,
enabled: s.enabled,
})),
favorites: favorites.map((f) => ({
id: f.id, name: f.name, major: f.major, minor: f.minor, category: f.category, color: f.color, shared: f.site_id === null,
})),
zones: zones.map((z) => ({ id: z.id, name: z.name, sort_order: z.sort_order })),
tvs: tvs.map((t) => ({
id: t.id, zone_id: t.zone_id, name: t.name, tag: t.tag, brand: t.brand, model: t.model,
ip: t.ip, mac: t.mac, control_method: t.control_method, ws_port: t.ws_port, ws_token: t.ws_token,
st_device_id: t.st_device_id, wol_enabled: t.wol_enabled,
power_capable: t.power_capable, channel_capable: t.channel_capable, volume_capable: t.volume_capable,
default_source_slot: t.default_source_slot, last_known_slot: t.last_known_slot, enabled: t.enabled,
})),
schedules: schedules.map((s) => ({
id: s.id, name: s.name, cron_expr: s.cron_expr, action_type: s.action_type, payload: s.payload, enabled: s.enabled,
})),
layouts: layouts.map((l) => ({ id: l.id, name: l.name, description: l.description, sort_order: l.sort_order })),
layout_items: layoutItems.map((it) => ({
id: it.id, layout_id: it.layout_id, target_type: it.target_type, target_id: it.target_id, action: it.action, step_order: it.step_order,
})),
};
const etag = crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
if (req.get('if-none-match') === etag) return res.status(304).end();
res.set('ETag', etag);
res.json(config);
});

app.post('/api/venue/agent/heartbeat', requireAgentAuth(), async (req, res) => {
const { status, agentVersion, configEtag } = req.body || {};
await withServiceClient((client) => client.query(
`UPDATE vc_agents SET status=$1, agent_version=COALESCE($2, agent_version), config_etag=COALESCE($3, config_etag), last_seen_at=now()
   WHERE site_id=$4`,
[status || 'online', agentVersion, configEtag, req.vcSite.site_id]
));
res.json({ ok: true });
});

// ---------------- Venue Control — Discovery & Diagnostics (Phase 1) ----------------
// docs/venue-control.md §12, Phase 1: "The scanner, classification, test
// operations, adoption... Everything downstream depends on what this
// finds." The actual scan runs on the agent box against its own LAN (a
// cloud server can't reach a bar's local subnet) -- see agent/lib/
// discovery/ for that half. These two routes are the cloud side of §8.1's
// `POST /api/venue/agent/discovery` line: the agent pushes a completed run
// here right after scanning, and separately calls the adopt route when an
// owner turns one scanned device into a real vc_tvs/vc_sources row.
// Agent-authenticated (requireAgentAuth), same as register/config/
// heartbeat above -- these are never called by a logged-in person directly.
app.post('/api/venue/agent/discovery/runs', requireAgentAuth(), async (req, res) => {
const { ranges, startedAt, finishedAt, hostCount, devices } = req.body || {};
if (!Array.isArray(devices)) return res.status(400).json({ error: 'Missing "devices" array.' });
const result = await withServiceClient(async (client) => {
const { rows: runRows } = await client.query(
`INSERT INTO vc_discovery_runs (site_id, started_at, finished_at, ranges, host_count, started_by)
   VALUES ($1, COALESCE($2, now()), $3, $4, $5, 'agent')
   RETURNING id`,
[req.vcSite.site_id, startedAt || null, finishedAt || null, ranges || [], hostCount || null]
);
const runId = runRows[0].id;
const deviceRows = [];
for (const d of devices) {
const { rows } = await client.query(
`INSERT INTO vc_discovery_devices (run_id, ip, mac, oui_vendor, open_ports, classified_as, confidence, identity, control_methods)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
   RETURNING id`,
[runId, d.ip, d.mac || null, d.oui_vendor || null, d.open_ports || [], d.classified_as || 'unknown',
 d.confidence || 'low', JSON.stringify(d.identity || {}), JSON.stringify(d.control_methods || [])]
);
deviceRows.push({ ip: d.ip, id: rows[0].id });
}
return { runId, deviceRows };
});
res.json({ ok: true, runId: result.runId, devices: result.deviceRows });
});

// Writes an adopted device through to vc_tvs or vc_sources ("Adoption
// writes through to Supabase, so a device catalogued at the bar is
// immediately visible in TSB Platform" -- §9.3), and marks the source
// discovery-device row as adopted so a later re-scan's health-view diff
// (§9.4) knows not to flag it as new. Scoped to the calling agent's own
// site -- a device id from another site's run is rejected, not just
// trusted from the request body.
app.post('/api/venue/agent/discovery/adopt', requireAgentAuth(), async (req, res) => {
const { discoveryDeviceId, as, ...fields } = req.body || {};
if (!discoveryDeviceId) return res.status(400).json({ error: 'Missing "discoveryDeviceId".' });
if (as !== 'tv' && as !== 'source') return res.status(400).json({ error: '"as" must be "tv" or "source".' });
try {
const created = await withServiceClient(async (client) => {
const { rows: deviceRows } = await client.query(
`SELECT dd.id, dr.site_id FROM vc_discovery_devices dd
   JOIN vc_discovery_runs dr ON dr.id = dd.run_id
  WHERE dd.id = $1`,
[discoveryDeviceId]
);
const device = deviceRows[0];
if (!device) throw Object.assign(new Error('Discovery device not found.'), { status: 404 });
if (device.site_id !== req.vcSite.site_id) throw Object.assign(new Error('That discovery device belongs to a different site.'), { status: 403 });

let record;
if (as === 'tv') {
const { rows } = await client.query(
`INSERT INTO vc_tvs (site_id, zone_id, name, tag, ip, mac, control_method, wol_enabled, default_source_slot)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
   RETURNING *`,
[req.vcSite.site_id, fields.zoneId || null, fields.name || 'Unnamed TV', fields.tag || null, fields.ip || null,
 fields.mac || null, fields.controlMethod || 'unknown', !!fields.wolEnabled, fields.defaultSourceSlot || null]
);
record = rows[0];
} else {
if (!fields.slot || !fields.qamChannel) throw Object.assign(new Error('A source needs "slot" and "qamChannel".'), { status: 400 });
// Phase 6: include port here too (same defaultSourcePort() rule as the
// manual add/edit routes) -- this INSERT previously omitted it entirely,
// which left every adopted source on the table's flat 8080 default even
// when discovery correctly classified it as a Roku (ECP is on 8060).
const { rows } = await client.query(
`INSERT INTO vc_sources (site_id, slot, qam_channel, label, kind, ip, port, mac)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
   RETURNING *`,
[req.vcSite.site_id, fields.slot, fields.qamChannel, fields.label || 'Unnamed source', fields.kind || 'directv',
 fields.ip || null, fields.port || defaultSourcePort(fields.kind), fields.mac || null]
);
record = rows[0];
}
await client.query('UPDATE vc_discovery_devices SET adopted_type=$1, adopted_id=$2 WHERE id=$3', [as, record.id, discoveryDeviceId]);
return record;
});
res.json({ ok: true, ...created });
} catch (err) {
res.status(err.status || 400).json({ error: err.message });
}
});

// Phase 3's two small agent->cloud pushes (docs/venue-control.md §3 calls
// out that a general commands/results queue would land "once there's
// something on the agent worth commanding" -- these two narrow writes
// don't need that whole queue built to be worth having):
// lib/scheduler.js reports what a fired schedule actually did, and
// agent/server.js's TV routes report a freshly captured WS pairing token
// so the next command doesn't need the on-screen "Allow this device?"
// prompt again.
app.post('/api/venue/agent/schedules/:id/result', requireAgentAuth(), async (req, res) => {
const { result } = req.body || {};
const { rows } = await withServiceClient((client) => client.query(
`UPDATE vc_schedules SET last_run_at = now(), last_result = $1
   WHERE id = $2 AND site_id = $3 RETURNING id`,
[String(result || '').slice(0, 2000), req.params.id, req.vcSite.site_id]
));
if (!rows[0]) return res.status(404).json({ error: 'Schedule not found for this site.' });
res.json({ ok: true });
});

app.post('/api/venue/agent/tvs/:id/token', requireAgentAuth(), async (req, res) => {
const { ws_token } = req.body || {};
if (!ws_token) return res.status(400).json({ error: 'Missing "ws_token".' });
const { rows } = await withServiceClient((client) => client.query(
`UPDATE vc_tvs SET ws_token = $1, updated_at = now()
   WHERE id = $2 AND site_id = $3 RETURNING id`,
[ws_token, req.params.id, req.vcSite.site_id]
));
if (!rows[0]) return res.status(404).json({ error: 'TV not found for this site.' });
res.json({ ok: true });
});

// Phase 4 (docs/venue-control.md §12): the agent pushes the slot a TV was
// last commanded to select (agent/lib/sync.js's reportTvSlot, called right
// after agent/server.js's /api/tvs/:id/slot or bulk/slot succeeds) so
// vc_tvs.last_known_slot stays current for TSB Platform's own admin view.
// Same "shown once, best-effort" posture as the token push above -- a
// failed push here doesn't undo the channel-select command that already
// happened on the TV.
app.post('/api/venue/agent/tvs/:id/slot', requireAgentAuth(), async (req, res) => {
const { slot } = req.body || {};
if (slot == null) return res.status(400).json({ error: 'Missing "slot".' });
const { rows } = await withServiceClient((client) => client.query(
`UPDATE vc_tvs SET last_known_slot = $1, updated_at = now()
   WHERE id = $2 AND site_id = $3 RETURNING id`,
[Number(slot), req.params.id, req.vcSite.site_id]
));
if (!rows[0]) return res.status(404).json({ error: 'TV not found for this site.' });
res.json({ ok: true });
});

// ---------------- Venue Control — Source control (Phase 2) ----------------
// docs/venue-control.md §12, Phase 2: "DirecTV driver, poller, sources admin
// CRUD (receiver ID, card #, IP, QAM channel), favorites CRUD with sort,
// staff Sources tab." The driver, poller, and staff-facing control API live
// on the agent (agent/lib/drivers/directv.js, agent/lib/poller.js,
// agent/server.js's /api/sources/* -- talking to a receiver only makes
// sense from the bar's own LAN, same reasoning as discovery in Phase 1).
// These routes are the cloud half: owner setup for the receiver inventory
// and the favorites list, both of which flow down to the agent through
// GET /api/venue/agent/config below (extended further down this file).
//
// Owner-only, same posture as the Sites card above it -- this is
// receiver/channel-plan setup, not day-to-day control. Day-to-day tuning
// happens on the agent's own local Sources tab, gated by the agent's staff
// PIN instead of a TSB Platform session.
app.get('/api/venue-control/sites/:locationId/sources', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient((client) => client.query(
`SELECT s.* FROM vc_sources s JOIN vc_sites vs ON vs.id = s.site_id
  WHERE vs.location_id = $1
  ORDER BY s.slot`,
[req.params.locationId]
));
res.json(rows);
});

// Phase 6: the port default used to be a flat COALESCE(...,8080) regardless
// of kind, which was harmless while every source was a DirecTV receiver
// (SHEF's actual port) but silently wrong the moment a Roku (ECP on 8060)
// row was added with no explicit port -- discovery-adopted or hand-added,
// same bug either way. Computed here in JS, once, so add/edit/adopt all
// apply the same rule instead of three copies of a port-per-kind table.
function defaultSourcePort(kind) {
  return kind === 'roku' ? 8060 : 8080;
}

app.post('/api/venue-control/sites/:locationId/sources', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { slot, qamChannel, label, kind, ip, port, mac, receiverId, accessCardId, notes } = req.body || {};
if (!slot || !qamChannel || !(label || '').trim()) return res.status(400).json({ error: 'A source needs "slot", "qamChannel", and "label".' });
try {
const source = await withServiceClient(async (client) => {
const { rows: siteRows } = await client.query('SELECT id FROM vc_sites WHERE location_id = $1', [req.params.locationId]);
if (!siteRows[0]) throw Object.assign(new Error('Turn Venue Control on for this location before adding sources.'), { status: 404 });
const { rows } = await client.query(
`INSERT INTO vc_sources (site_id, slot, qam_channel, label, kind, ip, port, mac, receiver_id, access_card_id, notes)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
   RETURNING *`,
[siteRows[0].id, slot, qamChannel, label.trim(), kind || 'directv', ip || null, port || defaultSourcePort(kind), mac || null,
 receiverId || null, accessCardId || null, notes || null]
);
return rows[0];
});
res.json({ ok: true, source });
} catch (err) {
if (err.code === '23505') return res.status(400).json({ error: 'That slot or QAM channel is already used by another source at this location.' });
if (err.code === '23514' && err.constraint === 'vc_sources_directv_needs_ip') return res.status(400).json({ error: 'A DirecTV source needs an IP address.' });
res.status(err.status || 400).json({ error: err.message });
}
});

app.post('/api/venue-control/sources/:id/update', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { slot, qamChannel, label, kind, ip, port, mac, receiverId, accessCardId, enabled, notes } = req.body || {};
if (!slot || !qamChannel || !(label || '').trim()) return res.status(400).json({ error: 'A source needs "slot", "qamChannel", and "label".' });
try {
const { rows } = await withServiceClient((client) => client.query(
`UPDATE vc_sources SET
   slot=$1, qam_channel=$2, label=$3, kind=$4, ip=$5, port=$6, mac=$7,
   receiver_id=$8, access_card_id=$9, notes=$10, enabled=COALESCE($11,enabled), updated_at=now()
 WHERE id=$12
 RETURNING *`,
[slot, qamChannel, label.trim(), kind || 'directv', ip || null, port || defaultSourcePort(kind), mac || null,
 receiverId || null, accessCardId || null, notes || null, typeof enabled === 'boolean' ? enabled : null, req.params.id]
));
if (!rows[0]) return res.status(404).json({ error: 'Source not found.' });
res.json({ ok: true, source: rows[0] });
} catch (err) {
if (err.code === '23505') return res.status(400).json({ error: 'That slot or QAM channel is already used by another source at this location.' });
if (err.code === '23514' && err.constraint === 'vc_sources_directv_needs_ip') return res.status(400).json({ error: 'A DirecTV source needs an IP address.' });
res.status(err.status || 400).json({ error: err.message });
}
});

app.post('/api/venue-control/sources/:id/archive', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient(async (client) => {
const { rows } = await client.query(
'UPDATE vc_sources SET enabled = false, updated_at = now() WHERE id = $1 RETURNING *',
[req.params.id]
);
if (rows[0]) await recordActivity(client, rows[0].site_id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'source.archive', targetType: 'source', targetId: rows[0].id, detail: { slot: rows[0].slot, label: rows[0].label } });
return rows;
});
if (!rows[0]) return res.status(404).json({ error: 'Source not found.' });
res.json({ ok: true, source: rows[0] });
});

app.post('/api/venue-control/sources/:id/restore', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient(async (client) => {
const { rows } = await client.query(
'UPDATE vc_sources SET enabled = true, updated_at = now() WHERE id = $1 RETURNING *',
[req.params.id]
);
if (rows[0]) await recordActivity(client, rows[0].site_id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'source.restore', targetType: 'source', targetId: rows[0].id, detail: { slot: rows[0].slot, label: rows[0].label } });
return rows;
});
if (!rows[0]) return res.status(404).json({ error: 'Source not found.' });
res.json({ ok: true, source: rows[0] });
});

// Favorites (§5: "site_id NULL = shared across all sites"). "shared: true"
// on create makes a national-channel favorite visible from every location;
// omitted/false scopes it to the location being managed. Scope is fixed at
// creation -- to move a favorite between shared and site-specific, archive
// it and add a new one, rather than growing an update-time migration path
// for a setup action nobody's asked for yet.
app.get('/api/venue-control/sites/:locationId/favorites', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows: siteRows } = await withServiceClient((client) => client.query('SELECT id FROM vc_sites WHERE location_id = $1', [req.params.locationId]));
const siteId = siteRows[0] ? siteRows[0].id : null;
const { rows } = await withServiceClient((client) => client.query(
'SELECT * FROM vc_favorites WHERE site_id = $1 OR site_id IS NULL ORDER BY category, sort_order, name',
[siteId]
));
res.json(rows);
});

app.post('/api/venue-control/sites/:locationId/favorites', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { name, major, minor, category, color, shared } = req.body || {};
if (!(name || '').trim() || !major) return res.status(400).json({ error: 'A favorite needs "name" and "major".' });
try {
const favorite = await withServiceClient(async (client) => {
let siteId = null;
if (!shared) {
const { rows: siteRows } = await client.query('SELECT id FROM vc_sites WHERE location_id = $1', [req.params.locationId]);
if (!siteRows[0]) throw Object.assign(new Error('Turn Venue Control on for this location before adding favorites.'), { status: 404 });
siteId = siteRows[0].id;
}
const { rows } = await client.query(
`INSERT INTO vc_favorites (site_id, name, major, minor, category, color)
   VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
[siteId, name.trim(), major, minor || null, (category || 'Sports').trim(), color || null]
);
return rows[0];
});
res.json({ ok: true, favorite });
} catch (err) {
res.status(err.status || 400).json({ error: err.message });
}
});

app.post('/api/venue-control/favorites/:id/update', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { name, major, minor, category, color } = req.body || {};
if (!(name || '').trim() || !major) return res.status(400).json({ error: 'A favorite needs "name" and "major".' });
const { rows } = await withServiceClient((client) => client.query(
'UPDATE vc_favorites SET name=$1, major=$2, minor=$3, category=$4, color=$5 WHERE id=$6 RETURNING *',
[name.trim(), major, minor || null, (category || 'Sports').trim(), color || null, req.params.id]
));
if (!rows[0]) return res.status(404).json({ error: 'Favorite not found.' });
res.json({ ok: true, favorite: rows[0] });
});

app.post('/api/venue-control/favorites/:id/archive', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient(async (client) => {
const { rows } = await client.query(
'UPDATE vc_favorites SET enabled = false WHERE id = $1 RETURNING *',
[req.params.id]
);
// site_id is nullable here (shared favorites) -- nothing to log against
// if it's a global favorite with no single owning site.
if (rows[0] && rows[0].site_id) await recordActivity(client, rows[0].site_id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'favorite.archive', targetType: 'favorite', targetId: rows[0].id, detail: { name: rows[0].name } });
return rows;
});
if (!rows[0]) return res.status(404).json({ error: 'Favorite not found.' });
res.json({ ok: true, favorite: rows[0] });
});

app.post('/api/venue-control/favorites/:id/restore', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient(async (client) => {
const { rows } = await client.query(
'UPDATE vc_favorites SET enabled = true WHERE id = $1 RETURNING *',
[req.params.id]
);
if (rows[0] && rows[0].site_id) await recordActivity(client, rows[0].site_id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'favorite.restore', targetType: 'favorite', targetId: rows[0].id, detail: { name: rows[0].name } });
return rows;
});
if (!rows[0]) return res.status(404).json({ error: 'Favorite not found.' });
res.json({ ok: true, favorite: rows[0] });
});

// Move within category + scope (site-specific favorites reorder among
// themselves; shared favorites reorder among themselves) -- same
// swap-adjacent-sort_order pattern as
// /api/servicecalls/equipment-types/:id/move. `IS NOT DISTINCT FROM` makes
// the sibling lookup null-safe for shared favorites (site_id IS NULL).
app.post('/api/venue-control/favorites/:id/move', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const direction = req.body.direction;
if (direction !== 'up' && direction !== 'down') return res.status(400).json({ error: 'Invalid direction.' });
const result = await withServiceClient(async (client) => {
const { rows: current } = await client.query('SELECT id, site_id, category FROM vc_favorites WHERE id = $1', [req.params.id]);
if (!current[0]) return { ok: false, error: 'Favorite not found.' };
const fav = current[0];
const { rows: siblings } = await client.query(
`SELECT id, sort_order FROM vc_favorites
  WHERE category = $1 AND enabled = true AND site_id IS NOT DISTINCT FROM $2
  ORDER BY sort_order, name`,
[fav.category, fav.site_id]
);
const idx = siblings.findIndex((s) => s.id === fav.id);
const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
if (idx === -1) return { ok: false, error: 'Favorite not found.' };
if (swapIdx < 0 || swapIdx >= siblings.length) return { ok: true }; // already at the edge
const other = siblings[swapIdx];
await client.query('UPDATE vc_favorites SET sort_order = $1 WHERE id = $2', [other.sort_order, fav.id]);
await client.query('UPDATE vc_favorites SET sort_order = $1 WHERE id = $2', [siblings[idx].sort_order, other.id]);
return { ok: true };
});
res.status(result.ok === false ? 404 : 200).json(result);
});

// ---------------- Venue Control — Zones (Phase 3) ----------------
// Physical TV groupings (docs/venue-control.md §5: "ZONES (physical TV
// groupings; sources are deliberately flat)"). vc_zones has no `enabled`
// column -- deleting a zone is a real delete. vc_tvs.zone_id is
// ON DELETE SET NULL, so deleting a zone just un-assigns any TVs in it
// (they show up under "Unassigned" on the agent's TVs tab) rather than
// losing anything about the TVs themselves, which is why this doesn't need
// the archive/restore soft-delete pattern sources/favorites/TVs use for
// rows tied to real hardware history.
app.get('/api/venue-control/sites/:locationId/zones', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient((client) => client.query(
`SELECT z.* FROM vc_zones z JOIN vc_sites vs ON vs.id = z.site_id
  WHERE vs.location_id = $1
  ORDER BY z.sort_order, z.name`,
[req.params.locationId]
));
res.json(rows);
});

app.post('/api/venue-control/sites/:locationId/zones', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { name, sortOrder } = req.body || {};
if (!(name || '').trim()) return res.status(400).json({ error: 'A zone needs a "name".' });
try {
const zone = await withServiceClient(async (client) => {
const { rows: siteRows } = await client.query('SELECT id FROM vc_sites WHERE location_id = $1', [req.params.locationId]);
if (!siteRows[0]) throw Object.assign(new Error('Turn Venue Control on for this location before adding zones.'), { status: 404 });
const { rows } = await client.query(
'INSERT INTO vc_zones (site_id, name, sort_order) VALUES ($1,$2,COALESCE($3,0)) RETURNING *',
[siteRows[0].id, name.trim(), sortOrder ?? null]
);
return rows[0];
});
res.json({ ok: true, zone });
} catch (err) {
if (err.code === '23505') return res.status(400).json({ error: 'A zone with that name already exists at this location.' });
res.status(err.status || 400).json({ error: err.message });
}
});

app.post('/api/venue-control/zones/:id/update', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { name, sortOrder } = req.body || {};
try {
const { rows } = await withServiceClient((client) => client.query(
'UPDATE vc_zones SET name = COALESCE($1, name), sort_order = COALESCE($2, sort_order) WHERE id = $3 RETURNING *',
[name ? name.trim() : null, sortOrder ?? null, req.params.id]
));
if (!rows[0]) return res.status(404).json({ error: 'Zone not found.' });
res.json({ ok: true, zone: rows[0] });
} catch (err) {
if (err.code === '23505') return res.status(400).json({ error: 'A zone with that name already exists at this location.' });
res.status(400).json({ error: err.message });
}
});

app.post('/api/venue-control/zones/:id/delete', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient(async (client) => {
const { rows } = await client.query('DELETE FROM vc_zones WHERE id = $1 RETURNING id, site_id, name', [req.params.id]);
if (rows[0]) await recordActivity(client, rows[0].site_id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'zone.delete', targetType: 'zone', targetId: rows[0].id, detail: { name: rows[0].name } });
return rows;
});
if (!rows[0]) return res.status(404).json({ error: 'Zone not found.' });
res.json({ ok: true });
});

// ---------------- Venue Control — TVs (Phase 3) ----------------
// docs/venue-control.md §12, Phase 3: "Discrete on/off with state
// verification, WoL, zones, bulk and per-zone operations, schedules." The
// driver/poller/staff routes live on the agent (samsung-ws.js,
// samsung-st.js, tv-poller.js, agent/server.js's /api/tvs/*) -- these are
// the cloud half: owner setup for the TV inventory, same posture as
// Sources above (receiver/TV setup is configuration, not day-to-day
// control, which happens on the agent's own staff-PIN-gated TVs tab).
app.get('/api/venue-control/sites/:locationId/tvs', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient((client) => client.query(
`SELECT t.* FROM vc_tvs t JOIN vc_sites vs ON vs.id = t.site_id
  WHERE vs.location_id = $1
  ORDER BY t.sort_order, t.name`,
[req.params.locationId]
));
res.json(rows);
});

app.post('/api/venue-control/sites/:locationId/tvs', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { zoneId, name, tag, brand, model, ip, mac, controlMethod, wsPort, stDeviceId, wolEnabled, defaultSourceSlot, notes } = req.body || {};
if (!(name || '').trim()) return res.status(400).json({ error: 'A TV needs a "name".' });
try {
const tv = await withServiceClient(async (client) => {
const { rows: siteRows } = await client.query('SELECT id FROM vc_sites WHERE location_id = $1', [req.params.locationId]);
if (!siteRows[0]) throw Object.assign(new Error('Turn Venue Control on for this location before adding TVs.'), { status: 404 });
const { rows } = await client.query(
`INSERT INTO vc_tvs (site_id, zone_id, name, tag, brand, model, ip, mac, control_method, ws_port, st_device_id, wol_enabled, default_source_slot, notes)
   VALUES ($1,$2,$3,$4,COALESCE($5,'samsung'),$6,$7,$8,COALESCE($9,'unknown'),$10,$11,$12,$13,$14)
   RETURNING *`,
[siteRows[0].id, zoneId || null, name.trim(), tag || null, brand || null, model || null, ip || null, mac || null,
 controlMethod || null, wsPort || null, stDeviceId || null, !!wolEnabled, defaultSourceSlot || null, notes || null]
);
return rows[0];
});
res.json({ ok: true, tv });
} catch (err) {
if (err.code === '23505') return res.status(400).json({ error: 'That MAC address is already used by another TV at this location.' });
if (err.code === '23514' && err.constraint === 'vc_tvs_control_chk') return res.status(400).json({ error: 'Not a recognized control method.' });
res.status(err.status || 400).json({ error: err.message });
}
});

app.post('/api/venue-control/tvs/:id/update', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { zoneId, name, tag, brand, model, ip, mac, controlMethod, wsPort, stDeviceId, wolEnabled,
powerCapable, channelCapable, volumeCapable, defaultSourceSlot, notes, resetToken } = req.body || {};
try {
const { rows } = await withServiceClient((client) => client.query(
`UPDATE vc_tvs SET
   zone_id = $1, name = COALESCE($2, name), tag = $3, brand = COALESCE($4, brand), model = $5,
   ip = $6, mac = $7, control_method = COALESCE($8, control_method), ws_port = $9, st_device_id = $10,
   wol_enabled = COALESCE($11, wol_enabled), power_capable = COALESCE($12, power_capable),
   channel_capable = COALESCE($13, channel_capable), volume_capable = COALESCE($14, volume_capable),
   default_source_slot = $15, notes = $16,
   ws_token = CASE WHEN $17 THEN NULL ELSE ws_token END,
   updated_at = now()
   WHERE id = $18 RETURNING *`,
[zoneId ?? null, name ? name.trim() : null, tag || null, brand || null, model || null, ip || null, mac || null,
 controlMethod || null, wsPort || null, stDeviceId || null, wolEnabled, powerCapable, channelCapable, volumeCapable,
 defaultSourceSlot ?? null, notes || null, !!resetToken, req.params.id]
));
if (!rows[0]) return res.status(404).json({ error: 'TV not found.' });
res.json({ ok: true, tv: rows[0] });
} catch (err) {
if (err.code === '23505') return res.status(400).json({ error: 'That MAC address is already used by another TV at this location.' });
if (err.code === '23514' && err.constraint === 'vc_tvs_control_chk') return res.status(400).json({ error: 'Not a recognized control method.' });
res.status(400).json({ error: err.message });
}
});

app.post('/api/venue-control/tvs/:id/archive', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient(async (client) => {
const { rows } = await client.query(
'UPDATE vc_tvs SET enabled = false, updated_at = now() WHERE id = $1 RETURNING *',
[req.params.id]
);
if (rows[0]) await recordActivity(client, rows[0].site_id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'tv.archive', targetType: 'tv', targetId: rows[0].id, detail: { name: rows[0].name } });
return rows;
});
if (!rows[0]) return res.status(404).json({ error: 'TV not found.' });
res.json({ ok: true, tv: rows[0] });
});

app.post('/api/venue-control/tvs/:id/restore', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient(async (client) => {
const { rows } = await client.query(
'UPDATE vc_tvs SET enabled = true, updated_at = now() WHERE id = $1 RETURNING *',
[req.params.id]
);
if (rows[0]) await recordActivity(client, rows[0].site_id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'tv.restore', targetType: 'tv', targetId: rows[0].id, detail: { name: rows[0].name } });
return rows;
});
if (!rows[0]) return res.status(404).json({ error: 'TV not found.' });
res.json({ ok: true, tv: rows[0] });
});

// ---------------- Venue Control — Schedules (Phase 3) ----------------
// docs/venue-control.md §5: "Cron is evaluated by the agent in the site's
// own timezone" -- these routes just manage the rows; agent/lib/scheduler.js
// is what actually reads cron_expr/action_type/payload and fires them.
// `enabled` doubles as this table's archive/restore switch (turning a
// schedule off is itself a meaningful, reversible action here, unlike a
// hard delete) -- update accepts it directly rather than needing separate
// archive/restore routes the way sources/favorites/TVs do.
app.get('/api/venue-control/sites/:locationId/schedules', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient((client) => client.query(
`SELECT s.* FROM vc_schedules s JOIN vc_sites vs ON vs.id = s.site_id
  WHERE vs.location_id = $1
  ORDER BY s.name`,
[req.params.locationId]
));
res.json(rows);
});

app.post('/api/venue-control/sites/:locationId/schedules', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { name, cronExpr, actionType, payload } = req.body || {};
if (!(name || '').trim() || !cronExpr || !actionType) return res.status(400).json({ error: 'A schedule needs "name", "cronExpr", and "actionType".' });
if (String(cronExpr).trim().split(/\s+/).length !== 5) return res.status(400).json({ error: 'cronExpr must have exactly 5 fields (minute hour day-of-month month day-of-week).' });
try {
const schedule = await withServiceClient(async (client) => {
const { rows: siteRows } = await client.query('SELECT id FROM vc_sites WHERE location_id = $1', [req.params.locationId]);
if (!siteRows[0]) throw Object.assign(new Error('Turn Venue Control on for this location before adding schedules.'), { status: 404 });
const { rows } = await client.query(
`INSERT INTO vc_schedules (site_id, name, cron_expr, action_type, payload)
   VALUES ($1,$2,$3,$4,COALESCE($5,'{}'::JSONB))
   RETURNING *`,
[siteRows[0].id, name.trim(), cronExpr, actionType, payload ? JSON.stringify(payload) : null]
);
return rows[0];
});
res.json({ ok: true, schedule });
} catch (err) {
if (err.code === '23514' && err.constraint === 'vc_sched_action_chk') return res.status(400).json({ error: 'Not a recognized action type -- expected "tvs_power", "apply_layout", or "source_tune".' });
res.status(err.status || 400).json({ error: err.message });
}
});

app.post('/api/venue-control/schedules/:id/update', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { name, cronExpr, actionType, payload, enabled } = req.body || {};
if (cronExpr && String(cronExpr).trim().split(/\s+/).length !== 5) return res.status(400).json({ error: 'cronExpr must have exactly 5 fields (minute hour day-of-month month day-of-week).' });
try {
const { rows } = await withServiceClient((client) => client.query(
`UPDATE vc_schedules SET
   name = COALESCE($1, name), cron_expr = COALESCE($2, cron_expr), action_type = COALESCE($3, action_type),
   payload = COALESCE($4, payload), enabled = COALESCE($5, enabled)
   WHERE id = $6 RETURNING *`,
[name ? name.trim() : null, cronExpr || null, actionType || null, payload ? JSON.stringify(payload) : null, enabled, req.params.id]
));
if (!rows[0]) return res.status(404).json({ error: 'Schedule not found.' });
res.json({ ok: true, schedule: rows[0] });
} catch (err) {
if (err.code === '23514' && err.constraint === 'vc_sched_action_chk') return res.status(400).json({ error: 'Not a recognized action type -- expected "tvs_power", "apply_layout", or "source_tune".' });
res.status(400).json({ error: err.message });
}
});

app.post('/api/venue-control/schedules/:id/delete', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient(async (client) => {
const { rows } = await client.query('DELETE FROM vc_schedules WHERE id = $1 RETURNING id, site_id, name', [req.params.id]);
if (rows[0]) await recordActivity(client, rows[0].site_id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'schedule.delete', targetType: 'schedule', targetId: rows[0].id, detail: { name: rows[0].name } });
return rows;
});
if (!rows[0]) return res.status(404).json({ error: 'Schedule not found.' });
res.json({ ok: true });
});

// ---------------- Venue Control — Layouts (Phase 5) ----------------
// docs/venue-control.md §5: "A layout captures the whole room in one
// record -- what each receiver is tuned to *and* what each TV is showing."
// §12 Phase 5: "Whole-room presets with capture-current-state..."
//
// Deliberate deviation from §8.1's idealized route list: there is no cloud
// POST .../layouts/:id/capture here. The cloud never holds live device
// state -- only the on-site agent polls DirecTV/Samsung directly (§3) --
// and the agent can't be reached synchronously from the cloud at all by
// design (§11: "Never expose the agent to the internet," no inbound path
// exists). So "capture current state" is an agent-local, admin-PIN-gated
// action (agent/server.js's POST /api/admin/layouts/:id/capture) that
// pushes the captured items up through POST /api/venue/agent/layouts/:id/
// items further down this file. This card manages layout shells
// (name/description/order) and can view captured items read-only; the
// actual capture happens on-site, same shape as Phase 4's channel_capable
// being an on-site-verified toggle rather than something the cloud can
// determine on its own.
app.get('/api/venue-control/sites/:locationId/layouts', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows: layouts } = await withServiceClient((client) => client.query(
`SELECT l.* FROM vc_layouts l JOIN vc_sites vs ON vs.id = l.site_id
  WHERE vs.location_id = $1
  ORDER BY l.sort_order, l.name`,
[req.params.locationId]
));
if (!layouts.length) return res.json([]);
const { rows: items } = await withServiceClient((client) => client.query(
'SELECT * FROM vc_layout_items WHERE layout_id = ANY($1::bigint[]) ORDER BY layout_id, step_order',
[layouts.map((l) => l.id)]
));
const itemsByLayout = new Map();
for (const it of items) {
if (!itemsByLayout.has(it.layout_id)) itemsByLayout.set(it.layout_id, []);
itemsByLayout.get(it.layout_id).push(it);
}
res.json(layouts.map((l) => ({ ...l, items: itemsByLayout.get(l.id) || [] })));
});

app.post('/api/venue-control/sites/:locationId/layouts', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { name, description, sortOrder } = req.body || {};
if (!(name || '').trim()) return res.status(400).json({ error: 'Name is required.' });
try {
const layout = await withServiceClient(async (client) => {
const { rows: siteRows } = await client.query('SELECT id FROM vc_sites WHERE location_id = $1', [req.params.locationId]);
if (!siteRows[0]) throw Object.assign(new Error('Turn Venue Control on for this location before adding layouts.'), { status: 404 });
const { rows } = await client.query(
`INSERT INTO vc_layouts (site_id, name, description, sort_order)
   VALUES ($1,$2,$3,COALESCE($4,0)) RETURNING *`,
[siteRows[0].id, name.trim(), description || null, sortOrder]
);
return { ...rows[0], items: [] };
});
res.json({ ok: true, layout });
} catch (err) {
if (err.code === '23505') return res.status(400).json({ error: 'A layout with that name already exists for this site.' });
res.status(err.status || 400).json({ error: err.message });
}
});

app.post('/api/venue-control/layouts/:id/update', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { name, description, sortOrder } = req.body || {};
try {
const { rows } = await withServiceClient((client) => client.query(
`UPDATE vc_layouts SET
   name = COALESCE($1, name), description = COALESCE($2, description), sort_order = COALESCE($3, sort_order)
   WHERE id = $4 RETURNING *`,
[name ? name.trim() : null, description, sortOrder, req.params.id]
));
if (!rows[0]) return res.status(404).json({ error: 'Layout not found.' });
res.json({ ok: true, layout: rows[0] });
} catch (err) {
if (err.code === '23505') return res.status(400).json({ error: 'A layout with that name already exists for this site.' });
res.status(400).json({ error: err.message });
}
});

app.post('/api/venue-control/layouts/:id/delete', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient(async (client) => {
// ON DELETE CASCADE on vc_layout_items.layout_id takes care of its items.
const { rows } = await client.query('DELETE FROM vc_layouts WHERE id = $1 RETURNING id, site_id, name', [req.params.id]);
if (rows[0]) await recordActivity(client, rows[0].site_id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'layout.delete', targetType: 'layout', targetId: rows[0].id, detail: { name: rows[0].name } });
return rows;
});
if (!rows[0]) return res.status(404).json({ error: 'Layout not found.' });
res.json({ ok: true });
});

// Agent-authenticated -- pushed by the on-site agent after an admin-PIN-
// gated "Capture current state" (agent/server.js's POST /api/admin/
// layouts/:id/capture). Replaces the layout's items wholesale (delete +
// reinsert in one transaction) rather than diffing, since a capture is
// always "this is the room right now," not an incremental edit. Verifies
// the layout actually belongs to the calling agent's site first -- every
// agent-facing route that touches a specific row does this same
// site-ownership check (see the token/slot routes above).
app.post('/api/venue/agent/layouts/:id/items', requireAgentAuth(), async (req, res) => {
const { items } = req.body || {};
if (!Array.isArray(items)) return res.status(400).json({ error: 'Missing "items" array.' });
for (const it of items) {
if (!['source', 'tv'].includes(it.target_type)) return res.status(400).json({ error: `Invalid target_type "${it.target_type}" -- expected "source" or "tv".` });
if (it.target_id == null) return res.status(400).json({ error: 'Every item needs a "target_id".' });
if (!it.action || typeof it.action !== 'object') return res.status(400).json({ error: 'Every item needs an "action" object.' });
}
try {
const layout = await withServiceClient(async (client) => {
const { rows: layoutRows } = await client.query(
'SELECT id, site_id, name FROM vc_layouts WHERE id = $1 AND site_id = $2',
[req.params.id, req.vcSite.site_id]
);
if (!layoutRows[0]) throw Object.assign(new Error('No layout with that id for this site.'), { status: 404 });
await client.query('DELETE FROM vc_layout_items WHERE layout_id = $1', [layoutRows[0].id]);
for (let i = 0; i < items.length; i++) {
const it = items[i];
await client.query(
`INSERT INTO vc_layout_items (layout_id, target_type, target_id, action, step_order)
   VALUES ($1,$2,$3,$4,$5)`,
[layoutRows[0].id, it.target_type, it.target_id, JSON.stringify(it.action), it.step_order ?? i]
);
}
await recordActivity(client, layoutRows[0].site_id, { actor: 'agent', origin: 'local', action: 'layout.capture', targetType: 'layout', targetId: layoutRows[0].id, detail: { name: layoutRows[0].name, item_count: items.length } });
return layoutRows[0];
});
res.json({ ok: true, layout_id: layout.id, item_count: items.length });
} catch (err) {
res.status(err.status || 400).json({ error: err.message });
}
});

// ---------------- Venue Control — Backups & Restore (Phase 5) ----------------
// docs/venue-control.md §6: "an agent box dies, you plug in a replacement,
// log in, and restore by site_id in minutes." See buildBackupPayload/
// insertBackup/performRestore above for the mechanics.
app.get('/api/venue-control/sites/:locationId/backups', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient((client) => client.query(
`SELECT b.id, b.kind, b.label, b.item_counts, b.created_by, b.created_at
   FROM vc_backups b JOIN vc_sites vs ON vs.id = b.site_id
   WHERE vs.location_id = $1
   ORDER BY b.created_at DESC`,
[req.params.locationId]
));
res.json(rows);
});

app.post('/api/venue-control/sites/:locationId/backups', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { label } = req.body || {};
try {
const backup = await withServiceClient(async (client) => {
const { rows: siteRows } = await client.query('SELECT id FROM vc_sites WHERE location_id = $1', [req.params.locationId]);
if (!siteRows[0]) throw Object.assign(new Error('Turn Venue Control on for this location before taking a backup.'), { status: 404 });
const backup = await insertBackup(client, siteRows[0].id, 'manual', label || null, req.person.name || req.person.email);
await recordActivity(client, siteRows[0].id, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'backup.create', targetType: 'backup', targetId: backup.id, detail: { kind: 'manual', item_counts: backup.item_counts } });
return backup;
});
res.json({ ok: true, backup: { ...backup, payload: undefined } });
} catch (err) {
res.status(err.status || 400).json({ error: err.message });
}
});

// Full payload, for download. Deliberately not nested under :locationId,
// matching §8.1's own route shape ("GET /api/venue/backups/:id"). Owner
// role is enough scoping here, same as every other admin route in this
// single-tenant app -- there's no per-location ACL layered on top of it.
app.get('/api/venue-control/backups/:id', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { rows } = await withServiceClient((client) => client.query('SELECT * FROM vc_backups WHERE id = $1', [req.params.id]));
if (!rows[0]) return res.status(404).json({ error: 'Backup not found.' });
res.json(rows[0]);
});

app.post('/api/venue-control/sites/:locationId/restore', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const { backupId } = req.body || {};
if (!backupId) return res.status(400).json({ error: 'Missing "backupId".' });
try {
const result = await withServiceClient(async (client) => {
const { rows: siteRows } = await client.query('SELECT id FROM vc_sites WHERE location_id = $1', [req.params.locationId]);
if (!siteRows[0]) throw Object.assign(new Error('No Venue Control site for this location.'), { status: 404 });
const siteId = siteRows[0].id;
const { rows: backupRows } = await client.query('SELECT * FROM vc_backups WHERE id = $1 AND site_id = $2', [backupId, siteId]);
if (!backupRows[0]) throw Object.assign(new Error('No backup with that id for this site.'), { status: 404 });
const backup = backupRows[0];
const recomputed = crypto.createHash('sha256').update(canonicalJson(backup.payload)).digest('hex');
if (recomputed !== backup.checksum) throw Object.assign(new Error(`Backup #${backup.id} failed its checksum check -- refusing to restore a corrupt snapshot.`), { status: 400 });
// §6: "A pre_restore snapshot is taken automatically before any
// restore, so a restore is itself reversible."
const preRestore = await insertBackup(client, siteId, 'pre_restore', `Before restoring backup #${backup.id}`, req.person.name || req.person.email);
const counts = await performRestore(client, siteId, backup.payload);
await recordActivity(client, siteId, { actor: req.person.name || req.person.email, origin: 'cloud', action: 'restore', targetType: 'backup', targetId: backup.id, detail: { restored: counts, pre_restore_backup_id: preRestore.id } });
return { restored: counts, pre_restore_backup_id: preRestore.id };
});
res.json({ ok: true, ...result });
} catch (err) {
res.status(err.status || 400).json({ error: err.message });
}
});

// Agent-facing (§8.1: "POST /api/venue/agent/backup -> nightly snapshot").
// Takes no body -- see buildBackupPayload's comment above for why: Supabase
// already holds every table a snapshot needs, so the agent's role here is
// just "tell me when," not "here's my state." Called once a day by
// lib/sync.js, and on demand by the agent-local POST /api/backup/now
// (admin-PIN gated) so §6's disaster-recovery story works from the on-site
// box alone, without needing TSB Platform reachable at all.
app.post('/api/venue/agent/backup', requireAgentAuth(), async (req, res) => {
try {
const backup = await withServiceClient(async (client) => {
const backup = await insertBackup(client, req.vcSite.site_id, 'auto', null, 'agent');
await recordActivity(client, req.vcSite.site_id, { actor: 'agent', origin: 'local', action: 'backup.create', targetType: 'backup', targetId: backup.id, detail: { kind: 'auto', item_counts: backup.item_counts } });
return backup;
});
res.json({ ok: true, backup: { ...backup, payload: undefined } });
} catch (err) {
res.status(err.status || 400).json({ error: err.message });
}
});

// List for the agent-local admin page's restore picker -- payload left out
// to keep this light, same as the owner-facing list above.
app.get('/api/venue/agent/backups', requireAgentAuth(), async (req, res) => {
const { rows } = await withServiceClient((client) => client.query(
'SELECT id, kind, label, item_counts, created_by, created_at FROM vc_backups WHERE site_id = $1 ORDER BY created_at DESC LIMIT 60',
[req.vcSite.site_id]
));
res.json(rows);
});

app.post('/api/venue/agent/restore', requireAgentAuth(), async (req, res) => {
const { backup_id } = req.body || {};
if (!backup_id) return res.status(400).json({ error: 'Missing "backup_id".' });
try {
const result = await withServiceClient(async (client) => {
const { rows: backupRows } = await client.query('SELECT * FROM vc_backups WHERE id = $1 AND site_id = $2', [backup_id, req.vcSite.site_id]);
if (!backupRows[0]) throw Object.assign(new Error('No backup with that id for this site.'), { status: 404 });
const backup = backupRows[0];
const recomputed = crypto.createHash('sha256').update(canonicalJson(backup.payload)).digest('hex');
if (recomputed !== backup.checksum) throw Object.assign(new Error(`Backup #${backup.id} failed its checksum check -- refusing to restore a corrupt snapshot.`), { status: 400 });
const preRestore = await insertBackup(client, req.vcSite.site_id, 'pre_restore', `Before restoring backup #${backup.id}`, 'agent');
const counts = await performRestore(client, req.vcSite.site_id, backup.payload);
await recordActivity(client, req.vcSite.site_id, { actor: 'agent', origin: 'local', action: 'restore', targetType: 'backup', targetId: backup.id, detail: { restored: counts, pre_restore_backup_id: preRestore.id } });
return { restored: counts, pre_restore_backup_id: preRestore.id };
});
res.json({ ok: true, ...result });
} catch (err) {
res.status(err.status || 400).json({ error: err.message });
}
});

// ---------------- Venue Control — Activity log (Phase 5) ----------------
// docs/venue-control.md §11: "All destructive admin actions write to
// vc_activity with actor and origin." recordActivity() above is what
// writes rows; this is the read side.
app.get('/api/venue-control/sites/:locationId/activity', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
const { rows } = await withServiceClient((client) => client.query(
`SELECT a.* FROM vc_activity a JOIN vc_sites vs ON vs.id = a.site_id
   WHERE vs.location_id = $1
   ORDER BY a.ts DESC LIMIT $2`,
[req.params.locationId, limit]
));
res.json(rows);
});

// Agent-facing batch push. §8.1 describes a general "POST /api/venue/agent/
// results -> command outcomes, activity batches" route; this is that same
// idea narrowed to just activity, matching the established pattern of
// small purpose-built routes over one generic catch-all (see
// reportScheduleResult/reportTvToken/reportTvSlot in lib/sync.js -- none of
// which ever needed the general commands/results queue either). Clamped
// batch size guards against a runaway local queue flooding the table in
// one call; see agent/lib/activity.js for the queue/flush side.
app.post('/api/venue/agent/activity', requireAgentAuth(), async (req, res) => {
const { entries } = req.body || {};
if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'Missing "entries" array.' });
if (entries.length > 200) return res.status(400).json({ error: 'Too many entries in one batch (max 200).' });
await withServiceClient(async (client) => {
for (const e of entries) {
await recordActivity(client, req.vcSite.site_id, {
actor: e.actor, origin: e.origin || 'local', action: e.action,
targetType: e.target_type, targetId: e.target_id, detail: e.detail, result: e.result,
});
}
});
res.json({ ok: true, count: entries.length });
});

// ---------------- Employees (owner/manager) ----------------
app.get('/api/employees/pending', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
res.json(await employees.listPending());
});

// Public, unauthenticated — this is what /apply.html submits to. New hires
// enter their basic info here, right in the app, then get sent to the
// separate Jotform "hire pack" for the sensitive tax/banking half. The
// Jotform webhook below is a secondary/optional intake path, not the
// primary one.
app.post('/api/employees/pending', async (req, res) => {
const name = (req.body.name || '').trim();
if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
const position = (req.body.position || '').trim() || null;
const person = await employees.createPendingEmployee({ ...req.body, name, position });
res.json({ ok: true, person });
});

// Jotform calls this on every submission of the "Ticket Sports Bar New Hire
// Information" form, if/when that gets wired up as a secondary intake path.
// See server/jotform.js for what is (and very much is not) read out of the
// submission.
app.post('/api/webhooks/jotform-new-hire', jotform.parseBody, jotform.handleWebhook);

// Self-service profile edit — any logged-in person, any time, for their own
// row only (req.person.id, never a client-supplied id). Sensitive fields
// (tax/banking/SSN) aren't here; those stay in Jotform's hire-pack form.
app.post('/api/me/profile', auth.requireSession('light'), async (req, res) => {
const name = (req.body.name || '').trim();
if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
const person = await employees.updateOwnProfile({ personId: req.person.id, name, email: req.body.email, phone: req.body.phone });
res.json({ ok: true, person });
});

app.post('/api/employees/:id/manager-review', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const result = await employees.managerReview({ personId: req.params.id, ...req.body, reviewedBy: req.person.id });
res.json(result);
});

// Discard/reject a still-pending applicant — never touches anyone already
// activated (see discardPending's own WHERE clause).
app.post('/api/employees/:id/discard', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const result = await employees.discardPending({ personId: req.params.id });
res.json(result);
});

// Emails a link to /apply.html to someone who hasn't applied yet.
app.post('/api/employees/invite', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const toEmail = (req.body.email || '').trim();
if (!toEmail) return res.status(400).json({ ok: false, error: 'Email is required.' });
const result = await employees.sendOnboardingInvite({ toEmail, toName: (req.body.name || '').trim() || null, sentBy: req.person.id });
res.json(result);
});

// A manager sees only their own location's roster; the owner sees everyone.
app.get('/api/employees', auth.requireSession('light'), async (req, res) => {
if (req.person.role === 'owner') return res.json(await employees.listAllWithAccess());
if (req.person.role === 'manager') return res.json(await employees.listAllWithAccess(req.person.location_id));
return res.status(403).json({ error: 'Managers/owners only.' });
});

app.post('/api/employees/:id/activate', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can activate an employee.' });
const result = await employees.activateEmployee({ personId: req.params.id, appAccess: req.body.appAccess, activatedBy: req.person.id });
res.json(result);
});

app.post('/api/employees/:id/app-access', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change app access.' });
const result = await employees.setAppAccess({ personId: req.params.id, appKey: req.body.appKey, enabled: req.body.enabled, updatedBy: req.person.id });
res.json(result);
});

// Owner-only full edit — position/location/pay rate, any time, any employee.
app.post('/api/employees/:id/update', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can edit an employee directly.' });
const { position, locationId, payRate } = req.body;
const result = await employees.ownerUpdateEmployee({ personId: req.params.id, position, locationId, payRate: payRate === '' || payRate == null ? null : Number(payRate) });
res.json(result);
});

// A manager can't set pay directly — this files a request the owner decides.
app.post('/api/employees/:id/request-raise', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const requestedRate = Number(req.body.requestedRate);
if (!requestedRate || requestedRate <= 0) return res.status(400).json({ ok: false, error: 'Enter a valid pay rate.' });
const result = await employees.requestPayRaise({ personId: req.params.id, requestedRate, requestedBy: req.person.id });
res.json(result);
});

// A manager sees only pending requests for their own location; the owner
// sees every pending request, across locations.
app.get('/api/pay-rate-requests', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const locationFilter = req.person.role === 'manager' ? req.person.location_id : undefined;
res.json(await employees.listPayRateRequests({ status: req.query.status || 'pending', locationFilter }));
});

app.post('/api/pay-rate-requests/:id/decide', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can decide pay rate requests.' });
const result = await employees.decidePayRateRequest({ requestId: req.params.id, approve: !!req.body.approve, decidedBy: req.person.id, note: req.body.note });
res.json(result);
});

// A small owner-editable memo box (see server/employees.js). Managers can
// read it — that's the point, it's shown to them right where they file a
// pay-raise request — but only the owner can change it.
app.get('/api/owner-notes/:key', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
res.json(await employees.getOwnerNote(req.params.key));
});
app.post('/api/owner-notes/:key', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can edit this note.' });
const result = await employees.setOwnerNote(req.params.key, req.body.body, req.person.id);
res.json(result);
});

// ---------------- Time Clock ----------------
app.get('/api/timeclock/status', auth.requireSession('light'), async (req, res) => {
const result = await req.withAuthedClient((client) => timeclock.getStatus(client, req.person.id));
res.json(result);
});
app.post('/api/timeclock/punch', auth.requireSession('light'), async (req, res) => {
const result = await req.withAuthedClient((client) => timeclock.clockAction(client, req.person, req.body.action, req.body.memo, req.body.deviceId));
res.json(result);
});
app.get('/api/timeclock/roster', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const result = await req.withAuthedClient((client) => timeclock.getRosterStatus(client));
res.json(result);
});
app.get('/api/timeclock/pay-period', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const idx = req.query.periodIndex !== undefined ? Number(req.query.periodIndex) : undefined;
const result = await req.withAuthedClient((client) => timeclock.getPayPeriod(client, idx));
res.json(result);
});
app.post('/api/timeclock/punch/:id/edit', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const result = await req.withAuthedClient((client) => timeclock.editPunch(client, { id: req.params.id, ...req.body, editedBy: req.person.id }));
res.json(result);
});
app.post('/api/timeclock/punch/:id/delete', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const result = await req.withAuthedClient((client) => timeclock.deletePunch(client, { id: req.params.id, reason: req.body.reason, editedBy: req.person.id }));
res.json(result);
});

// ---------------- Service Calls ----------------
app.get('/api/servicecalls/equipment-types', auth.requireSession('light'), async (req, res) => {
const { rows } = await pool.query('SELECT * FROM equipment_types WHERE active = true ORDER BY sort_order, name');
res.json(rows);
});

// Admin view — includes archived equipment types too, so a manager/owner
// can restore one. Mirrors /api/positions/admin.
app.get('/api/servicecalls/equipment-types/admin', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const { rows } = await pool.query('SELECT * FROM equipment_types ORDER BY active DESC, sort_order, name');
res.json(rows);
});

// Manual reorder ("move up/below one" per Scotto) — active types only;
// archived ones don't participate and stay wherever they sort by name.
app.post('/api/servicecalls/equipment-types/:id/move', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const direction = req.body.direction;
if (direction !== 'up' && direction !== 'down') return res.status(400).json({ ok: false, error: 'Invalid direction.' });
const result = await withServiceClient(async (client) => {
const { rows: siblings } = await client.query('SELECT id, sort_order FROM equipment_types WHERE active = true ORDER BY sort_order, name');
const idx = siblings.findIndex((s) => s.id === req.params.id);
const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
if (idx === -1) return { ok: false, error: 'Not found.' };
if (swapIdx < 0 || swapIdx >= siblings.length) return { ok: true }; // already at the edge
const other = siblings[swapIdx];
await client.query('UPDATE equipment_types SET sort_order = $1 WHERE id = $2', [other.sort_order, req.params.id]);
await client.query('UPDATE equipment_types SET sort_order = $1 WHERE id = $2', [siblings[idx].sort_order, other.id]);
return { ok: true };
});
res.json(result);
});

// Equipment types are manager+owner to add/archive/restore, same as
// Positions — authorization enforced here, not RLS (equipment_types has
// none, same open-reference-data posture as locations/positions).
app.post('/api/servicecalls/equipment-types', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const name = (req.body.name || '').trim();
if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
try {
const equipment = await withServiceClient(async (client) => {
const { rows } = await client.query(
  `INSERT INTO equipment_types (name, sort_order)
   VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM equipment_types))
   RETURNING *`,
  [name]
);
return rows[0];
});
res.json({ ok: true, equipment });
} catch (e) {
if (e.code === '23505') return res.status(400).json({ ok: false, error: 'An equipment type with that name already exists.' });
throw e;
}
});

// Archive/restore rather than delete — an equipment type can be
// referenced by years of service-call history; archived types just drop
// out of the active dropdown everywhere else (see patch_012).
app.post('/api/servicecalls/equipment-types/:id/archive', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const equipment = await withServiceClient(async (client) => {
const { rows } = await client.query('UPDATE equipment_types SET active = false WHERE id = $1 RETURNING *', [req.params.id]);
return rows[0];
});
if (!equipment) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, equipment });
});

app.post('/api/servicecalls/equipment-types/:id/restore', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const equipment = await withServiceClient(async (client) => {
const { rows } = await client.query('UPDATE equipment_types SET active = true WHERE id = $1 RETURNING *', [req.params.id]);
return rows[0];
});
if (!equipment) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, equipment });
});

// Send-to destinations — replaces the old fixed maintenance/manager/both
// enum with a manager/owner-curated list, each backed by specific people
// rather than a platform-wide role (see patch_012 for the full reasoning
// — same person-based-routing idea as Systems Monitoring's alert routes).
// Public active-only list: anyone reporting a call picks from this.
app.get('/api/servicecalls/destinations', auth.requireSession('light'), async (req, res) => {
const { rows } = await pool.query('SELECT * FROM service_call_destinations WHERE active = true ORDER BY name');
res.json(rows);
});

// Admin view — every destination (active or archived) with its full
// member roster, for the Manage tab.
app.get('/api/servicecalls/destinations/admin', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
res.json(await servicecalls.listDestinationsWithMembers());
});

app.post('/api/servicecalls/destinations', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const name = (req.body.name || '').trim();
if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
try {
const destination = await withServiceClient(async (client) => {
const { rows } = await client.query('INSERT INTO service_call_destinations (name) VALUES ($1) RETURNING *', [name]);
return rows[0];
});
res.json({ ok: true, destination });
} catch (e) {
if (e.code === '23505') return res.status(400).json({ ok: false, error: 'A destination with that name already exists.' });
throw e;
}
});

app.post('/api/servicecalls/destinations/:id/archive', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const destination = await withServiceClient(async (client) => {
const { rows } = await client.query('UPDATE service_call_destinations SET active = false WHERE id = $1 RETURNING *', [req.params.id]);
return rows[0];
});
if (!destination) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, destination });
});

app.post('/api/servicecalls/destinations/:id/restore', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const destination = await withServiceClient(async (client) => {
const { rows } = await client.query('UPDATE service_call_destinations SET active = true WHERE id = $1 RETURNING *', [req.params.id]);
return rows[0];
});
if (!destination) return res.status(404).json({ ok: false, error: 'Not found.' });
res.json({ ok: true, destination });
});

// Replaces a destination's whole member set at once (simpler than
// incremental add/remove — matches the checkbox-grid + Save UI).
app.post('/api/servicecalls/destinations/:id/members', auth.requireSession('full'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const result = await servicecalls.setDestinationMembers({ destinationId: req.params.id, personIds: req.body.personIds });
res.json(result);
});

app.get('/api/servicecalls', auth.requireSession('light'), async (req, res) => {
const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
const result = await req.withAuthedClient(async (client) => {
if (!isManagerOrOwner) {
const hasAccess = await servicecalls.requireServiceCallsAccess(client, req.person.id);
if (!hasAccess) return { error: 'Service Calls isn’t turned on for your account yet — ask your manager.' };
}
const filters = {
status: req.query.status, locationId: req.query.locationId, equipmentTypeId: req.query.equipmentTypeId,
createdBy: req.query.createdBy, closedBy: req.query.closedBy, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
};
return servicecalls.listCalls(client, filters);
});
if (result && result.error) return res.status(403).json(result);
res.json(result);
});

app.get('/api/servicecalls/report.csv', auth.requireSession('light'), async (req, res) => {
if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
const rows = await req.withAuthedClient((client) => servicecalls.listCalls(client, {
status: req.query.status, locationId: req.query.locationId, equipmentTypeId: req.query.equipmentTypeId,
createdBy: req.query.createdBy, closedBy: req.query.closedBy, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
}));
res.setHeader('Content-Type', 'text/csv');
res.setHeader('Content-Disposition', 'attachment; filename="service_calls.csv"');
res.send(servicecalls.toCsv(rows));
});

// Single-call detail, including its notes — backs the "click any call,
// open/pending/closed" detail modal. Registered after every fixed-segment
// GET route above so :id doesn't shadow equipment-types/destinations/
// report.csv. Same access gate as the list route.
app.get('/api/servicecalls/:id', auth.requireSession('light'), async (req, res) => {
const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
const result = await req.withAuthedClient(async (client) => {
if (!isManagerOrOwner) {
const hasAccess = await servicecalls.requireServiceCallsAccess(client, req.person.id);
if (!hasAccess) return { error: 'Service Calls isn’t turned on for your account yet — ask your manager.' };
}
return servicecalls.getCall(client, req.params.id);
});
if (result && result.error) return res.status(403).json(result);
if (!result) return res.status(404).json({ error: 'Not found.' });
res.json(result);
});

app.post('/api/servicecalls', auth.requireSession('light'), async (req, res) => {
const result = await req.withAuthedClient((client) => servicecalls.createCall(client, req.person, req.body));
res.json(result);
});

app.post('/api/servicecalls/:id/close', auth.requireSession('light'), async (req, res) => {
const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
const result = await req.withAuthedClient(async (client) => {
if (!isManagerOrOwner) {
const hasAccess = await servicecalls.requireServiceCallsAccess(client, req.person.id);
if (!hasAccess) return { ok: false, error: 'Service Calls isn’t turned on for your account yet — ask your manager.' };
}
return servicecalls.closeCall(client, { id: req.params.id, closedBy: req.person.id, remedy: req.body.remedy });
});
res.json(result);
});

// Add a note to any call — open or closed ("all logged": every note is
// timestamped and attributed, never edited or removed). Same access gate
// as close.
app.post('/api/servicecalls/:id/notes', auth.requireSession('light'), async (req, res) => {
const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
const result = await req.withAuthedClient(async (client) => {
if (!isManagerOrOwner) {
const hasAccess = await servicecalls.requireServiceCallsAccess(client, req.person.id);
if (!hasAccess) return { ok: false, error: 'Service Calls isn’t turned on for your account yet — ask your manager.' };
}
return servicecalls.addNote(client, { callId: req.params.id, personId: req.person.id, note: req.body.note });
});
res.json(result);
});

// ---------------- Systems Monitoring ----------------
// Visibility mirrors service_calls: manager/owner bypass the employee_apps
// gate entirely (this is an ops tool, not something staff self-enable
// into); everyone else needs 'monitoring' turned on for their account.
// Row-level scoping (owner sees every location, others only their own)
// is enforced by monitored_systems' RLS policy, not here.
app.get('/api/monitoring/systems', auth.requireSession('light'), async (req, res) => {
  const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
  const result = await req.withAuthedClient(async (client) => {
    if (!isManagerOrOwner) {
      const hasAccess = await monitoring.requireMonitoringAccess(client, req.person.id);
      if (!hasAccess) return { error: 'Systems Monitoring isn’t turned on for your account yet — ask your manager.' };
    }
    return monitoring.listSystems(client, {});
  });
  if (result && result.error) return res.status(403).json(result);
  res.json(result);
});

app.get('/api/monitoring/systems/:id/history', auth.requireSession('light'), async (req, res) => {
  const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
  const result = await req.withAuthedClient(async (client) => {
    if (!isManagerOrOwner) {
      const hasAccess = await monitoring.requireMonitoringAccess(client, req.person.id);
      if (!hasAccess) return { error: 'Systems Monitoring isn’t turned on for your account yet — ask your manager.' };
    }
    return monitoring.listStatusHistory(client, req.params.id, { hours: req.query.hours ? Number(req.query.hours) : 24 });
  });
  if (result && result.error) return res.status(403).json(result);
  res.json(result);
});

app.get('/api/monitoring/alerts', auth.requireSession('light'), async (req, res) => {
  const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
  const result = await req.withAuthedClient(async (client) => {
    if (!isManagerOrOwner) {
      const hasAccess = await monitoring.requireMonitoringAccess(client, req.person.id);
      if (!hasAccess) return { error: 'Systems Monitoring isn’t turned on for your account yet — ask your manager.' };
    }
    return monitoring.listAlerts(client, { openOnly: req.query.openOnly === 'true' });
  });
  if (result && result.error) return res.status(403).json(result);
  res.json(result);
});

// Owner/manager only — monitored_systems has no INSERT/UPDATE policy for
// barplatform_app (same reasoning as locations/positions), so these go
// through the service client with the role check enforced right here.
app.post('/api/monitoring/systems', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const { locationId, category, kind, name, externalRef, config, make, model, serialNumber } = req.body;
  const result = await monitoring.addSystem({ locationId, category, kind, name, externalRef, config, make, model, serialNumber, addedBy: req.person.id });
  res.json(result);
});

app.post('/api/monitoring/systems/:id/archive', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const result = await monitoring.archiveSystem(req.params.id);
  res.json(result);
});

app.post('/api/monitoring/systems/:id/update', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const { locationId, category, kind, name, make, model, serialNumber } = req.body;
  const result = await monitoring.updateSystem({ id: req.params.id, locationId, category, kind, name, make, model, serialNumber });
  res.json(result);
});

app.post('/api/monitoring/systems/:id/move', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const result = await monitoring.moveSystem(req.params.id, req.body.direction);
  res.json(result);
});

// Self-service notification channel preference (email/sms/both) — same
// trust boundary as /api/me/profile.
app.get('/api/monitoring/notify-settings', auth.requireSession('light'), async (req, res) => {
  res.json(await monitoring.getNotifySettings(req.person.id));
});
app.post('/api/monitoring/notify-settings', auth.requireSession('light'), async (req, res) => {
  const result = await monitoring.setNotifyChannel(req.person.id, req.body.channel);
  res.json(result);
});

// Alert routing admin — "notify this person about this category at this
// location" — independent of that person's own Monitoring dashboard
// access. A manager is scoped to their own location (their assignments
// plus any all-location ones); the owner sees and can create any route.
app.get('/api/monitoring/alert-routes', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const locationFilter = req.person.role === 'manager' ? req.person.location_id : undefined;
  res.json(await monitoring.listAlertRoutes({ locationFilter }));
});
app.post('/api/monitoring/alert-routes', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  // A manager can only route alerts for their own location, even if the
  // request body tries to say otherwise; the owner can route any location
  // or leave it blank for "every location".
  const locationId = req.person.role === 'owner' ? (req.body.locationId || null) : req.person.location_id;
  const result = await monitoring.addAlertRoute({ personId: req.body.personId, locationId, category: req.body.category || null, addedBy: req.person.id });
  res.json(result);
});
app.post('/api/monitoring/alert-routes/:id/remove', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const result = await monitoring.removeAlertRoute(req.params.id);
  res.json(result);
});

// ---------------- Scheduling ----------------
// Shift model: Schedule (roster/crew under a Location) x Position
// (qualification) x Employee. Manager-scoped via manager_schedules (not
// people.role) — the owner can manage every schedule regardless; a
// manager only manages schedules they're explicitly assigned to. See
// server/scheduling.js's header comment and db/patch_014 for the full
// design writeup (ported from the old Google Apps Script "TSB Scheduling"
// system, reviewed 2026-09-02).
//
// Self-service routes (my shifts, my availability, my time-off requests)
// use the same isManagerOrOwner-bypass / employee_apps.scheduling-gate
// pattern as Service Calls/Monitoring: a manager or owner always has
// access as part of their role, anyone else needs Scheduling turned on
// for their account.
//
// Schedule creation/rename/archive and the employee qualification-matrix
// writes (which schedules/positions an employee is checked into, which
// schedules a manager can manage) are owner-only here — those wholesale-
// replace an employee's whole assignment set (see setEmployeeSchedule
// Qualifications etc. in scheduling.js), and a manager saving with only
// their own manageable schedules in view would silently wipe that
// employee's assignments to schedules outside the manager's scope. Once
// there's a real need for delegated qualification-matrix editing this
// will need scoped merge logic, not a wider role check.
async function requireSelfServiceSchedulingAccess(req, res) {
  const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
  if (isManagerOrOwner) return true;
  const hasAccess = await scheduling.requireSchedulingAccess(req.person.id);
  if (!hasAccess) {
    res.status(403).json({ error: 'Scheduling isn’t turned on for your account yet — ask your manager.', ok: false });
    return false;
  }
  return true;
}

// Manager/owner scheduler bootstrap — schedules they manage (or every
// schedule, for the owner), the full employee roster with qualification
// matrices, and their pending-time-off count for the tile badge.
app.get('/api/scheduling/bootstrap', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await scheduling.getSchedulingBootstrapData(req.person));
});

// ---- Schedules (admin) ----
app.get('/api/scheduling/schedules/admin', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await scheduling.listSchedules());
});
app.post('/api/scheduling/schedules', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can add or rename a schedule.' });
  res.json(await scheduling.saveSchedule({ id: req.body.id, locationId: req.body.locationId, name: req.body.name }));
});
app.post('/api/scheduling/schedules/:id/archive', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can archive a schedule.' });
  res.json(await scheduling.archiveSchedule(req.params.id));
});
app.post('/api/scheduling/schedules/:id/restore', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can restore a schedule.' });
  res.json(await scheduling.restoreSchedule(req.params.id));
});

// ---- Employee qualification matrix (admin) ----
app.get('/api/scheduling/employees', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await scheduling.getEmployeesForScheduling());
});
app.post('/api/scheduling/employees/:id/schedules', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change which schedules an employee is checked into.' });
  res.json(await scheduling.setEmployeeScheduleQualifications(req.params.id, req.body.scheduleIds));
});
app.post('/api/scheduling/employees/:id/positions', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change an employee’s scheduling positions.' });
  res.json(await scheduling.setEmployeePositionQualifications(req.params.id, req.body.positionIds));
});
app.post('/api/scheduling/employees/:id/managed-schedules', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change which schedules a manager oversees.' });
  res.json(await scheduling.setManagerScheduleAssignments(req.params.id, req.body.scheduleIds));
});

// ---- Scheduler (manager/owner) — live shifts + this manager's own draft
// overlay, scoped to schedules they actually manage (the owner sees any
// requested schedule; a manager's request is filtered down to their own
// manageable set, silently dropping anything else). ----
app.get('/api/scheduling/week', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  if (!req.query.weekStart) return res.status(400).json({ error: 'weekStart is required.' });
  const requested = (req.query.scheduleIds || '').split(',').filter(Boolean);
  const manageable = await scheduling.getMyManageableScheduleIds(req.person);
  const scheduleIds = requested.length ? requested.filter((id) => manageable.includes(id)) : manageable;
  if (!scheduleIds.length) return res.json([]);
  res.json(await scheduling.getWeekShiftsWithDrafts(scheduleIds, req.query.weekStart, req.person.id));
});

// Print/multi-week view — published shifts only (no draft overlay), 1-3
// weeks starting at weekStart, scoped to schedules this manager/owner
// actually manages (same filtering as /week above).
app.get('/api/scheduling/print', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  if (!req.query.weekStart) return res.status(400).json({ error: 'weekStart is required.' });
  const requested = (req.query.scheduleIds || '').split(',').filter(Boolean);
  const manageable = await scheduling.getMyManageableScheduleIds(req.person);
  const scheduleIds = requested.length ? requested.filter((id) => manageable.includes(id)) : manageable;
  if (!scheduleIds.length) return res.json([]);
  res.json(await scheduling.getShiftsForPrint(scheduleIds, req.query.weekStart, req.query.weeks));
});

app.get('/api/scheduling/my-drafts/summary', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await scheduling.getMyDraftSummary(req.person.id));
});

app.post('/api/scheduling/drafts', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const manageable = await scheduling.getMyManageableScheduleIds(req.person);
  if (!manageable.includes(req.body.scheduleId)) return res.status(403).json({ ok: false, error: 'You don’t manage that schedule.' });
  res.json(await scheduling.saveDraftShift(req.body, req.person.id));
});
app.post('/api/scheduling/drafts/cancel', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await scheduling.draftCancelShift(req.body, req.person.id));
});
app.post('/api/scheduling/drafts/discard', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await scheduling.discardMyDrafts(req.person.id));
});
app.post('/api/scheduling/drafts/duplicate', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const manageable = await scheduling.getMyManageableScheduleIds(req.person);
  if (!manageable.includes(req.body.scheduleId)) return res.status(403).json({ ok: false, error: 'You don’t manage that schedule.' });
  res.json(await scheduling.draftDuplicateShift(req.body, req.body.targetDates || [], req.person.id));
});

// "Copy this week forward" — per employee (Scotto's explicit call, not a
// whole-Schedule bulk copy — see scheduling.js's copyWeekForwardForEmployee).
app.post('/api/scheduling/copy-week-forward', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  if (!req.body.personId || !req.body.weekStart) return res.status(400).json({ ok: false, error: 'personId and weekStart are required.' });
  res.json(await scheduling.copyWeekForwardForEmployee({ personId: req.body.personId, weekStartISO: req.body.weekStart, createdBy: req.person.id }));
});

// Publish — validates this manager's entire draft batch, applies it if
// clean, and notifies affected employees (email + SMS). Gated the same
// as every other sensitive write (requireSession('full')); per Scotto,
// no extra step-up prompt on top of that — the client just shows a plain
// "Are you sure?" confirm before calling this.
app.post('/api/scheduling/publish', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await scheduling.publishMyDrafts(req.body.overrideReasons || {}, req.person.id));
});

// ---- Time off ----
app.get('/api/scheduling/time-off/pending-count', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json({ count: await scheduling.getPendingTimeOffCountForManager(req.person) });
});
app.get('/api/scheduling/time-off/to-approve', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await scheduling.getTimeOffRequestsICanApprove(req.person));
});
app.get('/api/scheduling/time-off/all', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await scheduling.getAllTimeOffRequestsIManage(req.person));
});
app.post('/api/scheduling/time-off/:id/decide', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const decision = req.body.approve ? 'approved' : 'denied';
  res.json(await scheduling.decideTimeOffRequest(req.params.id, decision, req.person));
});

// Self-service — any employee with Scheduling turned on (managers/owners
// always allowed, same as everywhere else in this app).
app.get('/api/scheduling/time-off/mine', auth.requireSession('light'), async (req, res) => {
  if (!(await requireSelfServiceSchedulingAccess(req, res))) return;
  res.json(await scheduling.getMyTimeOffRequests(req.person.id));
});
app.post('/api/scheduling/time-off', auth.requireSession('light'), async (req, res) => {
  if (!(await requireSelfServiceSchedulingAccess(req, res))) return;
  res.json(await scheduling.submitTimeOffRequest(req.person, req.body));
});

// ---- Availability (pure self-service) ----
app.get('/api/scheduling/availability/mine', auth.requireSession('light'), async (req, res) => {
  if (!(await requireSelfServiceSchedulingAccess(req, res))) return;
  res.json(await scheduling.getMyAvailability(req.person.id));
});
app.post('/api/scheduling/availability', auth.requireSession('light'), async (req, res) => {
  if (!(await requireSelfServiceSchedulingAccess(req, res))) return;
  res.json(await scheduling.saveMyAvailabilityRow(req.body, req.person.id));
});
app.post('/api/scheduling/availability/:id/delete', auth.requireSession('light'), async (req, res) => {
  if (!(await requireSelfServiceSchedulingAccess(req, res))) return;
  res.json(await scheduling.deleteMyAvailabilityRow(req.params.id, req.person.id));
});

// ---- Employee portal: my shifts ----
app.get('/api/scheduling/my-shifts', auth.requireSession('light'), async (req, res) => {
  if (!(await requireSelfServiceSchedulingAccess(req, res))) return;
  if (!req.query.weekStart) return res.status(400).json({ error: 'weekStart is required.' });
  res.json(await scheduling.getMyAllShiftsForWeek(req.person.id, req.query.weekStart));
});
app.get('/api/scheduling/my-shifts/upcoming', auth.requireSession('light'), async (req, res) => {
  if (!(await requireSelfServiceSchedulingAccess(req, res))) return;
  res.json(await scheduling.getEmployeeUpcomingShifts(req.person.id));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Bar platform listening on http://localhost:${PORT}`));

// Daily safety net, same idea as the Apps Script midnight trigger.
// Runs with no logged-in person, so it has to use the service client —
// a plain pool.connect() here (barplatform_app, no session vars set)
// silently matches zero rows under time_entries' RLS policies, which
// are scoped to current_person_id()/current_role_name(). That made this
// job a silent no-op: it looked fine (no errors, no crash), it just never
// actually closed out any stale shifts.
setInterval(async () => {
const now = new Date();
if (now.getHours() === 0 && now.getMinutes() < 5) {
await withServiceClient(async (client) => {
const n = await timeclock.autoClockOutStale(client);
if (n > 0) console.log(`Auto clocked out ${n} stale shift(s).`);
});
}
}, 4 * 60 * 1000);

// Systems Monitoring — poll every 60s. A no-op until UNIFI_API_KEY is set
// and at least one 'unifi_*' system is registered (see
// monitoring.pollUnifiSystems), so this is safe to run from deploy day
// even with an empty registry.
setInterval(() => {
monitoring.pollUnifiSystems().catch((err) => console.error('[monitoring] poll cycle error', err));
}, 60 * 1000);
