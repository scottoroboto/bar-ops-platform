// Kitchen board collector (T2 Kitchen Display spec, Oct 2026). Every 5
// minutes from 7:30am to 1:30am (bar time) this box reads three SpotOn
// reports for today -- Employee Time (who's on, hours, SpotOn's labor $),
// the Daily Sales Recap (food sales so far) and Hourly Sales -- and posts
// them to the cloud (POST /api/venue/agent/kitchen/pull), which stores
// them and does the math for the board. Nothing is shown on this box.
//
// A failed pull is retried once, then waits for the next cycle. After 3
// failures in a row the cloud is told (it texts the owner). Needs
// SPOTON_USER / SPOTON_PASS in .env; with those blank this does nothing.
const cache = require('./cache');
const sync = require('./sync');
const spoton = require('./spoton');

const EVERY_MS = 5 * 60 * 1000;
const OPEN_FROM = 7 * 60 + 30;   // 7:30am
const OPEN_UNTIL = 1 * 60 + 30;  // 1:30am (next day)
// Location key from a SpotOn report address; T2's unless .env says otherwise.
const LOCATION_KEY = process.env.SPOTON_LOCATION_KEY || '1215273229887737856';

let session = null;
let timer = null;
let running = false;
let failures = 0;
let lastOkAt = cache.get('kitchenLastOkAt') || null;
let lastError = null;

function tz() { const c = cache.get('config') || {}; return (c.site && c.site.timezone) || 'America/Chicago'; }

function minutesNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz(), hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

function openNow() {
  const m = minutesNow();
  return m >= OPEN_FROM || m < OPEN_UNTIL;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// SpotOn's "clock_in_adjusted_local" is bar-local wall time with no zone.
function localToIso(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`; // the cloud attaches the site's timezone
}

function punchesFrom(rows) {
  return (rows || []).map((r) => ({
    fullName: String(r.full_name || `${r.first_name || ''} ${r.last_name || ''}`).trim(),
    roleName: String(r.role_name || ''),
    date: String(r.date || '').slice(0, 10),
    clockIn: localToIso(r.clock_in_adjusted_local),
    clockOut: r.is_clocked_out === false ? null : localToIso(r.clock_out_adjusted_local),
    regHours: num(r.regular_shift_hours),
    otHours: num(r.overtime_shift_hours),
    laborTotal: num(r.labor_total != null ? r.labor_total : num(r.regular_labor) + num(r.overtime_labor)),
    isClockedOut: r.is_clocked_out !== false && !!r.clock_out_adjusted_local,
  })).filter((p) => p.fullName && p.clockIn);
}

async function pullOnce() {
  if (!session) session = new spoton.Session({ log: (m) => console.log(`[kitchen] ${m}`) });
  const day = spoton.dateParam(new Date(), tz());
  const t0 = Date.now();
  const et = await session.fetchReport('employeetime', LOCATION_KEY, day);
  const rows = spoton.employeeTimeRows(et);
  if (!rows) throw new Error('Employee Time report loaded but had no data rows.');
  const dsrCap = await session.fetchReport('dsr', LOCATION_KEY, day);
  const dsr = spoton.dsrData(dsrCap);
  let hourly = null;
  try { hourly = spoton.hourlyRows(await session.fetchReport('hourlysales', LOCATION_KEY, day)); } catch (e) { /* optional */ }
  const payload = {
    pulledAt: new Date().toISOString(),
    reportDate: day,
    ms: Date.now() - t0,
    punches: punchesFrom(rows),
    dsr: dsr ? { sales: dsr.sales || [], labor: dsr.labor || [], daypart: dsr.daypart || [], orderSales: dsr.orderSalesSurcharges || [] } : null,
    hourly,
  };
  await sync.kitchenPull(payload);
  return payload;
}

async function tick() {
  if (running || backfilling || !spoton.enabled()) return;
  if (!openNow()) {
    if (session && !backfilling) { await session.close().catch(() => {}); session = null; }
    nightly().catch(() => {});
    return;
  }
  running = true;
  try {
    let payload;
    try {
      payload = await pullOnce();
    } catch (err) {
      console.warn('[kitchen] pull failed, trying once more:', err.message);
      if (session) { await session.close().catch(() => {}); session = null; }
      payload = await pullOnce();
    }
    failures = 0;
    lastError = null;
    lastOkAt = Date.now();
    cache.set('kitchenLastOkAt', lastOkAt);
    console.log(`[kitchen] pulled ${payload.punches.length} punches, food ${payload.dsr ? 'yes' : 'no'} in ${(payload.ms / 1000).toFixed(1)}s`);
  } catch (err) {
    failures += 1;
    lastError = err.message;
    console.error(`[kitchen] pull failed (${failures} in a row): ${err.message}`);
    if (session) { await session.close().catch(() => {}); session = null; }
    sync.kitchenPull({ pulledAt: new Date().toISOString(), error: err.message, failures }).catch(() => {});
  } finally {
    running = false;
  }
}

// ---- history ---------------------------------------------------------------
// Past days, read once so week / month / year to date are real. Runs by
// itself overnight (2am-7am, after the kitchen's last pull) for any day
// since BACKFILL_FROM the cloud doesn't have yet, and from
// tools/spoton-backfill.js by hand.
const BACKFILL_FROM = process.env.SPOTON_BACKFILL_FROM || `${new Date().getFullYear()}-01-01`;
const NIGHT_FROM = 2 * 60;   // 2:00am
const NIGHT_UNTIL = 7 * 60;  // 7:00am
let backfilling = false;

const ymdOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
function todayYmd() { return new Date().toLocaleDateString('en-CA', { timeZone: tz() }); }
function addDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function mmdd(ymd) { const [y, m, d] = ymd.split('-'); return `${m}-${d}-${y}`; }
function monthEnd(ymd) { const [y, m] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
// A punch's business day: its clock-in day, with 12am-4am counting toward the day before.
function bizDate(clockInLocal) {
  const m = String(clockInLocal || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
  if (!m) return null;
  return Number(m[2]) < 4 ? addDays(m[1], -1) : m[1];
}

async function backfill({ from = BACKFILL_FROM, to = null, force = false, log = () => {}, stopWhen = () => false } = {}) {
  to = to || addDays(todayYmd(), -1);
  if (!ymdOk(from) || from > to) throw new Error('Bad backfill range.');
  const have = force ? [] : await sync.kitchenHave(from, to);
  const haveSet = new Set(have);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!haveSet.has(d)) days.push(d);
  const out = { planned: days.length, alreadyStored: have.length, done: 0, failed: 0, stopped: false };
  if (!days.length) return out;
  log(`${from} to ${to}: ${days.length} day(s) to read${have.length ? `, ${have.length} already stored` : ''}`);
  const own = !session;
  if (!session) session = new spoton.Session({ log: (m) => log(`  ${m}`) });
  const t0 = Date.now();
  try {
    await session.ensureSignedIn();
    for (let mStart = `${from.slice(0, 7)}-01`; mStart <= to && !out.stopped; mStart = addDays(monthEnd(mStart), 1)) {
      const mEnd = monthEnd(mStart) < to ? monthEnd(mStart) : to;
      const inMonth = days.filter((d) => d >= mStart && d <= mEnd);
      if (!inMonth.length) continue;
      const byDay = new Map();
      try {
        // A day either side too, so shifts past midnight land on the right day.
        const cap = await session.fetchReport('employeetime', LOCATION_KEY, mmdd(addDays(mStart, -1)), mmdd(addDays(mEnd, 1)));
        for (const p of punchesFrom(spoton.employeeTimeRows(cap) || [])) {
          const d = bizDate(p.clockIn);
          if (!d) continue;
          if (!byDay.has(d)) byDay.set(d, []);
          byDay.get(d).push(p);
        }
        log(`${mStart.slice(0, 7)}: ${[...byDay.values()].reduce((a, x) => a + x.length, 0)} shifts on SpotOn`);
      } catch (err) {
        log(`${mStart.slice(0, 7)}: Employee Time failed (${err.message}); this month's days will have no labor`);
      }
      for (const d of inMonth) {
        if (stopWhen()) { out.stopped = true; log('stopping for now; the rest another time'); break; }
        let dsr = null;
        try {
          const x = spoton.dsrData(await session.fetchReport('dsr', LOCATION_KEY, mmdd(d)));
          dsr = x ? { sales: x.sales || [], labor: x.labor || [], daypart: x.daypart || [] } : null;
        } catch (err) { log(`  ${d}: sales recap failed (${err.message})`); }
        try {
          const r = await sync.kitchenPull({ backfill: true, businessDate: d, reportDate: mmdd(d), punches: byDay.get(d) || [], dsr });
          out.done += 1;
          const left = Math.round(((Date.now() - t0) / out.done) * (days.length - out.done) / 60000);
          log(`  ${d}: ${r.punches} shift(s), food ${r.food == null ? 'not found' : `$${Math.round(r.food)}`}   (${out.done}/${days.length}, ~${left} min left)`);
        } catch (err) {
          out.failed += 1;
          log(`  ${d}: could not save (${err.message})`);
        }
      }
    }
  } finally {
    if (own && session) { await session.close().catch(() => {}); session = null; }
  }
  return out;
}

