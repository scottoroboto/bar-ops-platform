#!/usr/bin/env node
// SmartThings on this box: power-on for the TVs that ignore Wake-on-LAN
// over Wi-Fi. One-time setup, then the box keeps its own sign-in.
//   node tools/smartthings.js                 status: signed in? which TVs are linked?
//   node tools/smartthings.js signin          sign in (needs the OAuth app's Client ID and Secret)
//   node tools/smartthings.js tvs             link SmartThings TVs to Bar Ops TVs (by name)
//   node tools/smartthings.js test "TV 6" on  turn one TV on (or off) through SmartThings
//   node tools/smartthings.js unlink "TV 6"   stop using SmartThings for one TV
// Saved in this box's local cache only; nothing goes to the cloud.
process.chdir(require('path').join(__dirname, '..'));
const readline = require('readline');
const cache = require('../lib/cache');
const st = require('../lib/drivers/samsung-st');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(String(a).trim())));
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const tvs = () => ((cache.get('config') || {}).tvs || []);
const map = () => cache.get('smartthingsDevices') || {};

async function status() {
  const a = cache.get('smartthingsAuth');
  if (a && a.refresh) {
    const days = Math.floor((Date.now() - (a.refreshedAt || 0)) / 86400000);
    console.log(`Signed in to SmartThings (session renewed ${days === 0 ? 'today' : `${days} day(s) ago`}; it renews itself).`);
  } else if (st.configured()) {
    console.log('Using SMARTTHINGS_TOKEN from .env (a website token: these expire after 24 hours). Run "signin" for a lasting one.');
  } else {
    console.log('Not signed in. Run: node tools/smartthings.js signin');
  }
  const m = map();
  const linked = tvs().filter((t) => m[String(t.id)] || t.st_device_id);
  console.log(linked.length ? `Linked TVs (power-on goes through SmartThings): ${linked.map((t) => t.name).join(', ')}` : 'No TVs linked yet. Run: node tools/smartthings.js tvs');
}

async function signin() {
  console.log('You need the Client ID and Client Secret of your SmartThings OAuth app (see the steps you were given).');
  const clientId = await ask('Client ID: ');
  const clientSecret = await ask('Client Secret: ');
  if (!clientId || !clientSecret) { console.log('Both are needed.'); return; }
  console.log(`\n1. Open this link on your phone or computer and sign in with the Samsung account that has the TVs:\n\n${st.authorizeUrl(clientId)}\n`);
  console.log(`2. Allow access. You'll land on a page at ${st.REDIRECT_URI} showing "code": "XXXXXX".`);
  const pasted = await ask('3. Paste the code here (or the whole address of that page): ');
  const m = pasted.match(/[?&]code=([^&\s]+)/) || pasted.match(/"code"\s*:\s*"([^"]+)"/);
  const code = m ? decodeURIComponent(m[1]) : pasted.replace(/"/g, '');
  if (!code) { console.log('No code.'); return; }
  await st.signIn(clientId, clientSecret, code);
  console.log('\nSigned in. The box keeps this session going by itself.');
  const list = await st.listTvs();
  console.log(`SmartThings sees ${list.length} TV(s). Next: node tools/smartthings.js tvs`);
}

async function link() {
  const list = await st.listTvs();
  if (!list.length) { console.log('SmartThings has no TVs on this account. Add them in the SmartThings app first.'); return; }
  const m = map();
  const ours = tvs();
  console.log(`SmartThings TVs on this account: ${list.length}\n`);
  for (const d of list) {
    let tv = ours.find((t) => squash(t.name) === squash(d.label)) || ours.find((t) => m[String(t.id)] === d.deviceId);
    if (!tv) {
      const ans = await ask(`"${d.label}" -- which Bar Ops TV is this? (type its name, Enter to skip): `);
      if (!ans) continue;
      tv = ours.find((t) => squash(t.name) === squash(ans));
      if (!tv) { console.log(`   No Bar Ops TV named "${ans}", skipped.`); continue; }
    }
    m[String(tv.id)] = d.deviceId;
    console.log(`   ${tv.name}  <-  "${d.label}"`);
  }
  cache.set('smartthingsDevices', m);
  console.log('\nSaved. Those TVs now turn on through SmartThings first. Restart the agent so it picks this up:');
  console.log('   pgrep -f server.js | xargs kill');
}

async function test(who, op) {
  const tv = tvs().find((t) => squash(t.name) === squash(who));
  if (!tv) { console.log(`No Bar Ops TV named "${who}".`); return; }
  const id = st.deviceIdFor(tv);
  if (!id) { console.log(`${tv.name} isn't linked to SmartThings. Run: node tools/smartthings.js tvs`); return; }
  const t = Date.now();
  if (op === 'off') await st.switchOff(id); else await st.switchOn(id);
  console.log(`Sent "${op === 'off' ? 'off' : 'on'}" to ${tv.name} through SmartThings in ${((Date.now() - t) / 1000).toFixed(1)}s. Watch the TV.`);
  await new Promise((r) => setTimeout(r, 8000));
  console.log(`SmartThings now says: ${await st.getSwitchState(id).catch((e) => e.message)}`);
}

(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  if (!cmd) await status();
  else if (cmd === 'signin') await signin();
  else if (cmd === 'tvs') await link();
  else if (cmd === 'test') await test(a, b);
  else if (cmd === 'unlink') {
    const tv = tvs().find((t) => squash(t.name) === squash(a));
    const m = map();
    if (tv) { delete m[String(tv.id)]; cache.set('smartthingsDevices', m); console.log(`${tv.name} unlinked.`); } else console.log(`No Bar Ops TV named "${a}".`);
  } else console.log('Commands: (none) | signin | tvs | test "TV 6" on|off | unlink "TV 6"');
  rl.close();
  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
