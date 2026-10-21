#!/usr/bin/env node
// What the Pi knows about the bar's Sonos and its Pandora login, for
// troubleshooting from the Pi:  node tools/sonos-check.js
// Prints the unit chosen, every unit seen, the station now playing (with
// its sn= account number), the Pandora account number the Sonos reports,
// and the station template the box learned. Add "forget" to drop the
// learned template so the next station played from the Sonos app teaches
// a fresh one:  node tools/sonos-check.js forget
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sonos = require('../lib/sonos');
(async () => {
  if (process.argv[2] === 'forget') { sonos.forgetPandoraTemplate(); console.log('Pandora template forgotten.'); }
  const p = await sonos.ensurePlayer();
  if (!p) { console.log('No Sonos found on this network.'); process.exit(1); }
  console.log(`Using: ${p.name} (${p.model}) at ${p.ip}`);
  for (const x of sonos.players()) console.log(`  seen: ${x.name || 'Unnamed Room'} at ${x.ip}${x.coordinator ? ' (coordinator)' : ''}${x.invisible ? ' (hidden)' : ''}`);
  const st = await sonos.readState();
  console.log(`Transport: ${st.transport}  station: ${st.station ? st.station.title : '-'}`);
  if (st.station && st.station.uri) console.log(`  uri: ${st.station.uri}`);
  if (st.track) console.log(`  track: ${st.track.artist} - ${st.track.title}`);
  const { sn, known } = await sonos.pandoraAccountSn(p.ip);
  console.log(`Pandora account on this Sonos: ${!known ? `couldn't read the accounts page (using ${sn ? `sn=${sn}` : 'no number'})` : sn === null ? 'NONE (add Pandora in the Sonos app)' : `sn=${sn}`}`);
  const tpl = sonos.pandoraTemplate();
  console.log(`Learned template: ${tpl ? tpl.uri : 'none yet'}`);
  if (tpl && sn && !new RegExp(`[?&]sn=${sn}(&|$)`).test(tpl.uri)) console.log('  -> template has a different account number; the box now rewrites sn= on every play, so this is fine.');
  process.exit(0);
})().catch((e) => { console.error('sonos-check:', e.message); process.exit(1); });
