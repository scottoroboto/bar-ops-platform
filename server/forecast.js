// Sales forecast for the kitchen board (patch_076, Scotto 2026-10-17).
//
// What it predicts: each bar's kitchen (food) and bar (total minus food)
// net sales for today and the next two weeks, plus where today's food
// sales "should" be at this hour.
//
// How: a log-scale ridge regression per bar and per side, learned from
// sales_daily (every day SpotOn has, back to kb_settings.history_from):
//   day of week + month of year + holidays (Gulf-coast ones included:
//   Mardi Gras, Thanksgiving Eve) + game days for the teams that fill the
//   bars (Alabama and FSU football, the Saints; ESPN's public schedules)
// with recent days weighted more (a year's half-life), then nudged by how
// the last four weeks ran against it. Days the owner left out are skipped;
// days far off what the model expects (closed, a storm, a broken pull, a
// one-off surge) are found and left out automatically, and listed so the
// owner can put any of them back.
//
// Accuracy is measured the honest way: the last 8 weeks are each
// predicted from only the data before them, and compared with what
// actually happened.
const { withServiceClient } = require('./db');

const TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
const HALF_LIFE_DAYS = 365;
const MIN_DAYS = 21;               // fewer usable days than this: no forecast
const HORIZON = 14;                // today + 13
const OUTLIER_MIN_RATIO = 1.8;     // never flag a day within 1.8x either way of expected
const CLOSED_BELOW = 150;          // total under this = closed / barely open
const CACHE_MS = 20 * 60 * 1000;

// The teams (Scotto: "Alabama football, Saints, Florida State football").
// ESPN team ids; add a row here to add a team.
const TEAMS = [
  { key: 'alabama', label: 'Alabama', league: 'college-football', espnId: 333 },
  { key: 'fsu', label: 'FSU', league: 'college-football', espnId: 52 },
  { key: 'saints', label: 'Saints', league: 'nfl', espnId: 18 },
];

// ---------------------------------------------------------------- dates
function ymdAdd(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dow(ymd) { return new Date(`${ymd}T12:00:00Z`).getUTCDay(); } // 0 Sun
function daysBetween(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }
function toYmd(v) { return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10); }
function localYmd(date, tz = TZ) { return new Date(date).toLocaleDateString('en-CA', { timeZone: tz }); }
function localHM(date, tz = TZ) { return new Date(date).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }); }
const p2 = (n) => String(n).padStart(2, '0');
function ymdOf(y, m, d) { return `${y}-${p2(m)}-${p2(d)}`; }
// n-th weekday (0 Sun..6 Sat) of a month; n = -1 for the last one.
function nthWeekday(y, m, wd, n) {
  if (n > 0) { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return ymdOf(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7); }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return ymdOf(y, m, lastDay - ((last - wd + 7) % 7));
}
function easter(y) { // anonymous Gregorian algorithm
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymdOf(y, month, day);
}

