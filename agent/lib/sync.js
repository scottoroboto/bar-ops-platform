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

module.exports = { register, pullConfig, heartbeat, start, stop, reportScheduleResult, reportTvToken };
