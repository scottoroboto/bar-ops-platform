// Kitchen board (T2 Kitchen Display spec, Oct 2026): near-live kitchen
// numbers against goal, on a TV in the kitchen. The location's Venue
// Control box pulls SpotOn's reports every 5 minutes (agent/lib/kitchen.js)
// and posts here; this file stores the pulls and does the math for the
// two screens (A: scoreboard, B: hour by hour).
//
// Money rules: SpotOn's own labor $ per shift is stored (kb_punches.
// labor_total) and only ever leaves this file as a percentage of food
// sales or an hours figure. Nothing returned by view() carries a labor
// dollar amount or a pay rate -- the kitchen TV must never show wages.
//
// Every table (patch_055) is RLS FORCE with zero policies: all reads and
// writes go through withServiceClient here; authorization is in the
// Express routes (server/index.js).
const crypto = require('crypto');
const { withServiceClient } = require('./db');
const notify = require('./notify');

const DEFAULT_TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
const STALE_AFTER_MS = 15 * 60 * 1000;
const OFF_PLAN_GRACE_MIN = 10;
const BOARD_HOURS = { from: 9, to: 25 }; // 9am through 1am (next day) on screen B

// ---- time helpers (same technique as server/timeclock.js) ---------------
function tzOffsetMinutes(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}
function zonedToUtc(naive, timeZone) {
  const m = String(naive || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return new Date(guess - tzOffsetMinutes(timeZone, new Date(guess)) * 60000);
}
function partsIn(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = {};
  for (const x of dtf.formatToParts(date)) if (x.type !== 'literal') p[x.type] = x.value;
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: p.weekday };
}
function ymdAddDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function toYmd(v) { return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10); }
// The business day: a shift past midnight counts toward the day it started.
function businessDate(date, timeZone, dayStartHour) { return partsIn(new Date(date.getTime() - dayStartHour * 3600000), timeZone).ymd; }
function dayStartUtc(ymd, timeZone, dayStartHour) { return zonedToUtc(`${ymd}T${String(dayStartHour).padStart(2, '0')}:00:00`, timeZone); }
function weekdayOf(ymd) { return new Date(`${ymd}T12:00:00Z`).getUTCDay(); } // 0 Sun .. 6 Sat
function isWeekend(ymd) { const d = weekdayOf(ymd); return d === 5 || d === 6; } // Fri, Sat
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round1(n) { return Math.round(n * 10) / 10; }
function nameKey(s) { return String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' '); }

// ---- settings ------------------------------------------------------------
async function settingsFor(client, locationId) {
  const { rows } = await client.query('SELECT * FROM kb_settings WHERE location_id = $1', [locationId]);
  if (rows[0]) return rows[0];
  const ins = await client.query('INSERT INTO kb_settings (location_id) VALUES ($1) ON CONFLICT (location_id) DO UPDATE SET location_id = EXCLUDED.location_id RETURNING *', [locationId]);
  return ins.rows[0];
}

// Which of these locations show managers the board (patch_057). A
// location with no settings row yet counts as on, matching the default.
async function managerViewLocations(locationIds) {
  if (!locationIds.length) return [];
  return withServiceClient(async (client) => {
    const { rows } = await client.query('SELECT location_id, managers_can_view FROM kb_settings WHERE location_id = ANY($1::uuid[])', [locationIds]);
    const off = new Set(rows.filter((r) => !r.managers_can_view).map((r) => String(r.location_id)));
    return locationIds.filter((id) => !off.has(String(id)));
  });
}

async function siteTz(client, locationId) {
  const { rows } = await client.query('SELECT timezone FROM vc_sites WHERE location_id = $1', [locationId]);
  return (rows[0] && rows[0].timezone) || DEFAULT_TZ;
}

function cleanList(v, max = 20) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
}

