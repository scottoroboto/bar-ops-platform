// Cloud <-> agent transport (docs/venue-control.md §3/§8.1): outbound HTTPS
// only, per-site bearer token, simple polling since staff use the local UI
// and cloud->agent commands are rare. Phase 0 wires register/config/
// heartbeat only -- /api/venue/agent/commands and /results (queued remote
// actions) land once there's something on the agent worth commanding.
const os = require('os');
const cache = require('./cache');
const { CLOUD_URL, AGENT_TOKEN } = require('../config');

const AGENT_VERSION = require('../package.json').version;
const POLL_MS = 30 * 1000; // matches the spec's 30s config/heartbeat cadence

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json', ...extra };
}

function localLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

async function register() {
  const body = {
    hostname: os.hostname(),
    agentVersion: AGENT_VERSION,
    platform: `${process.platform}/${process.arch}`,
    lanIp: localLanIp(),
  };
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/register`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cache.set('registration', data);
  cache.set('lastRegisterAt', new Date().toISOString());
  console.log(`[sync] registered as agent #${data.agentId} for ${data.locationName}`);
  return data;
}

async function pullConfig() {
  const etag = cache.get('configEtag');
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/config`, {
    headers: authHeaders(etag ? { 'If-None-Match': etag } : {}),
  });
  if (res.status === 304) {
    cache.set('lastConfigCheckAt', new Date().toISOString());
    return cache.get('config');
  }
  if (!res.ok) throw new Error(`config pull failed: ${res.status} ${await res.text()}`);
  const config = await res.json();
  cache.set('config', config);
  cache.set('configEtag', res.headers.get('etag'));
  cache.set('lastConfigCheckAt', new Date().toISOString());
  console.log(`[sync] config updated for ${config.site.name}`);
  return config;
}

async function heartbeat(status = 'online') {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/heartbeat`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ status, agentVersion: AGENT_VERSION, configEtag: cache.get('configEtag') }),
  });
  if (!res.ok) throw new Error(`heartbeat failed: ${res.status} ${await res.text()}`);
  cache.set('lastHeartbeatAt', new Date().toISOString());
  cache.set('lastHeartbeatOk', true);
}

// Pushed by lib/scheduler.js after firing a cron row, and by server.js's
// TV routes when a power/volume command captures a fresh WS pairing token
// -- both are small, one-off agent->cloud writes, not worth building the
// general commands/results queue noted in §3 for just these two cases.
async function reportScheduleResult(scheduleId, resultText) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/schedules/${scheduleId}/result`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ result: resultText }),
  });
  if (!res.ok) throw new Error(`schedule result push failed: ${res.status} ${await res.text()}`);
}

async function reportTvToken(tvId, wsToken) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/tvs/${tvId}/token`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ ws_token: wsToken }),
  });
  if (!res.ok) throw new Error(`tv token push failed: ${res.status} ${await res.text()}`);
}

// Phase 4 (docs/venue-control.md §12): pushes the slot a TV was last
// commanded to select, so vc_tvs.last_known_slot stays current for TSB
// Platform's own admin view and for lib/tv-poller.js's restart-continuity
// fallback (see that file). Best-effort like reportTvToken -- a failed push
// here doesn't undo the channel-select command that already happened.
async function reportTvSlot(tvId, slot) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/tvs/${tvId}/slot`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ slot }),
  });
  if (!res.ok) throw new Error(`tv slot push failed: ${res.status} ${await res.text()}`);
}

// Phase 5 (docs/venue-control.md §12/§6): pushes a captured layout's items
// up wholesale after an admin-PIN-gated "Capture current state"
// (lib/layouts.js's captureCurrentState(), called from agent/server.js).
async function pushLayoutItems(layoutId, items) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/layouts/${layoutId}/items`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ items }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `layout items push failed: ${res.status}`);
  return data;
}

// §6: "Agent pushes a full snapshot nightly (kind='auto')... any admin can
// trigger one on demand (kind='manual')." The cloud computes and stores
// the snapshot itself straight from Postgres (see server/index.js's
// buildBackupPayload) -- Supabase already holds every table a backup
// needs, so this call carries no body at all; it's purely "take one now."
async function takeBackupNow() {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/backup`, { method: 'POST', headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `backup push failed: ${res.status}`);
  return data;
}

async function listBackups() {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/backups`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `backup list failed: ${res.status}`);
  return data;
}

// §6's own replacement-procedure story ("plug in a replacement, log in,
// and restore by site_id in minutes") has to work from the on-site box
// alone, without TSB Platform reachable -- this is the local half of that:
// agent/server.js's admin-PIN-gated POST /api/restore calls straight
// through to here.
async function restoreBackup(backupId) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/restore`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ backup_id: backupId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `restore failed: ${res.status}`);
  return data;
}

// Batch push for lib/activity.js's queue -- see that file for what gets
// queued and how often this fires.
async function pushActivity(entries) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/activity`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ entries }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `activity push failed: ${res.status}`);
  return data;
}

// Once-a-day nightly backup (§6), driven off the existing 30s poll loop
// rather than a second timer -- checked on every heartbeat tick, but only
// actually fires when at least 23h have passed since the last successful
// push (tracked in the local cache so a restart doesn't cause an
// immediate extra backup, and a brief cloud outage just delays it to the
// next tick rather than skipping the day entirely).
const NIGHTLY_BACKUP_MIN_GAP_MS = 23 * 60 * 60 * 1000;

async function maybeTakeNightlyBackup() {
  const lastAt = cache.get('lastAutoBackupAt');
  if (lastAt && Date.now() - new Date(lastAt).getTime() < NIGHTLY_BACKUP_MIN_GAP_MS) return;
  try {
    await takeBackupNow();
    cache.set('lastAutoBackupAt', new Date().toISOString());
    console.log('[sync] nightly backup pushed.');
  } catch (err) {
    console.error('[sync] nightly backup failed (will retry on the next tick):', err.message);
  }
}

let timer = null;

function start() {
  if (!AGENT_TOKEN) {
    console.error('[sync] no AGENT_TOKEN configured -- not starting the cloud sync loop.');
    return;
  }
  (async () => {
    try {
      await register();
      await pullConfig();
      await heartbeat();
    } catch (err) {
      console.error('[sync] startup sequence failed:', err.message);
      cache.set('lastHeartbeatOk', false);
    }
  })();

  timer = setInterval(async () => {
    try {
      await pullConfig();
      await heartbeat();
      await maybeTakeNightlyBackup();
    } catch (err) {
      console.error('[sync] poll failed:', err.message);
      cache.set('lastHeartbeatOk', false);
    }
  }, POLL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  register, pullConfig, heartbeat, start, stop,
  reportScheduleResult, reportTvToken, reportTvSlot, pushLayoutItems,
  takeBackupNow, listBackups, restoreBackup, pushActivity,
};
