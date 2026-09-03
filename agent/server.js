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

app.listen(config.PORT, () => {
  console.log(`[server] Venue Control agent listening on :${config.PORT}`);
  sync.start();
});

process.on('SIGTERM', () => { sync.stop(); process.exit(0); });
process.on('SIGINT', () => { sync.stop(); process.exit(0); });
