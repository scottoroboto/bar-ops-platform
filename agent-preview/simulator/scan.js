#!/usr/bin/env node
/*
 * Venue Control — discovery scanner
 *
 * Sweeps a subnet, fingerprints what answers, and reports which control method
 * each device supports. This is the reference implementation of Phase 1 in
 * docs/venue-control.md §9 — the agent's scanner should behave exactly like it.
 *
 * Read-only. Changes nothing, tunes nothing, powers nothing.
 *
 *   node scan.js                       # scans 127.0.0.0/24
 *   node scan.js 192.168.1.0/24        # a real bar network
 *   node scan.js --json                # machine-readable, for adoption
 */

'use strict';
const net = require('net');
const http = require('http');
const os = require('os');

const PORTS = [8080, 8060, 8001, 8002, 55000, 9197];
const CONCURRENCY = 128;
const CONNECT_MS = 400;
const PROBE_MS = 2500;

const OUI = {
  'a4:6c:f1': 'Samsung Electronics', '8c:79:f5': 'Samsung Electronics',
  '5c:49:7d': 'Samsung Electronics', 'bc:14:85': 'Samsung Electronics',
  'b8:3e:59': 'Roku', 'ac:3a:7a': 'Roku', 'd8:31:34': 'Roku',
  '00:1e:c7': 'DirecTV', '00:1c:11': 'DirecTV',
  'b8:27:eb': 'Raspberry Pi Foundation', 'dc:a6:32': 'Raspberry Pi Foundation',
  '2c:cf:67': 'Raspberry Pi Foundation',
};

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const cidr = args.find((a) => /\d+\.\d+\.\d+\.\d+\/\d+/.test(a)) || '127.0.0.0/24';

// ------------------------------------------------------------------ helpers

function hosts(cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = parseInt(bitsRaw, 10);
  const b = base.split('.').map(Number);
  const start = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const size = 2 ** (32 - bits);
  const out = [];
  for (let i = 1; i < size - 1 && i < 4096; i++) {
    const n = (start + i) >>> 0;
    out.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  return out;
}

function tcpOpen(ip, port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const end = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(CONNECT_MS);
    s.once('connect', () => end(true));
    s.once('timeout', () => end(false));
    s.once('error', () => end(false));
    s.connect(port, ip);
  });
}

function get(ip, port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path, timeout: PROBE_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function arpTable() {
  const map = new Map();
  try {
    const raw = require('fs').readFileSync('/proc/net/arp', 'utf8');
    for (const line of raw.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length >= 4 && f[3] !== '00:00:00:00:00:00') map.set(f[0], f[3].toLowerCase());
    }
  } catch { /* not linux, or no permission */ }
  return map;
}

