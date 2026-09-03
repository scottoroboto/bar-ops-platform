// Phase 1 discovery engine (docs/venue-control.md §9.1): the six-pass scan
// -- announce, sweep, interrogate, identify, classify, report. Entirely
// read-only: nothing here ever sends a command that changes a device's
// state (that's discovery's separate, explicitly-gated "test" step, §9.2).
//
// Uses only Node stdlib (dgram, net, fs, os) plus the global `fetch` --
// matches the spec's "the agent has exactly three runtime dependencies"
// constraint (§4); discovery doesn't need a fourth.
const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const { lookupVendor } = require('../oui');

const SWEEP_PORTS = [8080, 8001, 8002, 8060, 9197, 55000, 7676, 80, 443, 22];
const SWEEP_CONCURRENCY = 64;
const SWEEP_TIMEOUT_MS = 400;
const ANNOUNCE_WINDOW_MS = 3000;
const INTERROGATE_TIMEOUT_MS = 1500;
const MAX_HOSTS_PER_RANGE = 4096; // guards against an accidental huge/incorrect CIDR

// ---------------------------------------------------------------- helpers

function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`Not a valid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// "192.168.1.0/24" -> array of host IP strings (network/broadcast excluded
// for prefixes < 31). Throws on anything that would expand past
// MAX_HOSTS_PER_RANGE, rather than silently truncating a scan.
function expandCidr(cidr) {
  const [base, prefixStr] = String(cidr).trim().split('/');
  const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Not a valid CIDR range: ${cidr}`);
  }
  const baseInt = ipToInt(base);
  const hostBits = 32 - prefix;
  const size = hostBits === 0 ? 1 : 2 ** hostBits;
  if (size > MAX_HOSTS_PER_RANGE) {
    throw new Error(`${cidr} expands to ${size} hosts, over the ${MAX_HOSTS_PER_RANGE}-host safety cap -- use a narrower range (e.g. a /22 or smaller).`);
  }
  const networkInt = (baseInt & (hostBits === 32 ? 0 : (0xffffffff << hostBits) >>> 0)) >>> 0;
  const ips = [];
  const first = size <= 2 ? 0 : 1;
  const last = size <= 2 ? size - 1 : size - 2;
  for (let i = first; i <= last; i++) ips.push(intToIp((networkInt + i) >>> 0));
  return ips;
}

function fetchWithTimeout(url, opts = {}, timeoutMs = INTERROGATE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// -------------------------------------------------------------- 1. announce

// SSDP M-SEARCH (ssdp:all) -- most consumer TVs/media devices answer this
// within a couple seconds, so most hosts are known before sweep even
// starts. Best-effort: a network that blocks multicast just yields an empty
// set here and everything falls through to the sweep pass instead.
function ssdpAnnounce(windowMs = ANNOUNCE_WINDOW_MS) {
  return new Promise((resolve) => {
    const found = new Set();
    const socket = dgram.createSocket('udp4');
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 2\r\n' +
      'ST: ssdp:all\r\n\r\n'
    );
    socket.on('message', (_msg, rinfo) => found.add(rinfo.address));
    socket.on('error', () => {}); // best-effort -- a bind/send failure just means an empty announce set
    socket.bind(() => {
      try {
        socket.send(msg, 0, msg.length, 1900, '239.255.255.250');
        socket.send(msg, 0, msg.length, 1900, '239.255.255.250'); // a second send catches devices that missed the first
      } catch { /* best-effort */ }
    });
    setTimeout(() => { try { socket.close(); } catch { /* already closed */ } resolve(found); }, windowMs);
  });
}

// mDNS query on 224.0.0.251:5353 -- best-effort presence signal only. This
// does not parse the DNS answer payload (would need a real DNS-message
// parser for marginal extra benefit over SSDP, which already covers the
// vendors this app cares about per §9.1); it just records which hosts
// responded at all, seeding them into the sweep pass.
function mdnsAnnounce(windowMs = ANNOUNCE_WINDOW_MS) {
  return new Promise((resolve) => {
    const found = new Set();
    const socket = dgram.createSocket('udp4');
    // A minimal DNS query for PTR _services._dns-sd._udp.local -- enough to
    // provoke a reply from most mDNS responders without needing per-service
    // query construction.
    const query = Buffer.from([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x09, 0x5f, 0x73, 0x65, 0x72, 0x76, 0x69, 0x63, 0x65, 0x73, 0x07, 0x5f,
      0x64, 0x6e, 0x73, 0x2d, 0x73, 0x64, 0x04, 0x5f, 0x75, 0x64, 0x70, 0x05,
      0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x00, 0x00, 0x0c, 0x00, 0x01,
    ]);
    socket.on('message', (_msg, rinfo) => found.add(rinfo.address));
    socket.on('error', () => {});
    socket.bind(() => {
      try { socket.send(query, 0, query.length, 5353, '224.0.0.251'); } catch { /* best-effort */ }
    });
    setTimeout(() => { try { socket.close(); } catch { /* already closed */ } resolve(found); }, windowMs);
  });
}