const HOLIDAY_LABELS = {
  nye: "New Year's Eve", nyd: "New Year's Day", super_bowl: 'Super Bowl Sunday', valentines: "Valentine's Day",
  mardi_gras_wknd: 'Mardi Gras weekend', fat_tuesday: 'Mardi Gras (Fat Tuesday)', st_patricks: "St. Patrick's Day", easter: 'Easter',
  cinco: 'Cinco de Mayo', mothers_day: "Mother's Day", memorial_day: 'Memorial Day', fathers_day: "Father's Day",
  july4: 'Fourth of July', labor_day: 'Labor Day', halloween: 'Halloween', thanksgiving_eve: 'Thanksgiving Eve',
  thanksgiving: 'Thanksgiving', black_friday: 'Black Friday', xmas_eve: 'Christmas Eve', xmas: 'Christmas',
};
const holidayCache = new Map();
function holidaysOfYear(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const e = easter(y); const tg = nthWeekday(y, 11, 4, 4);
  const map = {
    [ymdOf(y, 12, 31)]: ['nye'], [ymdOf(y, 1, 1)]: ['nyd'], [nthWeekday(y, 2, 0, 2)]: ['super_bowl'], [ymdOf(y, 2, 14)]: ['valentines'],
    [ymdAdd(e, -50)]: ['mardi_gras_wknd'], [ymdAdd(e, -49)]: ['mardi_gras_wknd'], [ymdAdd(e, -47)]: ['fat_tuesday'],
    [ymdOf(y, 3, 17)]: ['st_patricks'], [e]: ['easter'], [ymdOf(y, 5, 5)]: ['cinco'], [nthWeekday(y, 5, 0, 2)]: ['mothers_day'],
    [nthWeekday(y, 5, 1, -1)]: ['memorial_day'], [nthWeekday(y, 6, 0, 3)]: ['fathers_day'], [ymdOf(y, 7, 4)]: ['july4'],
    [nthWeekday(y, 9, 1, 1)]: ['labor_day'], [ymdOf(y, 10, 31)]: ['halloween'], [ymdAdd(tg, -1)]: ['thanksgiving_eve'], [tg]: ['thanksgiving'],
    [ymdAdd(tg, 1)]: ['black_friday'], [ymdOf(y, 12, 24)]: ['xmas_eve'], [ymdOf(y, 12, 25)]: ['xmas'],
  };
  holidayCache.set(y, map);
  return map;
}
function holidaysOn(ymd) {
  const y = Number(ymd.slice(0, 4));
  const out = new Set();
  for (const yy of [y, y + 1]) for (const k of (holidaysOfYear(yy)[ymd] || [])) out.add(k); // Mardi Gras can't cross years, but be safe
  return [...out];
}

// ---------------------------------------------------------------- model
// Feature columns: name -> ridge penalty (0 = unpenalized).
function featureRow(ymd, gamesByDate) {
  const f = { int: 1 };
  const d = dow(ymd); if (d !== 0) f[`dow:${d}`] = 1;
  const m = Number(ymd.slice(5, 7)); if (m !== 1) f[`mon:${m}`] = 1;
  for (const h of holidaysOn(ymd)) f[`hol:${h}`] = 1;
  const games = gamesByDate.get(ymd) || [];
  for (const g of games) { f[`team:${g.team_key}`] = 1; if (Number(g.season_type) === 3) f.post = 1; }
  return f;
}
function penaltyOf(name) {
  if (name === 'int' || name.startsWith('dow:')) return 0.05;
  if (name.startsWith('mon:')) return 3;
  if (name.startsWith('hol:')) return 1.5;
  if (name.startsWith('team:')) return 1;
  return 2; // post
}

// Solve (A) x = b for symmetric positive definite A (Cholesky).
function solveSPD(A, b) {
  const n = b.length; const L = A.map((r) => r.slice());
  for (let j = 0; j < n; j += 1) {
    let s = L[j][j]; for (let k = 0; k < j; k += 1) s -= L[j][k] * L[j][k];
    if (s <= 1e-12) s = 1e-12;
    L[j][j] = Math.sqrt(s);
    for (let i = j + 1; i < n; i += 1) { let t = L[i][j]; for (let k = 0; k < j; k += 1) t -= L[i][k] * L[j][k]; L[i][j] = t / L[j][j]; }
  }
  const y = new Array(n); for (let i = 0; i < n; i += 1) { let s = b[i]; for (let k = 0; k < i; k += 1) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  const x = new Array(n); for (let i = n - 1; i >= 0; i -= 1) { let s = y[i]; for (let k = i + 1; k < n; k += 1) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

// rows: [{ date, y (log sales), feats, w }]. Returns { coef: {name: beta} }.
function fitRidge(rows) {
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.feats)))].sort((a, b) => (a === 'int' ? -1 : b === 'int' ? 1 : a.localeCompare(b)));
  const idx = new Map(names.map((n, i) => [n, i])); const n = names.length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0)); const b = new Array(n).fill(0);
  let wsum = 0;
  for (const r of rows) {
    const ks = Object.keys(r.feats).map((k) => idx.get(k));
    for (const i of ks) { b[i] += r.w * r.y; for (const j of ks) A[i][j] += r.w; }
    wsum += r.w;
  }
  // Penalty scaled to the data's weight so it means the same at 60 days or 4 years.
  const scale = Math.max(1, wsum / 50);
  names.forEach((nm, i) => { A[i][i] += penaltyOf(nm) * scale * 0.2; });
  const x = solveSPD(A, b);
  return { coef: Object.fromEntries(names.map((nm, i) => [nm, x[i]])) };
}
function predictLog(model, feats) { let s = 0; for (const [k, v] of Object.entries(feats)) s += (model.coef[k] || 0) * v; return s + (model.level || 0); }

