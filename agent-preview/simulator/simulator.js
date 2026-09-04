#!/usr/bin/env node
/*
 * Venue Control — device simulator
 *
 * Stands up fake DirecTV receivers, Rokus and Samsung TVs that answer on the
 * real ports with the real protocols, so the agent and its drivers can be
 * built and exercised with no hardware in the room.
 *
 * Zero dependencies. Node 18+.
 *
 *   node simulator.js                 # loopback mode, real ports
 *   node simulator.js --mode ports    # everything on 127.0.0.1, offset ports
 *   node simulator.js --print-aliases # macOS: commands to create the aliases
 *   node simulator.js --list          # print the device map and exit
 *
 * Deliberate faults live in devices.json so the drivers meet the failure modes
 * that actually happen: a receiver asleep, a receiver that never answers, TVs
 * powered down, a TV that must be paired, a TV that has fallen off the network.
 */

'use strict';
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'devices.json'), 'utf8'));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODE = has('--mode') ? argv[argv.indexOf('--mode') + 1] : 'loopback';
const QUIET = has('--quiet');

const BASE = CFG.network.base;
const CH = CFG.channels;

// ---------------------------------------------------------------- utilities

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, n) => String(s).padEnd(n);

function mac(oui, n) {
  const h = (v) => v.toString(16).padStart(2, '0');
  return `${oui}:${h((n >> 16) & 0xff)}:${h((n >> 8) & 0xff)}:${h(n & 0xff)}`;
}

function log(...a) { if (!QUIET) console.log(...a); }

let hits = 0;
function trace(dev, what) {
  hits++;
  if (!QUIET) console.log(`  ${pad(dev.ip + (dev.port ? ':' + dev.port : ''), 22)} ${what}`);
}

// SHEF is single threaded: one request at a time per receiver, with latency.
function serialize(dev) {
  dev._q = (dev._q || Promise.resolve()).catch(() => {});
  return dev._q;
}

