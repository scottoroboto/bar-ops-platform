// Cloud <-> agent transport (docs/venue-control.md §3/§8.1): outbound HTTPS
// only, per-site bearer token, simple polling since staff use the local UI
// and cloud->agent commands are rare. Phase 0 wired register/config/
// heartbeat only; pollCommands() below is that "once there's something on
// the agent worth commanding" queue arriving -- the remote Discovery &
// Adopt trigger (claude/venue-control-gui-reconciliation.md §4, Option B)
// is the first thing that needed it. Piggybacks on this same 30s tick
// rather than a separate timer, same "poll is rare and cheap" posture as
// pullConfig/heartbeat -- a scan request can sit for up to one tick before
// an agent notices it, which the cloud admin UI shows honestly rather than
// pretending it's instant.
const os = require('os');
const cache = require('./cache');
const discovery = require('./discovery');
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

// lanIp rides along on every heartbeat, not just register(): the cloud's
// "TV Staff" tile links people to this box by the address it last
// reported, and a box that moves networks (DHCP renew, new switch, the
// Ticket 1 Pi going from the bench to the bar) would otherwise keep its
// stale registration-time IP in the cloud until the next restart.
async function heartbeat(status = 'online') {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/heartbeat`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ status, agentVersion: AGENT_VERSION, configEtag: cache.get('configEtag'), lanIp: localLanIp() }),
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

// patch_040: staff favorites lists live in the cloud; the box writes
// through here and re-pulls its config right after so the iPad's next
// refresh already has the change. Throws with the cloud's message.
// Manager sign-in on a bar iPad: who can, and their PIN checked by the cloud
// (which returns a short pass in their name). Needs the internet.
async function managerList() {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/managers`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `couldn't reach Bar Ops (${res.status})`);
  return data.people || [];
}
async function managerPass(personId, pin) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/manager-pass`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ personId, pin }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `couldn't reach Bar Ops (${res.status})`);
  return data;
}

async function musicWrite(path, body) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/music${path}`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `music write failed: ${res.status}`);
  try { await pullConfig(); } catch (e) { /* next timer pull catches up */ }
  return data;
}

// Lights (cloud patch_049): plugs found on the network (new ones arrive
// unnamed; known ones get their current address), each plug's live state
// once a minute, and a schedule change made on the iPad.
async function pushPlugsSeen(plugs) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/plugs/seen`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ plugs }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `plugs push failed: ${res.status}`);
  if (data.added) { try { await pullConfig(); } catch (e) { /* next pull */ } }
  return data;
}
async function pushPlugStatus(states) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/plugs/status`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ states }),
  });
  if (!res.ok) throw new Error(`plug status push failed: ${res.status}`);
}
async function plugScheduleWrite(plugId, schedule, actor) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/plugs/${plugId}/schedule`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ schedule, actor }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `plug schedule write failed: ${res.status}`);
  try { await pullConfig(); } catch (e) { /* next pull */ }
  return data;
}

// WAN port link states off the gateway (lib/unifi-local.js wanLinks) --
// the cloud lights the board's CABLE WAN / CELL WAN tiles from these.
async function pushWans(wans) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/wans`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ wans }),
  });
  if (!res.ok) throw new Error(`wan push failed: ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
}

// Kitchen board (Oct 2026): one pull of SpotOn's reports, or a failure.
async function kitchenPull(payload) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/kitchen/pull`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`kitchen pull push failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

async function kitchenHave(from, to) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/kitchen/have?from=${from}&to=${to}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`kitchen have failed: ${res.status}`);
  return (await res.json()).dates || [];
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
// patch_043 -- scenes captured on the box's TVs tab, and events (a
// temporary override on part of the room). Every write re-pulls config
// right after, the same way musicWrite does, so the box's own copy of
// vc_events/vc_layouts is fresh before the staff page re-lists them.
async function agentWrite(path, body) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent${path}`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} failed: ${res.status}`);
  try { await pullConfig(); } catch (e) { /* next timer pull catches up */ }
  return data;
}
function createScene(body) { return agentWrite('/layouts', body); }
function pushEvent(body) { return agentWrite('/events', body); }
function updateEvent(id, body) { return agentWrite(`/events/${id}/update`, body); }
function deleteEvent(id, body) { return agentWrite(`/events/${id}/delete`, body); }
function reportEventState(id, body) { return agentWrite(`/events/${id}/state`, body); }

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