function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function quantile(a, q) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const pos = (s.length - 1) * q; const lo = Math.floor(pos); const hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); }

// days: [{ date, value, manual: true|false|null, reasonManual }]
// Fits with outlier screening; returns { model, used, flagged: [{date, value, expected, why}], resid }.
function fitSide(days, gamesByDate, refDate) {
  const fr = (date) => { let m = gamesByDate.__rows; if (!m) { m = new Map(); Object.defineProperty(gamesByDate, '__rows', { value: m }); } if (!m.has(date)) m.set(date, featureRow(date, gamesByDate)); return m.get(date); };
  const base = days.filter((d) => d.value != null && d.manual !== true && d.date < refDate);
  const forced = new Set(base.filter((d) => d.manual === false).map((d) => d.date));
  const tooLow = (d) => d.value <= 0 || (d.closedHint === true);
  let excluded = new Map();
  for (const d of base) if (!forced.has(d.date) && tooLow(d)) excluded.set(d.date, 'Closed or no sales recorded');
  let model = null; let resid = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const rows = base.filter((d) => !excluded.has(d.date)).map((d) => ({
      date: d.date, y: Math.log(d.value), feats: fr(d.date), w: 0.5 ** (daysBetween(d.date, refDate) / HALF_LIFE_DAYS),
    }));
    if (rows.length < MIN_DAYS) return { model: null, used: rows.length, flagged: [], resid: [] };
    model = fitRidge(rows);
    resid = rows.map((r) => ({ date: r.date, r: r.y - predictLog(model, r.feats), w: r.w }));
    const mid = median(resid.map((z) => z.r));
    const mad = median(resid.map((x) => Math.abs(x.r - mid)));
    const thr = Math.max(Math.log(OUTLIER_MIN_RATIO), 3.5 * 1.4826 * mad);
    let changed = false;
    for (const d of base) {
      if (forced.has(d.date) || excluded.has(d.date) && excluded.get(d.date).startsWith('Closed')) continue;
      const r = Math.log(d.value) - predictLog(model, fr(d.date));
      const out = Math.abs(r) > thr;
      if (out && !excluded.has(d.date)) { excluded.set(d.date, r < 0 ? 'Far below expected' : 'Far above expected'); changed = true; }
      if (!out && excluded.has(d.date)) { excluded.delete(d.date); changed = true; }
    }
    if (!changed) break;
  }
  // Level: how the last 4 weeks ran against the model (shrunk toward 0).
  const recent = resid.filter((x) => daysBetween(x.date, refDate) <= 28).map((x) => x.r);
  model.level = recent.length ? median(recent) * (recent.length / (recent.length + 7)) : 0;
  const recentYear = resid.filter((x) => daysBetween(x.date, refDate) <= 365).map((x) => x.r - model.level);
  model.lo = quantile(recentYear, 0.1); model.hi = quantile(recentYear, 0.9);
  const flagged = base.filter((d) => excluded.has(d.date)).map((d) => ({
    date: d.date, value: d.value, expected: Math.round(Math.exp(predictLog(model, fr(d.date)))), why: excluded.get(d.date),
  }));
  return { model, used: base.length - excluded.size, flagged, resid };
}

