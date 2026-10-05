#!/usr/bin/env node
// Check the Sources page's games strip from this box:
//   node tools/sports-test.js                    today's games per league from ESPN, with the channel each maps to
//   node tools/sports-test.js nfl 20261011        one league, one day (YYYYMMDD)
//   node tools/sports-test.js guide 10.1.40.50    ask that receiver's guide what's on the sports channels now
//   node tools/sports-test.js guide 10.1.40.50 701-719 +120   ...on those channels, 120 minutes from now
// Read-only: nothing is tuned and nothing is saved.
process.chdir(require('path').join(__dirname, '..'));
const sports = require('../lib/sports');
const directv = require('../lib/drivers/directv');

function ymdToday() {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return d.replace(/-/g, '');
}

function chText(name, market) {
  const c = sports.channelFor(name);
  if (!c && /home|away/.test(market || '')) return `${name} = regional (other market)`;
  if (!c) return `${name} = ?? (no channel set)`;
  if (c.streaming) return `${name} = streaming only`;
  if (c.package) return `${name} = package (find it with the guide scan)`;
  if (c.off) return `${name} = not on our DirecTV`;
  return `${name} = ${c.major}${c.minor != null ? '-' + c.minor : ''} (${c.from})`;
}

async function games(leagueKey, ymd) {
  const leagues = leagueKey ? sports.LEAGUES.filter((l) => l.key === leagueKey) : sports.LEAGUES;
  if (!leagues.length) { console.log(`Leagues: ${sports.LEAGUES.map((l) => l.key).join(', ')}`); process.exit(1); }
  const unknown = new Set();
  for (const l of leagues) {
    try {
      const list = await sports.fetchDay(l, ymd);
      console.log(`\n${l.label}: ${list.length} game${list.length === 1 ? '' : 's'}`);
      for (const g of list.slice(0, 25)) {
        const when = new Date(g.start).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
        const score = g.state === 'pre' ? '' : `  ${g.away.abbr} ${g.away.score ?? ''} - ${g.home.abbr} ${g.home.score ?? ''}`;
        console.log(`  ${when.padStart(8)}  ${g.name.padEnd(14)} ${g.detail}${score}`);
        console.log(`            TV: ${g.networks.length ? g.networks.map((n) => chText(n.name, n.market)).join(' | ') : 'none listed'}`);
        for (const n of g.networks) if (!sports.channelFor(n.name) && !/home|away/.test(n.market)) unknown.add(n.name);
      }
      if (list.length > 25) console.log(`  ... and ${list.length - 25} more`);
    } catch (err) {
      console.log(`\n${l.label}: FAILED - ${err.message}`);
    }
  }
  if (unknown.size) console.log(`\nNetworks with no channel yet: ${[...unknown].join(', ')}`);
  console.log('\nAll good if the games above look right.');
}

async function guide(addr, chans, plusMin) {
  const [ip, port] = addr.split(':');
  const list = [];
  if (chans) {
    for (const part of chans.split(',')) {
      const [a, b] = part.split('-').map(Number);
      for (let x = a; x <= (b || a); x += 1) list.push(x);
    }
  } else {
    for (const n of sports.NETWORKS) { const c = sports.channelFor(n.keys[0]); if (c && c.major) list.push(c.major); }
  }
  const t = plusMin ? (Date.now() + plusMin * 60000) / 1000 : undefined;
  console.log(`Asking ${ip} about ${list.length} channels${plusMin ? ` at +${plusMin} min` : ' now'} (about ${Math.ceil(list.length * 0.4)}s) ...`);
  let ok = 0;
  for (const ch of list) {
    try {
      const p = await directv.getProgInfo(ip, Number(port) || 8080, ch, null, t);
      ok += 1;
      const start = p.startTime ? new Date(p.startTime * 1000).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) : '';
      console.log(`  ${String(ch).padStart(4)}  ${String(p.callsign || '').padEnd(10)} ${start.padStart(8)}  ${p.title || ''}${p.episodeTitle ? ' - ' + p.episodeTitle : ''}`);
    } catch (err) {
      console.log(`  ${String(ch).padStart(4)}  (no answer: ${err.message.replace(/^DirecTV \S+ \S+ -> /, '')})`);
    }
  }
  console.log(`\n${ok}/${list.length} channels answered.`);
}

(async () => {
  const [a, b, c, d] = process.argv.slice(2);
  if (a === 'guide') {
    if (!b) { console.log('Usage: node tools/sports-test.js guide <receiver ip> [channels like 206,209 or 701-719] [+minutes]'); process.exit(1); }
    const plus = [c, d].find((x) => x && /^\+\d+$/.test(x));
    const chans = [c, d].find((x) => x && /^\d/.test(x));
    await guide(b, chans, plus ? Number(plus.slice(1)) : 0);
  } else {
    await games(a, b || ymdToday());
  }
  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
