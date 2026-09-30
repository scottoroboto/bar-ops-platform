#!/usr/bin/env node
// Quick hands-on check of Kasa plugs from any machine on the same network
// (the Pi, or a laptop with Node). No cloud, nothing saved.
//   node agent/tools/kasa-test.js                 find plugs (this machine's network)
//   node agent/tools/kasa-test.js 10.1.40.0/24    find plugs on another subnet too
//   node agent/tools/kasa-test.js 10.1.40.57 info|on|off|blink
// If a plug says it wants a Kasa login, add KASA_USER=... KASA_PASS=... in
// front of the command.
const kasa = require('../lib/drivers/kasa');

if (process.env.KASA_USER) kasa.setAccount({ username: process.env.KASA_USER, password: process.env.KASA_PASS || '' });

(async () => {
  const [a, b] = process.argv.slice(2);
  if (a && /^\d+\.\d+\.\d+\.\d+$/.test(a)) {
    const plug = { ip: a };
    try {
      if (b === 'on' || b === 'off') { await kasa.setPower(plug, b === 'on'); console.log(`Turned ${b}.`); }
      if (b === 'blink') { console.log('Blinking twice…'); await kasa.blink(plug); console.log('Done.'); }
      const i = await kasa.getInfo(plug);
      console.log(`${a}: ${i.on ? 'ON' : 'OFF'}${i.watts !== null ? ` · ${i.watts} W` : ''} · ${i.model || '?'} · MAC ${i.mac || '?'} · name in Kasa: ${i.alias || '-'} · talks ${i.protocol.toUpperCase()}`);
    } catch (e) {
      console.log(`${a}: ${e.code === 'KLAP_AUTH' ? e.message + ' Run again with KASA_USER and KASA_PASS.' : 'no answer (' + (e.code || e.message) + ')'}`);
      process.exitCode = 1;
    }
    return;
  }
  console.log('Looking for Kasa plugs (about 4 seconds)…');
  const found = await kasa.discover({ ranges: a ? [a] : [] });
  if (!found.length) { console.log('None found. Is this machine on the same network as the plugs?'); return; }
  for (const p of found.sort((x, y) => String(x.ip).localeCompare(String(y.ip), undefined, { numeric: true }))) {
    let state = '';
    try { const i = await kasa.getInfo(p); state = `${i.on ? 'ON ' : 'OFF'}${i.watts !== null ? ` ${i.watts} W` : ''}`; } catch (e) { state = e.code === 'KLAP_AUTH' ? 'needs Kasa login' : 'no answer'; }
    console.log(`${String(p.ip).padEnd(15)} ${String(p.mac).padEnd(18)} ${String(p.model || '').padEnd(10)} ${state}`);
  }
  process.exit(0);
})();
