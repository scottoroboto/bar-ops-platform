// Cooler temperature sensors (Oct 2026): the gateway XIAO plugged into
// this box's USB prints one JSON line per radio packet. This reads them,
// queues them in the local SQLite file, and posts batches to the cloud
// (POST /api/venue/agent/sensors) with this box's agent token. A queue
// survives internet outages, reboots and the gateway being unplugged;
// resends are harmless (every reading carries a uuid).
//
// Every two minutes it pulls the cloud's sensor config (probe names and
// limits, each box's report interval, troubleshooting / install mode)
// and hands each box's settings to the gateway as a "cfg" line; the
// gateway passes them on the next time that box reports.
//
// No hardware, or the `serialport` package not installed: everything here
// goes quiet. Nothing else on the box depends on it.
//
//   SENSOR_SERIAL=/dev/ttyACM0   (.env, optional; default: find it)
const fs = require('fs');
const crypto = require('crypto');
const cache = require('./cache');
const sync = require('./sync');

let SerialPort = null; let ReadlineParser = null;
try { ({ SerialPort, ReadlineParser } = require('serialport')); } catch (e) { /* not installed on this box */ }

const BAUD = 115200;
const PUSH_EVERY_MS = 30 * 1000;
const HEARTBEAT_EVERY_MS = 60 * 1000;
const CONFIG_EVERY_MS = 2 * 60 * 1000;
const CFG_RESEND_MS = 10 * 60 * 1000;
const BATCH = 200;
const REOPEN_MS = 5000;