function json(res, code, body) {
  const b = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

function shefStatus(query, code = 200, msg = 'OK.') {
  return { code, commandResult: code === 200 ? 0 : 1, msg, query };
}

// ------------------------------------------------------------ device tables

const devices = [];
let portCursor = 20000;

function alloc(host, realPort) {
  if (MODE === 'ports') return { ip: '127.0.0.1', port: portCursor++, realPort };
  return { ip: BASE + host, port: realPort, realPort };
}

// --- DirecTV receivers
CFG.receivers.forEach((r, i) => {
  const a = alloc(r.host, 8080);
  devices.push({
    kind: 'directv', ...r, ...a,
    mac: mac('00:1e:c7', 0x100000 + i),
    state: {
      major: r.major, minor: 65535,
      mode: r.fault === 'standby' ? 1 : 0,
      startTime: now() - Math.floor(Math.random() * 3000),
      keybuf: '',
    },
  });
});

// --- Rokus
CFG.rokus.forEach((r, i) => {
  const a = alloc(r.host, 8060);
  devices.push({
    kind: 'roku', ...r, ...a,
    mac: mac('b8:3e:59', 0x200000 + i),
    state: { app: r.app, power: 'PowerOn' },
  });
});

// --- Samsung TVs
let tvIndex = 0;
for (const grp of CFG.tvs) {
  for (let n = 1; n <= grp.count; n++) {
    const tag = `${grp.tag}${n}`;
    const fault = CFG.faults[tag] || null;
    const host = grp.host + n;
    const a = alloc(host, grp.legacy ? 55000 : 8001);
    devices.push({
      kind: 'samsung', tag, zone: grp.zone, model: grp.model,
      tokenAuth: !!grp.tokenAuth, legacy: !!grp.legacy, fault,
      label: `${grp.zone} ${n}`, ...a,
      wsPort: MODE === 'ports' ? portCursor++ : (grp.legacy ? 55000 : 8002),
      mac: mac('a4:6c:f1', 0x300000 + tvIndex++),
      state: {
        power: fault === 'off' ? 'standby' : 'on',
        muted: false, volume: 0,
        channel: null, input: 'TV',
        paired: fault !== 'unpaired',
        token: null,
      },
    });
  }
}

// ------------------------------------------------------------------- DirecTV

function progFor(major, startTime) {
  const c = CH[String(major)];
  if (!c) return { call: 'UNKNOWN', title: 'To Be Announced', dur: 1800, offAir: true };
  return { ...c, offAir: false, startTime };
}

function shefHandler(dev) {
  return async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams);

    // A blackholed receiver accepts the connection and never answers — this is
    // what a real hung H25 does, and it is why every driver call needs a timeout.
    if (dev.fault === 'blackhole') { trace(dev, `${p} -> (hanging, never answers)`); return; }

    await serialize(dev);
    const work = (async () => {
      await sleep(120 + Math.random() * 180);
      const st = dev.state;

      if (p === '/info/getVersion') {
        return json(res, 200, {
          accessCardId: dev.card, receiverId: dev.receiverId,
          stbSoftwareVersion: '0xfaa', systemTime: now(), version: '1.12',
          status: shefStatus(p),
        });
      }
      if (p === '/info/getSerialNum')
        return json(res, 200, { serialNum: dev.receiverId.replace(/ /g, ''), status: shefStatus(p) });

      if (p === '/info/getLocations')
        return json(res, 200, {
          locations: [{ clientAddr: '0', locationName: dev.label }],
          status: shefStatus(p),
        });

      if (p === '/info/mode')
        return json(res, 200, { mode: st.mode, status: shefStatus(p) });

      if (p === '/info/getOptions')
        return json(res, 200, {
          options: ['/info/getLocations', '/info/getSerialNum', '/info/getVersion', '/info/mode',
            '/tv/getProgInfo', '/tv/getTuned', '/tv/tune', '/remote/processKey',
            '/serial/processCommand'].map((c) => ({ command: c, description: c })),
          status: shefStatus(p),
        });

      if (p === '/tv/getTuned') {
        if (st.mode === 1)
          return json(res, 403, { status: shefStatus(p, 403, 'The receiver is in standby.') });
        const pr = progFor(st.major, st.startTime);
        return json(res, 200, {
          callsign: pr.call, date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
          duration: pr.dur, isOffAir: pr.offAir, isPclocked: 3, isPpv: false,
          isRecording: false, isVod: false, major: st.major, minor: st.minor,
          offset: now() - st.startTime, programId: String(10000000 + st.major),
          rating: 'No Rating', startTime: st.startTime, stationId: 1000 + st.major,
          title: pr.title, status: shefStatus(p),
        });
      }

      if (p === '/tv/getProgInfo') {
        const major = parseInt(q.major, 10);
        if (!major) return json(res, 400, { status: shefStatus(p, 400, 'major is required.') });
        const pr = progFor(major, now() - 900);
        return json(res, 200, {
          callsign: pr.call, duration: pr.dur, isOffAir: pr.offAir, major,
          minor: 65535, programId: String(10000000 + major), rating: 'No Rating',
          startTime: now() - 900, title: pr.title, status: shefStatus(p),
        });
      }

      if (p === '/tv/tune') {
        const major = parseInt(q.major, 10);
        if (!major) return json(res, 400, { status: shefStatus(p, 400, 'major is required.') });
        if (st.mode === 1) st.mode = 0;             // tuning wakes a sleeping box
        st.major = major; st.minor = q.minor ? parseInt(q.minor, 10) : 65535;
        st.startTime = now() - Math.floor(Math.random() * 600);
        trace(dev, `tune -> ${major} (${(CH[major] || {}).call || '?'})`);
        return json(res, 200, { status: shefStatus(p) });
      }

      if (p === '/remote/processKey') {
        const key = String(q.key || '').toLowerCase();
        const majors = Object.keys(CH).map(Number).sort((a, b) => a - b);
        const at = majors.indexOf(st.major);
        if (key === 'chanup') st.major = majors[(at + 1) % majors.length];
        else if (key === 'chandown') st.major = majors[(at - 1 + majors.length) % majors.length];
        else if (/^[0-9]$/.test(key)) st.keybuf += key;
        else if (key === 'enter' && st.keybuf) { st.major = parseInt(st.keybuf, 10); st.keybuf = ''; }
        else if (key === 'poweron') st.mode = 0;
        else if (key === 'poweroff') st.mode = 1;
        else if (key === 'power') st.mode = st.mode ? 0 : 1;
        if (['chanup', 'chandown', 'enter'].includes(key)) st.startTime = now();
        trace(dev, `key ${key}`);
        return json(res, 200, { status: shefStatus(p) });
      }

      if (p === '/serial/processCommand')
        return json(res, 200, { status: shefStatus(p) });

      return json(res, 404, { status: shefStatus(p, 404, 'Not implemented.') });
    })();

    dev._q = work.catch(() => {});
    return work;
  };
}

