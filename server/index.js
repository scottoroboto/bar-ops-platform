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

// Phase 0 config is just the site shell (name/timezone/scan_ranges) so the
// agent has something real to poll and cache -- sources/tvs/etc join in
// starting Phase 2. ETag keeps the 30s poll near-free when nothing changed.
app.get('/api/venue/agent/config', requireAgentAuth(), async (req, res) => {
const config = {
schema_version: 1,
site: {
location_id: req.vcSite.location_id,
name: req.vcSite.location_name,
timezone: req.vcSite.timezone,
scan_ranges: req.vcSite.scan_ranges,
},
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
const { rows } = await client.query(
`INSERT INTO vc_sources (site_id, slot, qam_channel, label, kind, ip, mac)
   VALUES ($1,$2,$3,$4,$5,$6,$7)
   RETURNING *`,
[req.vcSite.site_id, fields.slot, fields.qamChannel, fields.label || 'Unnamed source', fields.kind || 'directv',
 fields.ip || null, fields.mac || null]
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