const xml = (body, tag) => (body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || null;

// ------------------------------------------------------------- interrogate

async function identify(ip, open) {
  const d = { ip, open_ports: open, classified_as: 'unknown', confidence: 'low', identity: {}, control_methods: [] };

  if (open.includes(8080)) {
    const r = await get(ip, 8080, '/info/getVersion');
    if (r && r.body.includes('receiverId')) {
      const v = JSON.parse(r.body);
      d.classified_as = 'directv_receiver';
      d.confidence = 'high';
      d.identity = { receiverId: v.receiverId, accessCardId: v.accessCardId, shef: v.version, sw: v.stbSoftwareVersion };
      d.control_methods.push({ method: 'shef', port: 8080, status: 'available' });
      const t = await get(ip, 8080, '/tv/getTuned');
      if (t) {
        try {
          const j = JSON.parse(t.body);
          d.identity.tuned = j.status?.code === 200 ? `${j.callsign} ${j.major} — ${j.title}` : j.status?.msg;
        } catch { /* ignore */ }
      }
      const m = await get(ip, 8080, '/info/mode');
      if (m) { try { d.identity.mode = JSON.parse(m.body).mode === 1 ? 'standby' : 'active'; } catch { /* */ } }
      return d;
    }
    if (r && r.status === 403) {
      d.classified_as = 'directv_receiver';
      d.confidence = 'high';
      d.control_methods.push({ method: 'shef', port: 8080, status: 'forbidden', fix: 'enable External Device access on the receiver' });
      return d;
    }
  }

  if (open.includes(8060)) {
    const r = await get(ip, 8060, '/query/device-info');
    if (r && r.body.includes('<device-info>')) {
      d.classified_as = 'roku';
      d.confidence = 'high';
      d.identity = {
        name: xml(r.body, 'user-device-name'), model: xml(r.body, 'model-name'),
        serial: xml(r.body, 'serial-number'), power: xml(r.body, 'power-mode'),
        mac: xml(r.body, 'wifi-mac'),
      };
      d.control_methods.push({ method: 'ecp', port: 8060, status: 'available' });
      return d;
    }
  }

  if (open.includes(8001)) {
    const r = await get(ip, 8001, '/api/v2/');
    if (r && r.body.includes('Samsung')) {
      const v = JSON.parse(r.body).device || {};
      d.classified_as = 'samsung_tv';
      d.confidence = 'high';
      d.identity = {
        name: v.name, modelName: v.modelName, wifiMac: v.wifiMac,
        networkType: v.networkType, PowerState: v.PowerState, TokenAuthSupport: v.TokenAuthSupport,
      };
      // THIS is the field that answers "what does this TV speak".
      if (String(v.TokenAuthSupport) === 'true')
        d.control_methods.push({ method: 'samsung_ws_token', port: 8002, status: 'available', needs_pairing: true });
      else
        d.control_methods.push({ method: 'samsung_ws_plain', port: 8001, status: 'available', needs_pairing: false });
      if (v.wifiMac) d.control_methods.push({ method: 'wol', status: 'available' });
      d.control_methods.push({ method: 'smartthings', status: 'unmatched' });
      return d;
    }
  }

  if (open.includes(55000)) {
    d.classified_as = 'samsung_tv';
    d.confidence = 'medium';
    d.identity = { note: 'pre-2016 Samsung — legacy remote port only' };
    d.control_methods.push({ method: 'samsung_legacy', port: 55000, status: 'available' });
    return d;
  }

  return d;
}

// -------------------------------------------------------------------- main

(async () => {
  const list = hosts(cidr);
  if (!JSON_OUT) {
    console.log(`\n  Scanning ${cidr} — ${list.length} hosts, ports ${PORTS.join(' ')}`);
    console.log('  Read-only: nothing is changed, tuned or powered.\n');
  }
  const t0 = Date.now();

  const found = [];
  await pool(list, CONCURRENCY, async (ip) => {
    const open = [];
    for (const p of PORTS) if (await tcpOpen(ip, p)) open.push(p);
    if (open.length) found.push({ ip, open });
  });

  const devices = await pool(found, 24, ({ ip, open }) => identify(ip, open));

  const arp = arpTable();
  for (const d of devices) {
    const m = d.identity.wifiMac || d.identity.mac || arp.get(d.ip);
    if (m) { d.mac = m.toLowerCase(); d.oui_vendor = OUI[d.mac.slice(0, 8)] || null; }
    if (d.classified_as === 'unknown' && d.oui_vendor) d.confidence = 'low';
  }

  devices.sort((a, b) => a.ip.split('.').map(Number)[3] - b.ip.split('.').map(Number)[3]);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (JSON_OUT) {
    console.log(JSON.stringify({ cidr, seconds: +secs, hosts: list.length, devices }, null, 2));
    return;
  }

  const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);
  const by = (k) => devices.filter((d) => d.classified_as === k);

  const show = (title, rows, cols) => {
    if (!rows.length) return;
    console.log(`  ${title}  (${rows.length})`);
    console.log('  ' + '-'.repeat(112));
    for (const d of rows) console.log('  ' + cols(d));
    console.log('');
  };

  show('DIRECTV RECEIVERS', by('directv_receiver'), (d) =>
    pad(d.ip, 16) + pad(d.identity.receiverId, 17) +
    pad(d.control_methods[0]?.status === 'forbidden' ? 'EXTERNAL ACCESS OFF' : (d.identity.mode || ''), 10) +
    pad(d.identity.tuned, 52) + pad('shef ' + (d.identity.shef || ''), 12));

  show('SAMSUNG TVS', by('samsung_tv'), (d) =>
    pad(d.ip, 16) + pad(d.identity.name, 24) + pad(d.identity.modelName, 14) +
    pad(d.identity.PowerState, 9) + pad(d.mac, 19) +
    pad(d.control_methods.map((m) => m.method).join(' + '), 40));

  show('ROKUS', by('roku'), (d) =>
    pad(d.ip, 16) + pad(d.identity.name, 24) + pad(d.identity.model, 14) +
    pad(d.identity.power, 12) + pad('ecp', 10));

  show('UNIDENTIFIED', by('unknown'), (d) =>
    pad(d.ip, 16) + pad('ports ' + d.open_ports.join(','), 26) + pad(d.oui_vendor || 'unknown vendor', 30));

  const pairing = devices.filter((d) => d.control_methods.some((m) => m.needs_pairing));
  console.log(`  ${devices.length} devices in ${secs}s.  ` +
    `${by('directv_receiver').length} receivers, ${by('samsung_tv').length} TVs, ${by('roku').length} Rokus.`);
  if (pairing.length) console.log(`  ${pairing.length} TVs need "Allow this device" accepted once at the screen.`);
  const off = devices.filter((d) => d.identity.PowerState === 'standby');
  if (off.length) console.log(`  ${off.length} TVs are in standby — Wake-on-LAN required to reach them.`);
  console.log('');
})();