// Walk-forward check: each of the last `weeks` weeks predicted from only
// the days before it. Returns { n, mape, within15 } (percent).
function backtest(days, gamesByDate, refDate, flaggedDates, weeks = 8) {
  const errs = [];
  for (let k = weeks; k >= 1; k -= 1) {
    const cut = ymdAdd(refDate, -7 * k);
    const fit = fitSide(days, gamesByDate, cut);
    if (!fit.model) continue;
    for (let i = 0; i < 7; i += 1) {
      const d = ymdAdd(cut, i);
      const day = days.find((x) => x.date === d);
      if (!day || day.value == null || day.value <= 0 || day.manual === true || flaggedDates.has(d) || d >= refDate) continue;
      const fc = Math.exp(predictLog(fit.model, featureRow(d, gamesByDate)));
      errs.push(Math.abs(fc - day.value) / day.value);
    }
  }
  if (!errs.length) return null;
  return { n: errs.length, mape: Math.round(median(errs) * 100), within15: Math.round((errs.filter((e) => e <= 0.15).length / errs.length) * 100) };
}

function effectPct(model, name) { return model && model.coef[name] != null ? Math.round((Math.exp(model.coef[name]) - 1) * 100) : null; }

// ---------------------------------------------------------------- pace curve
// Share of the day's food sales normally reached by each 15 minutes after
// the business day starts, from the last 8 weeks of 5-minute snapshots.
function buildCurve(snapsByDay, dayStartOf, wantDow) {
  const SLOTS = 24 * 4;
  const perDay = [];
  for (const [date, snaps] of snapsByDay) {
    const final = Math.max(...snaps.map((s) => s.food || 0));
    if (!(final > 50)) continue;
    const start = dayStartOf(date).getTime();
    const fr = new Array(SLOTS).fill(null); let j = 0; let last = 0;
    for (let k = 0; k < SLOTS; k += 1) {
      const t = start + (k + 1) * 15 * 60000;
      while (j < snaps.length && snaps[j].at.getTime() <= t) { if (snaps[j].food != null) last = snaps[j].food; j += 1; }
      fr[k] = Math.min(1, last / final);
    }
    perDay.push({ dow: dow(date), fr });
  }
  const same = perDay.filter((d) => d.dow === wantDow);
  const use = same.length >= 3 ? same : perDay;
  if (use.length < 3) return null;
  const curve = []; let prev = 0;
  for (let k = 0; k < SLOTS; k += 1) { const m = Math.max(prev, median(use.map((d) => d.fr[k]))); curve.push(Math.round(m * 1000) / 1000); prev = m; }
  return curve;
}
function curveAt(curve, minutesSinceStart) {
  if (!curve) return null;
  if (minutesSinceStart <= 0) return 0;
  const k = minutesSinceStart / 15 - 1;
  if (k < 0) return curve[0] * (minutesSinceStart / 15);
  if (k >= curve.length - 1) return curve[curve.length - 1];
  const lo = Math.floor(k); return curve[lo] + (curve[lo + 1] - curve[lo]) * (k - lo);
}

