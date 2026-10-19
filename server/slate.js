// The Scheduling page's forecast (Scotto, 2026-10-19): under each date a
// rounded sales forecast for the schedule's side (kitchen or bar), and a
// "Games/Events" popup with that day's forecast by hour, the games on TV
// and the bar's events.
//
// Games come from ESPN's public scoreboards (sports_slate, patch_078),
// refreshed every 6 hours for the next 3 weeks. Events are holidays (from
// the forecast's calendar) plus what an owner or manager adds (bar_events).
const { withServiceClient } = require('./db');
const forecast = require('./forecast');
const kitchenboard = require('./kitchenboard');

const TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
const DAYS_AHEAD = 21;
const LEAGUES = [
  { key: 'nfl', path: 'football/nfl', label: 'NFL' },
  { key: 'cfb', path: 'football/college-football', label: 'College football' },
  { key: 'nba', path: 'basketball/nba', label: 'NBA' },
  { key: 'nhl', path: 'hockey/nhl', label: 'NHL' },
  { key: 'mlb', path: 'baseball/mlb', label: 'MLB' },
  { key: 'cbb', path: 'basketball/mens-college-basketball', label: "Men's college basketball" },
];
// The teams that move the bars (forecast.TEAMS), keyed by ESPN league path.
const TRACKED = Object.fromEntries(forecast.TEAMS.map((t) => [`${t.league === 'nfl' ? 'football/nfl' : 'football/college-football'}:${t.espnId}`, t.label]));

const toYmd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const localYmd = (d, tz = TZ) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
const localHM = (d) => new Date(d).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const ymdAdd = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

// ---------------------------------------------------------------- ESPN
function teamName(c) {
  const t = (c && c.team) || {};
  return t.shortDisplayName || t.displayName || t.name || t.abbreviation || null;
}
function rankOf(c) {
  const r = c && c.curatedRank && Number(c.curatedRank.current);
  return r && r >= 1 && r <= 25 ? r : null;
}
function networkOf(comp) {
  const names = [];
  for (const b of comp.broadcasts || []) for (const n of b.names || []) names.push(n);
  if (!names.length) for (const g of comp.geoBroadcasts || []) if (g.media && g.media.shortName) names.push(g.media.shortName);
  return names.length ? [...new Set(names)].slice(0, 2).join(', ') : null;
}
function parseScoreboard(json, league, slateDate) {
  const out = [];
  for (const e of (json && json.events) || []) {
    const comp = (e.competitions || [])[0] || {};
    const cs = comp.competitors || [];
    const home = cs.find((c) => c.homeAway === 'home') || cs[0];
    const away = cs.find((c) => c.homeAway === 'away') || cs[1];
    const iso = comp.date || e.date;
    if (!iso || !home || !away) continue;
    const tbd = e.timeValid === false || comp.timeValid === false;
    const tracked = cs.map((c) => TRACKED[`${league.path}:${(c.team || {}).id}`]).find(Boolean) || null;
    out.push({
      league: league.key, espn_id: String(e.id), slate_date: slateDate,
      game_date: tbd ? localYmd(iso, 'America/New_York') : localYmd(iso), kickoff: tbd ? null : new Date(iso).toISOString(), time_tbd: tbd,
      away: teamName(away), home: teamName(home), away_rank: rankOf(away), home_rank: rankOf(home), network: networkOf(comp), tracked,
    });
  }
  return out;
}

