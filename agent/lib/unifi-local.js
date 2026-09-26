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

// The WAN row of /stat/health carries the gateway's last speed test:
// xput_down / xput_up in Mbps, speedtest_ping in ms, speedtest_lastrun
// as epoch seconds, speedtest_status 'Idle' or 'Running'.
async function lastResult() {
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
  };
}

// Starts a test and waits for a newer result (tests take 20-60 seconds).
async function runSpeedTest({ waitMs = 120 * 1000 } = {}) {
  const before = await lastResult();
  const beforeRun = before && before.lastRun ? before.lastRun.getTime() : 0;
  const res = await authed('POST', `/proxy/network/api/s/${site()}/cmd/devmgr`, { cmd: 'speedtest' });
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

module.exports = { configured, lastResult, runSpeedTest, login };