async function updateSettings(locationId, body, personId) {
  const b = body || {};
  const numIn = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw Object.assign(new Error('A goal is out of range.'), { status: 400 }); return n; };
  return withServiceClient(async (client) => {
    const cur = await settingsFor(client, locationId);
    const next = {
      kitchen_roles: b.kitchenRoles != null ? cleanList(b.kitchenRoles) : cur.kitchen_roles,
      food_keys: b.foodKeys != null ? cleanList(b.foodKeys) : cur.food_keys,
      food_goal_weekday: b.foodGoalWeekday != null ? numIn(b.foodGoalWeekday, 0, 100000) : cur.food_goal_weekday,
      food_goal_weekend: b.foodGoalWeekend != null ? numIn(b.foodGoalWeekend, 0, 100000) : cur.food_goal_weekend,
      labor_goal_weekday: b.laborGoalWeekday != null ? numIn(b.laborGoalWeekday, 1, 100) : cur.labor_goal_weekday,
      labor_goal_weekend: b.laborGoalWeekend != null ? numIn(b.laborGoalWeekend, 1, 100) : cur.labor_goal_weekend,
      labor_goal_week: b.laborGoalWeek != null ? numIn(b.laborGoalWeek, 1, 100) : cur.labor_goal_week,
      slow_night_line: b.slowNightLine != null ? numIn(b.slowNightLine, 0, 100000) : cur.slow_night_line,
      rotate_seconds: b.rotateSeconds != null ? Math.round(numIn(b.rotateSeconds, 10, 600)) : cur.rotate_seconds,
      day_start_hour: b.dayStartHour != null ? Math.round(numIn(b.dayStartHour, 0, 12)) : cur.day_start_hour,
      show_names: b.showNames != null ? !!b.showNames : cur.show_names,
      managers_can_view: b.managersCanView != null ? !!b.managersCanView : cur.managers_can_view,
    };
    const { rows } = await client.query(
      `UPDATE kb_settings SET kitchen_roles = $2, food_keys = $3, food_goal_weekday = $4, food_goal_weekend = $5, labor_goal_weekday = $6,
         labor_goal_weekend = $7, labor_goal_week = $8, slow_night_line = $9, rotate_seconds = $10, day_start_hour = $11, show_names = $12,
         managers_can_view = $14, updated_at = now(), updated_by = $13 WHERE location_id = $1 RETURNING *`,
      [locationId, next.kitchen_roles, next.food_keys, next.food_goal_weekday, next.food_goal_weekend, next.labor_goal_weekday,
        next.labor_goal_weekend, next.labor_goal_week, next.slow_night_line, next.rotate_seconds, next.day_start_hour, next.show_names, personId || null,
        next.managers_can_view],
    );
    return rows[0];
  });
}

// ---- the pull from the box ---------------------------------------------

// SpotOn's Daily Sales Recap "sales" rows: pick the food line(s) and the
// total. The row layout is SpotOn's; this looks for a name-like field that
// matches a food key and a money field named like net sales.
function moneyField(row, prefer) {
  const keys = Object.keys(row);
  for (const re of prefer) { const k = keys.find((x) => re.test(x) && typeof row[x] === 'number'); if (k) return row[k]; }
  return null;
}
function labelOf(row) {
  for (const k of ['name', 'category', 'sales_category', 'label', 'type', 'title', 'revenue_center', 'department']) if (typeof row[k] === 'string') return row[k];
  const k = Object.keys(row).find((x) => typeof row[x] === 'string' && !/typename/i.test(x));
  return k ? row[k] : '';
}
function foodFromSales(sales, foodKeys) {
  if (!Array.isArray(sales) || !sales.length) return { food: null, total: null };
  const prefer = [/^net_?sales?$/i, /net/i, /^sales$/i, /total/i, /amount/i];
  let food = 0; let found = false; let total = null;
  for (const row of sales) {
    if (!row || typeof row !== 'object') continue;
    const label = labelOf(row);
    const v = moneyField(row, prefer);
    if (v == null) continue;
    if (/^(grand\s*)?total/i.test(label)) { total = v; continue; }
    if (foodKeys.some((k) => label.toLowerCase().includes(String(k).toLowerCase()))) { food += v; found = true; }
  }
  if (total == null) total = sales.reduce((a, r) => a + (r && typeof r === 'object' && !/total/i.test(labelOf(r)) ? num(moneyField(r, prefer)) : 0), 0);
  // Sales rows with no food line yet (the bar is open, the kitchen has not
  // rung anything) mean $0 of food, not "no data": the home screen's bar
  // number is total minus food and must not go blank until lunch.
  return { food: found ? food : (total != null ? 0 : null), total };
}

async function ownerPhones(client) {
  const { rows } = await client.query(`SELECT id, phone FROM people WHERE role = 'owner' AND status = 'active' AND phone IS NOT NULL`);
  return rows;
}