// A9 (docs/venue-control-gui-reconciliation.md): batch push for
// lib/health.js's once-a-minute AV device-health sample -- see that file
// for how `items` is built from the existing source/TV pollers.
async function pushHealth(items) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/health`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ items }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `health push failed: ${res.status}`);
  return data;
}

// The bar's iPad flow (cloud patch_034): what the cloud wants the staff
// page to show, and the Clear / Service call buttons. Turn On is local
// (samsung-ws) and needs no cloud call -- the next health push closes the
// alert on its own once the TV answers.
// Cooler sensors (Oct 2026): a batch of node reports up, the probe/box
// settings down. A 4xx comes back with err.status so the caller can drop
// a batch the cloud will never take; anything else is retried.
async function sensorsPush(payload) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/sensors`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `sensors push failed: ${res.status}`), { status: res.status });
  return data;
}
async function sensorsConfig() {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/sensors/config`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `sensors config failed: ${res.status}`);
  return data;
}

async function pullAttention() {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/attention`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `attention pull failed: ${res.status}`);
  return data.attention || [];
}
async function clearAlert(systemId, duration) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/alerts/${encodeURIComponent(systemId)}/clear`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ duration }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `clear failed: ${res.status}`);
  return data;
}
async function serviceCall(systemId) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/alerts/${encodeURIComponent(systemId)}/service-call`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `service call failed: ${res.status}`);
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

// The cloud-admin Discovery & Adopt tab's "Scan network" button enqueues a
// vc_agent_commands row (server/index.js's POST .../discovery/scan) rather
// than calling the agent directly -- there's no inbound path to do that.
// This claims any pending commands for this site (the UPDATE...RETURNING
// on the cloud side marks them 'running' atomically, so a restart mid-poll
// can't cause two ticks to both pick up and double-run the same one) and
// runs each in turn. Only 'discovery_scan' exists today; an unknown type
// reports back as an error rather than being silently skipped, so a future
// command type added cloud-side-only-so-far fails loudly instead of just
// sitting there forever looking "picked up" with nothing happening.
// Checked every 5 seconds as well as on the 30s heartbeat, so a Blink or a
// scan from TV Admin starts within a few seconds. One poll at a time.
let commandsBusy = false;
async function pollCommandsOnce() {
  if (commandsBusy) return;
  commandsBusy = true;
  try { await pollCommands(); } finally { commandsBusy = false; }
}