async function announce() {
  const [ssdp, mdns] = await Promise.all([ssdpAnnounce(), mdnsAnnounce()]);
  return new Set([...ssdp, ...mdns]);
}

// ---------------------------------------------------------------- 2. sweep

function probePort(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

// TCP connect scan across `ips` × `ports`, bounded concurrency (a plain
// worker-pool over a flattened job list -- no extra dependency needed for
// something this small).
async function tcpSweep(ips, ports = SWEEP_PORTS, { concurrency = SWEEP_CONCURRENCY, timeoutMs = SWEEP_TIMEOUT_MS } = {}) {
  const jobs = [];
  for (const ip of ips) for (const port of ports) jobs.push({ ip, port });
  const openByIp = new Map();
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { ip, port } = jobs[next++];
      const open = await probePort(ip, port, timeoutMs);
      if (open) {
        if (!openByIp.has(ip)) openByIp.set(ip, []);
        openByIp.get(ip).push(port);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) || 1 }, worker);
  await Promise.all(workers);
  return openByIp;
}

// ------------------------------------------------------------ 3. interrogate

async function probeDirectv(ip) {
  const res = await fetchWithTimeout(`http://${ip}:8080/info/getVersion`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  return { classifiedAs: 'directv_receiver', confidence: 'high', identity: data };
}

async function probeSamsung(ip) {
  const res = await fetchWithTimeout(`http://${ip}:8001/api/v2/`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  const device = data.device || data;
  return {
    classifiedAs: 'samsung_tv',
    confidence: 'high',
    identity: {
      name: device.name || null,
      modelName: device.modelName || null,
      wifiMac: device.wifiMac || null,
      networkType: device.networkType || null,
      PowerState: device.PowerState || null,
      TokenAuthSupport: device.TokenAuthSupport ?? data.TokenAuthSupport ?? null,
    },
  };
}

async function probeRoku(ip) {
  const res = await fetchWithTimeout(`http://${ip}:8060/query/device-info`);
  if (!res.ok) return null;
  const xml = await res.text().catch(() => '');
  if (!xml) return null;
  const field = (tag) => (xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')) || [])[1] || null;
  return {
    classifiedAs: 'roku',
    confidence: 'high',
    identity: {
      name: field('friendly-device-name') || field('user-device-name'),
      modelName: field('model-name'),
      serialNumber: field('serial-number'),
      powerMode: field('power-mode'),
    },
  };
}

// Legacy Samsung sets: reachable on :55000 but never answer :8001 --
// identity is thin (there's no JSON endpoint to read on this generation),
// so this is a port-signature-only, medium-confidence classification.
function legacySamsungSignature(openPorts) {
  if (openPorts.includes(55000) && !openPorts.includes(8001)) {
    return { classifiedAs: 'samsung_tv_legacy', confidence: 'medium', identity: {} };
  }
  return null;
}

async function interrogate(ip, openPorts) {
  const probes = [];
  if (openPorts.includes(8080)) probes.push(probeDirectv(ip));
  if (openPorts.includes(8001)) probes.push(probeSamsung(ip));
  if (openPorts.includes(8060)) probes.push(probeRoku(ip));
  const results = (await Promise.all(probes)).filter(Boolean);
  if (results.length) return results[0]; // identity endpoints don't overlap across vendors in practice
  const legacy = legacySamsungSignature(openPorts);
  if (legacy) return legacy;
  return null;
}

// -------------------------------------------------------------- 4. identify

// Reads the kernel's ARP table (populated for any host the agent box has
// already exchanged L2 frames with -- true for anything just TCP-probed by
// the sweep pass above) to resolve IP -> MAC. Linux-only (`/proc/net/arp`),
// which matches the agent's supported hardware (README.md explicitly rules
// out the Windows box) -- returns an empty map rather than throwing on any
// platform where the file doesn't exist.
function readArpTable() {
  const map = new Map();
  let text;
  try {
    text = fs.readFileSync('/proc/net/arp', 'utf8');
  } catch {
    return map; // not on Linux, or no ARP table available -- degrade gracefully
  }
  const lines = text.split('\n').slice(1); // header row
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [ip, , , mac] = cols;
    if (mac && mac !== '00:00:00:00:00:00') map.set(ip, mac);
  }
  return map;
}

// -------------------------------------------------------------- 5/6. classify + report

function buildControlMethods(device) {
  const methods = [];
  if (device.classified_as === 'samsung_tv') {
    const tokenAuth = device.identity && device.identity.TokenAuthSupport;
    methods.push({
      method: tokenAuth === 'true' || tokenAuth === true ? 'samsung_ws_token' : 'samsung_ws_plain',
      port: 8002,
      status: 'available',
      needs_pairing: tokenAuth === 'true' || tokenAuth === true,
    });
    methods.push({ method: 'smartthings', status: 'unmatched' }); // Phase 6 territory -- not probed yet
  } else if (device.classified_as === 'samsung_tv_legacy') {
    methods.push({ method: 'samsung_legacy', port: 55000, status: 'available' });
  } else if (device.classified_as === 'directv_receiver') {
    methods.push({ method: 'shef_http', port: 8080, status: 'available' });
  } else if (device.classified_as === 'roku') {
    methods.push({ method: 'roku_ecp', port: 8060, status: 'available' });
  }
  if (device.mac) methods.push({ method: 'wol', status: 'available' });
  return methods;
}

function classifyDevice({ ip, mac, openPorts, interrogateResult }) {
  const ouiVendor = lookupVendor(mac);
  let classifiedAs = 'unknown';
  let confidence = 'low';
  let identity = {};

  if (interrogateResult) {
    classifiedAs = interrogateResult.classifiedAs;
    confidence = interrogateResult.confidence;
    identity = interrogateResult.identity || {};
  } else if (ouiVendor === 'Samsung Electronics' && (openPorts.includes(8001) || openPorts.includes(8002))) {
    classifiedAs = 'samsung_tv';
    confidence = 'medium'; // port signature + OUI agree, but the identity endpoint didn't actually answer
  } else if (ouiVendor === 'Roku' && openPorts.includes(8060)) {
    classifiedAs = 'roku';
    confidence = 'medium';
  } else if (ouiVendor) {
    // OUI-only match, no corroborating port/identity signal (§9.1: "low"
    // confidence). Still surfaced -- a TV that's asleep and answering
    // nothing still shows up as a Samsung, per the spec's own example.
    if (ouiVendor === 'Samsung Electronics') classifiedAs = 'samsung_tv';
    else if (ouiVendor === 'Roku') classifiedAs = 'roku';
    confidence = 'low';
  }

  const device = {
    ip, mac: mac || null, oui_vendor: ouiVendor,
    open_ports: openPorts, classified_as: classifiedAs, confidence, identity,
  };
  device.control_methods = buildControlMethods(device);
  return device;
}

// ------------------------------------------------------------------- scan

// Orchestrates all six passes. `ranges` is an array of CIDR strings (e.g.
// `["192.168.1.0/24"]`); `deep` currently just widens the announce window
// slightly -- reserved for a future "also probe every open port, not just
// known signatures" mode once real hardware shows what else is worth
// checking.
async function scan({ ranges, deep = false } = {}) {
  if (!Array.isArray(ranges) || !ranges.length) {
    throw new Error('scan() needs at least one CIDR range, e.g. ["192.168.1.0/24"].');
  }
  const startedAt = new Date().toISOString();

  const rangeIps = new Set();
  for (const cidr of ranges) for (const ip of expandCidr(cidr)) rangeIps.add(ip);

  const announced = await announce(); // seeds fast hits; sweep still covers the full range regardless
  const openByIp = await tcpSweep([...rangeIps], SWEEP_PORTS, {
    timeoutMs: deep ? SWEEP_TIMEOUT_MS * 2 : SWEEP_TIMEOUT_MS,
  });

  const arpTable = readArpTable();
  const candidateIps = new Set([...announced, ...openByIp.keys()]);

  const devices = [];
  for (const ip of candidateIps) {
    const openPorts = (openByIp.get(ip) || []).slice().sort((a, b) => a - b);
    const mac = arpTable.get(ip) || null;
    let interrogateResult = null;
    if (openPorts.length) {
      try {
        interrogateResult = await interrogate(ip, openPorts);
      } catch {
        interrogateResult = null; // a probe erroring out just means this device falls back to OUI/port-only classification
      }
    }
    devices.push(classifyDevice({ ip, mac, openPorts, interrogateResult }));
  }

  devices.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  return {
    ranges,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    host_count: rangeIps.size,
    devices,
  };
}

module.exports = { scan, expandCidr, classifyDevice, readArpTable, tcpSweep, announce, interrogate };