async function ingest(locationId, payload) {
  const p = payload || {};
  return withServiceClient(async (client) => {
    const tz = await siteTz(client, locationId);
    const settings = await settingsFor(client, locationId);
    if (p.error) {
      const { rows } = await client.query('INSERT INTO kb_pulls (location_id, ok, error) VALUES ($1, false, $2) RETURNING id', [locationId, String(p.error).slice(0, 500)]);
      if (Number(p.failures) === 3) {
        for (const o of await ownerPhones(client)) {
          await notify.sendSms(client, 'kb_pulls', rows[0].id, o.phone, `Bar Ops: the kitchen board at this bar can't read SpotOn (3 pulls failed). Last error: ${String(p.error).slice(0, 120)}`).catch(() => {});
        }
      }
      return { ok: true, logged: true };
    }
    // A backfill (tools/spoton-backfill.js) sends a whole past day at once:
    // it names the business date, its snapshot sits at that day's close,
    // and it isn't a "pull" for the stale banner or the owner's texts.
    const backfill = !!(p.backfill && /^\d{4}-\d{2}-\d{2}$/.test(String(p.businessDate || '')));
    const now = backfill ? new Date() : (p.pulledAt ? new Date(p.pulledAt) : new Date());
    const bdate = backfill ? p.businessDate : businessDate(now, tz, settings.day_start_hour);
    const snapAt = backfill ? new Date(dayStartUtc(bdate, tz, settings.day_start_hour).getTime() + 23 * 3600000) : now;
    const punches = Array.isArray(p.punches) ? p.punches : [];
    let kept = 0;
    for (const x of punches) {
      const clockIn = zonedToUtc(x.clockIn, tz);
      if (!clockIn || !x.fullName) continue;
      const clockOut = x.clockOut ? zonedToUtc(x.clockOut, tz) : null;
      const key = `${String(x.fullName).trim().toLowerCase()}|${clockIn.toISOString()}`;
      await client.query(
        `INSERT INTO kb_punches (location_id, business_date, punch_key, full_name, role_name, clock_in, clock_out, reg_hours, ot_hours, labor_total, is_clocked_out, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (location_id, business_date, punch_key) DO UPDATE SET role_name = EXCLUDED.role_name, clock_out = EXCLUDED.clock_out,
           reg_hours = EXCLUDED.reg_hours, ot_hours = EXCLUDED.ot_hours, labor_total = EXCLUDED.labor_total, is_clocked_out = EXCLUDED.is_clocked_out, last_seen_at = EXCLUDED.last_seen_at`,
        [locationId, bdate, key, String(x.fullName).trim().slice(0, 120), String(x.roleName || '').slice(0, 80), clockIn, clockOut, num(x.regHours), num(x.otHours), num(x.laborTotal), !!x.isClockedOut, now],
      );
      kept += 1;
    }
    // A punch that vanished from SpotOn's report (deleted by a manager) goes too.
    await client.query('DELETE FROM kb_punches WHERE location_id = $1 AND business_date = $2 AND last_seen_at < $3', [locationId, bdate, now]);
    const { food, total } = p.dsr ? foodFromSales(p.dsr.sales, settings.food_keys) : { food: null, total: null };
    if (backfill) await client.query('DELETE FROM kb_sales_snapshots WHERE location_id = $1 AND business_date = $2', [locationId, bdate]);
    await client.query(
      'INSERT INTO kb_sales_snapshots (location_id, business_date, at, food_net, total_net, raw) VALUES ($1, $2, $3, $4, $5, $6)',
      [locationId, bdate, snapAt, food, total, JSON.stringify({ dsr: p.dsr || null, hourly: p.hourly || null }).slice(0, 400000)],
    );
    if (backfill) return { ok: true, businessDate: bdate, punches: kept, food, total, backfill: true };
    const { rows } = await client.query('INSERT INTO kb_pulls (location_id, ok, ms, punches) VALUES ($1, true, $2, $3) RETURNING id', [locationId, p.ms != null ? Math.round(p.ms) : null, kept]);
    // Keep the snapshot table tidy: 60 days.
    await client.query(`DELETE FROM kb_sales_snapshots WHERE location_id = $1 AND at < now() - interval '60 days'`, [locationId]);
    await client.query(`DELETE FROM kb_pulls WHERE location_id = $1 AND at < now() - interval '30 days'`, [locationId]);
    return { ok: true, businessDate: bdate, punches: kept, food, total, pullId: rows[0].id };
  });
}

