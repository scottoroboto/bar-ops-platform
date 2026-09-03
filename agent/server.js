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
const scheduler = require('./lib/scheduler');
const layouts = require('./lib/layouts');
const activity = require('./lib/activity');
const directv = require('./lib/drivers/directv');
const roku = require('./lib/drivers/roku');
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
function requireStaffPin(req, res, next) {
// Phase 5 (lib/activity.js): who to blame in the audit log for this
// request. Set before the PIN check itself so a matched admin PIN (which
// also satisfies this gate, per the comment above) is correctly tagged
// "admin" rather than "staff" -- see the ok check below.
req.vcActor = (config.ADMIN_PIN && (req.get('x-staff-pin') || req.query.pin) === config.ADMIN_PIN) ? 'admin' : 'staff';
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
app.use('/api/layouts', requireStaffPin);

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
  const results = await mapWithConcurrency(targets, 4, async (tv) => {
    try {
      const result = await samsungWs.setPower(tv, state);
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
    const result = await samsungWs.setPower(tv, state);
    maybeReportToken(tv, result);
    const live = await tvPoller.pollNow(tv.id);
    activity.record('tv.power', { actor: req.vcActor, targetType: 'tv', targetId: tv.id, detail: { name: tv.name, state }, result: result.ok ? 'ok' : 'failed' });
    res.json({ ok: true, result, live });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/tvs/:id/volume', async (req, res) => {
  try {
    const tv = findTv(req.params.id);
    const { op } = req.body || {};
    if (!['up', 'down', 'mute', 'unmute'].includes(op)) return res.status(400).json({ error: 'Missing/invalid "op" -- expected "up", "down", "mute", or "unmute".' });
    const result = await samsungWs.setVolume(tv, op);
    maybeReportToken(tv, result);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
  const result = await samsungWs.selectChannel(tv, source.qam_channel);
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

app.post('/api/layouts/:id/apply', async (req, res) => {
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
app.post('/api/layouts/replay', async (req, res) => {
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
  scheduler.start();
  activity.start();
});

process.on('SIGTERM', () => { sync.stop(); poller.stop(); tvPoller.stop(); health.stop(); scheduler.stop(); activity.stop(); process.exit(0); });
process.on('SIGINT', () => { sync.stop(); poller.stop(); tvPoller.stop(); health.stop(); scheduler.stop(); activity.stop(); process.exit(0); });
