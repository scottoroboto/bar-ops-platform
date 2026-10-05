#!/usr/bin/env node
// Test TVs end to end, the same way the TVs page does it: power off,
// watch it 12s, power on, then type a channel.
//   node tools/tv-check.js "TV 1" 14        one TV, then source 14 (its QAM channel)
//   node tools/tv-check.js "TV 1" 12.1      ...or a QAM channel typed directly
//   node tools/tv-check.js all 14           every TV in order: after each you answer
//                                           y (worked) / n (didn't) / r (run it again),
//                                           and it moves on. A summary at the end.
//   node tools/tv-check.js all 14 --from "TV 5"   pick up where you left off
// "standby" while off means the set stayed on the network (Power On with
// Mobile is on, good); "asleep" means it dropped off and needs Wake-on-LAN.
process.chdir(require('path').join(__dirname, '..'));
const readline = require('readline');
const cache = require('../lib/cache');
const samsung = require('../lib/drivers/samsung-ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
const word = (s) => (s === 'unreachable' ? 'asleep (not answering)' : s === 'standby' ? 'standby (screen off, on the network)' : s);
const squash = (s) => String(s).toLowerCase().replace(/\s+/g, '');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(String(a).trim().toLowerCase())));

// "TV 2" before "TV 10"; named sets (GTPGA, Putt Putt) after the numbers.
function naturalOrder(a, b) {
  const na = String(a.name).match(/(\d+)/);
  const nb = String(b.name).match(/(\d+)/);
  if (na && nb) return Number(na[1]) - Number(nb[1]) || String(a.name).localeCompare(String(b.name));
  if (na) return -1;
  if (nb) return 1;
  return String(a.name).localeCompare(String(b.name));
}

async function testOne(tv, qam) {
  const r = { name: tv.name, offOk: false, offStays: null, onOk: false, onSecs: null, onMethod: null, channelSent: false };
  console.log(`\n=== ${tv.name} at ${tv.ip}  MAC ${tv.mac || 'none'}  Wake-on-LAN ${tv.wol_enabled ? 'on' : 'off'}`);
  console.log(`Now: ${word(await samsung.getPowerState(tv))}`);

  let t = Date.now();
  console.log('1. Power OFF ...');
  const off = await samsung.setPower(tv, 'off');
  r.offOk = off.ok;
  console.log(`   ${off.ok ? 'OK' : 'FAILED'} in ${secs(t)} (${off.method}, now ${word(off.state)})`);

  console.log('   Watching it for 12s while off:');
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    await sleep(2000);
    last = await samsung.getPowerState(tv, 1500);
    process.stdout.write(`   ${(i + 1) * 2}s ${last === 'unreachable' ? 'asleep' : last}${i === 5 ? '\n' : ''}`);
  }
  r.offStays = last !== 'unreachable';
  console.log(r.offStays
    ? '   -> It stays on the network when off. Good: power-on can press Power right away.'
    : '   -> It drops off the network when off. Power-on needs Wake-on-LAN (slower). Turn on "Power On with Mobile" on this TV.');

  t = Date.now();
  console.log('2. Power ON ...');
  const on = await samsung.setPower(tv, 'on');
  r.onOk = on.ok;
  r.onSecs = (Date.now() - t) / 1000;
  r.onMethod = on.method;
  console.log(`   ${on.ok ? 'OK' : 'FAILED'} in ${secs(t)} (${on.method}, now ${word(on.state)})`);

  if (qam && on.ok) {
    await sleep(3000); // let the picture settle before typing a channel
    t = Date.now();
    console.log(`3. Channel ${qam} ...`);
    try {
      const s = await samsung.selectChannel(tv, qam);
      r.channelSent = true;
      console.log(`   Sent ${s.keysSent.join(' ')} in ${secs(t)}. Check the TV shows ${qam}.`);
    } catch (err) {
      console.log(`   FAILED: ${err.message}`);
    }
  } else if (qam) {
    console.log('3. Channel skipped: the TV did not come on.');
  }
  return r;
}

(async () => {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--from');
  const from = fi >= 0 ? args.splice(fi, 2)[1] : null;
  const [who, chArg] = args;
  if (!who) { console.log('Usage: node tools/tv-check.js "TV 1" 14   or   node tools/tv-check.js all 14 [--from "TV 5"]'); process.exit(1); }
  const config = cache.get('config') || {};
  const tvs = (config.tvs || []).filter((t) => t.ip);
  let qam = null;
  if (chArg) {
    const src = (config.sources || []).find((s) => String(s.slot) === String(chArg));
    qam = src ? src.qam_channel : chArg;
    if (src) console.log(`Source ${chArg} is ${src.label} on QAM ${qam}`);
  }

  if (squash(who) !== 'all') {
    const tv = tvs.find((t) => squash(t.name) === squash(who) || t.ip === who);
    if (!tv) { console.log(`No TV named "${who}". TVs: ${tvs.map((t) => t.name).join(', ')}`); process.exit(1); }
    await testOne(tv, qam);
    process.exit(0);
  }

  let list = tvs.slice().sort(naturalOrder);
  if (from) {
    const i = list.findIndex((t) => squash(t.name) === squash(from));
    if (i < 0) { console.log(`No TV named "${from}".`); process.exit(1); }
    list = list.slice(i);
  }
  console.log(`${list.length} TVs, in this order: ${list.map((t) => t.name).join(', ')}`);
  const results = [];
  for (let i = 0; i < list.length; i += 1) {
    const tv = list[i];
    const go = await ask(`\nNext: ${tv.name} (${i + 1} of ${list.length}). Enter to test, s to skip, q to quit: `);
    if (go === 'q') break;
    if (go === 's') { results.push({ name: tv.name, verdict: 'skipped' }); continue; }
    let r;
    let verdict;
    for (;;) {
      r = await testOne(tv, qam);
      verdict = await ask(`\nDid ${tv.name} turn off, come back on${qam ? ` and land on ${qam}` : ''}? y / n / r (run again): `);
      if (verdict !== 'r') break;
    }
    let note = '';
    if (verdict === 'n') note = await ask('What went wrong? (Enter to skip): ');
    results.push({ ...r, verdict: verdict === 'y' ? 'worked' : verdict === 'n' ? 'did not work' : verdict || 'no answer', note });
  }

  console.log('\n===== Summary =====');
  for (const r of results) {
    if (r.verdict === 'skipped') { console.log(`${r.name.padEnd(12)} skipped`); continue; }
    const net = r.offStays == null ? '' : r.offStays ? 'stays on network' : 'NEEDS Power On with Mobile';
    console.log(`${r.name.padEnd(12)} ${r.verdict.padEnd(13)} on in ${r.onSecs != null ? `${r.onSecs.toFixed(0)}s`.padEnd(4) : '-   '} ${net}${r.note ? `  (${r.note})` : ''}`);
  }
  rl.close();
  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