// ---- the board -----------------------------------------------------------

async function kitchenShifts(client, locationId, ymd, tz) {
  const { rows } = await client.query(
    `SELECT s.id, s.shift_date, s.start_time, s.end_time, p.name AS person_name, pos.name AS position_name
       FROM shifts s JOIN schedules sc ON sc.id = s.schedule_id JOIN people p ON p.id = s.person_id JOIN positions pos ON pos.id = s.position_id
      WHERE sc.location_id = $1 AND sc.name ILIKE '%kitchen%' AND s.shift_date = $2 AND s.status = 'scheduled'`,
    [locationId, ymd],
  );
  return rows.map((r) => {
    const d = toYmd(r.shift_date);
    const start = zonedToUtc(`${d}T${String(r.start_time).slice(0, 8)}`, tz);
    let end = zonedToUtc(`${d}T${String(r.end_time).slice(0, 8)}`, tz);
    if (end <= start) end = new Date(end.getTime() + 86400000);
    return { id: r.id, name: r.person_name, slot: r.position_name, start, end, key: nameKey(r.person_name) };
  });
}

function overlapHours(aStart, aEnd, bStart, bEnd) {
  const s = Math.max(aStart.getTime(), bStart.getTime());
  const e = Math.min(aEnd.getTime(), bEnd.getTime());
  return e > s ? (e - s) / 3600000 : 0;
}

function fmtTime(date, tz) {
  return date ? new Date(date).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }) : null;
}

