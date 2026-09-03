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
const scheduler = require('./lib/scheduler');
const directv = require('./lib/drivers/directv');
const samsungWs = require('./lib/drivers/samsung-ws');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
function requireStaffPin(req, res, next) {
if (!config.STAFF_PIN && !config.ADMIN_PIN) return next();
const pin = req.get('x-staff-pin') || req.query.pin;
const ok = (config.STAFF_PIN && pin === config.STAFF_PIN) || (config.ADMIN_PIN && pin === config.ADMIN_PIN);
if (!ok) return res.status(401).json({ error: 'Invalid or missing staff PIN.' });
next();
}
app.use('/api/sources', requireStaffPin);
app.use('/api/favorites', requireStaffPin);
app.use('/api/tvs', requireStaffPin);
app.use('/api/zones', requireStaffPin);

// ---------------- Discovery & Diagnostics (Phase 1, docs/venue-control.md §9) ----------------
// Owner/admin only per §9's own opening line -- gated by the same admin PIN
// as /api/admin/*, matching §8.2's explicit route list ("Admin-scoped
// routes (/api/discovery/*, /api/backup/*, /api/restore) require the admin
// PIN"). A network scan and device adoption are setup/troubleshooting
// actions, not day-to-day staff control, so this stays behind the PIN even
// though it isn't nested under /api/admin/ in the URL (the spec's own path
// spelling is kept as-is rather than moved under /api/admin for tidiness).
app.use('/api/discovery', requireAdminPin);

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
function findSource(slotParam) {
  const slot = Number(slotParam);
  const config = cache.get('config') || {};
  const source = (config.sources || []).find((s) => Number(s.slot) === slot);
  if (!source) throw new Error(`No source at slot ${slotParam}.`);
  if (source.kind !== 'directv') throw new Error(`Source at slot ${slotParam} is a "${source.kind}", not a DirecTV receiver -- nothing to tune yet (see build order Phase 6 for Roku).`);
  if (!source.ip) throw new Error(`Source at slot ${slotParam} has no IP address configured yet.`);
  return source;
}

app.get('/api/sources', (req, res) => {
  const config = cache.get('config') || {};
  const liveBySlot = new Map(poller.getAllState().map((s) => [s.slot, s]));
  res.json((config.sources || []).map((s) => ({
    slot: s.slot, qam_channel: s.qam_channel, label: s.label, kind: s.kind,
    ip: s.ip, port: s.port,
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
      const source = findSource(slot);
      await directv.tune(source.ip, source.port || 8080, major, minor);
      const live = await poller.pollNow(slot);
      return { slot, ok: true, live };
    } catch (err) {
      return { slot, ok: false, error: err.message };
    }
  }));
  res.json({ ok: true, results });
});

app.post('/api/sources/:slot/tune', async (req, res) => {
  try {
    const source = findSource(req.params.slot);
    const { major, minor } = req.body || {};
    if (!major) return res.status(400).json({ error: 'Missing "major".' });
    await directv.tune(source.ip, source.port || 8080, major, minor);
    const live = await poller.pollNow(source.slot);
    res.json({ ok: true, live });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sources/:slot/key', async (req, res) => {
  try {
    const source = findSource(req.params.slot);
    const { key, hold } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing "key" -- e.g. "guide", "info", "select", "up", "down", "left", "right".' });
    await directv.processKey(source.ip, source.port || 8080, key, hold);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reads program info for any channel without tuning to it (§2/§7.1) -- the
// favorites grid uses this to show "ESPN -- Chiefs vs. Bills" instead of
// just "ESPN", sourced from whichever receiver is asked, not the one it's
// currently tuned to.
app.get('/api/sources/:slot/proginfo', async (req, res) => {
  try {
    const source = findSource(req.params.slot);
    if (!req.query.major) return res.status(400).json({ error: 'Missing "major" query param.' });
    const info = await directv.getProgInfo(source.ip, source.port || 8080, req.query.major, req.query.minor);
    res.json(info);
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
    sync.reportTvToken(tv.id, result.token).catch((err) => console.error('[server] failed to push captured ws_token:', err.message));
  }
}

app.get('/api/tvs', (req, res) => {
  const config = cache.get('config') || {};
  const liveById = new Map(tvPoller.getAllState().map((s) => [s.id, s]));
  res.json((config.tvs || []).map((t) => ({
    id: t.id, name: t.name, tag: t.tag, zone_id: t.zone_id,
    ip: t.ip, control_method: t.control_method,
    power_capable: t.power_capable, volume_capable: t.volume_capable,
    wol_enabled: t.wol_enabled,
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
  const results = await mapWithConcurrency(targets, 4, async (tv) => {
    try {
      const result = await samsungWs.setPower(tv, state);
      maybeReportToken(tv, result);
      const live = await tvPoller.pollNow(tv.id).catch(() => null);
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
    const result = await samsungWs.setPower(tv, state);
    maybeReportToken(tv, result);
    const live = await tvPoller.pollNow(tv.id);
    res.json({ ok: true, result, live });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/tvs/:id/volume', async (req, res) => {
  try {
    const tv = findTv(req.params.id);
    const { op } = req.body || {};
    if (!['up', 'down', 'mute'].includes(op)) return res.status(400).json({ error: 'Missing/invalid "op" -- expected "up", "down", or "mute".' });
    const result = await samsungWs.setVolume(tv, op);
    maybeReportToken(tv, result);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(config.PORT, () => {
  console.log(`[server] Venue Control agent listening on :${config.PORT}`);
  sync.start();
  poller.start();
  tvPoller.start();
  scheduler.start();
});

process.on('SIGTERM', () => { sync.stop(); poller.stop(); tvPoller.stop(); scheduler.stop(); process.exit(0); });
process.on('SIGINT', () => { sync.stop(); poller.stop(); tvPoller.stop(); scheduler.stop(); process.exit(0); });
