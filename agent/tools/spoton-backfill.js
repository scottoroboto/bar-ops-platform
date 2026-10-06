#!/usr/bin/env node
// Kitchen board history: read past days from SpotOn once, so week / month
// / year to date are real from day one.
//   node tools/spoton-backfill.js 2026-01-01              Jan 1 through yesterday
//   node tools/spoton-backfill.js 2026-01-01 2026-06-30   a range
//   node tools/spoton-backfill.js 2026-01-01 --force      redo days already stored
// Employee Time is read a month at a time (labor $ per shift), the Daily
// Sales Recap one day at a time (food). About 10 seconds per day: a full
// year is a couple of hours. Safe to stop (Ctrl+C) and run again: days
// already stored are skipped. Run it from ~/bar-ops-platform/agent while
// the agent is running; it uses the same SpotOn sign-in.
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();
const cache = require('../lib/cache');
const sync = require('../lib/sync');
const spoton = require('../lib/spoton');
const { punchesFrom } = require('../lib/kitchen');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');
const TZ = ((cache.get('config') || {}).site || {}).timezone || 'America/Chicago';
const DAY_START_HOUR = 4;

const ymdOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
function todayYmd() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function addDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function mmdd(ymd) { const [y, m, d] = ymd.split('-'); return `${m}-${d}-${y}`; }
function monthEnd(ymd) { const [y, m] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
// Business date of a punch: the clock-in's day, with 12am-4am counting toward the day before.
function bizDate(clockInLocal) {
  const m = String(clockInLocal || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
  if (!m) return null;
  return Number(m[2]) < DAY_START_HOUR ? addDays(m[1], -1) : m[1];
}

(async () => {
  const from = args[0];
  const to = args[1] && ymdOk(args[1]) ? args[1] : addDays(todayYmd(), -1);
  if (!ymdOk(from) || from > to) { console.log('Usage: node tools/spoton-backfill.js 2026-01-01 [2026-06-30] [--force]'); process.exit(1); }
  if (!spoton.enabled()) { console.log('SPOTON_USER / SPOTON_PASS are not set in agent/.env.'); process.exit(1); }

  const have = force ? [] : await sync.kitchenHave(from, to);
  const haveSet = new Set(have);
  let days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!haveSet.has(d)) days.push(d);
  console.log(`${from} to ${to}: ${days.length} day(s) to read${have.length ? `, ${have.length} already stored` : ''}. About ${Math.ceil(days.length * 10 / 60)} minutes.`);
  if (!days.length) process.exit(0);

  const session = new spoton.Session({ log: (m) => console.log(`  ${m}`) });
  await session.open();
  await session.ensureSignedIn();
  const t0 = Date.now();
  let done = 0; let failed = 0;

  // One Employee Time read per month, split into business days.
  for (let mStart = `${from.slice(0, 7)}-01`; mStart <= to; mStart = addDays(monthEnd(mStart), 1)) {
    const mEnd = monthEnd(mStart) < to ? monthEnd(mStart) : to;
    const inMonth = days.filter((d) => d >= mStart && d <= mEnd);
    if (!inMonth.length) continue;
    let byDay = new Map();
    try {
      // Read a day either side too, so shifts past midnight land on the right day.
      const cap = await session.fetchReport('employeetime', spoton.LOCATION_KEY, mmdd(addDays(mStart, -1)), mmdd(addDays(mEnd, 1)));
      const rows = spoton.employeeTimeRows(cap) || [];
      for (const p of punchesFrom(rows)) {
        const d = bizDate(p.clockIn);
        if (!d) continue;
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(p);
      }
      console.log(`${mStart.slice(0, 7)}: ${rows.length} shifts on SpotOn`);
    } catch (err) {
      console.log(`${mStart.slice(0, 7)}: Employee Time failed (${err.message}); days in this month will have no labor`);
    }
    for (const d of inMonth) {
      let dsr = null;
      try {
        const cap = await session.fetchReport('dsr', spoton.LOCATION_KEY, mmdd(d));
        const x = spoton.dsrData(cap);
        dsr = x ? { sales: x.sales || [], labor: x.labor || [], daypart: x.daypart || [] } : null;
      } catch (err) {
        console.log(`  ${d}: sales recap failed (${err.message})`);
      }
      try {
        const r = await sync.kitchenPull({ backfill: true, businessDate: d, reportDate: mmdd(d), punches: byDay.get(d) || [], dsr });
        done += 1;
        const left = Math.round(((Date.now() - t0) / done) * (days.length - done) / 60000);
        console.log(`  ${d}: ${r.punches} shift(s), food ${r.food == null ? 'not found' : `$${Math.round(r.food)}`}   (${done}/${days.length}, ~${left} min left)`);
      } catch (err) {
        failed += 1;
        console.log(`  ${d}: could not save (${err.message})`);
      }
    }
  }
  await session.close();
  console.log(`\nDone: ${done} day(s) stored, ${failed} failed, in ${Math.round((Date.now() - t0) / 60000)} minutes.`);
  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