async function view(locationId, { now = new Date() } = {}) {
  return withServiceClient(async (client) => {
    const tz = await siteTz(client, locationId);
    const s = await settingsFor(client, locationId);
    const loc = (await client.query('SELECT name FROM locations WHERE id = $1', [locationId])).rows[0];
    const bdate = businessDate(now, tz, s.day_start_hour);
    const dayStart = dayStartUtc(bdate, tz, s.day_start_hour);
    const weekend = isWeekend(bdate);
    const foodGoal = num(weekend ? s.food_goal_weekend : s.food_goal_weekday);
    const laborGoal = num(weekend ? s.labor_goal_weekend : s.labor_goal_weekday);
    const roles = s.kitchen_roles.map((r) => r.toLowerCase());
    const isKitchen = (role) => roles.includes(String(role || '').toLowerCase());

    const punches = (await client.query('SELECT * FROM kb_punches WHERE location_id = $1 AND business_date = $2 ORDER BY clock_in', [locationId, bdate])).rows
      .filter((r) => isKitchen(r.role_name))
      .map((r) => ({ ...r, clock_in: new Date(r.clock_in), clock_out: r.clock_out ? new Date(r.clock_out) : null, key: nameKey(r.full_name) }));
    const snaps = (await client.query('SELECT at, food_net, total_net FROM kb_sales_snapshots WHERE location_id = $1 AND business_date = $2 ORDER BY at', [locationId, bdate])).rows
      .map((r) => ({ at: new Date(r.at), food: r.food_net == null ? null : num(r.food_net), total: r.total_net == null ? null : num(r.total_net) }));
    const lastPull = (await client.query('SELECT at, ok, error FROM kb_pulls WHERE location_id = $1 ORDER BY at DESC LIMIT 1', [locationId])).rows[0] || null;
    const lastOk = (await client.query('SELECT at FROM kb_pulls WHERE location_id = $1 AND ok ORDER BY at DESC LIMIT 1', [locationId])).rows[0] || null;
    const shifts = await kitchenShifts(client, locationId, bdate, tz);

    const latestSnap = snaps.length ? snaps[snaps.length - 1] : null;
    const foodSoFar = latestSnap && latestSnap.food != null ? latestSnap.food : null;
    const actualHours = punches.reduce((a, r) => a + num(r.reg_hours) + num(r.ot_hours), 0);
    const laborSoFar = punches.reduce((a, r) => a + num(r.labor_total), 0); // never returned
    const schedSoFar = shifts.reduce((a, sh) => a + overlapHours(sh.start, sh.end, dayStart, now), 0);
    const schedTotal = shifts.reduce((a, sh) => a + (sh.end - sh.start) / 3600000, 0);
    const schedRemaining = shifts.reduce((a, sh) => a + overlapHours(sh.start, sh.end, now, new Date(now.getTime() + 48 * 3600000)), 0);

    // Average kitchen $/hour: today's own punches, else the last 14 days.
    let rate = actualHours >= 0.5 ? laborSoFar / actualHours : null;
    if (rate == null) {
      const r = (await client.query(
        `SELECT SUM(labor_total) AS l, SUM(reg_hours + ot_hours) AS h FROM kb_punches WHERE location_id = $1 AND business_date >= $2 AND business_date < $3 AND lower(role_name) = ANY($4)`,
        [locationId, ymdAddDays(bdate, -14), bdate, roles],
      )).rows[0];
      rate = r && num(r.h) > 0 ? num(r.l) / num(r.h) : null;
    }
    const expectedFood = Math.max(foodGoal, foodSoFar || 0);
    const projectedLabor = laborSoFar + (rate != null ? schedRemaining * rate : 0);
    const laborPctProjected = expectedFood > 0 && (rate != null || schedRemaining === 0) ? Math.round((projectedLabor / expectedFood) * 100) : null;
    const laborPctSoFar = foodSoFar ? Math.round((laborSoFar / foodSoFar) * 100) : null;

    // Where sales "should" be by now: the goal spread over 9am-close by hours elapsed.
    const openStart = zonedToUtc(`${bdate}T${String(BOARD_HOURS.from).padStart(2, '0')}:00:00`, tz);
    const closeAt = new Date(openStart.getTime() + (BOARD_HOURS.to - BOARD_HOURS.from) * 3600000);
    const paceFrac = Math.min(1, Math.max(0, (now - openStart) / (closeAt - openStart)));

    const showName = (n) => (s.show_names ? n : null);
    const onClock = punches.filter((r) => !r.is_clocked_out && !r.clock_out).map((r) => {
      const sh = shifts.find((x) => x.key === r.key && Math.abs(x.start - r.clock_in) < 6 * 3600000) || shifts.find((x) => x.key === r.key);
      return { name: showName(r.full_name), role: sh ? sh.slot : r.role_name, inAt: fmtTime(r.clock_in, tz), offAt: sh ? fmtTime(sh.end, tz) : null };
    });
    const offPlan = [];
    for (const r of punches) {
      const sh = shifts.find((x) => x.key === r.key && Math.abs(x.start - r.clock_in) < 6 * 3600000);
      if (!sh) { if (shifts.length) offPlan.push({ name: showName(r.full_name), note: `in ${fmtTime(r.clock_in, tz)} · not on the schedule`, extraHours: round1(num(r.reg_hours) + num(r.ot_hours)) }); continue; }
      const early = (sh.start - r.clock_in) / 60000;
      if (early > OFF_PLAN_GRACE_MIN) offPlan.push({ name: showName(r.full_name), note: `in ${fmtTime(r.clock_in, tz)} · shift ${fmtTime(sh.start, tz)}`, extraHours: round1(early / 60) });
      if (r.clock_out) {
        const late = (r.clock_out - sh.end) / 60000;
        if (late > OFF_PLAN_GRACE_MIN) offPlan.push({ name: showName(r.full_name), note: `out ${fmtTime(r.clock_out, tz)} · shift to ${fmtTime(sh.end, tz)}`, extraHours: round1(late / 60) });
      }
    }
    const scheduledNotIn = shifts.filter((sh) => sh.start < now && !punches.some((r) => r.key === sh.key)).map((sh) => ({ name: showName(sh.name), slot: sh.slot, startAt: fmtTime(sh.start, tz) }));

    // 7pm check (weeknights).
    const seven = zonedToUtc(`${bdate}T19:00:00`, tz);
    let sevenCheck = null;
    if (!weekend && now >= seven) {
      const at7 = [...snaps].reverse().find((x) => x.at <= seven && x.food != null);
      if (at7) sevenCheck = { foodAt7: Math.round(at7.food), line: num(s.slow_night_line), keep: at7.food >= num(s.slow_night_line) };
    }

    // Screen B: per hour 9am .. 1am.
    const hours = [];
    const snapAt = (t) => { const x = [...snaps].reverse().find((q) => q.at <= t && q.food != null); return x ? x.food : null; };
    const remainingHours = Math.max(0, (closeAt - now) / 3600000);
    const perHourExpected = remainingHours > 0 ? Math.max(0, foodGoal - (foodSoFar || 0)) / remainingHours : 0;
    for (let h = BOARD_HOURS.from; h < BOARD_HOURS.to; h += 1) {
      const start = new Date(openStart.getTime() + (h - BOARD_HOURS.from) * 3600000);
      const end = new Date(start.getTime() + 3600000);
      const mid = new Date(start.getTime() + 1800000);
      const past = end <= now; const current = start <= now && now < end;
      const a = snapAt(start); const b = snapAt(current ? now : end);
      const food = past || current ? (a != null && b != null ? Math.max(0, b - a) : (b != null && h === BOARD_HOURS.from ? b : null)) : null;
      const planned = shifts.filter((sh) => sh.start <= mid && sh.end > mid).length;
      const actual = past || current ? punches.filter((r) => r.clock_in <= mid && (r.clock_out || now) > mid).length : null;
      hours.push({ hour: h % 24, label: `${((h % 12) || 12)}${h % 24 < 12 ? 'a' : 'p'}`, food: food == null ? null : Math.round(food), expected: past || current ? null : Math.round(perHourExpected), planned, actual, current, over: actual != null && actual > planned });
    }
    const overHours = hours.filter((x) => x.over);
    let overNote = null;
    if (overHours.length) {
      const first = overHours[0]; const last = overHours[overHours.length - 1];
      overNote = `${first.label}–${last.label}: ${Math.max(...overHours.map((x) => x.actual))} on vs ${Math.max(...overHours.map((x) => x.planned))} planned`;
    }

    // Week strip, Sat..Fri.
    const dow = weekdayOf(bdate);
    const satOffset = (dow + 1) % 7; // days since Saturday
    const weekStart = ymdAddDays(bdate, -satOffset);
    const week = [];
    const weekRows = (await client.query(
      `SELECT business_date, SUM(labor_total) AS labor FROM kb_punches WHERE location_id = $1 AND business_date >= $2 AND business_date <= $3 AND lower(role_name) = ANY($4) GROUP BY business_date`,
      [locationId, weekStart, ymdAddDays(weekStart, 6), roles],
    )).rows;
    const weekFood = (await client.query(
      `SELECT DISTINCT ON (business_date) business_date, food_net FROM kb_sales_snapshots WHERE location_id = $1 AND business_date >= $2 AND business_date <= $3 AND food_net IS NOT NULL ORDER BY business_date, at DESC`,
      [locationId, weekStart, ymdAddDays(weekStart, 6)],
    )).rows;
    for (let i = 0; i < 7; i += 1) {
      const d = ymdAddDays(weekStart, i);
      const labor = num((weekRows.find((r) => toYmd(r.business_date) === d) || {}).labor);
      const foodRow = weekFood.find((r) => toYmd(r.business_date) === d);
      const food = foodRow ? num(foodRow.food_net) : null;
      const goal = num(isWeekend(d) ? s.labor_goal_weekend : s.labor_goal_weekday);
      const label = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][weekdayOf(d)];
      if (d === bdate) week.push({ day: label, pct: laborPctProjected, goal, state: 'live' });
      else if (d > bdate) week.push({ day: label, pct: null, goal, state: 'future' });
      else week.push({ day: label, pct: food ? Math.round((labor / food) * 100) : null, goal, state: food ? (labor / food * 100 <= goal ? 'hit' : 'missed') : 'nodata' });
    }

    // Week / month / year to date: SpotOn's labor $ over the last food
    // snapshot of each day, today's so-far included. Only as far back as
    // the board has been collecting.
    const periods = {};
    const firstDay = (await client.query('SELECT MIN(business_date) AS d FROM kb_sales_snapshots WHERE location_id = $1', [locationId])).rows[0];
    const since = firstDay && firstDay.d ? toYmd(firstDay.d) : bdate;
    for (const [key, from] of [['week', weekStart], ['month', `${bdate.slice(0, 7)}-01`], ['year', `${bdate.slice(0, 4)}-01-01`]]) {
      const start = from > since ? from : since;
      const r = (await client.query(
        `WITH food AS (SELECT DISTINCT ON (business_date) business_date, food_net FROM kb_sales_snapshots
                        WHERE location_id = $1 AND business_date >= $2 AND business_date <= $3 AND food_net IS NOT NULL ORDER BY business_date, at DESC),
              labor AS (SELECT business_date, SUM(labor_total) AS labor FROM kb_punches
                        WHERE location_id = $1 AND business_date >= $2 AND business_date <= $3 AND lower(role_name) = ANY($4) GROUP BY business_date)
         SELECT COALESCE(SUM(food.food_net), 0) AS food, COALESCE(SUM(labor.labor), 0) AS labor, COUNT(food.business_date) AS days
           FROM food LEFT JOIN labor ON labor.business_date = food.business_date`,
        [locationId, start, bdate, roles],
      )).rows[0];
      const food = num(r.food); const labor = num(r.labor);
      periods[key] = { pct: food > 0 ? Math.round((labor / food) * 100) : null, food: Math.round(food), days: Number(r.days), since: start };
    }

    const lastOkAt = lastOk ? new Date(lastOk.at) : null;
    return {
      location: loc ? loc.name : '', timezone: tz, businessDate: bdate, now: now.toISOString(),
      dataAsOf: lastOkAt ? lastOkAt.toISOString() : null,
      stale: !lastOkAt || now - lastOkAt > STALE_AFTER_MS,
      lastError: lastPull && !lastPull.ok ? lastPull.error : null,
      rotateSeconds: s.rotate_seconds,
      food: { soFar: foodSoFar == null ? null : Math.round(foodSoFar), goal: Math.round(foodGoal), pct: foodSoFar != null && foodGoal > 0 ? Math.round((foodSoFar / foodGoal) * 100) : null, paceFrac: Math.round(paceFrac * 100) / 100, onPace: foodSoFar != null && foodGoal > 0 ? foodSoFar / foodGoal >= paceFrac - 0.05 : null },
      labor: { pctProjected: laborPctProjected, pctSoFar: laborPctSoFar, goal: laborGoal, hit: laborPctProjected == null ? null : laborPctProjected <= laborGoal, weekGoal: num(s.labor_goal_week) },
      hours: { actual: round1(actualHours), scheduledSoFar: round1(schedSoFar), scheduledTotal: round1(schedTotal), over: round1(actualHours - schedSoFar) },
      foodCost: null, // not set up yet (purchases / food inventory): shows "—"
      onClock, offPlan, scheduledNotIn, sevenCheck, hoursByHour: hours, overNote, week, periods,
      scheduleKnown: shifts.length > 0,
    };
  });
}

