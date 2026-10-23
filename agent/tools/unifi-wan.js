#!/usr/bin/env node
// Read-only look at the bar's internet lines on the UniFi gateway, for
// "why does WAN1 keep dropping?" (Scotto, T1, 2026-10-23). Uses the same
// local admin the agent uses (UNIFI_URL/UNIFI_USER/UNIFI_PASS in
// agent/.env). Changes nothing. Prints:
//   - the gateway's WAN events (down / up / failover) for the last N hours
//   - each WAN port's link: speed, duplex, errors, drops
//   - the internet health numbers (drops, latency, uptime)
//   - how each WAN is set up (failover / load balance, priority)
//
//   node tools/unifi-wan.js          # last 48 hours
//   node tools/unifi-wan.js 168      # last week
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const unifi = require('../lib/unifi-local');
const site = process.env.UNIFI_SITE || 'default';
const TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';

const hours = Math.max(1, Math.min(24 * 30, Number(process.argv[2]) || 48));
const since = Date.now() - hours * 3600000;
const WANISH = /wan|isp|internet|failover|uplink|gw_?wan|connectivity|lost|restored/i;
const when = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

async function get(path) {
  const r = await unifi.raw(`/proxy/network/api/s/${site}/${path}`);
  if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
  return (r.json && r.json.data) || [];
}
async function tryGet(path) { try { return await get(path); } catch (e) { return null; } }

