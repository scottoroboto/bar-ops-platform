// Venue Control on-site agent -- Phase 0 (docs/venue-control.md §12):
// registration, config pull, heartbeat, local UI shell, admin PIN scaffold.
// Runs on a box on the bar's own LAN (Pi, mini PC, NAS, old laptop --
// anything with Node 18+; see README.md). Talks to the cloud outbound-only.
const express = require('express');
const path = require('path');
const config = require('./config');
const cache = require('./lib/cache');
const sync = require('./lib/sync');
const discovery = require('./lib/discovery');
const poller = require('./lib/poller');
const tvPoller = require('./lib/tv-poller');
const health = require('./lib/health');
const speedtest = require('./lib/speedtest');
const sonos = require('./lib/sonos');
const pandora = require('./lib/pandora');
const lights = require('./lib/lights');
const scheduler = require('./lib/scheduler');
const layouts = require('./lib/layouts');
const events = require('./lib/events');
const activity = require('./lib/activity');
const directv = require('./lib/drivers/directv');
const roku = require('./lib/drivers/roku');
const samsungWs = require('./lib/drivers/samsung-ws');
const { driverFor, KEY_METHODS } = require('./lib/drivers'); // Samsung or LG per TV (cloud patch_039)

const app = express();
app.use(express.json());
// no-cache: iPads check for a newer copy on every load (a quick 304 when
// nothing changed), so a git pull reaches the bar iPad at once instead of
// Safari reusing old page code for days.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const START_TIME = Date.now();

// Read-only, nothing sensitive in it -- the local status page (and Scotto,
// during setup) polls this to see whether the box is actually talking to
// the cloud, not just powered on.
app.get('/api/status', (req, res) => {
  res.json({
    uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
    cloudUrl: config.CLOUD_URL,
    hasToken: !!config.AGENT_TOKEN,
    registration: cache.get('registration'),
    site: cache.get('config'),
    lastRegisterAt: cache.get('lastRegisterAt'),
    lastConfigCheckAt: cache.get('lastConfigCheckAt'),
    lastHeartbeatAt: cache.get('lastHeartbeatAt'),
    lastHeartbeatOk: cache.get('lastHeartbeatOk'),
  });
});

// Admin PIN gate for admin-only local routes (discovery, backup, restore --
// per §11: "Discovery is admin-only by design"). As of Phase 1, this
// actually guards something real: /api/discovery/* below runs a network
// scan and can adopt/write devices into TSB Platform. If ADMIN_PIN is left
// unset in .env, this gate is a no-op and those routes are open to anyone
// on the LAN -- see the warning in .env.example. Set a real PIN before
// running discovery for real.
function requireAdminPin(req, res, next) {
  req.vcActor = 'admin'; // Phase 5 (lib/activity.js): who to blame in the audit log for this request
  if (!config.ADMIN_PIN) return next();
  const pin = req.get('x-admin-pin') || req.query.pin;
  if (pin !== config.ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN.' });
  next();
}
app.use('/api/admin', requireAdminPin);

// Staff PIN gate for day-to-day control routes (docs/venue-control.md §11:
// "Staff PIN for control routes; separate admin PIN for discovery, backup,
// restore, and configuration"). An admin PIN also satisfies this gate --
// the owner already has to remember that one, no reason to make them keep a
// second PIN in their head too -- but a staff PIN does NOT satisfy the
// admin gate above (staff shouldn't be able to run a network scan). If
// neither PIN is set in .env, this is a no-op, same documented gap as
// requireAdminPin -- see the warning in .env.example.
// patch_036 (cloud): the pass. base64url(JSON).hexHMAC, signed by the
// cloud with sha256(AGENT_TOKEN) — the same value it stores as this
// site's agent_token_hash. Checked here with no round trip, so a pass
// keeps working through an internet outage until its exp. See
// server/tvpass.js in the cloud repo for the minting side.
const crypto = require('crypto');
const PASS_KEY = config.AGENT_TOKEN ? crypto.createHash('sha256').update(config.AGENT_TOKEN).digest('hex') : '';
function verifyPass(pass) {
  if (!PASS_KEY || typeof pass !== 'string') return null;
  const dot = pass.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = pass.slice(0, dot), sig = pass.slice(dot + 1);
  const expect = crypto.createHmac('sha256', PASS_KEY).update(payload).digest('hex');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!data || data.v !== 1 || !(data.exp > Date.now())) return null;
  const site = (cache.get('config') || {}).site;
  const siteId = site ? (site.id != null ? site.id : site.site_id) : null;
  if (siteId != null && Number(siteId) !== Number(data.siteId)) return null;
  // A bar iPad the owner removed in TV Admin (patch_053).
  if (data.actor === 'device' && ((cache.get('config') || {}).revoked_bar_ipads || []).includes(data.deviceId)) return null;
  return data;
}
function requireStaffPin(req, res, next) {
  // A pass from the cloud (TV Staff in the Bar Ops app) is the normal way
  // in. The name on it is the actor in the activity log.
  const passData = verifyPass(req.get('x-staff-pass') || req.query.pass);
  if (passData) {
    req.vcActor = passData.actor === 'admin' ? 'admin' : (passData.name || 'staff');
    req.vcPass = passData;
    return next();
  }
  // Below: the old PINs, kept only as a setup/emergency path for a box whose
  // .env still sets one. With no PIN set, a missing or bad pass is a 401.
  if (!config.STAFF_PIN && !config.ADMIN_PIN) return res.status(401).json({ error: 'PASS_REQUIRED', message: 'Open the TVs from the Bar Ops app (TV Staff).' });
// Phase 5 (lib/activity.js): who to blame in the audit log for this
// request. Set before the PIN check itself so a matched admin PIN (which
// also satisfies this gate, per the comment above) is correctly tagged
// "admin" rather than "staff" -- see the ok check below.
req.vcActor = (config.ADMIN_PIN && (req.get('x-staff-pin') || req.query.pin) === config.ADMIN_PIN) ? 'admin' : 'staff';
const pin = req.get('x-staff-pin') || req.query.pin;
const ok = (config.STAFF_PIN && pin === config.STAFF_PIN) || (config.ADMIN_PIN && pin === config.ADMIN_PIN);
if (!ok) return res.status(401).json({ error: 'PASS_REQUIRED', message: 'Open the TVs from the Bar Ops app (TV Staff).' });
next();
}
app.use('/api/sources', requireStaffPin);
app.use('/api/favorites', requireStaffPin);
app.use('/api/tvs', requireStaffPin);
app.use('/api/zones', requireStaffPin);
app.use('/api/layouts', requireStaffPin);
app.use('/api/events', requireStaffPin);
app.use('/api/scenes', requireStaffPin);
app.use('/api/attention', requireStaffPin);
app.use('/api/music', requireStaffPin);
app.use('/api/lights', requireStaffPin);
app.use('/api/manager', requireStaffPin);

