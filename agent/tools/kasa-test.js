#!/usr/bin/env node
// Quick hands-on check of Kasa plugs from any machine on the same network
// (the Pi, or a laptop with Node). No cloud, nothing saved.
//   node agent/tools/kasa-test.js                 find plugs (this machine's network)
//   node agent/tools/kasa-test.js 10.1.40.0/24    find plugs on another subnet too
//   node agent/tools/kasa-test.js 10.1.40.57 info|on|off|blink
// Brand-new plug (join your laptop to the plug's own "TP-LINK_Smart Plug_…"
// Wi-Fi first):
//   node agent/tools/kasa-test.js networks                 what the plug can see
//   node agent/tools/kasa-test.js wifi "Ticket WiFi" 'password'      (single quotes if it has a $)
//   node agent/tools/kasa-test.js wifi "Ticket WiFi" 'password' wpa2 (force WPA2)
// If a plug says it wants a Kasa login, add KASA_USER=... KASA_PASS=... in
// front of the command.
const kasa = require('../lib/drivers/kasa');

if (process.env.KASA_USER) kasa.setAccount({ username: process.env.KASA_USER, password: process.env.KASA_PASS || '' });

(async () => {
  const [a, b, c] = process.argv.slice(2);
  if (a === 'networks') {
    try {
      const list = await kasa.wifiScan();
      if (!list.length) console.log('The plug sees no networks.');
      const SEC = { 0: 'open', 1: 'WEP', 2: 'WPA', 3: 'WPA2', 4: 'WPA3?' };
      for (const n of list) console.log(`${String(n.ssid).padEnd(32)} ${String(SEC[n.keyType] || `type ${n.keyType}`).padEnd(8)} ${n.signal !== null ? `${n.signal} dBm` : ''}`);
    } catch (e) {
      console.log(`No answer from a plug in setup mode (${e.code || e.message}). Is this computer on the plug's own "TP-LINK_Smart Plug" Wi-Fi?`);
      process.exitCode = 1;
    }
    return;
  }
  if (a === 'wifi') {
    if (!b) { console.log('Usage: node kasa-test.js wifi "Wi-Fi name" "password"'); process.exitCode = 1; return; }
    // Security type: what the plug reports for that network, unless given
    // as a 4th word ("wpa2" forces WPA2, the type Kasa plugs always handle).
    let keyType = 3;
    const forced = process.argv[5] ? String(process.argv[5]).toLowerCase() : '';
    try {
      const seen = (await kasa.wifiScan()).find((n) => n.ssid === b);
      if (!seen) console.log(`Heads up: the plug doesn't see a network called "${b}" (names are case-sensitive). Sending it anyway.`);
      else if (seen.keyType !== undefined && !forced) keyType = seen.keyType;
      if (seen) console.log(`The plug sees "${b}" at ${seen.signal} dBm, security type ${seen.keyType}.`);
    } catch (e) { /* some plugs don't scan; join still works */ }
    if (forced === 'wpa2') keyType = 3;
    else if (/^\d+$/.test(forced)) keyType = Number(forced);
    try {
      const r = await kasa.wifiJoin(undefined, b, c || '', keyType);
      console.log(r.confirmed ? `The plug took it. It's joining "${b}" now.` : `Sent. The plug dropped its setup Wi-Fi, which means it's joining "${b}".`);
      console.log('Put this computer back on the normal Wi-Fi. In about 30 seconds: node kasa-test.js   (to find it), or Find plugs in TV Admin.');
      console.log('If the plug\'s light goes back to blinking after a minute or two, the name or password was wrong. Run this again.');
    } catch (e) {
      console.log(`Couldn't send it (${e.code || e.message}). Is this computer on the plug's own "TP-LINK_Smart Plug" Wi-Fi?`);
      process.exitCode = 1;
    }
    return;
  }
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
