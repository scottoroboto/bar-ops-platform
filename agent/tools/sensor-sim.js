#!/usr/bin/env node
// Fake cooler readings, posted to the cloud as this box, so the alert
// flow and texts can be tested with no hardware. Uses CLOUD_URL and
// AGENT_TOKEN from .env (or run it on a laptop against a local server
// with those set in the environment).
//
//   node tools/sensor-sim.js normal            walk-in box, two probes, all fine, last 30 min
//   node tools/sensor-sim.js warm --shift 12   Draft probe climbing past 40°F over 25 min -> alert (ends 12 min ago)
//   node tools/sensor-sim.js recover           same probe back to 35°F for the last 10 min -> clears
//   node tools/sensor-sim.js error             a probe failing to read, 3 in a row
//   node tools/sensor-sim.js noprobe           a box finding no probe, twice
//   node tools/sensor-sim.js battery           a box at 3.35 V twice -> battery low (quiet)
//   node tools/sensor-sim.js stale             a box whose last report was 25 min ago -> silent within a minute
//   node tools/sensor-sim.js co2 [ppm]         the CO2 unit, state from the ppm
//   node tools/sensor-sim.js swap              battery jump -> swap event
// Each scenario uses its own box so they can run in any order; only
// recover follows warm (readings must be newer, hence --shift on warm).
// Options: --gateway 10:BD:A3:AE:B0:E8  --shift MINUTES (push every timestamp back)
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();
const crypto = require('crypto');
const { CLOUD_URL, AGENT_TOKEN } = require('../config');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const scenario = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || 'normal';
const num = args.find((a) => /^\d+$/.test(a));
const GW = (opt('gateway', '10:BD:A3:AE:B0:E8')).toUpperCase();
const BOX1 = (opt('box1', '10:BD:A3:AE:45:F0')).toUpperCase();
const BOX2 = (opt('box2', '10:BD:A3:AE:46:11')).toUpperCase();
const BOX3 = (opt('box3', '10:BD:A3:AE:47:22')).toUpperCase();
const BOX4 = '10:BD:A3:AE:48:33';
const BOX5 = '10:BD:A3:AE:49:44';
const BOX6 = '10:BD:A3:AE:4A:55';
const SHIFT = Number(opt('shift', 0)) || 0;
const P_DRAFT = '281997CB00000098';
const P_WALK_L = '28AA112233445570';
const P_WALK_R = '28AA112233445571';
const P_ERR = '28CC000000000044';
const P_BATT = '28DD000000000055';

const fToC = (f) => Math.round((f - 32) * 5 / 9 * 100) / 100;
const minsAgo = (m) => new Date(Date.now() - (m + SHIFT) * 60000).toISOString();
let seq = 200;
function report(mac, minutes, probes, extra = {}) {
  return { reading_uuid: crypto.randomUUID(), read_at: minsAgo(minutes), node_mac: mac, type: 'temp', seq: seq++, rssi: extra.rssi ?? -72, batt_mv: extra.batt_mv ?? 3910, probes, ...(extra.fields || {}) };
}

const readings = [];
switch (scenario) {
  case 'normal':
    for (let m = 30; m >= 0; m -= 5) {
      readings.push(report(BOX2, m, [{ id: P_WALK_L, c: fToC(36 + Math.random()) }, { id: P_WALK_R, c: fToC(36.5 + Math.random()) }]));
    }
    break;
  case 'warm':
    [36, 38, 40.5, 42, 43.5, 44.2].forEach((f, i) => readings.push(report(BOX1, 25 - i * 5, [{ id: P_DRAFT, c: fToC(f) }])));
    break;
  case 'recover':
    for (let m = 10; m >= 0; m -= 2) readings.push(report(BOX1, m, [{ id: P_DRAFT, c: fToC(35) }]));
    break;
  case 'error':
    [10, 5, 0].forEach((m) => readings.push(report(BOX4, m, [{ id: P_ERR, c: null }])));
    break;
  case 'noprobe':
    [5, 0].forEach((m) => readings.push(report(BOX3, m, [])));
    break;
  case 'battery':
    [5, 0].forEach((m) => readings.push(report(BOX5, m, [{ id: P_BATT, c: fToC(36) }], { batt_mv: 3350 })));
    break;
  case 'swap':
    readings.push(report(BOX5, 0, [{ id: P_BATT, c: fToC(36) }], { batt_mv: 4150, fields: { seq: 1 } }));
    break;
  case 'stale':
    readings.push(report(BOX6, 25, [{ id: '28BB000000000001', c: fToC(35) }]));
    break;
  case 'co2': {
    const ppm = Number(num || 850);
    const state = ppm >= 5000 ? 'alarm' : ppm >= 3000 ? 'warning' : 'normal';
    readings.push({ reading_uuid: crypto.randomUUID(), read_at: minsAgo(0), node_mac: '10:BD:A3:AE:C0:01', type: 'co2', seq: seq++, rssi: -60, batt_mv: 0, co2: { ppm, c: 3.1, rh: 78, state, muted: false } });
    break;
  }
  default:
    console.log('Unknown scenario. See the top of this file.'); process.exit(1);
}

(async () => {
  const body = { location: 'sim', gateway_mac: GW, sent_at: new Date().toISOString(), gateway: { uptime_s: 420, last_heartbeat_at: new Date().toISOString(), fw: '0.4.0' }, readings };
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/sensors`, { method: 'POST', headers: { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  console.log(`${scenario}: ${readings.length} report(s) ->`, res.status, JSON.stringify(data));
  if (!res.ok) process.exit(1);
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
