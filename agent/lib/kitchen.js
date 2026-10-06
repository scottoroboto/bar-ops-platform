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
  if (running || !spoton.enabled()) return;
  if (!openNow()) { if (session) { await session.close().catch(() => {}); session = null; } return; }
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

function status() {
  return { enabled: spoton.enabled(), open: openNow(), lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null, lastError, failures };
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

module.exports = { start, stop, tick, status, punchesFrom, pullOnce };