const db = cache.db;
db.exec(`CREATE TABLE IF NOT EXISTS sensor_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
const enqueueStmt = db.prepare('INSERT INTO sensor_queue (payload) VALUES (?)');
const takeStmt = db.prepare('SELECT id, payload FROM sensor_queue ORDER BY id LIMIT ?');
const countStmt = db.prepare('SELECT count(*) AS n FROM sensor_queue');
const deleteStmt = db.prepare('DELETE FROM sensor_queue WHERE id <= ? AND id IN (SELECT id FROM sensor_queue ORDER BY id LIMIT ?)');

const state = {
  enabled: !!SerialPort,
  path: null,
  open: false,
  gatewayMac: cache.get('sensorGatewayMac') || null,
  gatewayFw: cache.get('sensorGatewayFw') || null,
  channel: null,
  uptimeS: null,
  lastLineAt: null,
  lastHeartbeatAt: null,
  lastReadingAt: null,
  linesSeen: 0,
  badLines: 0,
  lastPushAt: null,
  lastPushOk: null,
  lastPushError: null,
  pushFails: 0,
  lastConfigAt: null,
  lastConfigError: null,
  nodesSeen: cache.get('sensorNodesSeen') || {},
};
let port = null;
let pushing = false;
let pushSoonTimer = null;
let nextPushAllowedAt = 0;
const lastCfgSent = new Map(); // mac -> { line, at }

function log(m) { console.log(`[sensors] ${m}`); }

function findPort() {
  if (process.env.SENSOR_SERIAL && process.env.SENSOR_SERIAL !== 'auto') return process.env.SENSOR_SERIAL;
  try {
    const byId = '/dev/serial/by-id';
    const names = fs.readdirSync(byId).filter((n) => /espressif|xiao|seeed|usb/i.test(n));
    if (names.length) return `${byId}/${names[0]}`;
  } catch (e) { /* no such dir */ }
  for (const p of ['/dev/ttyACM0', '/dev/ttyUSB0', '/dev/ttyACM1', '/dev/ttyUSB1']) {
    try { fs.accessSync(p); return p; } catch (e) { /* next */ }
  }
  return null;
}

function openPort() {
  if (!SerialPort || port) return;
  const path = findPort();
  if (!path) { setTimeout(openPort, REOPEN_MS * 6); return; }
  state.path = path;
  try {
    port = new SerialPort({ path, baudRate: BAUD, autoOpen: false });
  } catch (e) { state.lastPushError = e.message; setTimeout(openPort, REOPEN_MS); return; }
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  parser.on('data', (line) => { try { handleLine(String(line)); } catch (e) { state.badLines += 1; } });
  port.on('open', () => { state.open = true; log(`gateway on ${path}`); resendCfg(true); });
  port.on('close', () => { state.open = false; port = null; log('gateway unplugged; watching for it'); setTimeout(openPort, REOPEN_MS); });
  port.on('error', (e) => { state.open = false; log(`serial error: ${e.message}`); try { port.close(); } catch (x) { /* already */ } port = null; setTimeout(openPort, REOPEN_MS); });
  port.open((e) => { if (e) { log(`could not open ${path}: ${e.message}`); port = null; setTimeout(openPort, REOPEN_MS); } });
}

// One line from the gateway (or from a test). Returns what it did.
function handleLine(raw) {
  const line = raw.trim();
  if (!line.startsWith('{')) return null;
  let obj;
  try { obj = JSON.parse(line); } catch (e) { state.badLines += 1; return null; }
  state.lastLineAt = new Date().toISOString();
  state.linesSeen += 1;
  if (obj.gateway === 'started') {
    if (obj.mac) { state.gatewayMac = String(obj.mac).toUpperCase(); cache.set('sensorGatewayMac', state.gatewayMac); }
    if (obj.fw) { state.gatewayFw = String(obj.fw); cache.set('sensorGatewayFw', state.gatewayFw); }
    state.channel = obj.channel ?? state.channel;
    state.uptimeS = 0;
    lastCfgSent.clear();
    setTimeout(() => resendCfg(true), 2000);
    return 'started';
  }
  if (obj.gateway === 'alive') {
    state.lastHeartbeatAt = state.lastLineAt;
    state.uptimeS = Number.isFinite(Number(obj.uptime_s)) ? Number(obj.uptime_s) : state.uptimeS;
    return 'alive';
  }
  if (obj.mac && obj.type) {
    const mac = String(obj.mac).toUpperCase();
    const reading = {
      reading_uuid: crypto.randomUUID(),
      read_at: state.lastLineAt,
      node_mac: mac,
      type: obj.type,
      seq: obj.seq ?? null,
      rssi: obj.rssi ?? null,
      batt_mv: obj.batt_mv ?? null,
    };
    for (const k of ['interval_s', 'mode', 'mode_left_s', 'fw', 'fw_update', 'ant', 'link']) if (obj[k] !== undefined) reading[k] = obj[k];
    if (obj.type === 'co2') reading.co2 = obj.co2 || null;
    else reading.probes = Array.isArray(obj.probes) ? obj.probes.map((p) => ({ id: String(p.id || '').toUpperCase(), c: p.c == null ? null : Number(p.c) })) : [];
    enqueueStmt.run(JSON.stringify(reading));
    state.lastReadingAt = state.lastLineAt;
    state.nodesSeen[mac] = { at: state.lastLineAt, rssi: reading.rssi, batt_mv: reading.batt_mv, mode: obj.mode || 'normal', interval_s: obj.interval_s || null };
    cache.set('sensorNodesSeen', state.nodesSeen);
    pushSoon();
    return 'reading';
  }
  return null;
}

function pushSoon() {
  if (pushSoonTimer) return;
  pushSoonTimer = setTimeout(() => { pushSoonTimer = null; push().catch(() => {}); }, 2000);
}

function queued() { return countStmt.get().n; }

async function push({ heartbeat = false } = {}) {
  if (pushing) return;
  if (Date.now() < nextPushAllowedAt) return;
  const rows = takeStmt.all(BATCH);
  if (!rows.length && !heartbeat) return;
  if (!rows.length && !state.gatewayMac) return;
  pushing = true;
  try {
    const payload = {
      location: ((cache.get('config') || {}).site || {}).name || null,
      gateway_mac: state.gatewayMac,
      sent_at: new Date().toISOString(),
      gateway: { uptime_s: state.uptimeS, last_heartbeat_at: state.lastHeartbeatAt, fw: state.gatewayFw },
      readings: rows.map((r) => JSON.parse(r.payload)),
    };
    const res = await sync.sensorsPush(payload);
    if (rows.length) deleteStmt.run(rows[rows.length - 1].id, rows.length);
    state.lastPushAt = new Date().toISOString();
    state.lastPushOk = true;
    state.lastPushError = null;
    state.pushFails = 0;
    nextPushAllowedAt = 0;
    if (rows.length) log(`sent ${rows.length} reading(s): ${res.accepted} new, ${res.duplicates} already there${res.rejected ? `, ${res.rejected} rejected` : ''}`);
    if (queued() > 0) pushSoon();
  } catch (err) {
    state.lastPushOk = false;
    state.lastPushError = err.message;
    if (err.status && err.status >= 400 && err.status < 500) {
      // The cloud rejected the batch for good; keeping it would just repeat the refusal.
      log(`cloud refused a batch of ${rows.length} (${err.status}: ${err.message}); dropping it`);
      if (rows.length) deleteStmt.run(rows[rows.length - 1].id, rows.length);
    } else {
      state.pushFails += 1;
      const wait = Math.min(5 * 60 * 1000, 30 * 1000 * Math.pow(2, Math.min(4, state.pushFails - 1)));
      nextPushAllowedAt = Date.now() + wait;
      if (state.pushFails <= 3 || state.pushFails % 10 === 0) log(`cloud unreachable (${err.message}); ${queued()} queued, retrying in ${Math.round(wait / 1000)}s`);
    }
  } finally {
    pushing = false;
  }
}

async function pullConfig() {
  try {
    const cfg = await sync.sensorsConfig();
    cache.set('sensorConfig', cfg);
    state.lastConfigAt = new Date().toISOString();
    state.lastConfigError = null;
    resendCfg(false);
  } catch (err) {
    state.lastConfigError = err.message;
  }
}

// Hand each box's settings to the gateway. Only when something changed,
// or every ten minutes so a restarted gateway is not left waiting.
function resendCfg(force) {
  const cfg = cache.get('sensorConfig');
  if (!cfg || !port || !state.open) return;
  const now = Date.now();
  for (const n of cfg.nodes || []) {
    const line = JSON.stringify({ cmd: 'cfg', mac: n.mac, interval_s: n.report_interval_s, ts: n.troubleshoot || null, install: !!n.install });
    const prev = lastCfgSent.get(n.mac);
    if (!force && prev && prev.line === line && now - prev.at < CFG_RESEND_MS) continue;
    try { port.write(`${line}\n`); lastCfgSent.set(n.mac, { line, at: now }); } catch (e) { log(`could not write cfg to gateway: ${e.message}`); }
  }
}

function status() {
  return {
    enabled: state.enabled, path: state.path, open: state.open, gatewayMac: state.gatewayMac, gatewayFw: state.gatewayFw, channel: state.channel, uptimeS: state.uptimeS,
    lastLineAt: state.lastLineAt, lastHeartbeatAt: state.lastHeartbeatAt, lastReadingAt: state.lastReadingAt, linesSeen: state.linesSeen, badLines: state.badLines,
    queued: queued(), lastPushAt: state.lastPushAt, lastPushOk: state.lastPushOk, lastPushError: state.lastPushError,
    lastConfigAt: state.lastConfigAt, lastConfigError: state.lastConfigError, nodesSeen: state.nodesSeen,
    config: cache.get('sensorConfig') || null,
  };
}

let timers = [];
function start() {
  if (timers.length) return;
  if (!SerialPort) log('serialport package not installed: no gateway on this box (npm install on the box adds it)');
  else openPort();
  timers.push(setInterval(() => push().catch(() => {}), PUSH_EVERY_MS));
  timers.push(setInterval(() => push({ heartbeat: true }).catch(() => {}), HEARTBEAT_EVERY_MS));
  timers.push(setInterval(() => pullConfig().catch(() => {}), CONFIG_EVERY_MS));
  setTimeout(() => pullConfig().catch(() => {}), 15000);
  const q = queued();
  if (q) log(`${q} reading(s) queued from before; sending`);
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
  if (port) { try { port.close(); } catch (e) { /* fine */ } port = null; }
}

module.exports = { start, stop, status, handleLine, push, pullConfig, queued };
