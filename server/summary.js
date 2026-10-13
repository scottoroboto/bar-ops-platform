// Morning summary (patch_069). One email and/or text per manager per bar,
// built at the hour they picked from data the app already holds: SpotOn
// sales snapshots and punches (kitchen board), the Bar Ops schedule, cash
// counts, cooler sensors, service calls, applicants, network and AV status,
// and the My Teams games the bar's box pushes up.
//
// Shape of every summary: NEEDS YOU first (open service calls, applicants
// waiting, stock, alerts: drawer shortages and internet down), then
// Yesterday, Today, big games, the charts, critical systems. The owner
// switches the summary on per manager and picks the sections; the manager
// picks email / text / both and the hour (5-9am). Bar or kitchen comes
// from the manager's home widgets (bar_* on -> bar sections, kitchen_* ->
// kitchen), owner gets both.
//
// The text version ends with a link to the full page, which asks for that
// manager's PIN only (the link already says who it was sent to). Charts
// are PNGs rendered from the stored model when the email client asks for
// them, so they show in Gmail and Apple Mail without any clicking.
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { withServiceClient } = require('./db');
const notify = require('./notify');
const kitchenboard = require('./kitchenboard');
const home = require('./home');

let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { console.warn('[summary] @resvg/resvg-js not available; charts will be skipped'); }

const DEFAULT_TZ = 'America/Chicago';
const FONT_FILES = [path.join(__dirname, 'assets', 'DejaVuSans.ttf'), path.join(__dirname, 'assets', 'DejaVuSans-Bold.ttf')];
const FONT = 'DejaVu Sans';

// Sections the owner can switch per manager. Needs-you is always on.
const SECTIONS = [
  ['sales', 'Sales, total and day/night', true],
  ['cost', 'Liquor cost (food cost for kitchen)', false],
  ['labor', 'Labor cost', true],
  ['drawers', 'Drawers, deposit', true],
  ['clock', 'Clock: late in, missed out and who fixed it', true],
  ['projected', 'Projected sales, total and day/night', true],
  ['shifts', 'Scheduled shifts, time and name', true],
  ['games', 'Big games with start times', true],
  ['coolers', 'Cooler temps, hourly chart', true],
  ['timeline', 'Sales vs schedule timeline (games, sales, shifts)', true],
  ['systems', 'Critical systems: internet, receivers, Sonos/Pandora', true],
];
const DEFAULT_SECTIONS = Object.fromEntries(SECTIONS.map(([k, , d]) => [k, d]));

// ---------------------------------------------------------------- time
function partsIn(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = {};
  dtf.formatToParts(date).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: p.weekday };
}
function tzOffsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; dtf.formatToParts(date).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUtc - date.getTime()) / 60000;
}
// Local wall-clock (ymd + hh:mm) in tz -> UTC Date.
function zonedToUtc(ymd, hhmm, tz) {
  const naive = new Date(`${ymd}T${hhmm.length === 5 ? hhmm + ':00' : hhmm}Z`);
  const guess = new Date(naive.getTime() - tzOffsetMinutes(tz, naive) * 60000);
  return new Date(naive.getTime() - tzOffsetMinutes(tz, guess) * 60000);
}
function ymdAddDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function toYmd(v) { return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10); }
function fmtTime(date, tz) { return new Date(date).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).replace(' ', '').replace('AM', 'a').replace('PM', 'p'); }
function fmtHm(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); const ap = h < 12 ? 'a' : 'p'; return `${(h % 12) || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${ap}`; }
function fmtDate(ymd) { return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }); }
function fmtShort(ymd) { return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' }); }
function weekdayShort(ymd) { return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }); }
function hourLabel(h) { const k = ((h % 24) + 24) % 24; return k === 0 ? '12a' : k === 12 ? '12p' : `${k % 12}${k < 12 ? 'a' : 'p'}`; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function money(n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'); }
function pct(n) { return n == null ? '—' : `${n.toFixed(1)}%`; }
function cToF(c) { return c == null ? null : Math.round((Number(c) * 9 / 5 + 32) * 10) / 10; }
function nameKey(s) { return String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' '); }
function ago(ms) { const d = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); return d ? `${d} day${d === 1 ? '' : 's'} ${h} hr` : `${h} hr`; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function shortName(full) { const p = String(full || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0] || ''; }

// ---------------------------------------------------------------- settings
async function settingsFor(personId) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT * FROM morning_summary_settings WHERE person_id = $1', [personId]);
    const r = rows[0] || {};
    return {
      personId, enabled: r.enabled === true, channel: r.channel || 'email', sendHour: r.send_hour || 6,
      sections: { ...DEFAULT_SECTIONS, ...(r.sections || {}) }, dayNightCutoff: r.day_night_cutoff || 19, lateAfterMin: r.late_after_min || 5,
      sectionList: SECTIONS.map(([key, label]) => ({ key, label })),
    };
  });
}