// ---- device links (the kitchen TV) ------------------------------------------
function hashToken(t) { return crypto.createHash('sha256').update(t).digest('hex'); }

async function createDevice(locationId, name, personId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const row = await withServiceClient(async (client) => (await client.query(
    'INSERT INTO kb_devices (location_id, name, token_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING id, name, created_at',
    [locationId, String(name || 'Kitchen TV').trim().slice(0, 60), hashToken(token), personId || null],
  )).rows[0]);
  return { ...row, token };
}
async function listDevices(locationId) {
  return withServiceClient(async (client) => (await client.query('SELECT id, name, created_at FROM kb_devices WHERE location_id = $1 AND revoked_at IS NULL ORDER BY created_at', [locationId])).rows);
}
async function revokeDevice(id, personId) {
  return withServiceClient(async (client) => (await client.query('UPDATE kb_devices SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id, personId || null])).rows[0] || null);
}
async function locationForDevice(token) {
  if (!token) return null;
  return withServiceClient(async (client) => {
    const { rows } = await client.query('SELECT location_id FROM kb_devices WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(String(token))]);
    return rows[0] ? rows[0].location_id : null;
  });
}

// Business dates that already have a day's sales stored (backfill skips them).
async function haveDates(locationId, from, to) {
  return withServiceClient(async (client) => (await client.query(
    'SELECT DISTINCT business_date FROM kb_sales_snapshots WHERE location_id = $1 AND business_date >= $2 AND business_date <= $3 AND food_net IS NOT NULL ORDER BY business_date',
    [locationId, from, to],
  )).rows.map((r) => toYmd(r.business_date)));
}

async function recentPulls(locationId, limit = 12) {
  return withServiceClient(async (client) => (await client.query('SELECT at, ok, error, ms, punches FROM kb_pulls WHERE location_id = $1 ORDER BY at DESC LIMIT $2', [locationId, limit])).rows);
}

module.exports = { ingest, view, settingsFor, updateSettings, managerViewLocations, createDevice, listDevices, revokeDevice, locationForDevice, recentPulls, haveDates, foodFromSales, businessDate };
