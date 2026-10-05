#!/usr/bin/env node
// What does this bar's Sonos look like to the box? For sorting out music:
//   node tools/sonos-test.js              player, what's playing, Pandora favorites, learned format
//   node tools/sonos-test.js play         try the first station on the Pandora account
//   node tools/sonos-test.js play <id>    try one station by its Pandora id
//   node tools/sonos-test.js watch        print every change in what the Sonos is doing (Ctrl+C to stop)
// Uses SONOS_IP from agent/.env if set, otherwise finds the Sonos itself.
process.chdir(require('path').join(__dirname, '..'));
const sonos = require('../lib/sonos');
const pandora = require('../lib/pandora');

const short = (s, n = 700) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + ' …' : s; };

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  const p = await sonos.ensurePlayer();
  if (!p) { console.log('No Sonos found. Is it on this network (same as the box)? Try SONOS_IP=<its address> in .env.'); process.exit(1); }
  console.log(`Sonos: ${p.name} (${p.model}) at ${p.ip}`);
  const st = await sonos.readState();
  console.log(`\nNow: ${st.transport || '?'}  station: ${st.station ? `${st.station.title || '(no name)'}  ${st.station.uri}` : 'none'}`);
  const favs = await sonos.readFavorites(true);
  const pf = favs.filter((f) => sonos.pandoraStationId(f.uri));
  console.log(`\nMy Sonos: ${favs.length} favorites, ${pf.length} of them Pandora stations.`);
  if (pf[0]) { console.log(`First Pandora favorite: ${pf[0].title}\n  uri:  ${pf[0].uri}\n  meta: ${short(pf[0].meta)}`); }
  const tpl = sonos.pandoraTemplate();
  console.log(`\nLearned Pandora format: ${tpl ? `yes, from station ${tpl.id}\n  uri:  ${tpl.uri}\n  meta: ${short(tpl.didl)}` : 'not yet (play any Pandora station from the Sonos app, then run this again)'}`);
  if (cmd === 'watch') {
    const tagOf = (x, n) => { const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`).exec(x || ''); return m ? m[1] : ''; };
    const un = (x) => String(x || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    console.log('\nWatching. Start a station, let the song end, then Ctrl+C and paste everything.');
    let last = '';
    for (;;) {
      try {
        const [ti, pi, mi] = await Promise.all([
          sonos.soap(p.ip, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 }),
          sonos.soap(p.ip, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }),
          sonos.soap(p.ip, 'AVTransport', 'GetMediaInfo', { InstanceID: 0 }),
        ]);
        const trackMeta = un(tagOf(pi, 'TrackMetaData'));
        const line = [
          tagOf(ti, 'CurrentTransportState'),
          `media=${un(tagOf(mi, 'CurrentURI'))}`,
          `tracks=${tagOf(mi, 'NrTracks')}`,
          `track#=${tagOf(pi, 'Track')}`,
          `trackUri=${un(tagOf(pi, 'TrackURI')).slice(0, 140)}`,
          `song=${un(tagOf(trackMeta, 'dc:title'))}`,
          `len=${tagOf(pi, 'TrackDuration')}`,
        ].join(' | ');
        if (line !== last) { console.log(`${new Date().toLocaleTimeString()}  ${line}`); last = line; }
      } catch (err) { console.log(`${new Date().toLocaleTimeString()}  error: ${err.message}`); }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (cmd === 'play') {
    let s;
    if (arg) s = { stationId: arg, name: `Station ${arg}` };
    else if (pandora.enabled()) { const list = await pandora.fetchStations(); s = list[0]; }
    if (!s) { console.log('\nNo station to try (no Pandora login and no id given).'); process.exit(1); }
    console.log(`\nTrying "${s.name}" [${s.stationId}] ...`);
    try { await sonos.playPandoraStation(s); const after = await sonos.readState(); console.log(`OK: ${after.transport}  ${after.station && after.station.title}`); }
    catch (err) { console.log(`FAILED: ${err.message}`); }
  }
  process.exit(0);
})().catch((err) => { console.log('FAILED:', err.message); process.exit(1); });