// Owner sets enabled / sections / cutoff / late; the manager sets channel
// and hour. Texts need the person's own SMS consent (patch_067).
async function setSettings(personId, body, { byOwner, self, updatedBy } = {}) {
  const b = body || {};
  return withServiceClient(async (svc) => {
    const { rows: cur } = await svc.query('SELECT * FROM morning_summary_settings WHERE person_id = $1', [personId]);
    const c = cur[0] || {};
    let enabled = c.enabled === true; let sections = c.sections || {}; let cutoff = c.day_night_cutoff || 19; let late = c.late_after_min || 5;
    let channel = c.channel || 'email'; let hour = c.send_hour || 6;
    if (byOwner) {
      if (b.enabled !== undefined) enabled = !!b.enabled;
      if (b.sections && typeof b.sections === 'object') { sections = { ...sections }; for (const [k, v] of Object.entries(b.sections)) if (DEFAULT_SECTIONS[k] !== undefined) sections[k] = !!v; }
      if (b.dayNightCutoff !== undefined) { const n = Number(b.dayNightCutoff); if (!(n >= 12 && n <= 23)) return { ok: false, error: 'Pick a cutoff between noon and 11 PM.' }; cutoff = n; }
      if (b.lateAfterMin !== undefined) { const n = Number(b.lateAfterMin); if (!(n >= 1 && n <= 60)) return { ok: false, error: 'Late clock-in must be 1 to 60 minutes.' }; late = n; }
    }
    if (byOwner || self) {
      if (b.channel !== undefined) {
        if (!['email', 'sms', 'both'].includes(b.channel)) return { ok: false, error: 'Pick email, text or both.' };
        if (b.channel !== 'email') {
          const { rows: ns } = await svc.query('SELECT mns.sms_consent_at, mns.sms_consent_phone, p.phone FROM people p LEFT JOIN monitoring_notify_settings mns ON mns.person_id = p.id WHERE p.id = $1', [personId]);
          const n = ns[0] || {};
          if (!n.phone) return { ok: false, error: self ? 'Add your mobile number under My Account first.' : 'This person has no mobile number on file.' };
          if (!n.sms_consent_at || n.sms_consent_phone !== n.phone) return { ok: false, error: self ? 'Tick the text alerts consent box under My alert settings first, then come back.' : 'This person has not agreed to text alerts yet.' };
        }
        channel = b.channel;
      }
      if (b.sendHour !== undefined) { const n = Number(b.sendHour); if (!(n >= 5 && n <= 9)) return { ok: false, error: 'Pick a time between 5 and 9 AM.' }; hour = n; }
    }
    await svc.query(
      `INSERT INTO morning_summary_settings (person_id, enabled, channel, send_hour, sections, day_night_cutoff, late_after_min, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,now())
       ON CONFLICT (person_id) DO UPDATE SET enabled = $2, channel = $3, send_hour = $4, sections = $5::jsonb, day_night_cutoff = $6, late_after_min = $7, updated_by = $8, updated_at = now()`,
      [personId, enabled, channel, hour, JSON.stringify(sections), cutoff, late, updatedBy || null]);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- data
// Sales for one business date: the day's last SpotOn snapshot, plus the
// snapshot at the day/night cutoff so the two halves can be split.
async function salesFor(svc, locId, ymd, tz, cutoffHour) {
  const { rows: last } = await svc.query('SELECT food_net, total_net, at FROM kb_sales_snapshots WHERE location_id = $1 AND business_date = $2 AND total_net IS NOT NULL ORDER BY at DESC LIMIT 1', [locId, ymd]);
  if (!last[0]) return null;
  const cutoff = zonedToUtc(ymd, `${String(cutoffHour).padStart(2, '0')}:00`, tz);
  const { rows: atCut } = await svc.query('SELECT food_net, total_net FROM kb_sales_snapshots WHERE location_id = $1 AND business_date = $2 AND total_net IS NOT NULL AND at <= $3 ORDER BY at DESC LIMIT 1', [locId, ymd, cutoff]);
  const f = last[0]; const c = atCut[0] || null;
  const total = num(f.total_net); const food = f.food_net == null ? null : num(f.food_net);
  const bar = food == null ? null : Math.max(0, total - food);
  const dTotal = c ? num(c.total_net) : 0; const dFood = c && c.food_net != null ? num(c.food_net) : (food == null ? null : 0);
  const dBar = dFood == null ? null : Math.max(0, dTotal - dFood);
  const split = !!c;
  return {
    total, food, bar,
    day: split ? { total: dTotal, food: dFood, bar: dBar } : { total: null, food: null, bar: null },
    night: split ? { total: Math.max(0, total - dTotal), food: food == null || dFood == null ? null : Math.max(0, food - dFood), bar: bar == null || dBar == null ? null : Math.max(0, bar - dBar) } : { total: null, food: null, bar: null },
    hadCutoff: split,
  };
}
function sideOf(sales, side) {
  if (!sales) return null;
  const k = side === 'kitchen' ? 'food' : 'bar';
  if (sales[k] == null) return null;
  return { total: sales[k], day: sales.day[k], night: sales.night[k] };
}
function avgOf(list, pick) { const v = list.map(pick).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

// Hourly food/total per hour for a business date, from snapshot deltas.
async function hourlyFor(svc, locId, ymd, tz, fromH, toH) {
  const { rows } = await svc.query('SELECT at, food_net, total_net FROM kb_sales_snapshots WHERE location_id = $1 AND business_date = $2 ORDER BY at', [locId, ymd]);
  if (!rows.length) return null;
  const snaps = rows.map((r) => ({ at: new Date(r.at), food: r.food_net == null ? null : num(r.food_net), total: num(r.total_net) }));
  const at = (t, k) => { const x = [...snaps].reverse().find((q) => q.at <= t && q[k] != null); return x ? x[k] : null; };
  const out = [];
  for (let h = fromH; h < toH; h++) {
    const start = zonedToUtc(ymd, `${String(h % 24).padStart(2, '0')}:00`, tz); if (h >= 24) start.setUTCDate(start.getUTCDate() + 1);
    const end = new Date(start.getTime() + 3600000);
    const f0 = at(start, 'food'); const f1 = at(end, 'food'); const t0 = at(start, 'total'); const t1 = at(end, 'total');
    out.push({ h, food: f0 != null && f1 != null ? Math.max(0, f1 - f0) : null, bar: f0 != null && f1 != null && t0 != null && t1 != null ? Math.max(0, (t1 - f1) - (t0 - f0)) : null });
  }
  return out;
}

async function shiftsFor(svc, locId, ymd, side) {
  const { rows } = await svc.query(
    `SELECT sh.start_time, sh.end_time, p.name AS person_name, s.name AS schedule_name, pos.name AS position_name
     FROM shifts sh JOIN people p ON p.id = sh.person_id JOIN schedules s ON s.id = sh.schedule_id LEFT JOIN positions pos ON pos.id = sh.position_id
     WHERE s.location_id = $1 AND sh.shift_date = $2 AND sh.status = 'scheduled' ORDER BY sh.start_time, p.name`, [locId, ymd]);
  return rows.filter((r) => (/kitchen|cook|dish/i.test(r.schedule_name || '') || /cook|dish|kitchen/i.test(r.position_name || '')) === (side === 'kitchen'))
    .map((r) => ({ name: r.person_name, key: nameKey(r.person_name), position: r.position_name || '', start: String(r.start_time).slice(0, 5), end: String(r.end_time).slice(0, 5) }));
}

// Build everything one manager needs for one bar. `sides` is ['bar'],
// ['kitchen'] or both.
async function buildModel(svc, { person, location, sides, settings, now }) {
  const tz = location.timezone || DEFAULT_TZ;
  const kb = await kitchenboard.settingsFor(svc, location.id);
  const p = partsIn(now, tz);
  const today = p.ymd; const yday = ymdAddDays(today, -1);
  const cutoff = settings.dayNightCutoff;
  const kitchenRoles = (kb.kitchen_roles || []).map((r) => String(r).toLowerCase());
  const isKitchenRole = (role) => kitchenRoles.includes(String(role || '').toLowerCase());
  const dayStart = (ymd) => zonedToUtc(ymd, `${String(kb.day_start_hour || 4).padStart(2, '0')}:00`, tz);
  const ydayStart = dayStart(yday); const todayStart = dayStart(today);
  const model = { personName: person.name, location: location.name, locationId: location.id, tz, today, yday, sides, cutoff, sections: settings.sections, needs: {}, by: {}, systems: null, games: [], generatedAt: now.toISOString() };

  // ---- sales, per side ------------------------------------------------
  const ySales = await salesFor(svc, location.id, yday, tz, cutoff);
  const lastWeek = await salesFor(svc, location.id, ymdAddDays(yday, -7), tz, cutoff);
  const yHist = []; for (let i = 1; i <= 4; i++) yHist.push(await salesFor(svc, location.id, ymdAddDays(yday, -7 * i), tz, cutoff));
  const tHist = []; for (let i = 1; i <= 4; i++) tHist.push(await salesFor(svc, location.id, ymdAddDays(today, -7 * i), tz, cutoff));
  const { rows: punches } = await svc.query('SELECT full_name, role_name, clock_in, clock_out, is_clocked_out, labor_total FROM kb_punches WHERE location_id = $1 AND business_date = $2', [location.id, yday]);
  const { rows: lastWeekPunch } = await svc.query('SELECT role_name, labor_total FROM kb_punches WHERE location_id = $1 AND business_date = $2', [location.id, ymdAddDays(yday, -7)]);

  for (const side of sides) {
    const s = sideOf(ySales, side); const lw = sideOf(lastWeek, side);
    const hist = yHist.map((h) => sideOf(h, side));
    const labor = punches.filter((q) => isKitchenRole(q.role_name) === (side === 'kitchen')).reduce((a, q) => a + num(q.labor_total), 0);
    const lwLabor = lastWeekPunch.filter((q) => isKitchenRole(q.role_name) === (side === 'kitchen')).reduce((a, q) => a + num(q.labor_total), 0);
    const yesterday = {
      sales: s ? { total: s.total, day: s.day, night: s.night, lastWeek: lw ? lw.total : null, avg4: avgOf(hist, (x) => x && x.total), avgDay: avgOf(hist, (x) => x && x.day), avgNight: avgOf(hist, (x) => x && x.night) } : null,
      labor: punches.length ? { dollars: labor, pct: s && s.total > 0 ? labor / s.total * 100 : null, lastWeekPct: lw && lw.total > 0 && lastWeekPunch.length ? lwLabor / lw.total * 100 : null } : null,
      cost: null, // liquor / food cost: needs inventory counts and purchases (coming)
    };
    const th = tHist.map((h) => sideOf(h, side));
    const projected = th.some(Boolean) ? { total: avgOf(th, (x) => x && x.total), day: avgOf(th, (x) => x && x.day), night: avgOf(th, (x) => x && x.night) } : null;
    const shifts = await shiftsFor(svc, location.id, today, side);
    model.by[side] = { yesterday, today: { projected, shifts } };
  }

  // ---- drawers (bar) ----------------------------------------------------
  if (sides.includes('bar')) {
    const { rows: th } = await svc.query('SELECT alert_threshold FROM cash_shift_settings WHERE id');
    const threshold = th[0] ? num(th[0].alert_threshold) : 5;
    const { rows: counts } = await svc.query(
      `SELECT cc.variance, cc.counted_amount, cc.counted_at, cs.name AS source_name, p.name AS counted_by_name, ob.name AS behalf_name
       FROM cash_counts cc JOIN cash_sources cs ON cs.id = cc.source_id JOIN people p ON p.id = cc.counted_by LEFT JOIN people ob ON ob.id = cc.on_behalf_of
       WHERE cs.location_id = $1 AND cs.kind = 'drawer' AND cc.context = 'cash_out' AND cc.counted_at >= $2 AND cc.counted_at < $3 ORDER BY cc.counted_at`, [location.id, ydayStart, todayStart]);
    const { rows: deposits } = await svc.query(`SELECT amount FROM cash_transactions WHERE location_id = $1 AND type = 'deposit' AND performed_at >= $2 AND performed_at < $3`, [location.id, ydayStart, todayStart]);
    const drawers = counts.map((c) => ({ name: c.source_name, variance: num(c.variance), who: shortName(c.behalf_name || c.counted_by_name), at: fmtTime(c.counted_at, tz) }));
    model.by.bar.yesterday.drawers = counts.length || deposits.length ? { list: drawers, short: drawers.filter((d) => d.variance <= -threshold), threshold, deposit: deposits.length ? deposits.reduce((a, d) => a + num(d.amount), 0) : null } : null;
    model.needs.drawerShort = drawers.filter((d) => d.variance <= -threshold);
  }

  // ---- clock, per side -------------------------------------------------
  const lateMin = settings.lateAfterMin;
  for (const side of sides) {
    const flags = [];
    const shifts = await shiftsFor(svc, location.id, yday, side);
    const mine = punches.filter((q) => isKitchenRole(q.role_name) === (side === 'kitchen'));
    for (const q of mine) {
      const key = nameKey(q.full_name);
      const sh = shifts.find((x) => x.key === key && Math.abs(zonedToUtc(yday, x.start, tz) - new Date(q.clock_in)) < 6 * 3600000);
      if (sh) {
        const lateBy = (new Date(q.clock_in) - zonedToUtc(yday, sh.start, tz)) / 60000;
        if (lateBy > lateMin) flags.push({ kind: 'late', text: `${shortName(q.full_name)} in ${fmtTime(q.clock_in, tz)} for ${fmtHm(sh.start)} (${Math.round(lateBy)} min late)` });
      }
      if (!q.clock_out && !q.is_clocked_out) flags.push({ kind: 'missed', text: `${shortName(q.full_name)} ${sh ? `${fmtHm(sh.start)}–${fmtHm(sh.end)}` : 'yesterday'}, missed clock out: clock out time needs adjusted` });
    }
    model.by[side].yesterday.clock = { flags, hasPunches: mine.length > 0, hasSchedule: shifts.length > 0 };
  }
  // Bar Ops' own time clock: missed clock-outs and the fixes managers made
  // in the last day (who, when, to what).
  const { rows: openEntries } = await svc.query(
    `SELECT p.name FROM time_entries te JOIN people p ON p.id = te.person_id WHERE te.location_id = $1 AND te.clock_out IS NULL AND te.clock_in >= $2 AND te.clock_in < $3`, [location.id, ydayStart, todayStart]);
  const { rows: edits } = await svc.query(
    `SELECT pe.edited_at, pe.new_values, pe.old_values, ed.name AS editor, p.name AS person FROM punch_edits pe JOIN time_entries te ON te.id = pe.time_entry_id JOIN people ed ON ed.id = pe.edited_by JOIN people p ON p.id = te.person_id
     WHERE te.location_id = $1 AND pe.edited_at >= now() - interval '24 hours' ORDER BY pe.edited_at`, [location.id]);
  const timeclock = [];
  for (const e of openEntries) timeclock.push({ kind: 'missed', text: `${shortName(e.name)}, missed clock out: clock out time needs adjusted` });
  for (const e of edits) {
    const nv = e.new_values || {}; const ov = e.old_values || {};
    const what = nv.clock_out && nv.clock_out !== ov.clock_out ? `clock out set to ${fmtTime(nv.clock_out, tz)}` : nv.clock_in && nv.clock_in !== ov.clock_in ? `clock in set to ${fmtTime(nv.clock_in, tz)}` : 'punch edited';
    timeclock.push({ kind: 'fixed', text: `${shortName(e.person)}: ${what} by ${shortName(e.editor)} ${fmtShort(partsIn(new Date(e.edited_at), tz).ymd)} ${fmtTime(e.edited_at, tz)}` });
  }
  if (timeclock.length) for (const side of sides) model.by[side].yesterday.clock.flags.push(...timeclock);

  // ---- needs you --------------------------------------------------------
  const zoneOk = (z, side) => !z || z === 'both' || z === side;
  const { rows: calls } = await svc.query(
    `SELECT sc.id, sc.description, sc.created_at, sc.status, sc.zone, et.name AS equipment, sc.equipment_other,
            (SELECT n.note FROM service_call_notes n WHERE n.call_id = sc.id ORDER BY n.created_at DESC LIMIT 1) AS last_note,
            (SELECT n.created_at FROM service_call_notes n WHERE n.call_id = sc.id ORDER BY n.created_at DESC LIMIT 1) AS last_note_at
     FROM service_calls sc LEFT JOIN equipment_types et ON et.id = sc.equipment_type_id
     WHERE sc.location_id = $1 AND sc.status <> 'closed' ORDER BY sc.created_at`, [location.id]);
  model.needs.calls = calls.filter((c) => sides.some((s) => zoneOk(c.zone, s))).map((c) => ({
    what: c.equipment || c.equipment_other || c.description.slice(0, 60), description: c.description, ageDays: Math.floor((now - new Date(c.created_at)) / 86400000),
    lastNote: c.last_note || null, lastNoteDays: c.last_note_at ? Math.floor((now - new Date(c.last_note_at)) / 86400000) : null, working: c.status === 'pending', zone: c.zone || null,
  }));
  const { rows: apps } = await svc.query(
    `SELECT p.name, p.position, p.created_at, p.department FROM people p WHERE p.status = 'pending_review'
       AND (p.location_id = $1 OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.person_id = p.id AND el.location_id = $1)) ORDER BY p.created_at`, [location.id]);
  model.needs.applicants = apps.filter((a) => sides.some((s) => zoneOk(a.department, s))).map((a) => ({ name: a.name, position: a.position || '', waiting: ago(now - new Date(a.created_at)) }));
  model.needs.stock = []; // inventory counts: coming

  // ---- systems ----------------------------------------------------------
  const { rows: sys } = await svc.query(
    `SELECT ms.id, ms.name, ms.kind, ms.category, ss.status, ss.checked_at, ss.detail
     FROM monitored_systems ms
     LEFT JOIN LATERAL (SELECT status, checked_at, detail FROM system_status s WHERE s.system_id = ms.id ORDER BY checked_at DESC LIMIT 1) ss ON true
     WHERE ms.location_id = $1 AND ms.active = true`, [location.id]);
  const fresh = (r) => r.checked_at && now - new Date(r.checked_at) < 15 * 60 * 1000;
  const wans = sys.filter((r) => ['unifi_wan', 'fiber_wan', 'cable_wan', 'cell_wan', 'unifi_gateway'].includes(r.kind));
  const gateway = sys.find((r) => r.kind === 'unifi_gateway');
  const { rows: wanAlerts } = wans.length ? await svc.query(
    `SELECT sa.opened_at, sa.closed_at, ms.name FROM system_alerts sa JOIN monitored_systems ms ON ms.id = sa.system_id
     WHERE sa.system_id = ANY($1::uuid[]) AND sa.status = 'offline' AND (sa.closed_at IS NULL OR sa.closed_at >= now() - interval '24 hours') ORDER BY sa.opened_at`, [wans.map((w) => w.id)]) : { rows: [] };
  const internetDown = wanAlerts.map((a) => ({ from: fmtTime(a.opened_at, tz), to: a.closed_at ? fmtTime(a.closed_at, tz) : null, minutes: Math.round(((a.closed_at ? new Date(a.closed_at) : now) - new Date(a.opened_at)) / 60000), what: a.name }));
  const wanRow = wans.find((r) => r.detail && (r.detail.latency_ms != null || r.detail.download_mbps != null)) || null;
  const polled = wans.filter((w) => w.status);
  const internet = polled.length ? {
    up: gateway && gateway.status ? gateway.status !== 'offline' : polled.some((w) => w.status !== 'offline'),
    stale: !polled.some(fresh),
    latencyMs: wanRow && wanRow.detail.latency_ms != null ? Number(wanRow.detail.latency_ms) : null,
    down: wanRow && wanRow.detail.download_mbps ? Number(wanRow.detail.download_mbps) : null, upMbps: wanRow && wanRow.detail.upload_mbps ? Number(wanRow.detail.upload_mbps) : null,
    outages: internetDown,
  } : null;
  const receivers = sys.filter((r) => r.kind === 'vc_source' && r.status);
  const music = sys.find((r) => r.kind === 'vc_music') || null;
  const { rows: musicAlert } = music ? await svc.query('SELECT opened_at FROM system_alerts WHERE system_id = $1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1', [music.id]) : { rows: [] };
  model.systems = {
    internet,
    receivers: receivers.length ? { total: receivers.length, up: receivers.filter((r) => r.status === 'online').length, down: receivers.filter((r) => r.status !== 'online').map((r) => r.name) } : null,
    music: music ? { up: music.status === 'online', name: music.name, message: music.detail && music.detail.message ? String(music.detail.message) : null, downSince: musicAlert[0] ? fmtTime(musicAlert[0].opened_at, tz) : null } : null,
  };
  model.needs.internetDown = internetDown;

  // ---- coolers: 24 hourly points per probe, per side ----------------------
  for (const side of sides) {
    const { rows: probes } = await svc.query(`SELECT probe_id, display_name, high_c, low_c, state FROM sensor_probes WHERE location_id = $1 AND area = $2 AND assigned AND active ORDER BY sort_order, display_name`, [location.id, side]);
    if (!probes.length) { model.by[side].coolers = null; continue; }
    const end = new Date(now); end.setUTCMinutes(0, 0, 0);
    const start = new Date(end.getTime() - 24 * 3600000);
    const { rows: hrs } = await svc.query('SELECT probe_id, hour, sum_c, n FROM sensor_hourly WHERE probe_id = ANY($1::text[]) AND hour >= $2 AND hour < $3', [probes.map((q) => q.probe_id), start, end]);
    const series = probes.map((q) => {
      const v = [];
      for (let i = 0; i < 24; i++) {
        const h = new Date(start.getTime() + i * 3600000);
        const r = hrs.find((x) => x.probe_id === q.probe_id && new Date(x.hour).getTime() === h.getTime());
        v.push(r && num(r.n) ? cToF(num(r.sum_c) / num(r.n)) : null);
      }
      return { name: q.display_name, v, limitF: cToF(q.high_c), state: q.state };
    });
    const labels = []; for (let i = 0; i < 24; i++) labels.push(hourLabel(partsIn(new Date(start.getTime() + i * 3600000), tz).hour));
    const over = [];
    for (const s of series) {
      const idx = s.v.map((t, i) => (t != null && t > s.limitF ? i : -1)).filter((i) => i >= 0);
      if (idx.length) over.push({ name: s.name, from: labels[idx[0]], to: labels[Math.min(23, idx[idx.length - 1] + 1)], peak: Math.max(...idx.map((i) => s.v[i])), limit: s.limitF });
    }
    model.by[side].coolers = { series, labels, over, inRange: probes.filter((q) => q.state === 'normal').length, total: probes.length };
  }

  // ---- big games (pushed by the bar's box) -----------------------------
  const { rows: siteRows } = await svc.query('SELECT big_games FROM vc_sites WHERE location_id = $1 LIMIT 1', [location.id]);
  const bg = siteRows[0] && Array.isArray(siteRows[0].big_games) ? siteRows[0].big_games : [];
  model.games = bg.filter((g) => g && g.start && partsIn(new Date(g.start), tz).ymd === today).map((g) => {
    const st = new Date(g.start); const h = partsIn(st, tz);
    return { name: g.name || `${g.away} at ${g.home}`, league: g.league || '', time: fmtTime(st, tz), startH: h.hour + h.minute / 60, network: g.network || null, channel: g.channel || null, durationH: g.league === 'nfl' || g.league === 'ncaaf' ? 3.25 : 3 };
  }).sort((a, b) => a.startH - b.startH);

  // ---- kitchen timeline: projected food per hour vs who is on -------------
  if (sides.includes('kitchen')) {
    const curves = [];
    for (let i = 1; i <= 4; i++) { const c = await hourlyFor(svc, location.id, ymdAddDays(today, -7 * i), tz, 10, 26); if (c) curves.push(c); }
    const hours = [];
    for (let h = 10; h < 26; h++) hours.push({ h, food: curves.length ? avgOf(curves, (c) => { const x = c.find((q) => q.h === h); return x ? x.food : null; }) : null });
    model.by.kitchen.timeline = { hours, shifts: model.by.kitchen.today.shifts, games: model.games, haveCurves: curves.length };
  }
  return model;
}

// ---------------------------------------------------------------- charts
const PALETTE = ['#2458c7', '#1f8a4c', '#8a5fcf', '#d97706', '#c0392b', '#0e9aa7'];
function coolerSvg(c) {
  const W = 640, H = 220, L = 44, R = 12, T = 14, B = 30;
  const all = c.series.flatMap((s) => s.v).filter((v) => v != null);
  const limit = Math.max(...c.series.map((s) => s.limitF || 40));
  let lo = Math.floor((Math.min(...all, limit) - 4) / 5) * 5; let hi = Math.ceil((Math.max(...all, limit) + 4) / 5) * 5; if (hi - lo < 15) hi = lo + 15;
  const x = (i) => L + (i / 23) * (W - L - R); const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}"><rect width="${W}" height="${H}" fill="#ffffff"/>`;
  for (let v = lo; v <= hi; v += 5) out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e6ec"/><text x="${L - 6}" y="${y(v) + 4}" font-size="11" text-anchor="end" fill="#5c6577">${v}°</text>`;
  out += `<line x1="${L}" x2="${W - R}" y1="${y(limit)}" y2="${y(limit)}" stroke="#c0392b" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  for (let i = 0; i < 24; i += 3) out += `<text x="${x(i)}" y="${H - 10}" font-size="11" text-anchor="middle" fill="#5c6577">${c.labels[i]}</text>`;
  c.series.forEach((s, k) => {
    const col = PALETTE[k % PALETTE.length]; let d = ''; let pen = false;
    s.v.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen = true; });
    out += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round"/>`;
    const lastIdx = s.v.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0).pop();
    if (lastIdx != null) out += `<circle cx="${x(lastIdx)}" cy="${y(s.v[lastIdx])}" r="3.5" fill="${col}"/>`;
  });
  return out + '</svg>';
}
function timelineSvg(t) {
  const W = 640, L = 48, R = 14, H0 = 10, H1 = 26;
  const x = (h) => L + ((h - H0) / (H1 - H0)) * (W - L - R);
  const games = t.games.map((g, i) => ({ ...g, c: PALETTE[(i + 1) % PALETTE.length] }));
  const staff = t.shifts.map((s, i) => { const [sh, sm] = s.start.split(':').map(Number); const [eh, em] = s.end.split(':').map(Number); let from = sh + sm / 60; let to = eh + em / 60; if (to <= from) to += 24; return { name: shortName(s.name), from: Math.max(H0, from), to: Math.min(H1, to), c: PALETTE[i % PALETTE.length] }; }).filter((s) => s.to > s.from);
  const gTop = 8, gRowH = 18, gGap = 4; const gBottom = gTop + Math.max(1, games.length) * (gRowH + gGap);
  const cTop = gBottom + 12, cH = 120, cBottom = cTop + cH; const axisY = cBottom + 16; const sTop = axisY + 14, sRowH = 18, sGap = 4;
  const H = sTop + Math.max(1, staff.length) * (sRowH + sGap) + 6;
  const maxFood = Math.max(100, ...t.hours.map((h) => h.food || 0)); const top = Math.ceil(maxFood / 100) * 100;
  const ys = (v) => cTop + (1 - v / top) * cH;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}"><rect width="${W}" height="${H}" fill="#ffffff"/>`;
  for (let h = H0; h <= H1; h++) { const major = (h - H0) % 2 === 0; out += `<line x1="${x(h)}" x2="${x(h)}" y1="${gTop}" y2="${H - 6}" stroke="${major ? '#e3e6ec' : '#f1f3f6'}"/>`; if (major) out += `<text x="${x(h)}" y="${axisY}" font-size="11" text-anchor="middle" fill="#5c6577">${hourLabel(h)}</text>`; }
  out += `<text x="${L - 6}" y="${gTop + 13}" font-size="10" text-anchor="end" fill="#5c6577" font-weight="bold">GAMES</text>`;
  if (!games.length) out += `<text x="${L + 6}" y="${gTop + 13}" font-size="11" fill="#9aa3b2">none for My Teams today</text>`;
  games.forEach((g, i) => { const y = gTop + i * (gRowH + gGap); const from = Math.max(H0, g.startH); const label = `${g.time} ${g.name}${g.network ? ' · ' + g.network : ''}`; const minW = label.length * 6.6 + 12; let to = Math.min(H1, g.startH + g.durationH); if (x(to) - x(from) < minW) to = Math.min(H1, from + minW / ((W - L - R) / (H1 - H0))); if (to <= from) return; out += `<rect x="${x(from)}" y="${y}" width="${x(to) - x(from)}" height="${gRowH}" rx="4" fill="${g.c}" fill-opacity="0.18" stroke="${g.c}" stroke-width="1.2"/><text x="${x(from) + 6}" y="${y + 13}" font-size="11" font-weight="bold" fill="${g.c}">${esc(g.time)} ${esc(g.name)}${g.network ? ' · ' + esc(g.network) : ''}</text>`; });
  for (let v = 0; v <= top; v += top / 2) out += `<line x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}" stroke="#e3e6ec"/><text x="${L - 6}" y="${ys(v) + 4}" font-size="11" text-anchor="end" fill="#5c6577">$${Math.round(v)}</text>`;
  if (t.haveCurves) {
    const pts = t.hours.filter((h) => h.food != null).map((h) => `${x(h.h + 0.5).toFixed(1)},${ys(h.food).toFixed(1)}`);
    if (pts.length) { out += `<path d="M${pts.join(' L')} L${x(H1)},${ys(0)} L${x(H0)},${ys(0)} Z" fill="#2458c7" fill-opacity="0.08"/><path d="M${pts.join(' L')}" fill="none" stroke="#2458c7" stroke-width="2.4" stroke-linejoin="round"/>`; }
    out += `<text x="${x(H0) + 6}" y="${cTop + 12}" font-size="11" fill="#2458c7" font-weight="bold">projected food $/hr (last 4 ${'same weekdays'})</text>`;
  } else out += `<text x="${x(H0) + 6}" y="${cTop + cH / 2}" font-size="11" fill="#9aa3b2">no sales history for this weekday yet</text>`;
  out += `<text x="${L - 6}" y="${sTop + 13}" font-size="10" text-anchor="end" fill="#5c6577" font-weight="bold">ON</text>`;
  if (!staff.length) out += `<text x="${L + 6}" y="${sTop + 13}" font-size="11" fill="#9aa3b2">no kitchen shifts scheduled today</text>`;
  staff.forEach((s, i) => { const y = sTop + i * (sRowH + sGap); out += `<rect x="${x(s.from)}" y="${y}" width="${x(s.to) - x(s.from)}" height="${sRowH}" rx="4" fill="${s.c}" fill-opacity="0.85"/><text x="${x(s.from) + 6}" y="${y + 13}" font-size="11" font-weight="bold" fill="#ffffff">${esc(s.name)} ${hourLabel(Math.floor(s.from))}–${hourLabel(Math.floor(s.to))}</text>`; });
  return out + '</svg>';
}
function chartSvg(model, name) {
  if (name === 'coolers-bar' && model.by.bar && model.by.bar.coolers) return coolerSvg(model.by.bar.coolers);
  if (name === 'coolers-kitchen' && model.by.kitchen && model.by.kitchen.coolers) return coolerSvg(model.by.kitchen.coolers);
  if (name === 'timeline' && model.by.kitchen && model.by.kitchen.timeline) return timelineSvg(model.by.kitchen.timeline);
  return null;
}
function chartPng(model, name) {
  const svg = chartSvg(model, name);
  if (!svg || !Resvg) return null;
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: 1280 }, font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT } });
  return Buffer.from(r.render().asPng());
}