(async () => {
  if (!unifi.configured()) { console.log('UNIFI_URL/UNIFI_USER/UNIFI_PASS are not set in agent/.env'); process.exit(1); }
  console.log(`\nInternet lines, last ${hours} hours (times are bar time)`);

  // ---- setup
  const nets = (await tryGet('rest/networkconf')) || [];
  const wans = nets.filter((n) => n.purpose === 'wan');
  console.log('\nWAN SETUP');
  for (const w of wans) {
    console.log(`  ${pad(w.name, 16)} port=${pad(w.wan_networkgroup || '-', 6)} type=${pad(w.wan_type || '-', 7)} failover_priority=${w.wan_failover_priority ?? '-'} load_balance=${w.wan_load_balance_type || '-'}${w.wan_load_balance_weight != null ? ` weight=${w.wan_load_balance_weight}` : ''} smartq=${w.wan_smartq_enabled ? 'on' : 'off'} vlan=${w.wan_vlan_enabled ? w.wan_vlan : 'no'}`);
  }

  // ---- the gateway and its WAN ports
  const devs = (await tryGet('stat/device')) || [];
  const gw = devs.find((d) => /^(ugw|udm|uxg)/i.test(d.type || '') || d.wan1);
  if (gw) {
    console.log(`\nGATEWAY  ${gw.name || gw.model}  firmware ${gw.version || '?'}  up ${gw.uptime ? `${Math.floor(gw.uptime / 86400)}d ${Math.floor((gw.uptime % 86400) / 3600)}h` : '?'}`);
    for (const k of ['wan1', 'wan2', 'wan3']) {
      const w = gw[k];
      if (!w) continue;
      console.log(`  ${pad(k.toUpperCase(), 5)} up=${w.up ? 'YES' : 'no'}  ip=${pad(w.ip || '-', 16)} link=${w.speed ? `${w.speed}Mbps ${w.full_duplex ? 'full' : 'HALF'}` : '-'}  latency=${w.latency ?? '-'}ms  availability=${w.availability ?? '-'}%  rx_errors=${w.rx_errors ?? '-'} tx_errors=${w.tx_errors ?? '-'} rx_dropped=${w.rx_dropped ?? '-'}`);
    }
    const wanPorts = (gw.port_table || []).filter((p) => /wan/i.test(`${p.network_name || ''} ${p.name || ''}`));
    for (const p of wanPorts) {
      console.log(`  port ${pad(p.port_idx, 3)} ${pad(p.name || p.ifname, 12)} up=${p.up ? 'YES' : 'no'} ${p.speed ? `${p.speed}Mbps ${p.full_duplex ? 'full' : 'HALF'}` : ''}  rx_errors=${p.rx_errors ?? '-'} tx_errors=${p.tx_errors ?? '-'} rx_dropped=${p.rx_dropped ?? '-'}`);
    }
    if (gw.uptime_stats) {
      for (const [k, v] of Object.entries(gw.uptime_stats)) {
        const downs = (v.downtime || 0);
        console.log(`  ${pad(k, 5)} uptime stats: availability ${v.availability ?? '-'}%  downtime ${downs}s  latency_avg ${v.latency_average ?? '-'}ms  monitors: ${(v.monitors || []).map((m) => `${m.target || m.type} ${m.availability ?? '?'}%/${m.latency_average ?? '?'}ms`).join(', ') || '-'}`);
      }
    }
  } else {
    console.log('\n(gateway not found in the device list)');
  }

  // ---- health
  const health = (await tryGet('stat/health')) || [];
  for (const h of health.filter((x) => ['wan', 'www'].includes(x.subsystem))) {
    console.log(`\nHEALTH ${h.subsystem.toUpperCase()}  status=${h.status}  isp=${h.isp_name || '-'}  latency=${h.latency ?? '-'}ms  drops=${h.drops ?? '-'}  uptime=${h.uptime ? `${Math.floor(h.uptime / 3600)}h` : '-'}  xput_down=${h.xput_down ?? '-'} xput_up=${h.xput_up ?? '-'}`);
  }

  // ---- events: classic event list, then alarms
  const rows = [];
  const ev = await tryGet(`stat/event?within=${hours}&_limit=3000`);
  for (const e of ev || []) {
    const t = e.time || (e.datetime && Date.parse(e.datetime));
    const text = `${e.key || ''} ${e.msg || ''}`;
    if (t >= since && WANISH.test(text)) rows.push({ t, src: 'event', key: e.key || '', msg: e.msg || '' });
  }
  const al = await tryGet(`stat/alarm?within=${hours}&_limit=1000`);
  for (const e of al || []) {
    const t = e.time || (e.datetime && Date.parse(e.datetime));
    const text = `${e.key || ''} ${e.msg || ''}`;
    if (t >= since && WANISH.test(text)) rows.push({ t, src: 'alarm', key: e.key || '', msg: e.msg || '' });
  }
  // Newer UniFi Network keeps these in the System Log instead.
  // System Log parameters come as { NAME: { name, id, ... } }: shown as
  // NAME=value so the whole event reads on one line.
  const params = (p) => Object.entries(p || {}).map(([k, v]) => `${k}=${v && typeof v === 'object' ? (v.name ?? v.id ?? JSON.stringify(v)) : v}`).join('  ');
  if (!rows.length && unifi.post) {
    for (const kind of ['critical', 'all']) {
      for (let page = 0; page < 10; page++) {
        const r = await unifi.post(`/proxy/network/v2/api/site/${site}/system-log/${kind}`, { timestampFrom: since, timestampTo: Date.now(), pageNumber: page, pageSize: 500 }).catch(() => null);
        const list = (r && r.json && (r.json.data || r.json)) || [];
        const arr = Array.isArray(list) ? list : [];
        for (const e of arr) {
          const t = e.timestamp || e.time;
          const text = `${e.key || e.event || ''} ${e.message || e.msg || ''} ${params(e.parameters)}`;
          if (t >= since && WANISH.test(text)) rows.push({ t, src: `log:${kind}`, key: e.key || e.event || '', msg: e.message || e.msg || params(e.parameters) });
        }
        if (arr.length < 500) break;
      }
    }
  }
  rows.sort((a, b) => a.t - b.t);
  const seen = new Set();
  console.log(`\nWAN EVENTS (${rows.length})`);
  for (const r of rows) {
    const k = `${r.t}|${r.msg}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ${pad(when(r.t), 26)} ${r.key}\n      ${String(r.msg).slice(0, 600)}`);
  }
  if (!rows.length) console.log('  none found (or this UniFi version keeps them where this tool can\'t read them)');

  // Count WAN1 drops per day, if the events say which line.
  const downs = rows.filter((r) => /wan.?1|\bwan\b/i.test(r.msg) && /(down|lost|disconnect|offline|fail)/i.test(`${r.key} ${r.msg}`));
  if (downs.length) {
    const perDay = {};
    for (const r of downs) { const d = new Date(r.t).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric' }); perDay[d] = (perDay[d] || 0) + 1; }
    console.log('\nWAN DOWN EVENTS PER DAY');
    for (const [d, n] of Object.entries(perDay)) console.log(`  ${pad(d, 12)} ${n}`);
  }
  console.log('');
})().catch((e) => { console.error('unifi-wan:', e.message); process.exit(1); });