// ---------------------------------------------------------------------- Roku

function rokuHandler(dev) {
  return (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const xml = (s) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(s); };

    if (p === '/query/device-info') return xml(
      `<device-info><udn>${crypto.randomUUID()}</udn>` +
      `<serial-number>SIM${dev.slot}</serial-number><device-id>SIM${dev.slot}</device-id>` +
      `<model-name>Roku Ultra</model-name><model-number>4800X</model-number>` +
      `<friendly-device-name>${dev.label}</friendly-device-name>` +
      `<user-device-name>${dev.label}</user-device-name>` +
      `<wifi-mac>${dev.mac}</wifi-mac><power-mode>${dev.state.power}</power-mode>` +
      `<supports-wake-on-wlan>true</supports-wake-on-wlan></device-info>`);

    if (p === '/query/apps') return xml(
      `<apps><app id="837">YouTube</app><app id="195316">YouTube TV</app>` +
      `<app id="12">Netflix</app><app id="13535">Plex</app></apps>`);

    if (p === '/query/active-app') return xml(
      dev.state.app ? `<active-app><app id="195316">${dev.state.app}</app></active-app>`
                    : `<active-app><app>Roku</app></active-app>`);

    if (p.startsWith('/keypress/')) { trace(dev, `key ${p.slice(10)}`); res.writeHead(200); return res.end(); }
    if (p.startsWith('/launch/')) { dev.state.app = 'App ' + p.slice(8); trace(dev, `launch ${p.slice(8)}`); res.writeHead(200); return res.end(); }
    res.writeHead(404); res.end();
  };
}

// ------------------------------------------------------------------- Samsung

function samsungInfo(dev) {
  return {
    id: `uuid:${crypto.createHash('md5').update(dev.tag).digest('hex')}`,
    name: `[TV] ${dev.label}`,
    version: '2.0.25',
    device: {
      FrameTVSupport: 'false', GamePadSupport: 'true', ImeSyncedSupport: 'true',
      OS: 'Tizen', TokenAuthSupport: dev.tokenAuth ? 'true' : 'false',
      PowerState: dev.state.power, VoiceSupport: 'true',
      countryCode: 'US', description: 'Samsung DTV RCR',
      developerIP: '0.0.0.0', developerMode: '0',
      duid: `uuid:${dev.tag}`, firmwareVersion: 'Unknown',
      id: `uuid:${dev.tag}`, ip: dev.ip, model: '22_KANTM_UHD',
      modelName: dev.model, name: `[TV] ${dev.label}`,
      networkType: 'wired', resolution: '3840x2160',
      smartHubAgreement: 'true', ssid: '', type: 'Samsung SmartTV',
      udn: `uuid:${dev.tag}`, wifiMac: dev.mac,
    },
  };
}