// ---------------------------------------------------------------- email
function sideLabel(side) { return side === 'kitchen' ? 'kitchen' : 'bar'; }
function renderHtml(model, { base, token, test }) {
  const S = model.sections; const h = [];
  const H3 = (t, sub) => `<h3 style="font-family:Arial Narrow,Arial,sans-serif;font-size:20px;letter-spacing:.02em;text-transform:uppercase;color:#2a3140;margin:0 0 6px;">${esc(t)}${sub ? ` <span style="font-family:Arial,sans-serif;font-size:13px;text-transform:none;letter-spacing:0;color:#5c6577;font-weight:normal;margin-left:8px;">${esc(sub)}</span>` : ''}</h3>`;
  const H4 = (t) => `<div style="font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#9a5b00;margin:10px 0 3px;">${esc(t)}</div>`;
  const row = (l, v, d, sub) => `<tr><td style="padding:3px 0;white-space:nowrap;color:${sub ? '#5c6577' : '#1b1f27'};${sub ? 'padding-left:16px;' : ''}">${l}</td><td style="padding:3px 10px;text-align:right;font-weight:${sub ? '600' : 'bold'};white-space:nowrap;">${v}</td><td style="padding:3px 0;text-align:right;color:#5c6577;font-size:13px;">${d || ''}</td></tr>`;
  const ul = (items) => `<ul style="margin:0;padding-left:20px;">${items.map((i) => `<li style="margin:3px 0;">${i}</li>`).join('')}</ul>`;
  const up = (a, b) => { if (a == null || !b) return ''; const d = (a - b) / b * 100; return `<span style="color:${d >= 0 ? '#1f8a4c' : '#c0392b'};">${d >= 0 ? '+' : ''}${Math.round(d)}%</span>`; };
  const block = (inner) => `<div style="margin:0 0 18px;">${inner}</div>`;

  // needs you
  const N = model.needs; const needs = [];
  if (N.calls && N.calls.length) needs.push(H4('Open service calls') + ul(N.calls.map((c) => `<b>${esc(c.what)}.</b> Open ${c.ageDays} day${c.ageDays === 1 ? '' : 's'}${c.working ? ', being worked' : ''}. ${c.lastNote ? `Last note${c.lastNoteDays ? ` ${c.lastNoteDays}d ago` : ''}: ${esc(c.lastNote)}` : 'No notes yet.'}`)));
  if (N.applicants && N.applicants.length) needs.push(H4('Applicants') + ul([`<b>${N.applicants.length} waiting for review:</b> ${N.applicants.map((a) => `${esc(a.name)}${a.position ? ', ' + esc(a.position) : ''}, waiting ${a.waiting}`).join(' · ')}`]));
  if (N.stock && N.stock.length) needs.push(H4('Stock') + ul(N.stock.map((s) => esc(s))));
  const alerts = [];
  for (const d of N.drawerShort || []) alerts.push(`<b>${esc(d.name)} short $${Math.abs(d.variance).toFixed(2)}</b> at close (${esc(d.who)}). Over the $${N.calls ? '' : ''}${model.by.bar && model.by.bar.yesterday.drawers ? model.by.bar.yesterday.drawers.threshold : 5} line.`);
  for (const o of N.internetDown || []) alerts.push(o.to ? `<b>Internet was down</b> ${o.from} to ${o.to} (${o.minutes} min). Up since.` : `<b>Internet is down</b> since ${o.from} (${o.minutes} min).`);
  if (alerts.length) needs.push(H4('Alerts') + ul(alerts));
  h.push(`<div style="background:#fff4e5;border:1px solid #ffd59a;border-radius:10px;padding:12px 14px;margin:0 0 18px;">${H3('Needs you').replace('#2a3140', '#9a5b00')}${needs.length ? needs.join('') : '<div style="color:#5c6577;">Nothing waiting on you this morning.</div>'}</div>`);

  for (const side of model.sides) {
    const B = model.by[side]; const Y = B.yesterday; const T = B.today;
    const rows = [];
    if (S.sales) {
      if (Y.sales) {
        rows.push(row(`${side === 'kitchen' ? 'Food' : 'Bar'} sales`, money(Y.sales.total), `${up(Y.sales.total, Y.sales.lastWeek)} vs last ${weekdayShort(model.yday)} ${money(Y.sales.lastWeek)} · 4-wk ${weekdayShort(model.yday)} avg ${money(Y.sales.avg4)}`));
        if (Y.sales.day != null) {
          rows.push(row(`Day, open to ${hourLabel(model.cutoff)}`, money(Y.sales.day), Y.sales.avgDay != null ? `4-wk ${money(Y.sales.avgDay)}` : '', true));
          rows.push(row(`Night, ${hourLabel(model.cutoff)} to close`, money(Y.sales.night), Y.sales.avgNight != null ? `4-wk ${money(Y.sales.avgNight)}` : '', true));
        }
      } else rows.push(row(`${side === 'kitchen' ? 'Food' : 'Bar'} sales`, '—', 'no SpotOn snapshot for yesterday'));
    }
    if (S.cost) rows.push(row(side === 'kitchen' ? 'Food cost' : 'Liquor cost', '—', 'no inventory count yet'));
    if (S.labor) rows.push(Y.labor ? row(`${side === 'kitchen' ? 'Kitchen' : 'Bar'} labor`, pct(Y.labor.pct), `${money(Y.labor.dollars)}${Y.labor.lastWeekPct != null ? ` · last ${weekdayShort(model.yday)} ${pct(Y.labor.lastWeekPct)}` : ''}`) : row('Labor', '—', 'no punches for yesterday'));
    if (S.drawers && side === 'bar') {
      const D = Y.drawers;
      rows.push(D ? row('Drawers', D.short.length ? `${D.short.length} short` : 'All even', `${D.list.map((d) => `${esc(d.name)} ${d.variance >= 0 ? '+' : '−'}$${Math.abs(d.variance).toFixed(2)}`).join(' · ')}${D.deposit != null ? ` · deposit ${money(D.deposit)} logged` : ' · no deposit logged'}`) : row('Drawers', '—', 'no cash-out counts yesterday'));
    }
    if (S.clock) {
      const C = Y.clock;
      rows.push(C.flags.length ? row('Clock', `${C.flags.length} flag${C.flags.length === 1 ? '' : 's'}`, C.flags.map((f) => esc(f.text)).join(' · ')) : row('Clock', C.hasPunches ? 'Clean' : '—', C.hasPunches ? (C.hasSchedule ? 'no late or missed punches' : 'no schedule to compare against') : 'no punches for yesterday'));
    }
    if (rows.length) h.push(block(H3(`Yesterday${model.sides.length > 1 ? `, ${sideLabel(side)}` : ''}`, fmtDate(model.yday)) + `<table style="border-collapse:collapse;width:100%;font-size:15px;">${rows.join('')}</table>`));

    const todayRows = [];
    if (S.projected) {
      todayRows.push(T.projected ? row(`Projected ${side === 'kitchen' ? 'food' : 'bar'} sales`, money(T.projected.total), `4-wk ${weekdayShort(model.today)} avg${model.games.length ? `, ${model.games.length} game${model.games.length === 1 ? '' : 's'} tonight` : ''}`) : row('Projected sales', '—', 'no history for this weekday yet'));
      if (T.projected && T.projected.day != null) { todayRows.push(row(`Day, open to ${hourLabel(model.cutoff)}`, money(T.projected.day), '', true)); todayRows.push(row(`Night, ${hourLabel(model.cutoff)} to close`, money(T.projected.night), '', true)); }
    }
    let shiftsHtml = '';
    if (S.shifts) shiftsHtml = T.shifts.length ? `<table style="border-collapse:collapse;font-size:15px;margin-top:8px;">${T.shifts.map((s) => `<tr><td style="padding:2px 12px 2px 0;font-weight:bold;white-space:nowrap;">${fmtHm(s.start)} – ${fmtHm(s.end)}</td><td style="padding:2px 0;">${esc(s.name)}${s.position ? `, ${esc(s.position.toLowerCase())}` : ''}</td></tr>`).join('')}</table>` : `<div style="color:#5c6577;margin-top:6px;">No ${sideLabel(side)} shifts on the schedule for today.</div>`;
    if (todayRows.length || shiftsHtml) h.push(block(H3(`Today${model.sides.length > 1 ? `, ${sideLabel(side)}` : ''}`, fmtDate(model.today)) + (todayRows.length ? `<table style="border-collapse:collapse;width:100%;font-size:15px;">${todayRows.join('')}</table>` : '') + shiftsHtml));
  }

  if (S.games) h.push(block(H3('Big games tonight') + (model.games.length ? ul(model.games.map((g) => `<b>${esc(g.time)}</b> ${esc(g.name)}${g.network ? `, ${esc(g.network)}` : ''}${g.channel ? ` · ch ${esc(g.channel)}` : ''}`)) : '<div style="color:#5c6577;">No My Teams games today.</div>')));

  if (S.timeline && model.by.kitchen && model.by.kitchen.timeline) h.push(block(H3("Today's projected sales vs schedule", 'games, $ per hour, who is on') + `<img src="${base}/s/${token}/c/timeline.png" alt="Projected food sales per hour with games and kitchen shifts" style="width:100%;max-width:640px;display:block;">`));

  for (const side of model.sides) {
    const C = model.by[side].coolers;
    if (!S.coolers) continue;
    if (!C) { h.push(block(H3(`${side === 'kitchen' ? 'Kitchen' : 'Bar'} coolers`) + '<div style="color:#5c6577;">No cooler sensors assigned to this area yet.</div>')); continue; }
    const legend = C.series.map((s, k) => `<span style="margin-right:14px;"><span style="display:inline-block;width:18px;height:3px;vertical-align:middle;margin-right:6px;background:${PALETTE[k % PALETTE.length]};"></span>${esc(s.name)}</span>`).join('') + `<span><span style="display:inline-block;width:18px;border-top:2px dashed #c0392b;vertical-align:middle;margin-right:6px;"></span>limit</span>`;
    const overLine = C.over.length ? `<div style="color:#c0392b;font-size:13px;margin-top:4px;">${C.over.map((o) => `${esc(o.name)} was over ${o.limit}°F ${o.from} to ${o.to} (peak ${o.peak}°F)`).join(' · ')}</div>` : `<div style="color:#1f8a4c;font-size:13px;margin-top:4px;">All ${C.total} in range the whole 24 hours.</div>`;
    h.push(block(H3(`${side === 'kitchen' ? 'Kitchen' : 'Bar'} coolers, last 24 hours`, '°F, hourly') + `<img src="${base}/s/${token}/c/coolers-${side}.png" alt="Hourly cooler temperatures" style="width:100%;max-width:640px;display:block;"><div style="font-size:13px;color:#5c6577;margin-top:6px;">${legend}</div>${overLine}`));
  }

  if (S.systems && model.systems) {
    const Sy = model.systems; const rows = [];
    const ok = (t) => `<span style="color:#1f8a4c;">${t}</span>`; const bad = (t) => `<span style="color:#c0392b;">${t}</span>`;
    if (model.sides.includes('bar')) rows.push(Sy.internet ? row('Internet', Sy.internet.up ? ok('Up') : bad('Down'), `${Sy.internet.outages.length ? `down ${Sy.internet.outages.reduce((a, o) => a + o.minutes, 0)} min overnight` : 'no outages overnight'}${Sy.internet.latencyMs != null ? ` · ${Sy.internet.latencyMs} ms` : ''}${Sy.internet.down ? ` · ${Math.round(Sy.internet.down)} / ${Math.round(Sy.internet.upMbps || 0)} Mbps` : ''}${Sy.internet.stale ? ' · last check over 15 min ago' : ''}`) : row('Internet', '—', 'not monitored at this bar yet'));
    if (model.sides.includes('bar') && Sy.receivers) rows.push(row('Receivers', Sy.receivers.up === Sy.receivers.total ? ok(`${Sy.receivers.up} of ${Sy.receivers.total}`) : bad(`${Sy.receivers.up} of ${Sy.receivers.total}`), Sy.receivers.down.length ? `${Sy.receivers.down.map(esc).join(', ')} not answering` : 'all answering'));
    if (model.sides.includes('bar') && Sy.music) rows.push(row('Sonos/Pandora', Sy.music.up ? ok('Up') : bad('Down'), Sy.music.up ? (Sy.music.message ? esc(Sy.music.message) : '') : `down since ${Sy.music.downSince || 'overnight'}${Sy.music.message ? ` · ${esc(Sy.music.message)}` : ''}`));
    for (const side of model.sides) { const C = model.by[side].coolers; if (C && side === 'kitchen') rows.push(row('Kitchen coolers', C.inRange === C.total ? ok('In range') : bad(`${C.inRange} of ${C.total} in range`), `${C.total} reporting`)); }
    if (rows.length) h.push(block(H3('Critical systems', `as of ${fmtTime(model.generatedAt, model.tz)}`) + `<table style="border-collapse:collapse;width:100%;font-size:15px;">${rows.join('')}</table>`));
  }

  const title = `${esc(model.location)} ${model.sides.length > 1 ? 'bar and kitchen' : sideLabel(model.sides[0])} · ${fmtShort(model.today)}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Morning summary</title></head>
<body style="margin:0;background:#f3f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b1f27;line-height:1.45;">
<div style="max-width:680px;margin:0 auto;background:#ffffff;">
  <div style="padding:14px 18px;border-bottom:1px solid #e3e6ec;"><div style="font-size:16px;font-weight:bold;">${title}${test ? ' <span style="color:#d97706;font-weight:normal;">(test)</span>' : ''}</div><div style="font-size:13px;color:#5c6577;">Bar Ops morning summary for ${esc(model.personName)} · sent ${fmtTime(model.generatedAt, model.tz)}</div></div>
  <div style="padding:18px;">${h.join('')}</div>
  <div style="padding:12px 18px;border-top:1px solid #e3e6ec;font-size:12px;color:#5c6577;">Bar Ops sends this at the time you picked. Change it under Systems Monitoring → My alert settings. <a href="${base}/" style="color:#2458c7;">Open Bar Ops</a></div>
</div></body></html>`;
}

