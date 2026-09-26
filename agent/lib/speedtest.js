// Runs the gateway's speed test on a schedule and reports each result to
// the cloud, where it drives the Apps Home network board's DOWN/UP and
// the par check (server/monitoring.js reportAgentSpeed). Every
// SPEEDTEST_EVERY_HOURS (default 6), plus the gateway's own last result
// at boot so the board fills in without waiting. Off unless the UniFi
// local login is set in .env.
const config = require('../config');
const unifi = require('./unifi-local');
const cache = require('./cache');
const { CLOUD_URL, AGENT_TOKEN } = config;

const BOOT_DELAY_MS = 45 * 1000;
let timer = null;

async function report(result, ran) {
  const body = {
    downloadMbps: result.downloadMbps, uploadMbps: result.uploadMbps, latencyMs: result.latencyMs,
    measuredAt: result.lastRun ? result.lastRun.toISOString() : new Date().toISOString(),
    ispName: result.ispName, wanIp: result.wanIp, ran: !!ran,
  };
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/speedtest`, {
    method: 'POST', headers: { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`speed test report failed: ${res.status} ${await res.text()}`);
  cache.set('lastSpeedTest', { ...body, reportedAt: new Date().toISOString() });
  return res.json().catch(() => ({}));
}

async function runOnce({ run = true } = {}) {
  if (!unifi.configured()) return null;
  const result = run ? await unifi.runSpeedTest() : await unifi.lastResult();
  if (!result || result.downloadMbps == null) return null;
  console.log(`[speedtest] ${run ? 'ran' : 'read'}: ${result.downloadMbps} down / ${result.uploadMbps} up Mbps, ${result.latencyMs} ms`);
  await report(result, run);
  return result;
}

function start() {
  if (!unifi.configured()) { console.log('[speedtest] UNIFI_URL/UNIFI_USER/UNIFI_PASS not set — gateway speed tests off'); return; }
  const everyMs = Math.max(1, Number(config.SPEEDTEST_EVERY_HOURS) || 6) * 3600 * 1000;
  setTimeout(() => runOnce({ run: false }).catch((err) => console.error('[speedtest] boot read failed:', err.message)), BOOT_DELAY_MS);
  timer = setInterval(() => runOnce({ run: true }).catch((err) => console.error('[speedtest] run failed:', err.message)), everyMs);
  console.log(`[speedtest] gateway speed test every ${everyMs / 3600000}h via ${config.UNIFI_URL}`);
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, runOnce };
