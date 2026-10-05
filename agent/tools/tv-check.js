#!/usr/bin/env node
// Test one TV end to end, the same way the TVs page does it:
//   node tools/tv-check.js "TV 1" 14        off, wait, on, then source 14 (its QAM channel)
//   node tools/tv-check.js "TV 1" 12.1      ...or a QAM channel typed directly
//   node tools/tv-check.js "TV 1"           off and on only
// Prints how long each step took and what the TV did while it was off:
// "standby" means it stayed on the network (Power On with Mobile is on,
// good); "asleep" means it dropped off and needs Wake-on-LAN (slower).
process.chdir(require('path').join(__dirname, '..'));
const cache = require('../lib/cache');
const samsung = require('../lib/drivers/samsung-ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
const word = (s) => (s === 'unreachable' ? 'asleep (not answering)' : s === 'standby' ? 'standby (screen off, on the network)' : s);
const squash = (s) => String(s).toLowerCase().replace(/\s+/g, '');

(async () => {
  const [who, chArg] = process.argv.slice(2);
  if (!who) { console.log('Usage: node tools/tv-check.js "TV 1" [source slot like 14, or QAM channel like 12.1]'); process.exit(1); }
  const config = cache.get('config') || {};
  const tvs = config.tvs || [];
  const tv = tvs.find((t) => squash(t.name) === squash(who) || t.ip === who);
  if (!tv) { console.log(`No TV named "${who}". TVs: ${tvs.map((t) => t.name).join(', ')}`); process.exit(1); }
  let qam = null;
  if (chArg) {
    const src = (config.sources || []).find((s) => String(s.slot) === String(chArg));
    qam = src ? src.qam_channel : chArg;
    if (src) console.log(`Source ${chArg} is ${src.label} on QAM ${qam}`);
  }
  console.log(`${tv.name} at ${tv.ip}  MAC ${tv.mac || 'none'}  Wake-on-LAN ${tv.wol_enabled ? 'on' : 'off'}`);
  console.log(`Now: ${word(await samsung.getPowerState(tv))}\n`);

  let t = Date.now();
  console.log('1. Power OFF ...');
  const off = await samsung.setPower(tv, 'off');
  console.log(`   ${off.ok ? 'OK' : 'FAILED'} in ${secs(t)} (${off.method}, now ${word(off.state)})`);

  console.log('   Watching it for 12s while off:');
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    await sleep(2000);
    const s = await samsung.getPowerState(tv, 1500);
    seen.push(s);
    process.stdout.write(`   ${(i + 1) * 2}s ${s === 'unreachable' ? 'asleep' : s}${i === 5 ? '\n' : ''}`);
  }
  const offState = seen[seen.length - 1];
  console.log(offState === 'unreachable'
    ? '   -> It drops off the network when off. Power-on needs Wake-on-LAN (slower). Turn on "Power On with Mobile" on this TV.'
    : '   -> It stays on the network when off. Good: power-on can press Power right away.');

  t = Date.now();
  console.log('\n2. Power ON ...');
  const on = await samsung.setPower(tv, 'on');
  console.log(`   ${on.ok ? 'OK' : 'FAILED'} in ${secs(t)} (${on.method}, now ${word(on.state)})`);

  if (qam && on.ok) {
    await sleep(3000); // let the picture settle before typing a channel
    t = Date.now();
    console.log(`\n3. Channel ${qam} ...`);
    try {
      const r = await samsung.selectChannel(tv, qam);
      console.log(`   Sent ${r.keysSent.join(' ')} in ${secs(t)}. Check the TV shows ${qam}.`);
    } catch (err) {
      console.log(`   FAILED: ${err.message}`);
    }
  } else if (qam) {
    console.log('\n3. Channel skipped: the TV did not come on.');
  }
  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
