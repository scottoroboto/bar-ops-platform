// Which box is really at each receiver's address (Oct 2026).
//
// The config names each DirecTV receiver by IP. The bar's router hands
// those addresses out by DHCP, so after a power cut (T1, the hurricane)
// the boxes came back on different addresses and "Rcvr 12" was quietly
// talking to the box that feeds a different TV channel. Every DirecTV box
// reports a receiver ID that never changes, so:
//
//  - the first time a slot's box answers, its ID is learned and sent to
//    the cloud (vc_sources.receiver_id, plus the MAC for a DHCP reservation);
//  - every few minutes each address is asked for its ID again. An ID that
//    no longer matches marks the slot "mismatch": the card turns red and
//    tuning it is refused, because the box there feeds some other TV;
//  - a mismatched or silent slot triggers one sweep of the LAN for port
//    8080. If the slot's real box is found at another address, that address
//    is used from then on and reported to the cloud, which updates the
//    config so the fix sticks across restarts.
//  - two slots configured with one address are "duplicate" until the owner
//    sorts them out (identity can't say which of the two is right).
const os = require('os');
const cache = require('./cache');
const directv = require('./drivers/directv');
const scanner = require('./discovery/scanner');

const CHECK_MS = 5 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000;
const SCAN_COOLDOWN_MS = 10 * 60 * 1000;

const state = new Map(); // slot -> { slot, status, ip, mac, expected, found, sharedWith, checkedAt, movedFrom }
let overrides = cache.get('identityOverrides') || {}; // slot -> ip the box was found at
let reporter = null; // async (items) => cloud
let timer = null;
let lastScanAt = 0;
let running = false;

function lanCidr() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address.replace(/\.\d+$/, '.0/24');
    }
  }
  return null;
}
const dtvSources = (config) => ((config && config.sources) || []).filter((s) => s.kind === 'directv' && s.enabled !== false && s.ip);
const ridOf = (v) => (v && v.receiverId != null && String(v.receiverId).trim() ? String(v.receiverId).trim() : null);
async function readId(ip, port) {
  try { return ridOf(await directv.getVersion(ip, port || 8080)); } catch (e) { return null; }
}

// Rewrites a freshly pulled config so every consumer (poller, tune, games)
// uses the address the box was actually found at. Once the cloud has taken
// the new address the override is redundant and dropped.
function applyOverrides(config) {
  if (!config) return config;
  for (const s of config.sources || []) {
    const ip = overrides[s.slot];
    if (!ip || s.kind !== 'directv') continue;
    if (s.ip === ip) delete overrides[s.slot];
    else { s.ip_configured = s.ip; s.ip = ip; }
  }
  cache.set('identityOverrides', overrides);
  return config;
}

async function check(force) {
  if (running) return;
  running = true;
  try {
    const config = cache.get('config');
    const sources = dtvSources(config);
    if (!sources.length) return;
    const arp = scanner.readArpTable();
    const slotsAt = new Map();
    for (const s of sources) slotsAt.set(s.ip, [...(slotsAt.get(s.ip) || []), Number(s.slot)]);
    const found = new Map();
    await Promise.all(sources.map(async (s) => found.set(Number(s.slot), await readId(s.ip, s.port))));
    const learn = [];
    let needScan = false;
    const now = new Date().toISOString();
    for (const s of sources) {
      const slot = Number(s.slot);
      const rid = found.get(slot);
      const expected = s.receiver_id ? String(s.receiver_id).trim() : null;
      const sharedWith = (slotsAt.get(s.ip) || []).filter((x) => x !== slot);
      const e = { slot, ip: s.ip, mac: arp.get(s.ip) || null, expected, found: rid, sharedWith, checkedAt: now, movedFrom: s.ip_configured || null };
      if (sharedWith.length && !expected) e.status = 'duplicate';
      else if (!rid) { e.status = expected ? 'unreachable' : 'unknown'; if (expected) needScan = true; }
      else if (!expected) { e.status = 'ok'; learn.push({ slot, receiverId: rid, ip: s.ip, mac: e.mac }); }
      else if (rid === expected) e.status = 'ok';
      else { e.status = 'mismatch'; needScan = true; }
      state.set(slot, e);
    }
    // One receiver ID belongs to one slot. Two slots learning the same ID
    // are the duplicate-address case seen from the other side.
    const seen = new Map();
    for (const l of learn) {
      const other = seen.get(l.receiverId);
      if (other != null) { state.get(l.slot).status = 'duplicate'; state.get(other).status = 'duplicate'; state.get(l.slot).sharedWith = [other]; state.get(other).sharedWith = [l.slot]; }
      else seen.set(l.receiverId, l.slot);
    }
    const clean = learn.filter((l) => state.get(l.slot).status === 'ok');
    if (clean.length && reporter) await reporter(clean).catch((err) => console.warn('[identity] report failed:', err.message));
    if (needScan && (force || Date.now() - lastScanAt > SCAN_COOLDOWN_MS)) await relocate(sources);
  } finally { running = false; }
}

// Sweep the LAN for DirecTV boxes and move any lost slot to the address
// its receiver ID is answering from.
async function relocate(sources) {
  lastScanAt = Date.now();
  const cidr = lanCidr();
  if (!cidr) return;
  const open = await scanner.tcpSweep(scanner.expandCidr(cidr), [8080], { concurrency: 64, timeoutMs: 400 });
  const atIp = new Map();
  await Promise.all([...open.keys()].map(async (ip) => { const rid = await readId(ip, 8080); if (rid) atIp.set(rid, ip); }));
  const arp = scanner.readArpTable();
  const moved = [];
  for (const s of sources) {
    const slot = Number(s.slot);
    const e = state.get(slot);
    if (!e || !e.expected || (e.status !== 'mismatch' && e.status !== 'unreachable')) continue;
    const ip = atIp.get(e.expected);
    if (!ip || ip === e.ip) continue;
    overrides[slot] = ip;
    state.set(slot, { ...e, status: 'ok', ip, found: e.expected, mac: arp.get(ip) || e.mac, movedFrom: e.ip, checkedAt: new Date().toISOString() });
    moved.push({ slot, receiverId: e.expected, ip, mac: arp.get(ip) || null, moved: true });
    console.log(`[identity] slot ${slot}: receiver ${e.expected} found at ${ip} (was ${e.ip})`);
  }
  if (!moved.length) return;
  cache.set('identityOverrides', overrides);
  applyOverrides(cache.get('config'));
  if (reporter) await reporter(moved).catch((err) => console.warn('[identity] report failed:', err.message));
}

function get(slot) { return state.get(Number(slot)) || null; }
function all() { return Array.from(state.values()); }
function blocked(slot) {
  const e = get(slot);
  if (!e) return null;
  if (e.status === 'mismatch') return `The box at ${e.ip} is not Rcvr ${slot} (it reports receiver ${e.found}, expected ${e.expected}). Not tuning it: it feeds a different TV channel.`;
  if (e.status === 'duplicate') return `Rcvr ${slot} shares address ${e.ip} with Rcvr ${e.sharedWith.join(', ')}. Fix the addresses under Venue Control before tuning.`;
  return null;
}
function setReporter(fn) { reporter = fn; }
function start() {
  if (timer) return;
  setTimeout(() => check(false).catch((err) => console.error('[identity] check failed:', err.message)), FIRST_CHECK_MS);
  timer = setInterval(() => check(false).catch((err) => console.error('[identity] check failed:', err.message)), CHECK_MS);
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, check, get, all, blocked, applyOverrides, setReporter, lanCidr };
