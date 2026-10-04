#!/usr/bin/env node
// Check this box's Pandora link before staff rely on it:
//   node tools/pandora-test.js                  sign in, count stations, try a search
//   node tools/pandora-test.js search "Zac Brown"
//   node tools/pandora-test.js create "Zac Brown"   makes a REAL station on the account
// Reads PANDORA_USER / PANDORA_PASS from agent/.env. Prints no password.
process.chdir(require('path').join(__dirname, '..'));
const config = require('../config');
const pandora = require('../lib/pandora');

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const q = rest.join(' ') || 'Zac Brown Band';
  if (!config.PANDORA_USER || !config.PANDORA_PASS) {
    console.log('PANDORA_USER / PANDORA_PASS are not set in agent/.env.');
    process.exit(1);
  }
  console.log(`Signing in to Pandora as ${config.PANDORA_USER} ...`);
  await pandora.login();
  console.log('Signed in.');
  if (!cmd) {
    const list = await pandora.fetchStations();
    console.log(`\n${list.length} stations on the account (Shuffle left out). First 5:`);
    for (const s of list.slice(0, 5)) console.log(`  ${s.name}   [id ${s.stationId}]${s.art ? '' : '   (no artwork)'}`);
  }
  if (!cmd || cmd === 'search' || cmd === 'create') {
    const results = await pandora.search(q);
    console.log(`\nSearch "${q}": ${results.length} results. Top 5:`);
    for (const r of results.slice(0, 5)) console.log(`  ${r.kind}: ${r.name}${r.sub ? ' - ' + r.sub : ''}   [${r.pandoraId}]`);
    if (cmd === 'create') {
      if (!results.length) { console.log('Nothing to make a station from.'); process.exit(1); }
      const st = await pandora.createStation(results[0].pandoraId);
      console.log(`\nMade station "${st.name}" [id ${st.stationId}] from ${results[0].name}.`);
    }
  }
  console.log('\nAll good.');
  process.exit(0);
})().catch((err) => {
  console.log(`\nFAILED: ${err.message}`);
  if (err.data) console.log('Pandora said:', JSON.stringify(err.data).slice(0, 400));
  process.exit(1);
});