function samsungHttp(dev) {
  return (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    // A TV that is fully powered down answers nothing at all. Only WoL revives it.
    if (dev.state.power === 'standby' && dev.fault === 'off') { req.socket.destroy(); return; }
    if (dev.fault === 'blackhole') return;                       // on the network, mute

    if (p === '/api/v2/' || p === '/api/v2') return json(res, 200, samsungInfo(dev));
    if (p === '/sim/allow') {                                    // stands in for tapping Allow on the screen
      dev.state.paired = true; trace(dev, 'pairing allowed at the TV');
      return json(res, 200, { ok: true, tag: dev.tag });
    }
    if (p === '/sim/state') return json(res, 200, { tag: dev.tag, ...dev.state });
    res.writeHead(404); res.end();
  };
}

// --- minimal WebSocket server (no dependencies)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsSend(sock, str) {
  const p = Buffer.from(str);
  let head;
  if (p.length < 126) head = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  sock.write(Buffer.concat([head, p]));
}

function wsRead(buf) {                      // returns [payloadString|null, rest]
  if (buf.length < 2) return [null, buf];
  const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) === 0x80;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return [null, buf]; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return [null, buf]; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const need = off + (masked ? 4 : 0) + len;
  if (buf.length < need) return [null, buf];
  let key = null;
  if (masked) { key = buf.slice(off, off + 4); off += 4; }
  const pay = Buffer.from(buf.slice(off, off + len));
  if (key) for (let i = 0; i < pay.length; i++) pay[i] ^= key[i % 4];
  const rest = buf.slice(need);
  if (op === 8) return [' CLOSE', rest];
  return [pay.toString('utf8'), rest];
}

function attachWs(server, dev) {
  server.on('upgrade', (req, sock) => {
    const u = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
               'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

    const token = u.searchParams.get('token');
    if (dev.tokenAuth && !dev.state.paired && !token) {
      // Exactly what an un-accepted Samsung does: connects, refuses, closes.
      wsSend(sock, JSON.stringify({ event: 'ms.channel.unauthorized' }));
      trace(dev, 'remote REFUSED — needs Allow at the TV (POST /sim/allow)');
      return setTimeout(() => sock.destroy(), 50);
    }
    if (!dev.state.token) dev.state.token = String(10000000 + Math.floor(Math.random() * 89999999));
    wsSend(sock, JSON.stringify({
      event: 'ms.channel.connect',
      data: dev.tokenAuth ? { token: dev.state.token } : {},
    }));

    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const [msg, rest] = wsRead(buf);
        if (msg === null) break;
        buf = rest;
        if (msg === ' CLOSE') return sock.destroy();
        try { handleKey(dev, JSON.parse(msg), sock); } catch { /* ignore junk */ }
      }
    });
    sock.on('error', () => {});
  });
}

function handleKey(dev, m, sock) {
  const k = m?.params?.DataOfCmd;
  if (!k) return;
  const st = dev.state;
  if (k === 'KEY_POWERON') st.power = 'on';
  else if (k === 'KEY_POWEROFF') st.power = 'standby';
  else if (k === 'KEY_POWER') st.power = st.power === 'on' ? 'standby' : 'on';
  else if (k === 'KEY_MUTE') st.muted = !st.muted;
  else if (k === 'KEY_VOLUP') st.volume = Math.min(100, st.volume + 1);
  else if (k === 'KEY_VOLDOWN') st.volume = Math.max(0, st.volume - 1);
  else if (k === 'KEY_SOURCE') st.input = st.input === 'TV' ? 'HDMI1' : 'TV';
  else if (/^KEY_[0-9]$/.test(k)) st._buf = (st._buf || '') + k.slice(4);
  else if (k === 'KEY_MINUS') st._buf = (st._buf || '') + '.';
  else if (k === 'KEY_ENTER') { if (st._buf) st.channel = st._buf; st._buf = ''; }
  trace(dev, `${k}${st.channel ? ` (ch ${st.channel})` : ''}`);
  wsSend(sock, JSON.stringify({ event: 'ed.installedApp.get', data: { ok: true } }));
}