// Manager button on the staff pages (bar iPads): list the owner + managers
// at this bar, check a PIN through the cloud, hand back their short pass.
app.get('/api/manager/people', async (req, res) => {
  try { res.json({ people: await sync.managerList() }); }
  catch (err) { res.status(502).json({ error: `Manager sign-in needs the internet: ${err.message}` }); }
});
app.post('/api/manager/sign-in', async (req, res) => {
  const { personId, pin } = req.body || {};
  try {
    const r = await sync.managerPass(personId, pin);
    activity.record('manager.sign_in', { actor: r.name, targetType: 'staff', targetId: null, detail: { on: req.vcActor } });
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------------- Lights (lib/lights.js, cloud patch_049) ----------------
// The Lights tab: every named plug with live on/off + watts, the routines
// with tonight's times, and today's sunset/dusk. A tap holds until that
// plug's next scheduled change.
app.get('/api/lights', (req, res) => res.json(lights.view()));

app.post('/api/lights/power', async (req, res) => {
  const b = req.body || {};
  const on = b.on === true || b.on === 'on';
  const named = (cache.get('config') || {}).plugs ? (cache.get('config').plugs || []).filter((p) => p.name) : [];
  let ids;
  if (b.all) ids = named.map((p) => p.id);
  else if (b.group) ids = named.filter((p) => (p.group_name || 'Lights') === b.group).map((p) => p.id);
  else ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((id) => named.some((p) => p.id === id));
  if (!ids.length) return res.status(400).json({ error: 'No lights picked.' });
  const r = await lights.setPower(ids, on, { by: req.vcActor });
  activity.record(`lights.${on ? 'on' : 'off'}`, { actor: req.vcActor, targetType: 'plug', targetId: ids.length === 1 ? ids[0] : null, detail: { count: ids.length, group: b.group || null, all: !!b.all, failed: r.failed }, result: r.ok ? 'ok' : 'partial' });
  res.json({ ok: r.ok, failed: r.failed, view: lights.view() });
});

app.post('/api/lights/:id/blink', async (req, res) => {
  try {
    await lights.blink(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// "Run ON" / "Run OFF" on a routine card: its lights now, holding until the
// routine's next time.
app.post('/api/lights/routines/:id/run', async (req, res) => {
  const on = !!(req.body && (req.body.on === true || req.body.on === 'on'));
  const ids = lights.routinePlugIds(Number(req.params.id));
  if (!ids.length) return res.status(400).json({ error: 'This routine has no lights yet.' });
  const r = await lights.setPower(ids, on, { by: req.vcActor });
  activity.record(`lights.routine.run_${on ? 'on' : 'off'}`, { actor: req.vcActor, targetType: 'light_routine', targetId: Number(req.params.id), detail: { count: ids.length, failed: r.failed }, result: r.ok ? 'ok' : 'partial' });
  res.json({ ok: r.ok, failed: r.failed, view: lights.view() });
});

// The plug sheet's schedule: follow a routine, its own times, or none.
// Saved in the cloud (the list lives there) and pulled straight back down.
app.post('/api/lights/:id/schedule', async (req, res) => {
  try {
    await sync.plugScheduleWrite(Number(req.params.id), (req.body || {}).schedule, req.vcActor);
    res.json({ ok: true, view: lights.view() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- Music (lib/sonos.js) ----------------
// Now playing + the station tiles (Sonos favorites) for the staff Music
// page and the strip on every staff page. Volume is deliberately absent.
// One station list from two places: every station on the bar's Pandora
// account (lib/pandora.js, when linked) and whatever is in My Sonos. A
// Pandora station that's also a favorite plays through the favorite;
// one that isn't plays by its id ("P:<id>"). Pandora stations are keyed
// by station id, so favorites lists and Deleted stations match either way.
function musicStations() {
  const favs = sonos.getFavorites();
  const favByKey = new Map();
  for (const f of favs) { const k = sonos.pandoraStationId(f.uri); if (k) favByKey.set(k, f); }
  const out = [];
  const seen = new Set();
  for (const s of pandora.getStations()) {
    const key = `ST:${String(s.stationId).toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fav = favByKey.get(key);
    out.push({ id: fav ? fav.id : `P:${s.stationId}`, title: s.name, art: s.art || (fav && fav.art) || null, service: 'Pandora', uri: `x-sonosapi-radio:ST%3a${key.slice(3)}`, key, shuffle: !!s.shuffle });
  }
  for (const f of favs) {
    const k = sonos.pandoraStationId(f.uri);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push({ id: f.id, title: f.title, art: f.art, service: f.service, uri: k ? `x-sonosapi-radio:ST%3a${k.slice(3)}` : f.uri, key: k || String(f.uri).split('?')[0] });
  }
  return out;
}
function currentStationId(stations) {
  const key = sonos.currentStationKey();
  const hit = key && stations.find((s) => s.key === key);
  return hit ? hit.id : null;
}

app.get('/api/music/state', async (req, res) => {
  const st = sonos.getState();
  const config = cache.get('config') || {};
  const hidden = config.music_hidden || [];
  const hiddenUris = new Set(hidden.map((h) => h.uri));
  const all = musicStations();
  res.json({
    ...st,
    favorites: all.filter((f) => !hiddenUris.has(f.uri)),
    hiddenStations: all.filter((f) => hiddenUris.has(f.uri)).map((f) => ({ ...f, hidden_by: (hidden.find((h) => h.uri === f.uri) || {}).hidden_by })),
    lists: config.music_lists || [],
    currentFavoriteId: currentStationId(all),
    pandora: pandora.status(),
    isOwner: req.vcActor === 'admin',
  });
});
// ---- favorites lists (patch_040): written to the cloud through lib/sync.js
function musicActor(req) { return req.vcActor === 'admin' ? 'owner' : (req.vcActor || 'staff'); }
function ownerOnly(req, res) {
  if (req.vcActor !== 'admin') { res.status(403).json({ error: 'Only the owner can remove things for good.' }); return false; }
  return true;
}
app.post('/api/music/lists', async (req, res) => {
  try {
    const r = await sync.musicWrite('/lists', { name: req.body && req.body.name, copyOf: req.body && req.body.copyOf, actor: musicActor(req) });
    activity.record('music.list.create', { actor: req.vcActor, targetType: 'music', targetId: r.id, detail: { name: req.body && req.body.name, copyOf: req.body && req.body.copyOf } });
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/music/lists/:id/stations', async (req, res) => {
  try {
    const r = await sync.musicWrite(`/lists/${encodeURIComponent(req.params.id)}/stations`, { add: req.body && req.body.add, remove: req.body && req.body.remove });
    activity.record('music.list.stations', { actor: req.vcActor, targetType: 'music', targetId: req.params.id, detail: { add: req.body && req.body.add && req.body.add.title, remove: req.body && req.body.remove } });
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/music/lists/:id/:op(delete|restore|purge)', async (req, res) => {
  if (req.params.op === 'purge' && !ownerOnly(req, res)) return;
  try {
    const r = await sync.musicWrite(`/lists/${encodeURIComponent(req.params.id)}/${req.params.op}`, { actor: musicActor(req) });
    activity.record('music.list.' + req.params.op, { actor: req.vcActor, targetType: 'music', targetId: req.params.id, detail: {} });
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/music/hidden/:op(hide|restore|purge)', async (req, res) => {
  const { uri, title, favoriteId } = req.body || {};
  if (req.params.op === 'purge' && !ownerOnly(req, res)) return;
  try {
    if (req.params.op === 'purge' && favoriteId && String(favoriteId).startsWith('FV:')) await sonos.removeFavorite(String(favoriteId));
    const r = await sync.musicWrite(`/hidden/${req.params.op}`, { uri, title, actor: musicActor(req) });
    activity.record('music.station.' + req.params.op, { actor: req.vcActor, targetType: 'music', targetId: null, detail: { title } });
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/music/refresh', async (req, res) => {
  try { await sonos.readState(); await sonos.readFavorites(true); } catch (e) { /* state carries the error */ }
  await pandora.refresh().catch(() => {});
  res.json({ ok: true });
});
app.post('/api/music/:action(play|pause|next|previous)', async (req, res) => {
  const map = { play: 'Play', pause: 'Pause', next: 'Next', previous: 'Previous' };
  try {
    const st = await sonos.transport(map[req.params.action]);
    activity.record('music.' + req.params.action, { actor: req.vcActor, targetType: 'music', targetId: null, detail: {} });
    res.json({ ok: true, state: st });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// "+ Add station": search Pandora, then make a station from a result and
// start it on the Sonos.
app.get('/api/music/pandora/search', async (req, res) => {
  if (!pandora.enabled()) return res.status(400).json({ error: 'This box isn’t linked to a Pandora account yet.' });
  try { res.json({ results: await pandora.search(req.query.q) }); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/music/pandora/add', async (req, res) => {
  if (!pandora.enabled()) return res.status(400).json({ error: 'This box isn’t linked to a Pandora account yet.' });
  const { pandoraId, name } = req.body || {};
  try {
    const st = await pandora.createStation(pandoraId);
    activity.record('music.station.create', { actor: req.vcActor, targetType: 'music', targetId: null, detail: { from: name || pandoraId, station: st.name } });
    let playing = true;
    let playError = null;
    try { await sonos.playPandoraStation(st); } catch (e) { playing = false; playError = e.message; }
    res.json({ ok: true, station: { id: `P:${st.stationId}`, title: st.name, art: st.art }, playing, playError });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/music/station', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing station "id".' });
  try {
    let r;
    if (String(id).startsWith('P:')) {
      const s = pandora.stationById(String(id).slice(2));
      if (!s) return res.status(404).json({ error: 'That station is no longer on the Pandora account.' });
      r = await sonos.playPandoraStation(s);
    } else {
      r = await sonos.playFavorite(String(id));
    }
    activity.record('music.station', { actor: req.vcActor, targetType: 'music', targetId: null, detail: { station: r.station } });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- Attention: TVs the bar should look at (cloud patch_034) ----------------
// The cloud flags a TV that has been unreachable 3+ minutes inside TV
// hours; the staff TVs page shows it with three buttons. Turn On is the
// same power-on as the TV Remote, followed by an immediate health push so
// the cloud clears the flag as soon as the set answers. Clear and Service
// call are relayed to the cloud with the site token; the cloud replies
// with the refreshed list, which we cache and hand straight back.
app.get('/api/attention', (req, res) => {
  res.json({ attention: health.getAttention(), at: cache.get('attentionAt') || null });
});
app.post('/api/attention/:systemId/turn-on', async (req, res) => {
  const item = health.getAttention().find((a) => String(a.systemId) === String(req.params.systemId));
  if (!item) return res.status(404).json({ error: 'That TV is no longer flagged.' });
  let tv;
  try { tv = findTv(item.tvId); } catch (err) { return res.status(400).json({ error: err.message }); }
  const result = await driverFor(tv).setPower(tv, 'on');
  maybeReportToken(tv, result);
  const live = await tvPoller.pollNow(tv.id).catch(() => null);
  activity.record('tv.power', { actor: req.vcActor, targetType: 'tv', targetId: tv.id, detail: { state: 'on', via: 'attention' }, result: result.ok ? 'ok' : 'failed' });
  await health.reportOnce().catch(() => {});
  res.json({ ok: result.ok, state: result.state, method: result.method, live, attention: health.getAttention() });
});
function attentionTvId(systemId) {
  const item = health.getAttention().find((a) => String(a.systemId) === String(systemId));
  return item ? item.tvId : null;
}
app.post('/api/attention/:systemId/clear', async (req, res) => {
  const tvId = attentionTvId(req.params.systemId);
  try {
    const data = await sync.clearAlert(req.params.systemId, req.body.duration);
    if (Array.isArray(data.attention)) health.rememberAttention(data.attention);
    activity.record('tv.alert_clear', { actor: req.vcActor, targetType: 'tv', targetId: tvId, detail: { duration: req.body.duration }, result: 'ok' });
    res.json({ ok: true, silencedUntil: data.silencedUntil, attention: health.getAttention() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/attention/:systemId/service-call', async (req, res) => {
  const tvId = attentionTvId(req.params.systemId);
  try {
    const data = await sync.serviceCall(req.params.systemId);
    if (Array.isArray(data.attention)) health.rememberAttention(data.attention);
    activity.record('tv.service_call', { actor: req.vcActor, targetType: 'tv', targetId: tvId, detail: { serviceCallId: data.serviceCallId }, result: 'ok' });
    res.json({ ok: true, serviceCallId: data.serviceCallId, already: !!data.already, attention: health.getAttention() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- Discovery & Diagnostics (Phase 1, docs/venue-control.md §9) ----------------
// Owner/admin only per §9's own opening line -- gated by the same admin PIN
// as /api/admin/*, matching §8.2's explicit route list ("Admin-scoped
// routes (/api/discovery/*, /api/backup/*, /api/restore) require the admin
// PIN"). A network scan and device adoption are setup/troubleshooting
// actions, not day-to-day staff control, so this stays behind the PIN even
// though it isn't nested under /api/admin/ in the URL (the spec's own path
// spelling is kept as-is rather than moved under /api/admin for tidiness).
app.use('/api/discovery', requireAdminPin);

// §8.2: "Admin-scoped routes (/api/discovery/*, /api/backup/*, /api/
// restore) require the admin PIN." /api/backups (list, for the restore
// picker) isn't in that literal route list but carries the same
// sensitivity, so it's gated the same way.
app.use('/api/backup', requireAdminPin);
app.use('/api/backups', requireAdminPin);
app.use('/api/restore', requireAdminPin);

app.post('/api/discovery/scan', async (req, res) => {
  try {
    const { ranges, deep } = req.body || {};
    const effectiveRanges = Array.isArray(ranges) && ranges.length
      ? ranges
      : (cache.get('config') || {}).site?.scan_ranges;
    if (!Array.isArray(effectiveRanges) || !effectiveRanges.length) {
      return res.status(400).json({ error: 'No scan ranges given and none are configured for this site yet -- pass { "ranges": ["192.168.1.0/24"] } or set scan_ranges on the site.' });
    }
    const run = await discovery.runScan({ ranges: effectiveRanges, deep: !!deep });
    res.json({ ok: true, run });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/discovery/runs/:id', (req, res) => {
  const run = discovery.getRun(req.params.id === 'latest' ? 'latest' : Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'No discovery run found with that id.' });
  res.json(run);
});

app.post('/api/discovery/runs/:id/resync', async (req, res) => {
  try {
    const run = await discovery.resyncRun(req.params.id === 'latest' ? 'latest' : Number(req.params.id));
    res.json({ ok: true, run });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/discovery/test', async (req, res) => {
  try {
    const { run_id, targets, test } = req.body || {};
    if (!test) return res.status(400).json({ error: 'Missing "test" -- one of identity, power_state, round_trip, pair, wol, power_cycle, channel.' });
    if (!targets) return res.status(400).json({ error: 'Missing "targets" -- an IP, a list of IPs, or "all".' });
    const result = await discovery.runTest({ runId: run_id, targets, test });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/discovery/adopt', async (req, res) => {
  try {
    const { run_id, ip, device_id, as, ...fields } = req.body || {};
    if (!ip && !device_id) return res.status(400).json({ error: 'Missing "ip" or "device_id" identifying which discovered device to adopt.' });
    const adopted = await discovery.adopt({ runId: run_id, deviceIp: ip, deviceCloudId: device_id, as, fields });
    res.json({ ok: true, adopted });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- Source control (Phase 2, docs/venue-control.md §7.1/§8.2) ----------------
// Staff-facing -- gated by requireStaffPin above, not requireAdminPin.
// Reads receiver metadata from the synced site config (cache.get('config'),
// refreshed every 30s by lib/sync.js) and talks to receivers through
// lib/drivers/directv.js; live tuned/mode state comes from lib/poller.js's
// in-memory cache rather than a fresh SHEF call on every page load.
// Phase 6: generalized from directv-only to any source kind with a real
// driver (directv, roku) -- static/spare are idle slots with nothing to
// control and are rejected here the same way a missing device used to be.
// Callers that need one specific kind (tune/proginfo are DirecTV-only;
// apps/launch are Roku-only) layer requireKind() on top of this.
function findSource(slotParam) {
  const slot = Number(slotParam);
  const config = cache.get('config') || {};
  const source = (config.sources || []).find((s) => Number(s.slot) === slot);
  if (!source) throw new Error(`No source at slot ${slotParam}.`);
  if (source.kind !== 'directv' && source.kind !== 'roku') throw new Error(`Source at slot ${slotParam} is a "${source.kind}" -- nothing to control (static/spare slots have no driver).`);
  if (!source.ip) throw new Error(`Source at slot ${slotParam} has no IP address configured yet.`);
  return source;
}

function requireKind(source, kind, verb) {
  if (source.kind !== kind) throw new Error(`Source at slot ${source.slot} is a "${source.kind}", not a ${kind === 'directv' ? 'DirecTV receiver' : 'Roku'} -- can't ${verb} it.`);
  return source;
}

// Like findSource, but for pointing a TV at a slot (Phase 4, §7.2/§8.2):
// selecting a channel on the TV's own cable tuner only needs the source's
// qam_channel string -- it doesn't touch the receiver at all, so unlike
// findSource this has no kind/ip requirement. A TV can be pointed at any
// programmed slot regardless of what (if anything) is actually driving it.
function findSourceForSlot(slotParam) {
  const slot = Number(slotParam);
  const config = cache.get('config') || {};
  const source = (config.sources || []).find((s) => Number(s.slot) === slot);
  if (!source) throw new Error(`No source at slot ${slotParam}.`);
  return source;
}

app.get('/api/sources', (req, res) => {
  const config = cache.get('config') || {};
  const liveBySlot = new Map(poller.getAllState().map((s) => [s.slot, s]));
  res.json((config.sources || []).map((s) => ({
    slot: s.slot, qam_channel: s.qam_channel, label: s.label, kind: s.kind,
    ip: s.ip, port: s.port, notes: s.notes,
    live: liveBySlot.get(Number(s.slot)) || null,
  })));
});

// Registered BEFORE /api/sources/:slot/tune below -- Express matches routes
// in registration order, and ":slot" would otherwise happily match the
// literal string "bulk" and swallow every call to this route first.
// Fans out fully in parallel across receivers (§7.1: "different receivers
// are independent and can be driven in parallel... total time approx one
// receiver's latency") -- each individual receiver still goes through its
// own serialized queue inside the driver, so a bulk tune can't itself
// trigger the burst-hang problem the 350ms gap exists to avoid.
app.post('/api/sources/bulk/tune', async (req, res) => {
  const { slots, major, minor } = req.body || {};
  if (!Array.isArray(slots) || !slots.length) return res.status(400).json({ error: 'Missing "slots" array.' });
  if (!major) return res.status(400).json({ error: 'Missing "major".' });
  const results = await Promise.all(slots.map(async (slot) => {
    try {
      const source = requireKind(findSource(slot), 'directv', 'tune');
      await directv.tune(source.ip, source.port || 8080, major, minor);
      const live = await poller.pollNow(slot);
      activity.record('source.tune', { actor: req.vcActor, targetType: 'source', targetId: slot, detail: { major, minor } });
      return { slot, ok: true, live };
    } catch (err) {
      return { slot, ok: false, error: err.message };
    }
  }));
  res.json({ ok: true, results });
});

app.post('/api/sources/:slot/tune', async (req, res) => {
  try {
    const source = requireKind(findSource(req.params.slot), 'directv', 'tune');
    const { major, minor } = req.body || {};
    if (!major) return res.status(400).json({ error: 'Missing "major".' });
    await directv.tune(source.ip, source.port || 8080, major, minor);
    const live = await poller.pollNow(source.slot);
    activity.record('source.tune', { actor: req.vcActor, targetType: 'source', targetId: source.slot, detail: { major, minor } });
    res.json({ ok: true, live });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Phase 6: /key now dispatches per kind -- DirecTV's remote key codes
// ("guide", "info", "up"/"down"/...) and Roku's ECP keys ("Home", "Select",
// "Up"/"Down"/..., "Back") are different vocabularies driven by different
// devices, but both are "send this one remote button" from the staff UI's
// point of view, so they share this one route rather than forking staff.js
// per kind.
app.post('/api/sources/:slot/key', async (req, res) => {
  try {
    const source = findSource(req.params.slot);
    const { key, hold } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing "key".' });
    if (source.kind === 'directv') {
      await directv.processKey(source.ip, source.port || 8080, key, hold);
    } else {
      await roku.keypress(source.ip, source.port || 8060, key);
      await poller.pollNow(source.slot).catch(() => {}); // a key like Home changes the active app -- refresh, but don't fail the request if the re-read hiccups
    }
    activity.record('source.key', { actor: req.vcActor, targetType: 'source', targetId: source.slot, detail: { key } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reads program info for any channel without tuning to it (§2/§7.1) -- the
// favorites grid uses this to show "ESPN -- Chiefs vs. Bills" instead of
// just "ESPN", sourced from whichever receiver is asked, not the one it's
// currently tuned to. DirecTV-only -- Roku has no channel/program concept.
app.get('/api/sources/:slot/proginfo', async (req, res) => {
  try {
    const source = requireKind(findSource(req.params.slot), 'directv', 'read program info for');
    if (!req.query.major) return res.status(400).json({ error: 'Missing "major" query param.' });
    const info = await directv.getProgInfo(source.ip, source.port || 8080, req.query.major, req.query.minor);
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- Roku app control (Phase 6, docs/venue-control.md §7.3) ----------------
// Staff-facing, same PIN gate as the rest of /api/sources.
app.get('/api/sources/:slot/apps', async (req, res) => {
  try {
    const source = requireKind(findSource(req.params.slot), 'roku', 'list apps on');
    const apps = await roku.getApps(source.ip, source.port || 8060);
    res.json({ ok: true, apps });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sources/:slot/launch', async (req, res) => {
  try {
    const source = requireKind(findSource(req.params.slot), 'roku', 'launch an app on');
    const { appId } = req.body || {};
    if (!appId) return res.status(400).json({ error: 'Missing "appId".' });
    await roku.launch(source.ip, source.port || 8060, appId);
    const live = await poller.pollNow(source.slot);
    activity.record('source.launch', { actor: req.vcActor, targetType: 'source', targetId: source.slot, detail: { appId } });
    res.json({ ok: true, live });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/favorites', (req, res) => {
  const config = cache.get('config') || {};
  res.json(config.favorites || []);
});

// Read-only passthrough so the staff TVs tab can group/label TVs by zone
// name without a second admin-only endpoint -- same shape as /api/favorites.
app.get('/api/zones', (req, res) => {
  const config = cache.get('config') || {};
  res.json(config.zones || []);
});

// ---------------- TV power (Phase 3, docs/venue-control.md §7.2/§8.2) ----------------
// Staff-facing -- gated by requireStaffPin above. Reads TV rows from the
// synced config the same way findSource() reads sources above; live power
// state comes from lib/tv-poller.js's in-memory cache, not a fresh read on
// every page load.
function findTv(idParam) {
  const id = Number(idParam);
  const config = cache.get('config') || {};
  const tv = (config.tvs || []).find((t) => Number(t.id) === id);
  if (!tv) throw new Error(`No TV with id ${idParam}.`);
  if (!tv.ip) throw new Error(`"${tv.name}" has no IP address configured yet.`);
  return tv;
}

// Any command that captured a fresh WS pairing token (first-time pairing,
// or a re-pair after a stale one) pushes it to the cloud so it's usable
// next time without re-triggering the on-screen "Allow this device?"
// prompt -- see docs/venue-control.md §7.2 and lib/sync.js's reportTvToken.
function maybeReportToken(tv, result) {
  if (result && result.token && result.token !== tv.ws_token) {
    // Apply it to the synced config in memory RIGHT NOW, not just up in
    // the cloud. Until the next 30s config pull brought the token back
    // down, every command in that window reconnected token-less, so the
    // TV re-prompted "Allow this device?" on each press and minted a
    // fresh token every time -- Scotto hit Allow 5-6 times pairing his
    // first real TV (2026-09-18). One Allow is the contract.
    const config = cache.get('config');
    if (config && Array.isArray(config.tvs)) {
      const row = config.tvs.find((t) => Number(t.id) === Number(tv.id));
      if (row) { row.ws_token = result.token; cache.set('config', config); }
    }
    tv.ws_token = result.token;
    sync.reportTvToken(tv.id, result.token).catch((err) => console.error('[server] failed to push captured ws_token:', err.message));
  }
}

app.get('/api/tvs', (req, res) => {
  const config = cache.get('config') || {};
  const liveById = new Map(tvPoller.getAllState().map((s) => [s.id, s]));
  res.json((config.tvs || []).map((t) => ({
    id: t.id, name: t.name, tag: t.tag, zone_id: t.zone_id,
    ip: t.ip, control_method: t.control_method,
    power_capable: t.power_capable, channel_capable: t.channel_capable, volume_capable: t.volume_capable,
    wol_enabled: t.wol_enabled, default_source_slot: t.default_source_slot,
    live: liveById.get(Number(t.id)) || null,
  })));
});

// Fans out with concurrency 4 per §7.2 ("Bulk operations run with
// concurrency 4 and return a per-TV result table") rather than one big
// Promise.all -- ~50 TVs all opening WS connections at once is exactly the
// kind of burst the concurrency cap exists to avoid. No zone_id/tv_ids ->
// whole site, matching §8.2's own route shape.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

// Registered BEFORE /api/tvs/:id/power below -- Express matches routes in
// registration order, and ":id" would otherwise happily match the literal
// string "bulk" and swallow every call to this route first. (Same bug class
// already found and fixed once in Phase 2 for /api/sources/bulk/tune vs.
// /api/sources/:slot/tune -- fixed here proactively rather than waiting to
// rediscover it via a failing end-to-end test.)
app.post('/api/tvs/bulk/power', async (req, res) => {
  const { state, zone_id, tv_ids } = req.body || {};
  if (state !== 'on' && state !== 'off') return res.status(400).json({ error: 'Missing/invalid "state" -- expected "on" or "off".' });
  const config = cache.get('config') || {};
  let targets = (config.tvs || []).filter((t) => t.enabled !== false && t.ip);
  if (Array.isArray(tv_ids) && tv_ids.length) {
    const ids = new Set(tv_ids.map(Number));
    targets = targets.filter((t) => ids.has(Number(t.id)));
  } else if (zone_id != null) {
    targets = targets.filter((t) => Number(t.zone_id) === Number(zone_id));
  }
  const results = await mapWithConcurrency(targets, 16, /* power-on is mostly waiting on the set; don't queue a zone 4 at a time */ async (tv) => {
    try {
      const result = await driverFor(tv).setPower(tv, state);
      maybeReportToken(tv, result);
      const live = await tvPoller.pollNow(tv.id).catch(() => null);
      activity.record('tv.power', { actor: req.vcActor, targetType: 'tv', targetId: tv.id, detail: { name: tv.name, state }, result: result.ok ? 'ok' : 'failed' });
      return { id: tv.id, name: tv.name, ok: result.ok, state: result.state, method: result.method, live };
    } catch (err) {
      return { id: tv.id, name: tv.name, ok: false, error: err.message };
    }
  });
  res.json({ ok: true, results });
});

app.post('/api/tvs/:id/power', async (req, res) => {
  try {
    const tv = findTv(req.params.id);
    const { state } = req.body || {};
    if (state !== 'on' && state !== 'off') return res.status(400).json({ error: 'Missing/invalid "state" -- expected "on" or "off".' });
    const result = await driverFor(tv).setPower(tv, state);
    maybeReportToken(tv, result);
    const live = await tvPoller.pollNow(tv.id);
    activity.record('tv.power', { actor: req.vcActor, targetType: 'tv', targetId: tv.id, detail: { name: tv.name, state }, result: result.ok ? 'ok' : 'failed' });
    res.json({ ok: true, result, live });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Registered BEFORE /api/tvs/:id/volume below -- same route-ordering
// reason as bulk/power/bulk/slot above (Phase 2 precedent: a literal
// "bulk" segment must come before a sibling ":id" route or Express will
// match ":id" first). Used by the TV remote panel (06, docs/
// venue-control-gui-reconciliation.md's design-pack round) to send one
// volume/mute op to every TV the remote is currently aimed at in one call,
// rather than the client firing N individual /:id/volume requests.
app.post('/api/tvs/bulk/volume', async (req, res) => {
  const { op, tv_ids } = req.body || {};
  if (!['up', 'down', 'mute', 'unmute'].includes(op)) return res.status(400).json({ error: 'Missing/invalid "op" -- expected "up", "down", "mute", or "unmute".' });
  if (!Array.isArray(tv_ids) || !tv_ids.length) return res.status(400).json({ error: 'Missing "tv_ids" array.' });
  const config = cache.get('config') || {};
  const ids = new Set(tv_ids.map(Number));
  const targets = (config.tvs || []).filter((t) => t.enabled !== false && t.ip && ids.has(Number(t.id)));
  const results = await mapWithConcurrency(targets, 4, async (tv) => {
    try {
      const result = await driverFor(tv).setVolume(tv, op);
      maybeReportToken(tv, result);
      activity.record('tv.volume', { actor: req.vcActor, targetType: 'tv', targetId: tv.id, detail: { name: tv.name, op }, result: result.ok !== false ? 'ok' : 'failed' });
      return { id: tv.id, name: tv.name, ok: result.ok !== false, result };
    } catch (err) {
      return { id: tv.id, name: tv.name, ok: false, error: err.message };
    }
  });
  res.json({ ok: true, results });
});

app.post('/api/tvs/:id/volume', async (req, res) => {
  try {
    const tv = findTv(req.params.id);
    const { op } = req.body || {};
    if (!['up', 'down', 'mute', 'unmute'].includes(op)) return res.status(400).json({ error: 'Missing/invalid "op" -- expected "up", "down", "mute", or "unmute".' });
    const result = await driverFor(tv).setVolume(tv, op);
    maybeReportToken(tv, result);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Generic "send this key (or key sequence) to these TVs" -- the TV remote
// panel (06) is a real physical-remote analog: INPUT/CH UP/CH DOWN are
// single keys, and typing a channel on the on-screen keypad + ENTER is the
// exact same digit/KEY_MINUS/KEY_ENTER sequence samsung-ws.js's own
// keysForQamChannel() builds for Phase 4's "Change source" admin
// convenience feature -- reused here via sendKeySequence directly rather
// than re-implemented. Deliberately NOT gated by channel_capable (§5's
// gate exists so an *unattended* admin action doesn't claim success it
// can't verify; a person standing there aiming a real remote at the screen
// can always see for themselves, exactly like the physical remote never
// checks a flag either). No per-IP serialization needed the way DirecTV/
// SHEF needs it -- each TV's own WS connection already serializes against
// itself inside sendKeySequence, and different TVs' sockets are fully
// independent, so this fans out with the same concurrency-4 cap as every
// other bulk TV route.
app.post('/api/tvs/bulk/key', async (req, res) => {
  const { tv_ids, keys, key } = req.body || {};
  const keySeq = Array.isArray(keys) && keys.length ? keys : (key ? [key] : null);
  if (!keySeq) return res.status(400).json({ error: 'Missing "key" or "keys".' });
  if (!Array.isArray(tv_ids) || !tv_ids.length) return res.status(400).json({ error: 'Missing "tv_ids" array.' });
  const config = cache.get('config') || {};
  const ids = new Set(tv_ids.map(Number));
  const targets = (config.tvs || []).filter((t) => t.enabled !== false && t.ip && ids.has(Number(t.id))
    && KEY_METHODS.has(t.control_method));
  const results = await mapWithConcurrency(targets, 4, async (tv) => {
    try {
      const result = await driverFor(tv).sendKeySequence(tv, keySeq);
      maybeReportToken(tv, result);
      activity.record('tv.key', { actor: req.vcActor, targetType: 'tv', targetId: tv.id, detail: { name: tv.name, keys: keySeq }, result: 'ok' });
      return { id: tv.id, name: tv.name, ok: true };
    } catch (err) {
      return { id: tv.id, name: tv.name, ok: false, error: err.message };
    }
  });
  res.json({ ok: true, results });
});

// ---------------- TV source selection (Phase 4, docs/venue-control.md §7.2/§8.2) ----------------
// Staff-facing -- gated by requireStaffPin above, same as power/volume.
// Sends the source's qam_channel as key-code presses over the same WS
// remote-control path power uses -- see samsung-ws.js's selectChannel().
// This is genuinely unverified (§7.2: "marked stretch because it is
// unverified") -- there's no way to read back what a Samsung TV's built-in
// tuner actually landed on, so a 200 here means "the keys were sent",
// not "the picture changed." Staff confirm visually, same as the doc says.
//
// channel_capable gates this the same way the *_capable flags gate every
// other TV capability (§5: "written by discovery tool, not guessed") --
// but nothing in Phase 1/2/3 actually sets it to true automatically
// (discovery's own "channel" test type is still unwired, deliberately left
// for a future round -- see claude/project-status.md), so today it's
// purely an owner-set toggle on the TVs admin card: try it once, confirm
// visually, then flip the toggle.
function requireChannelCapable(tv) {
  if (!tv.channel_capable) {
    throw new Error(`"${tv.name}" isn't marked channel-capable yet -- try "Change source" once you're looking at the screen, then flip "Channel capable" on for it in TSB Platform: Venue Control → TVs.`);
  }
}

async function selectTvSlot(tv, slot) {
  const source = findSourceForSlot(slot);
  requireChannelCapable(tv);
  const result = await driverFor(tv).selectChannel(tv, source.qam_channel);
  maybeReportToken(tv, result);
  tvPoller.reportSlot(tv.id, slot);
  sync.reportTvSlot(tv.id, slot).catch((err) => console.error('[server] failed to push last_known_slot:', err.message));
  return result;
}

// Registered BEFORE /api/tvs/:id/slot below -- same route-ordering reason
// as bulk/power above (Phase 2 precedent). Silently skips any target TV
// that isn't channel_capable rather than failing the whole batch, same
// spirit as bulk/power skipping TVs with no IP.
app.post('/api/tvs/bulk/slot', async (req, res) => {
  const { slot, zone_id, tv_ids } = req.body || {};
  if (slot == null) return res.status(400).json({ error: 'Missing "slot".' });
  let source;
  try { source = findSourceForSlot(slot); } catch (err) { return res.status(400).json({ error: err.message }); }
  const config = cache.get('config') || {};
  let targets = (config.tvs || []).filter((t) => t.enabled !== false && t.ip && t.channel_capable);
  if (Array.isArray(tv_ids) && tv_ids.length) {
    const ids = new Set(tv_ids.map(Number));
    targets = targets.filter((t) => ids.has(Number(t.id)));
  } else if (zone_id != null) {
    targets = targets.filter((t) => Number(t.zone_id) === Number(zone_id));
  }
  const results = await mapWithConcurrency(targets, 4, async (tv) => {
    try {
      const result = await selectTvSlot(tv, slot);
      activity.record('tv.slot', { actor: req.vcActor, targetType: 'tv', targetId: tv.id, detail: { name: tv.name, slot: Number(slot) }, result: result.ok ? 'ok' : 'failed' });
      return { id: tv.id, name: tv.name, ok: result.ok, slot: Number(slot), method: result.method };
    } catch (err) {
      return { id: tv.id, name: tv.name, ok: false, error: err.message };
    }
  });
  res.json({ ok: true, slot: Number(slot), results });
});

app.post('/api/tvs/:id/slot', async (req, res) => {
  try {
    const tv = findTv(req.params.id);
    const { slot } = req.body || {};
    if (slot == null) return res.status(400).json({ error: 'Missing "slot".' });
    const result = await selectTvSlot(tv, slot);
    activity.record('tv.slot', { actor: req.vcActor, targetType: 'tv', targetId: tv.id, detail: { name: tv.name, slot: Number(slot) }, result: result.ok ? 'ok' : 'failed' });
    res.json({ ok: true, slot: Number(slot), result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- Layouts (Phase 5, docs/venue-control.md §5/§10/§8.2) ----------------
// Staff-facing (gated by requireStaffPin above, same as sources/tvs) --
// "one tap to apply, with a 15-second undo bar rather than a confirmation
// dialog" (§10). All execution logic lives in lib/layouts.js, shared with
// lib/scheduler.js's apply_layout action; this route is just a thin
// wrapper that also hands the client an in-memory undo snapshot to hold
// onto for the 15s window.
app.get('/api/layouts', (req, res) => {
  res.json(layouts.listLayouts());
});

app.post('/api/layouts/:id/apply', requireManagerSoon, async (req, res) => {
  try {
    const result = await layouts.apply(req.params.id);
    const ok = result.results.filter((r) => r.ok).length;
    activity.record('layout.apply', { actor: req.vcActor, targetType: 'layout', targetId: result.layout_id, detail: { name: result.name, ok, total: result.results.length } });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// The undo half of the 15-second bar -- the client POSTs back exactly the
// `undo` array apply() handed it, unmodified. No layout lookup, nothing
// persisted; this is a pure replay of a raw items list. Not logged to
// activity under its own name -- the resulting per-item tv.power/tv.slot/
// source.tune calls it triggers aren't recorded either (undo intentionally
// isn't re-run through those individual routes), so the log shows the
// apply and lets a human infer the undo from a following "layout.undo"
// entry recorded here instead.
app.post('/api/layouts/replay', requireManagerSoon, async (req, res) => {
  try {
    const { items, label } = req.body || {};
    const result = await layouts.replay(items);
    activity.record('layout.undo', { actor: req.vcActor, detail: { label: label || null, item_count: Array.isArray(items) ? items.length : 0 } });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin-only (gated by requireAdminPin via app.use('/api/admin', ...)
// above) -- "capture current state" reads live device state the agent
// already has in memory (lib/layouts.js's captureCurrentState()) and
// pushes it to the cloud, replacing that layout's items wholesale. See the
// big comment on the cloud's Layouts section (server/index.js) for why
// this lives here and not on TSB Platform.
// ---------------- Scenes and events (patch_043, lib/events.js) ----------------
// Staff can list, Apply now and End (a plain confirm on the page, no PIN).
// Capturing, editing and deleting is for the owner or a manager -- the
// pass from the Bar Ops app says which (server/tvpass.js actor).
// Routines and Events are for the owner and managers only (Scotto,
// 2026-10-05): staff and bar iPads don't see those tabs, and can't run them.
function requireManagerSoon(req, res, next) { return requireManager(req, res, next); }
function isManager(req) {
  return req.vcActor === 'admin' || (req.vcPass && (req.vcPass.actor === 'admin' || req.vcPass.actor === 'manager'));
}
function requireManager(req, res, next) {
  if (!isManager(req)) return res.status(403).json({ error: 'Only the owner or a manager can do that.' });
  next();
}

app.get('/api/events', (req, res) => {
  res.json({
    events: events.listEvents(),
    scenes: layouts.listLayouts().map((l) => ({ id: l.id, name: l.name, description: l.description, daily_time: l.daily_time, enabled: l.enabled, kind: l.kind, item_count: l.items.length })),
    pending_conflict: events.pendingConflict(),
    is_manager: isManager(req),
  });
});
app.post('/api/events/:id/apply', requireManagerSoon, async (req, res) => {
  try {
    const result = await events.applyEvent(req.params.id, { actor: req.vcActor, choice: (req.body || {}).choice, source: 'manual' });
    if (result.started) activity.record('event.apply', { actor: req.vcActor, targetType: 'event', targetId: result.event_id, detail: { name: result.name, ok: result.results.filter((r) => r.ok).length, total: result.results.length } });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/events/:id/end', requireManagerSoon, async (req, res) => {
  try {
    const result = await events.endEvent(req.params.id, { actor: req.vcActor, reason: 'ended early' });
    activity.record('event.end', { actor: req.vcActor, targetType: 'event', targetId: result.event_id, detail: { name: result.name, how: result.how } });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/events/conflict/resolve', async (req, res) => {
  try {
    const result = await events.resolveConflict((req.body || {}).choice, { actor: req.vcActor });
    activity.record('event.conflict', { actor: req.vcActor, targetType: 'event', targetId: result.event_id || null, detail: { choice: (req.body || {}).choice } });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// Capture: nothing changes on any device -- the items are built from what
// the highlighted TVs are doing (or the picked source) and saved for later.
app.post('/api/events', requireManager, async (req, res) => {
  const b = req.body || {};
  try {
    const items = events.buildItems({ tvIds: b.tv_ids, slot: b.slot, major: b.major, minor: b.minor, appId: b.app_id });
    const data = await sync.pushEvent({
      name: b.name, note: b.note, kind: b.kind, event_date: b.event_date, days: b.days, start_time: b.start_time, end_time: b.end_time,
      after_mode: b.after_mode, after_layout_id: b.after_layout_id, items, actor: req.vcActor,
    });
    res.json({ ok: true, event: data.event, item_count: items.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/events/:id/update', requireManager, async (req, res) => {
  const b = req.body || {};
  try {
    const body = { ...b, actor: req.vcActor };
    delete body.tv_ids; delete body.slot; delete body.major; delete body.minor; delete body.app_id;
    if (Array.isArray(b.tv_ids) && b.tv_ids.length) body.items = events.buildItems({ tvIds: b.tv_ids, slot: b.slot, major: b.major, minor: b.minor, appId: b.app_id });
    const data = await sync.updateEvent(req.params.id, body);
    res.json({ ok: true, event: data.event });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/events/:id/delete', requireManager, async (req, res) => {
  try {
    await sync.deleteEvent(req.params.id, { actor: req.vcActor });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// A whole-room scene captured from the TVs tab (what every source and TV
// is doing right now), saved to the cloud with an optional daily time.
app.post('/api/scenes/capture', requireManager, async (req, res) => {
  const b = req.body || {};
  try {
    const items = layouts.captureCurrentState();
    if (!items.length) return res.status(400).json({ error: 'Nothing to capture yet -- no source or TV has a live reading. Wait a few seconds and try again.' });
    const data = await sync.createScene({ name: b.name, daily_time: b.daily_time || null, items, actor: req.vcActor });
    activity.record('scene.capture', { actor: req.vcActor, targetType: 'layout', targetId: data.layout && data.layout.id, detail: { name: b.name, item_count: items.length } });
    res.json({ ok: true, layout: data.layout, item_count: items.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/layouts/:id/capture', async (req, res) => {
  try {
    const items = layouts.captureCurrentState();
    if (!items.length) return res.status(400).json({ error: 'Nothing to capture yet -- no source or TV has a live reading. Wait for the next poll cycle and try again.' });
    const pushed = await sync.pushLayoutItems(req.params.id, items);
    res.json({ ok: true, item_count: items.length, layout_id: pushed.layout_id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- Backup & Restore (Phase 5, docs/venue-control.md §6/§8.2) ----------------
// Admin-only (requireAdminPin, applied above via app.use('/api/backup', ...)
// / '/api/backups' / '/api/restore'). Thin proxies to the cloud's
// agent-facing routes -- the agent holds no unique state to send (§6), so
// there's nothing to compute locally; this exists so §6's disaster-
// recovery story ("plug in a replacement, log in, and restore... in
// minutes") works entirely from the on-site box, without anyone needing to
// find TSB Platform first.
app.post('/api/backup/now', async (req, res) => {
  try {
    const result = await sync.takeBackupNow();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/backups', async (req, res) => {
  try {
    res.json(await sync.listBackups());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/restore', async (req, res) => {
  try {
    const { backup_id } = req.body || {};
    if (!backup_id) return res.status(400).json({ error: 'Missing "backup_id".' });
    const result = await sync.restoreBackup(backup_id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(config.PORT, () => {
  console.log(`[server] Venue Control agent listening on :${config.PORT}`);
  sync.start();
  poller.start();
  tvPoller.start();
  health.start();
  speedtest.start();
  sonos.start();
  pandora.start();
  lights.start();
  scheduler.start();
  activity.start();
});

process.on('SIGTERM', () => { sync.stop(); poller.stop(); tvPoller.stop(); health.stop(); scheduler.stop(); activity.stop(); process.exit(0); });
process.on('SIGINT', () => { sync.stop(); poller.stop(); tvPoller.stop(); health.stop(); scheduler.stop(); activity.stop(); process.exit(0); });