// ---------------------------------------------------------------- games (ESPN)
function parseEspnSchedule(json, team, seasonParam, seasonType) {
  const out = [];
  for (const e of (json && json.events) || []) {
    const comp = (e.competitions || [])[0] || {};
    const cs = comp.competitors || [];
    const us = cs.find((c) => String((c.team || {}).id) === String(team.espnId)) || cs.find((c) => c.id && String(c.id) === String(team.espnId));
    const them = cs.find((c) => c !== us);
    const iso = comp.date || e.date;
    if (!iso) continue;
    const tbd = e.timeValid === false || comp.timeValid === false;
    // A TBD kickoff comes as midnight Eastern: that date, not the evening before.
    const gameDate = tbd ? localYmd(iso, 'America/New_York') : localYmd(iso);
    out.push({
      espn_id: String(e.id), team_key: team.key, game_date: gameDate, kickoff: tbd ? null : new Date(iso).toISOString(), time_tbd: tbd,
      opponent: them && them.team ? (them.team.shortDisplayName || them.team.displayName || them.team.name || null) : null,
      home_away: us ? us.homeAway || null : null,
      season: Number((e.season && e.season.year) || seasonParam), season_type: Number((e.seasonType && (e.seasonType.type || e.seasonType.id)) || seasonType),
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

// Pull schedules: every season from the oldest history year, once; the
// current and last season again every day (times get set, games move).
async function refreshGames({ all = false } = {}) {
  return withServiceClient(async (client) => {
    const { rows: [h] } = await client.query('SELECT LEAST(MIN(history_from), CURRENT_DATE) AS d FROM kb_settings');
    const { rows: have } = await client.query('SELECT team_key, season, COUNT(*)::int AS n FROM sports_games GROUP BY 1, 2');
    const firstYear = Math.max(2015, Number(toYmd(h && h.d ? h.d : '2022-01-01').slice(0, 4)) - 1);
    const thisYear = Number(localYmd(new Date()).slice(0, 4));
    let saved = 0; const errors = [];
    for (const team of TEAMS) {
      for (let season = firstYear; season <= thisYear; season += 1) {
        const known = have.some((r) => r.team_key === team.key && Number(r.season) === season && r.n > 0);
        if (known && !all && season < thisYear - 1) continue;
        for (const st of [2, 3]) {
          const url = `https://site.api.espn.com/apis/site/v2/sports/football/${team.league}/teams/${team.espnId}/schedule?season=${season}&seasontype=${st}`;
          try {
            const games = parseEspnSchedule(await fetchJson(url), team, season, st);
            for (const g of games) {
              await client.query(
                `INSERT INTO sports_games (espn_id, team_key, game_date, kickoff, time_tbd, opponent, home_away, season, season_type, fetched_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
                 ON CONFLICT (espn_id, team_key) DO UPDATE SET game_date = EXCLUDED.game_date, kickoff = EXCLUDED.kickoff, time_tbd = EXCLUDED.time_tbd,
                   opponent = EXCLUDED.opponent, home_away = EXCLUDED.home_away, season = EXCLUDED.season, season_type = EXCLUDED.season_type, fetched_at = now()`,
                [g.espn_id, g.team_key, g.game_date, g.kickoff, g.time_tbd, g.opponent, g.home_away, g.season, g.season_type],
              );
              saved += 1;
            }
          } catch (err) { errors.push(`${team.key} ${season}/${st}: ${err.message}`); }
        }
      }
    }
    if (errors.length) console.warn(`[forecast] game schedule: ${errors.length} request(s) failed, e.g. ${errors[0]}`);
    console.log(`[forecast] game schedule refreshed: ${saved} game row(s) saved`);
    cache.clear();
    return { saved, errors: errors.length };
  });
}

// ---------------------------------------------------------------- per bar
const cache = new Map(); // locationId -> { at, value }

async function loadInputs(client, locationId, today) {
  const { rows: sales } = await client.query(
    `SELECT business_date, food_net, total_net, excluded, excluded_reason FROM sales_daily
      WHERE location_id = $1 AND business_date < $2 ORDER BY business_date`, [locationId, today]);
  const { rows: games } = await client.query(
    `SELECT team_key, game_date, kickoff, time_tbd, opponent, home_away, season_type FROM sports_games ORDER BY kickoff NULLS LAST`);
  const { rows: [s] } = await client.query('SELECT day_start_hour, history_from FROM kb_settings WHERE location_id = $1', [locationId]);
  return { sales, games, dayStartHour: s ? Number(s.day_start_hour) : 4, historyFrom: s && s.history_from ? toYmd(s.history_from) : '2022-01-01' };
}

function zonedToUtc(naive, tz) {
  const guess = Date.parse(`${naive}Z`);
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; dtf.formatToParts(new Date(guess)).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  const off = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - guess) / 60000;
  return new Date(guess - off * 60000);
}

function buildForecast({ sales, games, today, dayStartHour }) {
  const gamesByDate = new Map();
  for (const g of games) { const k = toYmd(g.game_date); if (!gamesByDate.has(k)) gamesByDate.set(k, []); gamesByDate.get(k).push(g); }
  const food = []; const bar = [];
  for (const r of sales) {
    const date = toYmd(r.business_date);
    const total = r.total_net == null ? null : Number(r.total_net);
    const f = r.food_net == null ? (total != null ? 0 : null) : Number(r.food_net);
    const closed = total != null && total < CLOSED_BELOW;
    const manual = r.excluded === true ? true : r.excluded === false ? false : null;
    food.push({ date, value: f, manual, reasonManual: r.excluded_reason, closedHint: closed });
    bar.push({ date, value: total == null || f == null ? null : total - f, manual, reasonManual: r.excluded_reason, closedHint: closed });
  }
  const sides = {};
  for (const [key, days] of [['food', food], ['bar', bar]]) {
    const fit = fitSide(days, gamesByDate, today);
    sides[key] = { fit, accuracy: fit.model ? backtest(days, gamesByDate, today, new Set(fit.flagged.map((x) => x.date))) : null };
  }
  if (!sides.food.fit.model || !sides.bar.fit.model) return { ready: false, reason: `Needs at least ${MIN_DAYS} days of sales; has ${Math.min(sides.food.fit.used, sides.bar.fit.used)}.` };

  const teamLabel = Object.fromEntries(TEAMS.map((t) => [t.key, t.label]));
  const out = [];
  for (let i = 0; i < HORIZON; i += 1) {
    const d = ymdAdd(today, i);
    const feats = featureRow(d, gamesByDate);
    const side = (k) => {
      const m = sides[k].fit.model; const lp = predictLog(m, feats);
      return { fc: Math.round(Math.exp(lp)), lo: Math.round(Math.exp(lp + m.lo)), hi: Math.round(Math.exp(lp + m.hi)) };
    };
    const drivers = [];
    for (const g of gamesByDate.get(d) || []) {
      const who = teamLabel[g.team_key] || g.team_key;
      const vs = g.opponent ? `${g.home_away === 'away' ? 'at' : 'vs'} ${g.opponent}` : '';
      const when = g.time_tbd || !g.kickoff ? 'time TBD' : localHM(g.kickoff);
      drivers.push({ kind: 'game', label: `${who} ${vs} · ${when}`.replace(/\s+/g, ' ').trim(), food: effectPct(sides.food.fit.model, `team:${g.team_key}`), bar: effectPct(sides.bar.fit.model, `team:${g.team_key}`) });
    }
    for (const h of holidaysOn(d)) drivers.push({ kind: 'holiday', label: HOLIDAY_LABELS[h] || h, food: effectPct(sides.food.fit.model, `hol:${h}`), bar: effectPct(sides.bar.fit.model, `hol:${h}`) });
    out.push({ date: d, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow(d)], food: side('food'), bar: side('bar'), drivers });
  }

  // Left-out days, newest first: the owner's own and the automatic ones.
  const manual = sales.filter((r) => r.excluded === true).map((r) => ({ date: toYmd(r.business_date), total: r.total_net == null ? null : Math.round(Number(r.total_net)), why: r.excluded_reason || 'Left out by the owner', manual: true }));
  const auto = new Map();
  for (const [k, label] of [['food', 'Kitchen'], ['bar', 'Bar']]) {
    for (const f of sides[k].fit.flagged) {
      const row = auto.get(f.date) || { date: f.date, total: null, why: [], manual: false };
      const pct = f.expected > 0 ? Math.round((f.value / f.expected) * 100) : null;
      row.why.push(f.why.startsWith('Closed') ? f.why : `${label} ${pct != null ? `${pct}% of expected` : f.why.toLowerCase()}`);
      auto.set(f.date, row);
    }
  }
  const totals = new Map(sales.map((r) => [toYmd(r.business_date), r.total_net == null ? null : Math.round(Number(r.total_net))]));
  const autoList = [...auto.values()].map((r) => ({ ...r, total: totals.get(r.date), why: [...new Set(r.why)].join(' · ') }));
  const kept = sales.filter((r) => r.excluded === false).map((r) => toYmd(r.business_date));
  const dates = sales.filter((r) => r.total_net != null).map((r) => toYmd(r.business_date));

  const teamEffects = TEAMS.map((t) => ({ team: t.label, food: effectPct(sides.food.fit.model, `team:${t.key}`), bar: effectPct(sides.bar.fit.model, `team:${t.key}`), games: games.filter((g) => g.team_key === t.key && toYmd(g.game_date) < today && dates.includes(toYmd(g.game_date))).length }));
  return {
    ready: true, today, dayStartHour, days: out,
    accuracy: { food: sides.food.accuracy, bar: sides.bar.accuracy },
    history: { days: dates.length, from: dates[0] || null, to: dates[dates.length - 1] || null, usedFood: sides.food.fit.used, usedBar: sides.bar.fit.used },
    leftOut: [...manual, ...autoList.filter((a) => !manual.some((m) => m.date === a.date))].sort((a, b) => b.date.localeCompare(a.date)),
    keptByOwner: kept,
    teamEffects,
  };
}

// The forecast for one bar (cached 20 minutes). now: for today's date.
async function forLocation(locationId, { now = new Date(), fresh = false } = {}) {
  const hit = cache.get(locationId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await withServiceClient(async (client) => {
    const inputs = await loadInputs(client, locationId, '9999-12-31');
    // Business date: the same rule the board uses (day starts at day_start_hour).
    const today = localYmd(new Date(now.getTime() - inputs.dayStartHour * 3600000));
    const sales = inputs.sales.filter((r) => toYmd(r.business_date) < today);
    const fc = buildForecast({ sales, games: inputs.games, today, dayStartHour: inputs.dayStartHour });
    fc.historyFrom = inputs.historyFrom;
    if (!fc.ready) return fc;
    // The pace curve for today's day of week.
    const { rows: snaps } = await client.query(
      `SELECT business_date, at, food_net FROM kb_sales_snapshots WHERE location_id = $1 AND business_date >= $2 AND business_date < $3 ORDER BY at`,
      [locationId, ymdAdd(today, -56), today]);
    const byDay = new Map();
    const leftOut = new Set(fc.leftOut.map((x) => x.date));
    for (const s of snaps) { const d = toYmd(s.business_date); if (leftOut.has(d)) continue; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push({ at: new Date(s.at), food: s.food_net == null ? null : Number(s.food_net) }); }
    const dayStartOf = (d) => zonedToUtc(`${d}T${p2(inputs.dayStartHour)}:00:00`, TZ);
    fc.curve = buildCurve(byDay, dayStartOf, dow(today));
    // Keep what was said, to grade it later (once a day per bar).
    for (const d of fc.days) {
      await client.query(
        `INSERT INTO sales_forecasts (location_id, business_date, made_on, food_fc, bar_fc, detail) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (location_id, business_date, made_on) DO NOTHING`,
        [locationId, d.date, today, d.food.fc, d.bar.fc, JSON.stringify({ food: d.food, bar: d.bar, drivers: d.drivers })]);
    }
    return fc;
  });
  cache.set(locationId, { at: Date.now(), value });
  return value;
}

// The owner's call on a day: true = leave out, false = keep, null = let the app judge.
async function setDay(locationId, date, excluded, reason, personId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw Object.assign(new Error('Pick a date.'), { status: 400 });
  const ex = excluded === true || excluded === false ? excluded : null;
  await withServiceClient((client) => client.query(
    `INSERT INTO sales_daily (location_id, business_date, excluded, excluded_reason, excluded_by, source) VALUES ($1,$2,$3,$4,$5,'owner')
     ON CONFLICT (location_id, business_date) DO UPDATE SET excluded = EXCLUDED.excluded, excluded_reason = EXCLUDED.excluded_reason, excluded_by = EXCLUDED.excluded_by, updated_at = now()`,
    [locationId, date, ex, ex === true ? String(reason || '').trim().slice(0, 120) || 'Left out by the owner' : null, personId]));
  cache.delete(locationId);
  return { ok: true };
}

async function setHistoryFrom(locationId, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw Object.assign(new Error('Pick a date.'), { status: 400 });
  await withServiceClient((client) => client.query('UPDATE kb_settings SET history_from = $2 WHERE location_id = $1', [locationId, date]));
  return { ok: true };
}

module.exports = {
  forLocation, setDay, setHistoryFrom, refreshGames, curveAt, TEAMS,
  _test: { buildForecast, fitSide, featureRow, holidaysOn, easter, nthWeekday, parseEspnSchedule, buildCurve, curveAt, backtest },
};