// --- Wake-on-LAN: one broadcast listener, routed by the MAC in the magic packet
function startWol(byMac) {
  for (const port of [9, 9999]) {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => s.close());
    s.on('message', (msg) => {
      if (msg.length < 102) return;
      const target = Array.from(msg.slice(6, 12)).map((b) => b.toString(16).padStart(2, '0')).join(':');
      const dev = byMac.get(target);
      if (!dev) return;
      dev.state.power = 'on';
      if (dev.fault === 'off') dev.fault = null;               // it woke up; it now answers
      log(`  WoL  ${pad(dev.tag, 6)} ${target} -> powered on`);
    });
    try { s.bind(port); } catch { /* privileged port without root */ }
  }
}

// ------------------------------------------------------------------- certs

function certs() {
  const dir = path.join(ROOT, '.certs');
  const k = path.join(dir, 'key.pem'), c = path.join(dir, 'cert.pem');
  if (!fs.existsSync(k)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-subj', '/CN=Samsung Simulator', '-keyout', k, '-out', c], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(k), cert: fs.readFileSync(c) };
}

// -------------------------------------------------------------------- start

if (has('--print-aliases')) {
  console.log('# macOS only — Linux needs none of this. Run once per boot:');
  for (const d of devices) console.log(`sudo ifconfig lo0 alias ${d.ip} up`);
  console.log('\n# to remove later:');
  console.log(`for i in $(seq 90 210); do sudo ifconfig lo0 -alias 127.0.0.$i; done`);
  process.exit(0);
}

if (has('--list')) {
  for (const d of devices)
    console.log(`${pad(d.kind, 8)} ${pad(d.tag || d.label, 16)} ${pad(d.ip + ':' + d.port, 24)} ${d.mac}${d.fault ? '  [' + d.fault + ']' : ''}`);
  process.exit(0);
}

const tls = (() => { try { return certs(); } catch { return null; } })();
const byMac = new Map(devices.map((d) => [d.mac, d]));
let started = 0, failed = 0;

for (const d of devices) {
  const boot = (srv, port) => new Promise((ok) => {
    srv.on('error', (e) => { failed++; if (failed < 4) console.error(`  ! ${d.ip}:${port} ${e.code}`); ok(); });
    srv.listen(port, d.ip, () => { started++; ok(); });
  });

  if (d.kind === 'directv') boot(http.createServer(shefHandler(d)), d.port);
  else if (d.kind === 'roku') boot(http.createServer(rokuHandler(d)), d.port);
  else if (d.kind === 'samsung') {
    if (!d.legacy) boot(http.createServer(samsungHttp(d)), d.port);
    const ws = d.legacy || !tls ? http.createServer() : https.createServer(tls);
    attachWs(ws, d);
    boot(ws, d.wsPort);
  }
}

startWol(byMac);

setTimeout(() => {
  const n = (k) => devices.filter((d) => d.kind === k).length;
  console.log('\n  Ticket Sports Bar — device simulator\n');
  console.log(`  ${n('directv')} DirecTV receivers   ${BASE}90-99 : 8080`);
  console.log(`  ${n('roku')} Rokus                ${BASE}100-101 : 8060`);
  console.log(`  ${n('samsung')} Samsung TVs         ${BASE}121-206 : 8001 / 8002`);
  console.log(`\n  mode: ${MODE}   listeners: ${started}${failed ? `   failed: ${failed}` : ''}${tls ? '' : '   (no TLS — wss disabled)'}`);
  console.log('\n  Deliberately broken, so the drivers meet reality:');
  for (const d of devices.filter((x) => x.fault))
    console.log(`    ${pad(d.tag || d.label, 14)} ${pad(d.ip, 16)} ${d.fault}`);
  console.log('\n  Try it:');
  console.log(`    curl ${BASE}90:8080/info/getVersion`);
  console.log(`    curl "${BASE}90:8080/tv/getTuned"`);
  console.log(`    curl "${BASE}90:8080/tv/tune?major=212"`);
  console.log(`    curl ${BASE}121:8001/api/v2/`);
  console.log('\n  node scan.js        # discover everything, the way the agent will');
  console.log('  Ctrl-C to stop.\n');
}, 400);
