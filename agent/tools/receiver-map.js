#!/usr/bin/env node
// Map the DirecTV boxes to their receiver numbers, from the box (Oct 2026).
//
// After a power cut the router can hand the receivers new addresses, so
// "Rcvr 12" in the config may point at the box that feeds channel 16.1.
// This tool finds every box, tunes each to a different well-known channel
// so you can read which TV channel shows which network, and then records
// the right box for each receiver number in the cloud.
//
//   node tools/receiver-map.js scan              every box on the LAN: letter, address, receiver ID, what it is tuned to, which slot(s) point at it
//   node tools/receiver-map.js label             tune box A to CNN, B to ESPN, ... (prints the table) -- then walk the TVs
//   node tools/receiver-map.js apply 10=B 11=A ... record "Rcvr 10 is box B" and so on in the cloud, overriding what is there
//   node tools/receiver-map.js restore           put every box back on the channel it was on before `label`
//
// Run from the agent folder on the Pi (cd ~/bar-ops-platform/agent). Does not
// touch the running agent; restart it after `apply`.
const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const cache = require('../lib/cache');
const directv = require('../lib/drivers/directv');
const scanner = require('../lib/discovery/scanner');

const LABELS = [
  [202, 'CNN'], [206, 'ESPN'], [209, 'ESPN2'], [212, 'NFL Network'], [213, 'MLB Network'], [215, 'NHL Network'],
  [216, 'NBA TV'], [219, 'FS1'], [245, 'TNT'], [247, 'TBS'], [249, 'Comedy Central'], [278, 'Discovery'],
  [229, 'HGTV'], [231, 'Food Network'], [232, 'Travel'], [240, 'Golf'],
];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SAVE = path.join(__dirname, '..', 'receiver-map.json');

function lanCidr() {
  for (const name of Object.keys(os.networkInterfaces())) for (const n of os.networkInterfaces()[name] || []) if (n.family === 'IPv4' && !n.internal) return n.address.replace(/\.\d+$/, '.0/24');
  return null;
}
async function findBoxes() {
  const cidr = lanCidr();
  if (!cidr) throw new Error('No LAN address on this box.');
  process.stderr.write(`Sweeping ${cidr} for DirecTV boxes…\n`);
  const open = await scanner.tcpSweep(scanner.expandCidr(cidr), [8080], { concurrency: 64, timeoutMs: 400 });
  const arp = scanner.readArpTable();
  const sources = ((cache.get('config') || {}).sources || []).filter((s) => s.kind === 'directv');
  const boxes = [];
  await Promise.all([...open.keys()].map(async (ip) => {
    let v; try { v = await directv.getVersion(ip, 8080); } catch (e) { return; }
    const rid = v && v.receiverId ? String(v.receiverId).trim() : null;
    if (!rid) return;
    let tuned = null; try { const t = await directv.getTuned(ip, 8080); tuned = t && t.major != null ? { major: t.major, minor: t.minor != null && t.minor !== 65535 ? t.minor : null, title: t.title || '' } : null; } catch (e) { /* asleep */ }
    boxes.push({ ip, receiverId: rid, mac: arp.get(ip) || null, tuned, slots: sources.filter((s) => s.ip === ip).map((s) => s.slot) });
  }));
  boxes.sort((a, b) => a.ip.split('.').map(Number).reduce((x, o) => x * 256 + o, 0) - b.ip.split('.').map(Number).reduce((x, o) => x * 256 + o, 0));
  boxes.forEach((b, i) => { b.letter = LETTERS[i] || `#${i + 1}`; });
  return boxes;
}
function table(boxes, withLabel) {
  const lines = [`${'Box'.padEnd(4)} ${'Address'.padEnd(14)} ${'Receiver ID'.padEnd(14)} ${'MAC'.padEnd(18)} ${withLabel ? 'Now showing'.padEnd(22) : 'Tuned to'.padEnd(22)} Config says`];
  for (const b of boxes) {
    const now = withLabel && b.label ? `${b.label[0]} ${b.label[1]}` : (b.tuned ? `${b.tuned.major}${b.tuned.minor != null ? '.' + b.tuned.minor : ''} ${b.tuned.title}`.trim() : 'asleep');
    lines.push(`${b.letter.padEnd(4)} ${b.ip.padEnd(14)} ${b.receiverId.padEnd(14)} ${(b.mac || '?').padEnd(18)} ${now.slice(0, 22).padEnd(22)} ${b.slots.length ? b.slots.map((s) => 'Rcvr ' + s).join(', ') : '—'}`);
  }
  return lines.join('\n');
}
async function cloud(pathname, body) {
  const res = await fetch(`${config.CLOUD_URL}${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${config.AGENT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'scan') {
    const boxes = await findBoxes();
    fs.writeFileSync(SAVE, JSON.stringify({ at: new Date().toISOString(), boxes }, null, 1));
    console.log(table(boxes));
    console.log(`\n${boxes.length} box(es). Next: node tools/receiver-map.js label`);
  } else if (cmd === 'label') {
    const boxes = await findBoxes();
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]; const [ch, name] = LABELS[i] || [202 + i, `channel ${202 + i}`];
      b.before = b.tuned; b.label = [ch, name];
      try { await directv.tune(b.ip, 8080, ch); } catch (e) { b.label = [ch, `${name} (tune failed: ${e.message})`]; }
    }
    fs.writeFileSync(SAVE, JSON.stringify({ at: new Date().toISOString(), boxes }, null, 1));
    console.log(table(boxes, true));
    console.log('\nNow look at the TVs. For each TV channel, note which network is on it, then:\n  node tools/receiver-map.js apply 10=B 11=A 12=D ...   (receiver number = box letter)\nWhen done: node tools/receiver-map.js restore');
  } else if (cmd === 'apply') {
    const saved = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
    const pairs = process.argv.slice(3).map((a) => a.split('='));
    if (!pairs.length) { console.log('Give pairs like 10=B 11=A'); process.exit(1); }
    const items = [];
    for (const [slot, letter] of pairs) {
      const b = saved.boxes.find((x) => x.letter === String(letter).toUpperCase());
      if (!b) { console.log(`No box "${letter}" in the last scan.`); process.exit(1); }
      items.push({ slot: Number(slot), receiverId: b.receiverId, ip: b.ip, mac: b.mac, force: true });
    }
    const out = await cloud('/api/venue/agent/sources/identity', { items });
    for (const r of out.results || []) console.log(`Rcvr ${r.slot}: ${r.ok ? `ok -> ${r.row && r.row.ip} (receiver ${r.row && r.row.receiver_id})` : 'FAILED ' + r.error}`);
    console.log('\nRecorded. Now restart the agent so it picks this up: pgrep -f server.js | xargs kill');
  } else if (cmd === 'restore') {
    const saved = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
    for (const b of saved.boxes) {
      if (!b.before || b.before.major == null) continue;
      try { await directv.tune(b.ip, 8080, b.before.major, b.before.minor); console.log(`${b.letter} ${b.ip} back to ${b.before.major}`); } catch (e) { console.log(`${b.letter} ${b.ip}: ${e.message}`); }
    }
  } else {
    console.log('Usage: node tools/receiver-map.js scan | label | apply 10=B 11=A ... | restore');
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
