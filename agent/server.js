// Venue Control on-site agent -- Phase 0 (docs/venue-control.md §12):
// registration, config pull, heartbeat, local UI shell, admin PIN scaffold.
// Runs on a box on the bar's own LAN (Pi, mini PC, NAS, old laptop --
// anything with Node 18+; see README.md). Talks to the cloud outbound-only.
const express = require('express');
const path = require('path');
const config = require('./config');
const cache = require('./lib/cache');
const sync = require('./lib/sync');

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

// Admin PIN gate for future admin-only local routes (discovery, backup,
// restore -- Phase 1+, per §11: "Discovery is admin-only by design"). Wired
// now so later phases just add routes under /api/admin/* rather than
// retrofitting auth onto an already-open surface. Nothing lives behind it
// yet in Phase 0, so an unset ADMIN_PIN just means there's nothing to guard.
function requireAdminPin(req, res, next) {
  if (!config.ADMIN_PIN) return next();
  const pin = req.get('x-admin-pin') || req.query.pin;
  if (pin !== config.ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN.' });
  next();
}
app.use('/api/admin', requireAdminPin);

app.listen(config.PORT, () => {
  console.log(`[server] Venue Control agent listening on :${config.PORT}`);
  sync.start();
});

process.on('SIGTERM', () => { sync.stop(); process.exit(0); });
process.on('SIGINT', () => { sync.stop(); process.exit(0); });