// ---------------------------------------------------------------- text
function renderText(model, { base, token }) {
  const N = model.needs; const L = [];
  const side = model.sides.length > 1 ? 'bar+kitchen' : model.sides[0];
  L.push(`Bar Ops ${model.location} ${side}, ${fmtShort(model.today)}`);
  L.push(`Full summary: ${base}/s/${token}`);
  const needs = [];
  if (N.calls && N.calls.length) needs.push(`Svc calls ${N.calls.length}: ${N.calls.slice(0, 3).map((c) => `${c.what} ${c.ageDays}d`).join(', ')}.`);
  if (N.applicants && N.applicants.length) needs.push(`Applicants ${N.applicants.length}: ${N.applicants.slice(0, 3).map((a) => `${shortName(a.name)}${a.position ? ' ' + a.position.toLowerCase() : ''} ${a.waiting.replace(/ days?/, 'd').replace(/ hr/, 'h').replace(' ', '')}`).join(', ')}.`);
  const alerts = [];
  for (const d of N.drawerShort || []) alerts.push(`${d.name} short $${Math.abs(d.variance).toFixed(2)}`);
  for (const o of N.internetDown || []) alerts.push(o.to ? `Internet down ${o.from}-${o.to}` : `Internet down since ${o.from}`);
  if (alerts.length) needs.push(`Alerts: ${alerts.join('. ')}.`);
  if (needs.length) { L.push('NEEDS YOU'); L.push(...needs); }
  for (const s of model.sides) {
    const Y = model.by[s].yesterday; const T = model.by[s].today; const S = model.sections; const parts = [];
    if (S.sales && Y.sales) parts.push(`${money(Y.sales.total)}${Y.sales.lastWeek ? ` (${Math.round((Y.sales.total - Y.sales.lastWeek) / Y.sales.lastWeek * 100) >= 0 ? '+' : ''}${Math.round((Y.sales.total - Y.sales.lastWeek) / Y.sales.lastWeek * 100)}%)` : ''}${Y.sales.day != null ? ` day ${money(Y.sales.day)} / night ${money(Y.sales.night)}` : ''}`);
    if (S.labor && Y.labor && Y.labor.pct != null) parts.push(`labor ${pct(Y.labor.pct)}`);
    if (S.clock && Y.clock.flags.length) parts.push(Y.clock.flags.map((f) => f.text).join('; '));
    if (parts.length) L.push(`Yest${model.sides.length > 1 ? ' ' + s : ''}: ${parts.join('. ')}.`);
    const tp = [];
    if (S.projected && T.projected) tp.push(`proj ${money(T.projected.total)}${T.projected.day != null ? ` (day ${money(T.projected.day)} / night ${money(T.projected.night)})` : ''}`);
    if (S.shifts && T.shifts.length) tp.push(T.shifts.map((x) => `${fmtHm(x.start)} ${shortName(x.name)}`).join(' · '));
    if (tp.length) L.push(`Today${model.sides.length > 1 ? ' ' + s : ''}: ${tp.join('. ')}.`);
  }
  if (model.sections.games && model.games.length) L.push(model.games.map((g) => `${g.name} ${g.time}${g.network ? ' ' + g.network : ''}`).join(', '));
  L.push('Reply STOP to opt out');
  return L.join('\n');
}