async function fetchJson(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// Today through 3 weeks out, every league. A date's games are replaced
// wholesale so a cancelled or moved game drops off.
async function refreshSlate() {
  const today = localYmd(new Date());
  let saved = 0; let failed = 0;
  for (let i = 0; i <= DAYS_AHEAD; i += 1) {
    const date = ymdAdd(today, i);
    for (const league of LEAGUES) {
      let games;
      try {
        games = parseScoreboard(await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard?dates=${date.replace(/-/g, '')}`), league, date);
      } catch (err) { failed += 1; continue; }
      await withServiceClient(async (client) => {
        await client.query('DELETE FROM sports_slate WHERE league = $1 AND slate_date = $2', [league.key, date]);
        for (const g of games) {
          await client.query(
            `INSERT INTO sports_slate (league, espn_id, slate_date, game_date, kickoff, time_tbd, away, home, away_rank, home_rank, network, tracked, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
             ON CONFLICT (league, espn_id) DO UPDATE SET slate_date = EXCLUDED.slate_date, game_date = EXCLUDED.game_date, kickoff = EXCLUDED.kickoff, time_tbd = EXCLUDED.time_tbd,
               away = EXCLUDED.away, home = EXCLUDED.home, away_rank = EXCLUDED.away_rank, home_rank = EXCLUDED.home_rank, network = EXCLUDED.network, tracked = EXCLUDED.tracked, fetched_at = now()`,
            [g.league, g.espn_id, g.slate_date, g.game_date, g.kickoff, g.time_tbd, g.away, g.home, g.away_rank, g.home_rank, g.network, g.tracked]);
          saved += 1;
        }
      });
    }
  }
  await withServiceClient((client) => client.query('DELETE FROM sports_slate WHERE game_date < $1', [ymdAdd(today, -2)]));
  console.log(`[slate] sports schedule refreshed: ${saved} game(s)${failed ? `, ${failed} request(s) failed` : ''}`);
  return { saved, failed };
}

// ---------------------------------------------------------------- forecast per schedule
// A schedule's side: "Kitchen" in the name means the kitchen, else the bar.
function sideOf(scheduleName) { return /kitchen/i.test(String(scheduleName || '')) ? 'food' : 'bar'; }

// For the week grid: one entry per (bar, side) among the chosen schedules,
// with each day's rounded forecast. Days already past get none.
async function weekForecast(scheduleIds, weekStart) {
  const { rows: scheds } = await withServiceClient((client) => client.query(
    `SELECT s.id, s.name, s.location_id, l.name AS location_name FROM schedules s JOIN locations l ON l.id = s.location_id WHERE s.id = ANY($1::uuid[])`, [scheduleIds]));
  const groups = new Map();
  for (const s of scheds) {
    const key = `${s.location_id}:${sideOf(s.name)}`;
    if (!groups.has(key)) groups.set(key, { locationId: s.location_id, locationName: s.location_name, side: sideOf(s.name) });
  }
  const out = [];
  for (const g of groups.values()) {
    let fc = null;
    try { fc = await forecast.forLocation(g.locationId); } catch (err) { console.error('[slate] forecast failed', err.message); }
    const days = {};
    // The owner's Sales Board override for a day wins over the forecast.
    const ov = await kitchenboard.overridesFor(g.locationId, weekStart, ymdAdd(weekStart, 6));
    const today = fc && fc.today;
    for (let i = 0; i < 7; i += 1) {
      const d = ymdAdd(weekStart, i);
      if (today && d < today) continue;
      const set = ov.get(`${g.side === 'food' ? 'kitchen' : 'bar'}|${d}`);
      const f = fc && fc.ready ? fc.days.find((x) => x.date === d) : null;
      if (set != null) days[d] = set;
      else if (f) days[d] = Math.round(f[g.side].fc / 100) * 100;
    }
    out.push({ ...g, today: fc && fc.today, days });
  }
  return out;
}

// ---------------------------------------------------------------- one day
async function dayDetail(locationId, side, date) {
  let fc = null;
  try { fc = await forecast.forLocation(locationId); } catch (err) { console.error('[slate] forecast failed', err.message); }
  const day = fc && fc.ready ? fc.days.find((x) => x.date === date) : null;
  const curve = fc && fc.curves ? fc.curves[side === 'food' ? 'food' : 'bar'][dow(date)] : null;
  const set = (await kitchenboard.overridesFor(locationId, date, date)).get(`${side === 'food' ? 'kitchen' : 'bar'}|${date}`);
  const amount = set != null ? set : day ? day[side === 'food' ? 'food' : 'bar'].fc : null;
  const hours = amount != null && curve ? forecast.hourlyFor(amount, curve, fc.dayStartHour) : null;
  return withServiceClient(async (client) => {
    const { rows: loc } = await client.query('SELECT name FROM locations WHERE id = $1', [locationId]);
    const { rows: games } = await client.query(
      `SELECT league, kickoff, time_tbd, away, home, away_rank, home_rank, network, tracked FROM sports_slate WHERE game_date = $1 ORDER BY kickoff NULLS LAST, league`, [date]);
    const { rows: events } = await client.query(
      `SELECT e.id, e.start_time, e.name, p.name AS added_by_name FROM bar_events e LEFT JOIN people p ON p.id = e.added_by
        WHERE e.location_id = $1 AND e.event_date = $2 ORDER BY e.start_time NULLS FIRST, e.created_at`, [locationId, date]);
    const label = Object.fromEntries(LEAGUES.map((l) => [l.key, l.label]));
    const nm = (team, rank) => (rank ? `#${rank} ${team}` : team);
    // The best two-hour stretch, like "6–8 PM" or "11 AM–1 PM".
    let busiest = null;
    if (hours && hours.length > 1) {
      let best = -1; let at = 0;
      for (let i = 0; i < hours.length - 1; i += 1) { const v = hours[i].amount + hours[i + 1].amount; if (v > best) { best = v; at = i; } }
      const st = hours[at].hour; const en = (hours[at + 1].hour + 1) % 24;
      const ap = (h) => (h < 12 ? 'AM' : 'PM'); const h12 = (h) => (h % 12) || 12;
      busiest = ap(st) === ap(en) ? `${h12(st)}–${h12(en)} ${ap(en)}` : `${h12(st)} ${ap(st)}–${h12(en)} ${ap(en)}`;
    }
    return {
      date, locationName: loc[0] ? loc[0].name : '', side,
      forecast: set != null ? set : day ? Math.round(day[side === 'food' ? 'food' : 'bar'].fc / 100) * 100 : null,
      forecastSet: set != null,
      busiest, hours,
      games: games.map((g) => ({
        league: label[g.league] || g.league, time: g.time_tbd || !g.kickoff ? 'TBD' : localHM(g.kickoff), hour: g.kickoff ? Number(new Date(g.kickoff).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24 : null,
        matchup: `${nm(g.away, g.away_rank)} at ${nm(g.home, g.home_rank)}`, network: g.network, tracked: g.tracked,
        ranked: !!(g.away_rank || g.home_rank),
      })),
      holidays: forecast.holidaysOn(date).map((h) => forecast.HOLIDAY_LABELS[h] || h),
      events: events.map((e) => ({ id: e.id, time: e.start_time, name: e.name, addedBy: e.added_by_name })),
    };
  });
}

async function addEvent(locationId, date, startTime, name, personId) {
  const n = String(name || '').trim().slice(0, 120);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, error: 'Pick a date.' };
  if (!n) return { ok: false, error: 'Name the event.' };
  const t = /^\d{2}:\d{2}$/.test(String(startTime || '')) ? startTime : null;
  await withServiceClient((client) => client.query('INSERT INTO bar_events (location_id, event_date, start_time, name, added_by) VALUES ($1,$2,$3,$4,$5)', [locationId, date, t, n, personId]));
  return { ok: true };
}
async function removeEvent(id) {
  const { rows } = await withServiceClient((client) => client.query('DELETE FROM bar_events WHERE id = $1 RETURNING location_id', [id]));
  return rows[0] ? { ok: true, locationId: rows[0].location_id } : { ok: false, error: 'Not found.' };
}
async function eventLocation(id) {
  const { rows } = await withServiceClient((client) => client.query('SELECT location_id FROM bar_events WHERE id = $1', [id]));
  return rows[0] ? rows[0].location_id : null;
}

module.exports = { refreshSlate, weekForecast, dayDetail, addEvent, removeEvent, eventLocation, sideOf, _test: { parseScoreboard, LEAGUES } };
