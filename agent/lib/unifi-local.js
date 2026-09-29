// The Dream Machine's own API, from inside the bar (Scotto, 2026-09-26:
// four days of cloud ISP metrics for T1 never carried a speed test, so
// the box runs the test itself). Talks to UniFi OS on the gateway with a
// local-only admin (Settings -> Admins -> add, "restrict to local
// access"), self-signed certificate and all. Two calls:
//   runSpeedTest()  -- asks the gateway to test, waits for the result
//   lastResult()    -- the gateway's most recent result without testing
// Nothing here is used unless UNIFI_URL/UNIFI_USER/UNIFI_PASS are set.
const https = require('https');
const http = require('http');
const config = require('../config');

const TIMEOUT_MS = 20 * 1000;
let session = null; // { cookie, csrf, at }

function configured() {
  return !!(config.UNIFI_URL && config.UNIFI_USER && config.UNIFI_PASS);
}

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, config.UNIFI_URL);
    const lib = url.protocol === 'http:' ? http : https;
    const data = body == null ? null : JSON.stringify(body);
    const req = lib.request(url, {
      method,
      rejectUnauthorized: false, // the gateway's certificate is self-signed
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`UniFi ${method} ${path} timed out after ${TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  const res = await request('POST', '/api/auth/login', { username: config.UNIFI_USER, password: config.UNIFI_PASS, rememberMe: false });
  if (res.status !== 200) throw new Error(`UniFi login failed (${res.status}): ${(res.json && res.json.message) || res.text.slice(0, 120)}`);
  const cookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const csrf = res.headers['x-csrf-token'] || res.headers['x-updated-csrf-token'] || '';
  if (!cookie) throw new Error('UniFi login returned no session cookie.');
  session = { cookie, csrf, at: Date.now() };
  return session;
}

async function authed(method, path, body) {
  if (!session || Date.now() - session.at > 30 * 60 * 1000) await login();
  const headers = { Cookie: session.cookie, ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) };
  let res = await request(method, path, body, headers);
  if (res.status === 401 || res.status === 403) { // session dropped — sign in once more
    await login();
    res = await request(method, path, body, { Cookie: session.cookie, ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) });
  }
  if (res.headers['x-updated-csrf-token']) session.csrf = res.headers['x-updated-csrf-token'];
  return res;
}

const site = () => config.UNIFI_SITE || 'default';

// Where the gateway keeps its last speed test depends on the Network
// version. Newer releases (10.x on Scotto's T1 UDM, 2026-09-26) put it on
// the gateway's own device record as "speedtest-status" {xput_download,
// xput_upload, latency, rundate}; older ones put it on the WAN row of
// /stat/health as xput_down/xput_up/speedtest_ping/speedtest_lastrun.
// Try the device record first, then the health row.
function isGateway(d) {
  return d && (d.type === 'udm' || d.type === 'ugw' || d.type === 'uxg' || /udm|ucg|uxg|dream|gateway/i.test(`${d.model || ''} ${d.shortname || ''}`));
}

async function gatewayDevice() {
  const res = await authed('GET', `/proxy/network/api/s/${site()}/stat/device`);
  if (res.status !== 200) throw new Error(`UniFi device read failed (${res.status}).`);
  return ((res.json && res.json.data) || []).find(isGateway) || null;
}

async function lastResult() {
  const gw = await gatewayDevice();
  const st = gw && gw['speedtest-status'];
  if (st && (st.rundate || st.xput_download != null)) {
    const running = st.status_summary != null ? Number(st.status_summary) === 1 : false;
    return {
      status: running ? 'Running' : 'Idle',
      lastRun: st.rundate ? new Date(st.rundate * 1000) : null,
      downloadMbps: typeof st.xput_download === 'number' ? st.xput_download : null,
      uploadMbps: typeof st.xput_upload === 'number' ? st.xput_upload : null,
      latencyMs: typeof st.latency === 'number' ? st.latency : null,
      wanIp: (gw.wan1 && gw.wan1.ip) || null,
      ispName: (gw.wan1 && gw.wan1.isp_name) || null,
      mac: gw.mac || null,
      via: 'device',
    };
  }
  const res = await authed('GET', `/proxy/network/api/s/${site()}/stat/health`);
  if (res.status !== 200) throw new Error(`UniFi health read failed (${res.status}).`);
  const rows = (res.json && res.json.data) || [];
  const wan = rows.find((r) => r.subsystem === 'wan') || null;
  if (!wan) return null;
  return {
    status: wan.speedtest_status || null,
    lastRun: wan.speedtest_lastrun ? new Date(wan.speedtest_lastrun * 1000) : null,
    downloadMbps: typeof wan.xput_down === 'number' ? wan.xput_down : null,
    uploadMbps: typeof wan.xput_up === 'number' ? wan.xput_up : null,
    latencyMs: typeof wan.speedtest_ping === 'number' ? wan.speedtest_ping : null,
    wanIp: wan.wan_ip || null,
    ispName: wan.isp_name || null,
    mac: gw ? gw.mac : null,
    via: 'health',
  };
}

// Every WAN port on the gateway with its link state -- the UDM keeps them
// on its own device record as wan1 / wan2 (a cable modem on the second
// port shows up as wan2 with up:true and a public IP the moment it links).
// Reported to the cloud once a minute (lib/health.js) so the CABLE WAN /
// CELL WAN tiles on the Apps Home board have something real behind them.
async function wanLinks() {
  const gw = await gatewayDevice();
  if (!gw) return [];
  const out = [];
  for (const key of Object.keys(gw)) {
    if (!/^wan\d*$/.test(key)) continue;
    const w = gw[key];
    if (!w || typeof w !== 'object') continue;
    const port = key === 'wan' ? 'wan1' : key;
    out.push({
      port,
      up: w.up === true || w.up === 'true' || (w.up == null && !!w.ip),
      ip: w.ip || null,
      isp: w.isp_name || w.isp_organization || null,
      name: w.name || null,
      ifname: w.ifname || null,
      type: w.type || null,
      speed_mbps: typeof w.speed === 'number' ? w.speed : (typeof w.max_speed === 'number' ? w.max_speed : null),
    });
  }
  out.sort((a, b) => a.port.localeCompare(b.port));
  return out;
}

// For finding where a new Network version hides things: raw JSON of any path.
async function raw(path) {
  const res = await authed('GET', path);
  return { status: res.status, json: res.json, text: res.json ? undefined : res.text.slice(0, 2000) };
}

// Starts a test and waits for a newer result (tests take 20-60 seconds).
async function runSpeedTest({ waitMs = 120 * 1000 } = {}) {
  const before = await lastResult();
  const beforeRun = before && before.lastRun ? before.lastRun.getTime() : 0;
  // Newer versions want the gateway's MAC on the command; older ones ignore it.
  const body = { cmd: 'speedtest', ...(before && before.mac ? { mac: before.mac } : {}) };
  const res = await authed('POST', `/proxy/network/api/s/${site()}/cmd/devmgr`, body);
  if (res.status !== 200) throw new Error(`UniFi speed test refused (${res.status}): ${(res.json && res.json.meta && res.json.meta.msg) || res.text.slice(0, 120)}`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const now = await lastResult();
    const ran = now && now.lastRun ? now.lastRun.getTime() : 0;
    if (ran > beforeRun && now.status !== 'Running') return now;
  }
  throw new Error('UniFi speed test did not finish in time.');
}

module.exports = { configured, lastResult, runSpeedTest, login, raw, gatewayDevice, wanLinks };
