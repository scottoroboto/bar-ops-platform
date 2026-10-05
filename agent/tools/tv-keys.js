#!/usr/bin/env node
// Send remote keys to one Samsung TV from the Pi, to see how it takes a
// channel number. Uses the TV's saved token from this box; nothing saved.
//   node tools/tv-keys.js "TV 8" 1 2 - 1 enter          type 12-1 like the Pi does
//   node tools/tv-keys.js "TV 8" 1 2 - 1 enter --gap 600 same, slower between keys
//   node tools/tv-keys.js "TV 8" try 12.1                four ways, 8 seconds apart: watch the TV
// Keys: 0-9, "-" (dash), enter, or any Samsung key name (KEY_CHUP, KEY_INFO...).
process.chdir(require('path').join(__dirname, '..'));
const cache = require('../lib/cache');
const samsung = require('../lib/drivers/samsung-ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function keyName(k) {
  if (/^\d$/.test(k)) return `KEY_${k}`;
  if (k === '-' || /^dash$/i.test(k)) return 'KEY_MINUS';
  if (/^enter$/i.test(k)) return 'KEY_ENTER';
  return /^KEY_/i.test(k) ? k.toUpperCase() : `KEY_${k.toUpperCase()}`;
}

(async () => {
  const args = process.argv.slice(2);
  const gi = args.indexOf('--gap');
  const gap = gi >= 0 ? Number(args.splice(gi, 2)[1]) || 200 : 200;
  const [who, ...rest] = args;
  if (!who || !rest.length) { console.log('Usage: node tools/tv-keys.js "TV 8" 1 2 - 1 enter [--gap 600]   or   node tools/tv-keys.js "TV 8" try 12.1'); process.exit(1); }
  const tvs = (cache.get('config') || {}).tvs || [];
  const tv = tvs.find((t) => String(t.name).toLowerCase() === who.toLowerCase() || t.ip === who);
  if (!tv) { console.log(`No TV named "${who}" on this box. TVs: ${tvs.map((t) => t.name).join(', ')}`); process.exit(1); }
  console.log(`${tv.name} at ${tv.ip} (${tv.control_method})`);

  if (rest[0] === 'try') {
    const ch = rest[1] || '12.1';
    const [major, minor] = ch.split('.');
    const d = (s) => s.split('').map(keyName);
    const ways = [
      ['A: digits, dash, digit, Enter (what the Pi does now)', [...d(major), 'KEY_MINUS', ...d(minor || ''), 'KEY_ENTER'], 200],
      ['B: same, slower (0.7s between keys)', [...d(major), 'KEY_MINUS', ...d(minor || ''), 'KEY_ENTER'], 700],
      ['C: main number only, then Enter', [...d(major), 'KEY_ENTER'], 200],
      ['D: digits, dash, digit, no Enter', [...d(major), 'KEY_MINUS', ...d(minor || '')], 200],
    ];
    for (const [label, keys, g] of ways) {
      console.log(`\n${label}\n  sending ${keys.join(' ')}`);
      try { await samsung.sendKeySequence(tv, keys, { interKeyDelayMs: g }); console.log('  sent. What channel is the TV on now?'); } catch (err) { console.log(`  failed: ${err.message}`); }
      await sleep(8000);
    }
  } else {
    const keys = rest.map(keyName);
    console.log(`Sending ${keys.join(' ')} with ${gap}ms between keys`);
    await samsung.sendKeySequence(tv, keys, { interKeyDelayMs: gap });
    console.log('Sent.');
  }
  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