// Overnight: once per night, between 2am and 7am, when the kitchen pulls are off.
async function nightly() {
  if (backfilling || running || !spoton.enabled()) return;
  const m = minutesNow();
  if (m < NIGHT_FROM || m >= NIGHT_UNTIL) return;
  const today = todayYmd();
  if (cache.get('kitchenBackfillNight') === today) return;
  backfilling = true;
  try {
    const r = await backfill({ log: (x) => console.log(`[kitchen] history: ${x}`), stopWhen: () => minutesNow() >= NIGHT_UNTIL - 5 });
    if (!r.stopped) cache.set('kitchenBackfillNight', today);
    if (r.planned) console.log(`[kitchen] history: ${r.done} day(s) stored tonight, ${r.failed} failed${r.stopped ? ', more tomorrow night' : ''}`);
  } catch (err) {
    console.error('[kitchen] history failed:', err.message);
  } finally {
    backfilling = false;
  }
}

function status() {
  return { enabled: spoton.enabled(), open: openNow(), lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null, lastError, failures, backfilling, historyFrom: BACKFILL_FROM, lastHistoryNight: cache.get('kitchenBackfillNight') || null };
}

function start() {
  if (timer || !spoton.enabled()) return;
  console.log('[kitchen] collector on: SpotOn reports every 5 minutes, 7:30am-1:30am');
  setTimeout(tick, 20000); // let the config sync land first
  timer = setInterval(tick, EVERY_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (session) session.close().catch(() => {});
}

module.exports = { start, stop, tick, status, punchesFrom, pullOnce, backfill, nightly };