// ---------------------------------------------------------------- send
function baseUrl() { return (process.env.APP_BASE_URL || 'https://app.ticketsportsbar.com').replace(/\/$/, ''); }

async function sidesFor(svc, person) {
  if (person.role === 'owner') return ['bar', 'kitchen'];
  const { rows } = await svc.query('SELECT * FROM home_lines WHERE person_id = $1', [person.id]);
  const l = rows[0] || {};
  const sides = [];
  if (l.bar_sales || l.bar_labor || l.bar_staff || l.bar_coolers) sides.push('bar');
  if (l.kitchen_sales || l.kitchen_labor || l.kitchen_staff || l.kitchen_coolers) sides.push('kitchen');
  return sides.length ? sides : (person.role === 'maintenance' ? ['bar', 'kitchen'] : ['bar']);
}

async function locationsFor(svc, person) {
  const { rows } = await svc.query(
    `SELECT l.id, l.name, vs.timezone FROM locations l LEFT JOIN vc_sites vs ON vs.location_id = l.id
     WHERE l.active = true AND ($2 OR l.id = $3 OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.person_id = $1 AND el.location_id = l.id)) ORDER BY l.name`,
    [person.id, person.role === 'owner' || person.role === 'maintenance', person.location_id]);
  return rows;
}

// Build, store and send one person's summaries (one per bar they work at).
async function sendFor(personId, { test = false, now = new Date() } = {}) {
  return withServiceClient(async (svc) => {
    const { rows: pr } = await svc.query('SELECT * FROM people WHERE id = $1', [personId]);
    const person = pr[0];
    if (!person) return { ok: false, error: 'Not found.' };
    const settings = await settingsFor(personId);
    if (!settings.enabled && !test) return { ok: false, error: 'Morning summary is not switched on for this person.' };
    const sides = await sidesFor(svc, person);
    const locs = await locationsFor(svc, person);
    if (!locs.length) return { ok: false, error: 'No bar on this person\'s account.' };
    const base = baseUrl(); const results = [];
    for (const location of locs) {
      const model = await buildModel(svc, { person, location, sides, settings, now });
      const token = crypto.randomBytes(18).toString('base64url');
      const html = renderHtml(model, { base, token, test });
      const text = renderText(model, { base, token });
      const channel = settings.channel;
      let emailStatus = null; let smsStatus = null;
      if (channel === 'email' || channel === 'both') {
        if (!person.email) emailStatus = 'no email on file';
        else { const r = await sendHtmlEmail(svc, personId, person.email, `${test ? '[Test] ' : ''}${location.name} ${sides.length > 1 ? 'bar and kitchen' : sides[0]} summary, ${fmtShort(model.today)}`, html, text); emailStatus = r.ok ? (r.simulated ? 'simulated' : 'sent') : `failed: ${r.error}`; }
      }
      if (channel === 'sms' || channel === 'both') {
        if (!person.phone) smsStatus = 'no phone on file';
        else { const r = await notify.sendSms(svc, 'morning_summary', personId, person.phone, text); smsStatus = r.ok ? (r.simulated ? 'simulated' : 'sent') : `failed: ${r.error}`; }
      }
      await svc.query(
        `INSERT INTO morning_summary_sends (person_id, location_id, for_date, send_date, token, is_test, html, text_body, model, email_status, sms_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [personId, location.id, model.yday, model.today, token, test, html, text, JSON.stringify(model), emailStatus, smsStatus]);
      results.push({ location: location.name, token, emailStatus, smsStatus, url: `${base}/s/${token}` });
    }
    return { ok: true, results };
  });
}

// notify.sendEmail is text-only; the summary wants HTML with a text part,
// through the same Resend call, master switch and log.
async function sendHtmlEmail(client, personId, to, subject, html, text) {
  if (!(await notify.notificationsEnabled(client))) { await client.query(`INSERT INTO notifications_log (related_table, related_id, channel, recipient, status, detail) VALUES ('morning_summary',$1,'email',$2,'disabled',$3)`, [personId, to, subject]); return { ok: true, simulated: true }; }
  const apiKey = process.env.RESEND_API_KEY || process.env.SMTP_PASS; const from = process.env.SMTP_FROM;
  if (!apiKey || !from) { console.log(`[summary][email][SIMULATED] to=${to} subject="${subject}"`); await client.query(`INSERT INTO notifications_log (related_table, related_id, channel, recipient, status, detail) VALUES ('morning_summary',$1,'email',$2,'simulated',$3)`, [personId, to, subject]); return { ok: true, simulated: true }; }
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, subject, html, text }), signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && (data.message || data.error)) || `Resend API error (${res.status})`);
    await client.query(`INSERT INTO notifications_log (related_table, related_id, channel, recipient, status, detail) VALUES ('morning_summary',$1,'email',$2,'sent',$3)`, [personId, to, subject]);
    return { ok: true };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Timed out reaching Resend (15s).' : String(err.message || err);
    await client.query(`INSERT INTO notifications_log (related_table, related_id, channel, recipient, status, detail) VALUES ('morning_summary',$1,'email',$2,'failed',$3)`, [personId, to, message]);
    return { ok: false, error: message };
  } finally { clearTimeout(timeout); }
}

// Called every minute. Sends to everyone whose hour has arrived at their
// bar and who has not had today's summary yet.
async function runDue(now = new Date()) {
  const due = await withServiceClient(async (svc) => {
    const { rows } = await svc.query(
      `SELECT s.person_id, s.send_hour, p.location_id, p.role,
              COALESCE((SELECT vs.timezone FROM vc_sites vs WHERE vs.location_id = COALESCE(p.location_id, (SELECT el.location_id FROM employee_locations el WHERE el.person_id = p.id LIMIT 1)) LIMIT 1), $1) AS tz
       FROM morning_summary_settings s JOIN people p ON p.id = s.person_id WHERE s.enabled = true AND p.status = 'active'`, [DEFAULT_TZ]);
    const out = [];
    for (const r of rows) {
      const lp = partsIn(now, r.tz || DEFAULT_TZ);
      if (lp.hour !== r.send_hour) continue;
      const { rows: sent } = await svc.query('SELECT 1 FROM morning_summary_sends WHERE person_id = $1 AND send_date = $2 AND is_test = false LIMIT 1', [r.person_id, lp.ymd]);
      if (!sent.length) out.push(r.person_id);
    }
    return out;
  });
  let n = 0;
  for (const id of due) {
    try { const r = await sendFor(id, { now }); if (r.ok) n++; else console.warn('[summary] not sent', id, r.error); } catch (err) { console.error('[summary] send failed', id, err); }
  }
  return n;
}

// ---------------------------------------------------------------- web view
// /s/:token shows the stored page after the manager's PIN. The link says
// who it was sent to, so there is no username step. A short-lived view
// token in a cookie keeps the page open for the morning.
const views = new Map(); // viewToken -> { token, exp }
function cookies(req) { const out = {}; String(req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return out; }
function pinPage(token, error) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Morning summary</title>
<style>body{margin:0;background:#0f1115;color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;}form{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:24px;width:320px;max-width:90vw;}h1{font-size:18px;margin:0 0 6px;}p{color:#9aa3b2;font-size:14px;margin:0 0 14px;}input{width:100%;box-sizing:border-box;font-size:28px;letter-spacing:.3em;text-align:center;padding:10px;border-radius:10px;border:1px solid #262b36;background:#0f1115;color:#eef0f4;}button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#4f8dfd;color:#fff;font-size:16px;font-weight:600;}.err{color:#e5566d;font-size:14px;margin:10px 0 0;}</style></head>
<body><form method="post" action="/s/${esc(token)}/pin"><h1>Morning summary</h1><p>Enter your Bar Ops PIN to open it.</p><input name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" autofocus maxlength="8">${error ? `<div class="err">${esc(error)}</div>` : ''}<button type="submit">Open</button></form></body></html>`;
}
async function sendRow(token) {
  return withServiceClient(async (svc) => { const { rows } = await svc.query('SELECT id, person_id, html, model FROM morning_summary_sends WHERE token = $1', [token]); return rows[0] || null; });
}
async function viewPage(req, res) {
  const token = String(req.params.token || ''); if (!/^[A-Za-z0-9_-]{10,40}$/.test(token)) return res.status(404).send('Not found');
  const row = await sendRow(token); if (!row) return res.status(404).send('This summary link is no longer valid.');
  const v = cookies(req)[`bo_s_${token}`]; const live = v && views.get(v);
  if (live && live.token === token && live.exp > Date.now()) return res.type('html').send(row.html);
  res.type('html').send(pinPage(token));
}
async function pinPost(req, res) {
  const token = String(req.params.token || ''); if (!/^[A-Za-z0-9_-]{10,40}$/.test(token)) return res.status(404).send('Not found');
  const row = await sendRow(token); if (!row) return res.status(404).send('This summary link is no longer valid.');
  const pin = String((req.body || {}).pin || '').trim();
  const result = await withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT * FROM people WHERE id = $1', [row.person_id]);
    const person = rows[0]; if (!person || !person.pin_hash) return { ok: false, error: 'No PIN on this account. Sign in to Bar Ops and set one under My Account.' };
    if (person.pin_locked_at) return { ok: false, error: 'Your PIN is locked. Sign in to Bar Ops with your password to reset it.' };
    const valid = await bcrypt.compare(pin, person.pin_hash);
    if (!valid) {
      const count = (person.pin_failed_count || 0) + 1;
      if (count >= 5) { await svc.query('UPDATE people SET pin_failed_count = 0, pin_locked_at = now() WHERE id = $1', [person.id]); return { ok: false, error: 'Fifth wrong PIN. Your PIN is now locked; sign in to Bar Ops with your password to set a new one.' }; }
      await svc.query('UPDATE people SET pin_failed_count = $2 WHERE id = $1', [person.id, count]);
      return { ok: false, error: `Wrong PIN. ${5 - count} tr${5 - count === 1 ? 'y' : 'ies'} left.` };
    }
    if (person.pin_failed_count) await svc.query('UPDATE people SET pin_failed_count = 0 WHERE id = $1', [person.id]);
    return { ok: true };
  });
  if (!result.ok) return res.status(401).type('html').send(pinPage(token, result.error));
  const vt = crypto.randomBytes(18).toString('base64url');
  views.set(vt, { token, exp: Date.now() + 12 * 3600000 });
  for (const [k, x] of views) if (x.exp < Date.now()) views.delete(k);
  res.set('Set-Cookie', `bo_s_${token}=${vt}; Path=/s/${token}; Max-Age=43200; HttpOnly; Secure; SameSite=Lax`);
  res.redirect(`/s/${token}`);
}
async function chartRoute(req, res) {
  const token = String(req.params.token || ''); const name = String(req.params.name || '');
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(token) || !/^[a-z-]{3,20}$/.test(name)) return res.status(404).end();
  const row = await sendRow(token); if (!row || !row.model) return res.status(404).end();
  const png = chartPng(row.model, name); if (!png) return res.status(404).end();
  res.set('Content-Type', 'image/png'); res.set('Cache-Control', 'private, max-age=86400'); res.send(png);
}

// A preview for the settings pages: builds for this person without sending.
async function preview(personId, { now = new Date() } = {}) {
  return withServiceClient(async (svc) => {
    const { rows: pr } = await svc.query('SELECT * FROM people WHERE id = $1', [personId]); const person = pr[0]; if (!person) return null;
    const settings = await settingsFor(personId); const sides = await sidesFor(svc, person); const locs = await locationsFor(svc, person); if (!locs.length) return null;
    const model = await buildModel(svc, { person, location: locs[0], sides, settings, now });
    return { html: renderHtml(model, { base: baseUrl(), token: 'preview', test: true }), text: renderText(model, { base: baseUrl(), token: 'preview' }), model };
  });
}

module.exports = { SECTIONS, settingsFor, setSettings, sendFor, runDue, viewPage, pinPost, chartRoute, preview, buildModel, renderHtml, renderText, chartSvg, chartPng };