async function pollCommands() {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/commands`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`commands poll failed: ${res.status} ${await res.text()}`);
  const { commands } = await res.json();
  for (const cmd of commands || []) {
    await runCommand(cmd);
  }
}

async function runCommand(cmd) {
  try {
    let result;
    if (cmd.type === 'discovery_scan') {
      const payload = cmd.payload || {};
      const config = cache.get('config') || {};
      const ranges = Array.isArray(payload.ranges) && payload.ranges.length
        ? payload.ranges
        : config.site && config.site.scan_ranges;
      if (!Array.isArray(ranges) || !ranges.length) {
        throw new Error('No scan ranges given and none configured for this site -- set scan_ranges on the site, or pass ranges when starting the scan.');
      }
      const run = await discovery.runScan({ ranges, deep: !!payload.deep });
      result = { localRunId: run.id, cloudRunId: run.cloud_run_id, deviceCount: run.devices.length, synced: run.synced };
      if (!run.synced) throw new Error(`Scan completed locally but failed to sync to the cloud: ${run.sync_error || 'unknown error'}. It will show up once resynced.`);
    } else if (cmd.type === 'tv_identify') {
      // Identify (cloud patch_038): volume up, pause, volume down, twice —
      // the TV's on-screen volume bar shows and the level ends where it
      // started. Same drivers the staff remote uses. A never-paired Samsung
      // pops its "Allow this device?" prompt instead, which is fine: the
      // captured token is pushed up like any other first command.
      const payload = cmd.payload || {};
      const config = cache.get('config') || {};
      const tv = (config.tvs || []).find((t) => Number(t.id) === Number(payload.tvId));
      if (!tv) throw new Error(`No TV with id ${payload.tvId} in this box's config yet — it syncs within 30 seconds of being adopted.`);
      if (!tv.ip) throw new Error(`"${tv.name}" has no IP address configured.`);
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      if (tv.control_method === 'roku') {
        const roku = require('./drivers/roku');
        for (let i = 0; i < 2; i++) { await roku.keypress(tv.ip, 'VolumeUp'); await pause(1200); await roku.keypress(tv.ip, 'VolumeDown'); await pause(800); }
        result = { ok: true, method: 'roku' };
      } else if (tv.control_method === 'samsung_ws_token' || tv.control_method === 'samsung_ws_plain' || tv.control_method === 'lg_webos') {
        const samsungWs = require('./drivers').driverFor(tv); // Samsung or LG — same volume up/down shape
        let last = null;
        for (let i = 0; i < 2; i++) {
          last = await samsungWs.setVolume(tv, 'up');
          if (last && last.token && last.token !== tv.ws_token) { tv.ws_token = last.token; cache.set('config', config); reportTvToken(tv.id, last.token).catch(() => {}); }
          if (!last || !last.ok) throw new Error(`"${tv.name}" didn't answer: ${(last && last.error) || 'unreachable'}. Is it on and paired?`);
          await pause(1200);
          await samsungWs.setVolume(tv, 'down');
          await pause(800);
        }
        result = { ok: true, method: last && last.method };
      } else {
        throw new Error(`"${tv.name}" has no control method the box can nudge (${tv.control_method || 'none'}).`);
      }
    } else if (cmd.type === 'kasa_scan') {
      // "Find plugs" in TV Admin → Lights (cloud patch_049).
      const r = await require('./lights').discover((cmd.payload || {}).ranges || []);
      if (r.error) throw new Error(`Found ${r.found} plug(s) but couldn't report them: ${r.error}`);
      result = { found: r.found, added: r.added };
    } else if (cmd.type === 'kasa_blink') {
      // "Blink" next to a plug in TV Admin: flash that sign twice.
      const payload = cmd.payload || {};
      const lights = require('./lights');
      if (lights.plugById(payload.plugId)) await lights.blink(payload.plugId);
      else if (payload.ip) await require('./drivers/kasa').blink({ ip: payload.ip });
      else throw new Error('This plug hasn’t been found on the network yet.');
      result = { ok: true };
    } else if (cmd.type === 'speedtest') {
      // "Test now" from Systems Monitoring. Same run-and-report as the
      // scheduled test; the cloud files the numbers on the bar's line.
      const speedtest = require('./speedtest'); // required here, not at the top: speedtest -> config/unifi-local/cache only, no cycle
      const r = await speedtest.runOnce({ run: true });
      if (!r) throw new Error('This box has no gateway login set (UNIFI_URL/UNIFI_USER/UNIFI_PASS in agent/.env).');
      result = { downloadMbps: r.downloadMbps, uploadMbps: r.uploadMbps, latencyMs: r.latencyMs, measuredAt: r.lastRun ? r.lastRun.toISOString() : new Date().toISOString() };
    } else {
      throw new Error(`Unknown command type "${cmd.type}" -- this agent build doesn't know how to run it.`);
    }
    await reportCommandResult(cmd.id, 'done', result, null);
  } catch (err) {
    console.error(`[sync] command #${cmd.id} (${cmd.type}) failed:`, err.message);
    await reportCommandResult(cmd.id, 'error', null, err.message).catch((reportErr) => {
      console.error(`[sync] also failed to report command #${cmd.id}'s error back to the cloud:`, reportErr.message);
    });
  }
}

async function reportCommandResult(commandId, status, result, error) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/commands/${commandId}/result`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ status, result, error }),
  });
  if (!res.ok) throw new Error(`command result push failed: ${res.status} ${await res.text()}`);
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
let commandTimer = null;
const COMMAND_POLL_MS = 5 * 1000;

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
      await pollCommands();
    } catch (err) {
      console.error('[sync] startup sequence failed:', err.message);
      cache.set('lastHeartbeatOk', false);
    }
  })();

  timer = setInterval(async () => {
    try {
      await pullConfig();
      await heartbeat();
      await pollCommandsOnce();
      await maybeTakeNightlyBackup();
    } catch (err) {
      console.error('[sync] poll failed:', err.message);
      cache.set('lastHeartbeatOk', false);
    }
  }, POLL_MS);
  commandTimer = setInterval(() => { pollCommandsOnce().catch(() => {}); }, COMMAND_POLL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  if (commandTimer) clearInterval(commandTimer);
  timer = null;
  commandTimer = null;
}

module.exports = {
  musicWrite, managerList, managerPass,
  pushPlugsSeen, pushPlugStatus, plugScheduleWrite,
  pushWans,
  pullAttention, clearAlert, serviceCall,
  register, pullConfig, heartbeat, start, stop,
  reportScheduleResult, reportTvToken, reportTvSlot, pushLayoutItems, kitchenPull, kitchenHave,
  createScene, pushEvent, updateEvent, deleteEvent, reportEventState,
  takeBackupNow, listBackups, restoreBackup, pushActivity, pushHealth,
  pollCommands,
  sensorsPush, sensorsConfig,
};
