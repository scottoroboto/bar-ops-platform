// Morning summary (patch_069, redesigned 2026-10-19). One email and/or
// text per person covering every bar they work at, built at the hour they
// picked from data the app already holds: SpotOn sales and punches, the
// sales forecast, the Bar Ops schedule, cash counts, cooler sensors,
// equipment alerts, service calls, applicants, and the ESPN slate.
//
// Shape (Scotto's mockup g2): a card per bar with yesterday's sales next
// to today's forecast in the same rows (total, Kitchen, Bar, Labor); then
// today's games and events; then equipment and service, summarized with
// links into the app. The owner switches the summary on per person and
// picks the sections; the person picks email / text / both and the hour
// (5-9am). Bar or kitchen comes from the person's home widgets (bar_* on ->
// bar, kitchen_* -> kitchen), owner gets both.
//
// The text version ends with a link to the full page, which asks for that
// person's PIN only (the link already says who it was sent to).
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { withServiceClient } = require('./db');
const notify = require('./notify');
const kitchenboard = require('./kitchenboard');
const home = require('./home');
const forecast = require('./forecast');
const slate = require('./slate');

let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { console.warn('[summary] @resvg/resvg-js not available; charts will be skipped'); }

const DEFAULT_TZ = 'America/Chicago';
const FONT_FILES = [path.join(__dirname, 'assets', 'DejaVuSans.ttf'), path.join(__dirname, 'assets', 'DejaVuSans-Bold.ttf')];
const FONT = 'DejaVu Sans';

// Sections the owner can switch per person. Service calls and applicants
// always show.
const SECTIONS = [
  ['sales', "Yesterday's sales", true],
  ['labor', 'Labor cost %', true],
  ['projected', "Today's forecast", true],
  ['shifts', 'Scheduled hours', true],
  ['games', 'Games and events', true],
  ['systems', 'Equipment down, and back overnight', true],
  ['coolers', 'Coolers out of range', true],
  ['drawers', 'Drawer shortages', true],
  ['clock', 'Clock flags: late in, missed out', true],
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
function fmtDate(ymd) { return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtShort(ymd) { return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric', year: 'numeric' }); }
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
  if (!model || !model.by) return null; // summaries before the 2026-10-19 redesign only
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

// ---------------------------------------------------------------- one summary, every bar
// Scotto, 2026-10-19 (mockup g2): one email for all of a person's bars.
// Each bar gets a card with yesterday's sales next to today's forecast in
// the same rows (total, Kitchen, Bar, Labor), and labor % colored against
// the Sales Board targets (kitchen labor_goal_*, bar bar_labor_goal). Then
// today's games and events, then equipment and service, summarized with
// links. Anyone who gets this by email no longer gets monitoring's 6am
// equipment email (monitoring.sendDailySummaries skips them).
const ACCENTS = [['#d8453c', '#d8453c'], ['#f2a516', '#e39200'], ['#2563eb', '#2563eb'], ['#16a34a', '#15803d']]; // [strip, chip]
const CAT_NAME = { network: 'Network', av: 'TVs & AV', hvac: 'HVAC', refrigeration: 'Refrigeration', freezer: 'Freezer', ice_machine: 'Ice machine', power: 'Power', other: 'Other' };
function shortLoc(name) { const m = String(name || '').match(/(\d+)\s*$/); return m ? `T${m[1]}` : String(name || '').split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 3); }
function isWeekendYmd(ymd) { const d = new Date(`${ymd}T12:00:00Z`).getUTCDay(); return d === 5 || d === 6; }
function shiftHours(list) {
  return (list || []).reduce((a, s) => { const [sh, sm] = s.start.split(':').map(Number); const [eh, em] = s.end.split(':').map(Number); let h = (eh + em / 60) - (sh + sm / 60); if (h <= 0) h += 24; return a + h; }, 0);
}
function clock12(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return `${(h % 12) || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
// Minutes into the bar's day (6 AM start) for a time like "7:15 PM", for sorting.
function dayMinutes(t) { const m = String(t || '').match(/(\d+):(\d+)\s*([AP])M/i); if (!m) return -1; let h = Number(m[1]) % 12 + (m[3].toUpperCase() === 'P' ? 12 : 0); if (h < 6) h += 24; return h * 60 + Number(m[2]); }
function round100(n) { return n == null ? null : Math.round(n / 100) * 100; }

// A business day's sales: sales_daily (final once the box backfills), else
// the day's last snapshot.
async function daySales(svc, locId, ymd, tz, cutoff) {
  const { rows } = await svc.query('SELECT food_net, total_net FROM sales_daily WHERE location_id = $1 AND business_date = $2 AND total_net IS NOT NULL', [locId, ymd]);
  if (rows[0]) { const total = num(rows[0].total_net); const food = rows[0].food_net == null ? null : num(rows[0].food_net); return { total, food, bar: food == null ? null : Math.max(0, total - food) }; }
  const s = await salesFor(svc, locId, ymd, tz, cutoff);
  return s ? { total: s.total, food: s.food, bar: s.bar } : null;
}

// One bar's card plus what it adds to the games and equipment cards.
async function barBlock(svc, { person, location, sides: sidesIn, settings, now }, i) {
  const sides = [...sidesIn].sort((a, b) => (a === 'kitchen' ? -1 : b === 'kitchen' ? 1 : 0)); // Kitchen row above Bar
  const m = await buildModel(svc, { person, location, sides, settings, now });
  const kb = await kitchenboard.settingsFor(svc, location.id);
  const code = shortLoc(location.name); const [strip, chip] = ACCENTS[i % ACCENTS.length];
  const goals = { kitchen: num(isWeekendYmd(m.yday) ? kb.labor_goal_weekend : kb.labor_goal_weekday) || 30, bar: num(kb.bar_labor_goal) || 18 };
  const keyOf = (side) => (side === 'kitchen' ? 'food' : 'bar');

  // ---- yesterday
  const ys = await daySales(svc, location.id, m.yday, m.tz, m.cutoff);
  const lw = await daySales(svc, location.id, ymdAddDays(m.yday, -7), m.tz, m.cutoff);
  const pick = (s, side) => (s ? s[keyOf(side)] : null);
  const both = sides.length > 1;
  const yest = { rows: [], total: null, lastWeek: null, labor: null };
  if (ys) {
    yest.total = both ? ys.total : pick(ys, sides[0]);
    yest.lastWeek = lw ? (both ? lw.total : pick(lw, sides[0])) : null;
    let laborAll = 0; let haveLabor = false; let goalWeighted = 0;
    for (const side of sides) {
      const sales = pick(ys, side); const L = m.by[side].yesterday.labor;
      const dollars = L ? L.dollars : null;
      if (dollars != null) { laborAll += dollars; haveLabor = true; }
      goalWeighted += (sales || 0) * goals[side];
      yest.rows.push({ side, label: side === 'kitchen' ? 'Kitchen' : 'Bar', sales, laborPct: dollars != null && sales > 0 ? dollars / sales * 100 : null, goal: goals[side] });
    }
    const salesSum = sides.reduce((a, s) => a + (pick(ys, s) || 0), 0);
    if (haveLabor) yest.labor = { dollars: laborAll, pct: salesSum > 0 ? laborAll / salesSum * 100 : null, goal: salesSum > 0 ? goalWeighted / salesSum : goals[sides[0]] };
  }

  // ---- today
  let fc = null;
  try { fc = await forecast.forLocation(location.id, { now }); } catch (err) { console.error('[summary] forecast failed', location.name, err.message); }
  const fd = fc && fc.ready ? fc.days.find((d) => d.date === m.today) : null;
  // The owner's Sales Board override for today wins over the forecast.
  const ov = await kitchenboard.overridesFor(location.id, m.today, m.today);
  const today = { ready: false, rows: [], total: null, hours: null, why: (fc && fc.reason) || 'no forecast yet' };
  let hoursAll = 0; let anyShift = false;
  for (const side of sides) {
    const shifts = m.by[side].today.shifts; const h = shiftHours(shifts); if (shifts.length) anyShift = true; hoursAll += h;
    const set = ov.get(`${side}|${m.today}`);
    const amt = set != null ? set : fd ? round100(fd[keyOf(side)].fc) : null;
    today.rows.push({ side, label: side === 'kitchen' ? 'Kitchen' : 'Bar', fc: amt, set: set != null, hours: shifts.length ? h : null });
  }
  today.ready = today.rows.every((r) => r.fc != null);
  if (today.ready) { today.total = today.rows.reduce((a, r) => a + r.fc, 0); today.allSet = today.rows.every((r) => r.set); }
  today.hours = anyShift ? hoursAll : null;

  // ---- games and events (dayDetail: the Scheduling page's popup)
  let detail = null;
  try { detail = await slate.dayDetail(location.id, 'bar', m.today); } catch (err) { console.error('[summary] day detail failed', location.name, err.message); }

  // ---- equipment and service
  const zoneOk = (z) => person.role === 'owner' || !z || z === 'both' || sides.includes(z);
  const { rows: down } = await svc.query(
    `SELECT ms.name, ms.category, ms.zone, sa.opened_at, (ms.silenced_until IS NOT NULL AND ms.silenced_until > now()) AS silenced
       FROM system_alerts sa JOIN monitored_systems ms ON ms.id = sa.system_id
      WHERE ms.location_id = $1 AND sa.closed_at IS NULL AND sa.expected_on = true AND ms.active = true AND ms.kind <> 'vc_tv' ORDER BY sa.opened_at`, [location.id]);
  const { rows: back } = await svc.query(
    `SELECT ms.name, ms.zone, sa.opened_at, sa.closed_at FROM system_alerts sa JOIN monitored_systems ms ON ms.id = sa.system_id
      WHERE ms.location_id = $1 AND sa.closed_at >= now() - interval '24 hours' AND sa.expected_on = true AND ms.kind <> 'vc_tv'
        AND sa.closed_at - sa.opened_at >= interval '3 minutes' ORDER BY sa.closed_at`, [location.id]);
  const coolers = sides.map((s) => m.by[s].coolers).filter(Boolean);
  return {
    card: { name: location.name, code, strip, chip, sides, yday: m.yday, today: m.today, yest, fc: today },
    tz: m.tz, today: m.today, yday: m.yday,
    detail,
    down: down.filter((d) => zoneOk(d.zone)).map((d) => ({ code, name: d.name, cat: CAT_NAME[d.category] || d.category || 'Other', since: fmtTime(d.opened_at, m.tz), silenced: d.silenced })),
    back: back.filter((d) => zoneOk(d.zone)).map((d) => ({ code, name: d.name, from: fmtTime(d.opened_at, m.tz), to: fmtTime(d.closed_at, m.tz) })),
    coolersOver: coolers.flatMap((c) => c.over.map((o) => ({ code, ...o, now: (c.series.find((s) => s.name === o.name) || {}).state }))),
    coolerCount: coolers.reduce((a, c) => a + c.total, 0),
    calls: (m.needs.calls || []).map((c) => ({ code, ...c })),
    drawers: (m.needs.drawerShort || []).map((d) => ({ code, ...d })),
    applicants: m.needs.applicants || [],
    clock: [...new Set(sides.flatMap((s) => m.by[s].yesterday.clock.flags.filter((f) => f.kind !== 'fixed').map((f) => `${code} ${f.text.replace(/, missed clock out: clock out time needs adjusted$/, ' missed clock out')}`)))],
  };
}

// Games: our teams one by one, pro games grouped by start time, college
// games only when ranked teams meet (or a top 10 plays); the rest counted.
function pickGames(games) {
  const out = []; const groups = new Map(); let collegeRest = 0;
  for (const g of games) {
    if (g.tracked) { out.push({ hour: g.hour, time: g.time, text: g.matchup, net: g.network, ours: true }); continue; }
    const college = /college/i.test(g.league);
    if (college) {
      const ranks = (g.matchup.match(/#(\d+)/g) || []).map((x) => Number(x.slice(1)));
      if (ranks.length === 2 || ranks.some((r) => r <= 10)) out.push({ hour: g.hour, time: g.time, text: g.matchup, net: g.network });
      else collegeRest += 1;
      continue;
    }
    const k = `${g.league}|${g.time}`;
    if (!groups.has(k)) groups.set(k, { hour: g.hour, time: g.time, league: g.league, list: [] });
    groups.get(k).list.push(g);
  }
  for (const gr of groups.values()) {
    if (gr.list.length === 1) out.push({ hour: gr.hour, time: gr.time, text: `${gr.league}: ${gr.list[0].matchup}`, net: gr.list[0].network });
    else out.push({ hour: gr.hour, time: gr.time, text: `${gr.league} · ${gr.list.length} games` });
  }
  out.sort((a, b) => dayMinutes(a.time) - dayMinutes(b.time) || (b.ours ? 1 : 0) - (a.ours ? 1 : 0));
  return { list: out.slice(0, 10), more: Math.max(0, out.length - 10) + collegeRest };
}

async function buildSummary(svc, { person, locs, sides, settings, now }) {
  const blocks = [];
  for (let i = 0; i < locs.length; i += 1) blocks.push(await barBlock(svc, { person, location: locs[i], sides, settings, now }, i));
  const first = blocks[0]; const S = settings.sections;
  const M = { v: 2, personName: person.name, tz: first.tz, today: first.today, yday: first.yday, sections: S, generatedAt: now.toISOString(), bars: blocks.map((b) => b.card), multi: blocks.length > 1 };

  // ---- games and events
  const d0 = blocks.map((b) => b.detail).find(Boolean);
  M.games = d0 ? pickGames(d0.games) : { list: [], more: 0 };
  M.events = blocks.flatMap((b) => (b.detail ? b.detail.events.map((e) => ({ code: b.card.code, time: e.time ? clock12(e.time) : '', name: e.name })) : []));
  M.holidays = d0 ? d0.holidays : [];
  M.busiest = blocks.filter((b) => b.detail && b.detail.busiest).map((b) => `${b.card.code} ${b.detail.busiest}`);

  // ---- equipment and service, worst first
  const items = []; const tag = (code) => (M.multi ? `${code} ` : '');
  if (S.systems) {
    const down = blocks.flatMap((b) => b.down);
    if (down.length) {
      const groups = new Map(); for (const d of down) { const k = `${tag(d.code)}${d.cat}`; groups.set(k, (groups.get(k) || []).concat(d)); }
      const sub = down.length <= 2 ? down.map((d) => `${tag(d.code)}${d.name}, since ${d.since}${d.silenced ? ' (silenced)' : ''}`).join(' · ')
        : [...groups.entries()].map(([k, l]) => (l.length > 1 ? `${k} (${l.length})` : `${k}: ${l[0].name}`)).join(' · ');
      items.push({ level: 'red', title: `${down.length} piece${down.length === 1 ? '' : 's'} of equipment down`, sub, href: '/monitoring.html' });
    }
  }
  if (S.coolers) {
    for (const b of blocks) for (const o of b.coolersOver) items.push({ level: 'red', title: `${tag(o.code)}${o.name} hit ${Math.round(o.peak)}°F`, sub: `${o.from}–${o.to}, ${o.now === 'normal' ? 'back in range' : 'still above'} ${Math.round(o.limit)}°F`, href: '/sensors.html' });
  }
  const calls = blocks.flatMap((b) => b.calls);
  if (calls.length) {
    const oldest = Math.max(...calls.map((c) => c.ageDays));
    const sub = calls.slice(0, 3).map((c) => `${tag(c.code)}${c.what}${c.working ? ' (being worked)' : ''}`).join(' · ') + (calls.length > 3 ? ` · ${calls.length - 3} more` : '');
    items.push({ level: 'amb', title: `${calls.length} service call${calls.length === 1 ? '' : 's'} open`, sub: `${oldest ? `Oldest ${oldest} day${oldest === 1 ? '' : 's'} · ` : ''}${sub}`, href: '/servicecalls.html' });
  }
  if (S.drawers) for (const b of blocks) for (const d of b.drawers) items.push({ level: 'amb', title: `${tag(d.code)}drawer $${Math.abs(d.variance).toFixed(2)} short`, sub: `${d.name} at close · ${d.who}`, href: '/cashhandling.html' });
  const seen = new Set(); const apps = blocks.flatMap((b) => b.applicants).filter((a) => (seen.has(a.name) ? false : seen.add(a.name)));
  if (apps.length) items.push({ level: 'amb', title: `${apps.length} applicant${apps.length === 1 ? '' : 's'} waiting`, sub: apps.slice(0, 3).map((a) => `${shortName(a.name)}${a.position ? `, ${a.position.toLowerCase()}` : ''} · ${a.waiting}`).join(' · '), href: '/employees.html' });
  if (S.clock) {
    const flags = blocks.flatMap((b) => (M.multi ? b.clock : b.clock.map((t) => t.replace(/^\S+ /, ''))));
    if (flags.length) items.push({ level: 'amb', title: `${flags.length} clock flag${flags.length === 1 ? '' : 's'}`, sub: flags.slice(0, 2).join(' · ') + (flags.length > 2 ? ` · ${flags.length - 2} more` : ''), href: '/timeclock.html' });
  }
  M.items = items.map((it) => ({ ...it, title: it.title.charAt(0).toUpperCase() + it.title.slice(1) }));
  const back = S.systems ? blocks.flatMap((b) => b.back) : [];
  M.back = back.slice(0, 5).map((x) => `${tag(x.code)}${x.name} ${x.from}–${x.to}`).concat(back.length > 5 ? [`${back.length - 5} more`] : []);
  const coolerCount = blocks.reduce((a, b) => a + b.coolerCount, 0);
  M.coolersOk = S.coolers && coolerCount && !blocks.some((b) => b.coolersOver.length) ? coolerCount : 0;
  return M;
}

// ---------------------------------------------------------------- email
// Tables and inline styles only, so Gmail, Outlook and Apple Mail all
// draw it the same; sized for a phone first (max 480px).
const C = { bg: '#eef1f5', card: '#ffffff', ink: '#18202e', soft: '#3d4657', muted: '#677185', line: '#e8ecf2', blue: '#1d4ed8', fcBg: '#f2f6ff', green: '#15803d', greenBg: '#e3f6e9', amber: '#b45309', amberBg: '#fff1d6', red: '#dc2626', amb: '#f59e0b', orange: '#c2410c' };
function pill(p, goal) {
  if (p == null) return '';
  const ok = goal == null || p <= goal;
  return `<span style="display:inline-block;border-radius:999px;padding:0 6px;font-weight:700;font-size:12px;line-height:18px;background:${ok ? C.greenBg : C.amberBg};color:${ok ? C.green : C.amber};">${Math.round(p)}%</span>`;
}
function delta(a, b) {
  if (a == null || !b) return '';
  const d = Math.round((a - b) / b * 100);
  return `<span style="font-size:12px;font-weight:700;margin-left:6px;letter-spacing:0;color:${d >= 0 ? C.green : C.orange};">${d >= 0 ? '▲' : '▼'}&nbsp;${Math.abs(d)}%</span>`;
}
function hrs(h) { return h == null ? '' : `${Math.round(h)}&nbsp;h`; }
function rowsTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:13px;">${rows.map(([n, v, x]) => `<tr><td style="padding:6px 0;border-top:1px solid ${C.line};color:${C.soft};white-space:nowrap;">${n}</td><td align="right" style="padding:6px 0 6px 4px;border-top:1px solid ${C.line};font-weight:700;white-space:nowrap;">${v}</td><td align="right" width="34" style="padding:6px 0 6px 4px;border-top:1px solid ${C.line};color:${C.muted};font-size:12px;white-space:nowrap;">${x || ''}</td></tr>`).join('')}</table>`;
}
const LBL = (t, color) => `<div style="font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${color || C.muted};margin:0 0 4px;">${t}</div>`;
const BIG = (t, color) => `<div style="font-size:22px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;color:${color || C.ink};margin:0 0 4px;">${t}</div>`;
const SEC = (t) => `<div style="font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};margin:0 0 6px;">${t}</div>`;
const CHIP = (code, bg, small) => `<span style="display:inline-block;font-size:${small ? 10.5 : 12}px;font-weight:800;color:#ffffff;background:${bg};border-radius:6px;padding:1px 7px;">${esc(code)}</span>`;
const card = (strip, inner) => `<tr><td style="background:${C.card};border-radius:14px;border-top:5px solid ${strip};padding:14px 12px;">${inner}</td></tr><tr><td height="12" style="font-size:0;line-height:0;">&nbsp;</td></tr>`;

function barCard(b, S) {
  const Y = b.yest; const F = b.fc;
  const left = [];
  if (S.sales) {
    left.push(LBL(`Yesterday · ${weekdayShort(b.yday)}`));
    if (Y.total == null) left.push(BIG('—') + `<div style="font-size:12.5px;color:${C.muted};">No SpotOn sales for yesterday.</div>`);
    else {
      left.push(BIG(`${money(Y.total)}${delta(Y.total, Y.lastWeek)}`));
      const rows = Y.rows.length > 1 ? Y.rows.map((r) => [r.label, money(r.sales), S.labor ? pill(r.laborPct, r.goal) : '']) : [];
      if (S.labor) rows.push(['Labor', Y.labor ? money(Y.labor.dollars) : '—', Y.labor ? pill(Y.labor.pct, Y.labor.goal) : '']);
      if (rows.length) left.push(rowsTable(rows));
    }
  }
  const right = [];
  if (S.projected) {
    right.push(LBL('Today · forecast', C.blue));
    if (!F.ready) right.push(BIG('—', C.blue) + `<div style="font-size:12.5px;color:${C.muted};">${esc(F.why)}</div>`);
    else {
      right.push(BIG(`${F.allSet ? '' : '~'}${money(F.total)}`, C.blue));
      const rows = F.rows.length > 1 ? F.rows.map((r) => [r.label, `${r.set ? '' : '~'}${money(r.fc)}`, S.shifts ? hrs(r.hours) : '']) : [];
      if (S.shifts) rows.push(['Labor', F.hours != null ? `${Math.round(F.hours)} hrs` : '—', F.hours != null ? 'sched' : '']);
      if (rows.length) right.push(rowsTable(rows));
    }
  } else if (S.shifts) right.push(LBL('Today', C.blue) + rowsTable([['Scheduled', F.hours != null ? `${Math.round(F.hours)} hrs` : '—', '']]));
  const head = `<div style="font-size:17px;font-weight:800;margin:0 0 10px;">${CHIP(b.code, b.chip)}&nbsp; ${esc(b.name)}${b.sides.length === 1 ? ` <span style="font-size:13px;font-weight:600;color:${C.muted};">${b.sides[0]}</span>` : ''}</div>`;
  let body;
  if (left.length && right.length) body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="50%" valign="top" style="padding:4px 8px 0 0;">${left.join('')}</td><td width="50%" valign="top" style="background:${C.fcBg};border-radius:10px;padding:8px 8px 2px;">${right.join('')}</td></tr></table>`;
  else body = (left.join('') || '') + (right.length ? `<div style="background:${C.fcBg};border-radius:10px;padding:8px 10px 2px;">${right.join('')}</div>` : '');
  return card(b.strip, head + body);
}

function gamesCard(M, base) {
  const rows = [];
  const ev = (tm, html) => `<tr><td valign="top" width="74" style="padding:7px 8px 7px 0;border-top:1px solid ${C.line};color:${C.blue};font-weight:700;font-size:13.5px;white-space:nowrap;">${tm}</td><td style="padding:7px 0;border-top:1px solid ${C.line};font-size:14px;">${html}</td></tr>`;
  const all = [
    ...M.holidays.map((h) => ({ k: -2, html: ev('All day', `<b>${esc(h)}</b>`) })),
    ...M.games.list.map((g) => ({ k: dayMinutes(g.time), html: ev(esc(g.time), `${g.ours ? `<b>${esc(g.text)}</b> <span style="font-size:11px;font-weight:700;color:#b4231b;background:#fde2e0;border-radius:999px;padding:1px 7px;">ours</span>` : esc(g.text)}${g.net ? ` <span style="color:${C.muted};">· ${esc(g.net)}</span>` : ''}`) })),
    ...M.events.map((e) => ({ k: dayMinutes(e.time), html: ev(esc(e.time || 'Today'), `${M.multi ? `${CHIP(e.code, '#18202e', true)} ` : ''}${esc(e.name)}`) })),
  ].sort((a, b) => a.k - b.k);
  for (const x of all) rows.push(x.html);
  const foot = [];
  if (M.games.more) foot.push(`${M.games.more} more game${M.games.more === 1 ? '' : 's'} on the <a href="${base}/scheduling.html" style="color:${C.blue};font-weight:600;text-decoration:none;">schedule</a>`);
  if (M.busiest.length) foot.push(`Busiest: ${M.busiest.map(esc).join(' · ')}`);
  const table = rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows.join('').replace('border-top:1px solid ' + C.line + ';', '').replace('border-top:1px solid ' + C.line + ';', '')}</table>` : `<div style="font-size:14px;color:${C.muted};">No games or events on the list today.</div>`;
  return card('#2563eb', SEC("Today's games &amp; events") + table + (foot.length ? `<div style="font-size:12.5px;color:${C.muted};margin-top:6px;">${foot.join('<br>')}</div>` : ''));
}

function equipCard(M, base) {
  const dot = (lv) => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${lv === 'red' ? C.red : lv === 'grn' ? '#16a34a' : C.amb};"></span>`;
  const items = M.items.length ? M.items : [{ level: 'grn', title: 'Nothing down, nothing waiting', sub: '', href: '/monitoring.html' }];
  const rows = items.map((it, i) => {
    const bt = i ? `border-top:1px solid ${C.line};` : '';
    const a = (inner, extra) => `<a href="${base}${it.href}" style="color:${C.ink};text-decoration:none;display:block;${extra || ''}">${inner}</a>`;
    return `<tr><td valign="top" width="18" style="padding:12px 0 9px;${bt}">${dot(it.level)}</td><td style="padding:9px 6px 9px 0;${bt}font-size:14px;">${a(`<b>${esc(it.title)}</b>${it.sub ? `<span style="display:block;color:${C.muted};font-size:12.5px;margin-top:1px;">${esc(it.sub)}</span>` : ''}`)}</td><td width="12" align="right" style="padding:9px 0;${bt}color:#9aa3b2;font-size:16px;">${a('›')}</td></tr>`;
  });
  const foot = [];
  if (M.back.length) foot.push(`Back overnight: ${M.back.map(esc).join(', ')}.`);
  if (M.coolersOk) foot.push(`Coolers: all ${M.coolersOk} in range the last 24 hours.`);
  return card('#dc2626', SEC('Equipment &amp; service') + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows.join('')}</table>` + (foot.length ? `<div style="font-size:12.5px;color:${C.muted};margin-top:6px;">${foot.join('<br>')}</div>` : ''));
}

function renderHtml(M, { base, token, test }) {
  const S = M.sections; const parts = [];
  for (const b of M.bars) if (S.sales || S.projected || S.shifts) parts.push(barCard(b, S));
  if (S.games) parts.push(gamesCard(M, base));
  parts.push(equipCard(M, base));
  const where = M.bars.map((b) => b.name).join(' & ');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Morning summary</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.ink};line-height:1.35;font-variant-numeric:tabular-nums;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};"><tr><td align="center" style="padding:14px 10px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;text-align:left;">
<tr><td style="background:#24345a;background-image:linear-gradient(135deg,#1e2a44,#2b3d66);border-radius:16px;padding:16px 16px 14px;color:#ffffff;"><div style="font-size:21px;font-weight:800;color:#ffffff;">${fmtDate(M.today)}${test ? ' <span style="font-size:13px;font-weight:600;color:#ffd38a;">test</span>' : ''}</div><div style="font-size:13px;color:#c7d2ea;margin-top:2px;">Morning summary · ${esc(where)} · ${clock12(`${partsIn(new Date(M.generatedAt), M.tz).hour}:${partsIn(new Date(M.generatedAt), M.tz).minute}`)}</div></td></tr>
<tr><td height="12" style="font-size:0;line-height:0;">&nbsp;</td></tr>
${parts.join('\n')}
<tr><td align="center" style="font-size:12px;color:#8a93a3;padding-top:2px;">▲▼ vs the same day last week · forecast is a guess that gets better with time<br><a href="${base}/" style="color:${C.blue};font-weight:600;text-decoration:none;">Open Bar Ops</a></td></tr>
</table></td></tr></table></body></html>`;
}

// ---------------------------------------------------------------- text
function renderText(M, { base, token }) {
  const S = M.sections; const L = [];
  L.push(`Bar Ops ${fmtShort(M.today)}`);
  for (const b of M.bars) {
    const Y = b.yest; const F = b.fc; const parts = [];
    if (S.sales && Y.total != null) {
      const d = Y.lastWeek ? Math.round((Y.total - Y.lastWeek) / Y.lastWeek * 100) : null;
      let s = `yest ${money(Y.total)}${d != null ? ` (${d >= 0 ? '+' : ''}${d}%)` : ''}`;
      if (Y.rows.length > 1) s += ` K ${money(Y.rows.find((r) => r.side === 'kitchen').sales)} B ${money(Y.rows.find((r) => r.side === 'bar').sales)}`;
      if (S.labor && Y.labor && Y.labor.pct != null) s += `, labor ${Math.round(Y.labor.pct)}%`;
      parts.push(s);
    }
    if (S.projected && F.ready) parts.push(`today ${F.allSet ? '' : '~'}${money(F.total)}${S.shifts && F.hours != null ? `, ${Math.round(F.hours)} hrs sched` : ''}`);
    if (parts.length) L.push(`${b.code}: ${parts.join('. ')}.`);
  }
  if (S.games) {
    const g = [...M.holidays, ...M.games.list.filter((x) => x.ours).map((x) => `${x.text} ${x.time}`), ...M.events.map((e) => `${M.multi ? e.code + ' ' : ''}${e.name}${e.time ? ' ' + e.time : ''}`)];
    if (g.length) L.push(g.join('; '));
  }
  if (M.items.length) L.push(M.items.map((i) => i.title).join('. ') + '.');
  else L.push('Nothing down, nothing waiting.');
  L.push(`Full summary: ${base}/s/${token}`);
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

// Build, store and send one person's summary: one email for every bar
// they work at.
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
    const base = baseUrl();
    const model = await buildSummary(svc, { person, locs, sides, settings, now });
    const token = crypto.randomBytes(18).toString('base64url');
    const html = renderHtml(model, { base, token, test });
    const text = renderText(model, { base, token });
    const channel = settings.channel;
    let emailStatus = null; let smsStatus = null;
    if (channel === 'email' || channel === 'both') {
      if (!person.email) emailStatus = 'no email on file';
      else { const r = await sendHtmlEmail(svc, personId, person.email, `${test ? '[Test] ' : ''}Morning summary${locs.length === 1 ? `, ${locs[0].name}` : ''} · ${fmtShort(model.today)}`, html, text); emailStatus = r.ok ? (r.simulated ? 'simulated' : 'sent') : `failed: ${r.error}`; }
    }
    if (channel === 'sms' || channel === 'both') {
      if (!person.phone) smsStatus = 'no phone on file';
      else { const r = await notify.sendSms(svc, 'morning_summary', personId, person.phone, text); smsStatus = r.ok ? (r.simulated ? 'simulated' : 'sent') : `failed: ${r.error}`; }
    }
    await svc.query(
      `INSERT INTO morning_summary_sends (person_id, location_id, for_date, send_date, token, is_test, html, text_body, model, email_status, sms_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [personId, locs.length === 1 ? locs[0].id : null, model.yday, model.today, token, test, html, text, JSON.stringify(model), emailStatus, smsStatus]);
    return { ok: true, results: [{ location: locs.map((l) => l.name).join(' & '), token, emailStatus, smsStatus, url: `${base}/s/${token}` }] };
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
    const model = await buildSummary(svc, { person, locs, sides, settings, now });
    return { html: renderHtml(model, { base: baseUrl(), token: 'preview', test: true }), text: renderText(model, { base: baseUrl(), token: 'preview' }), model };
  });
}

module.exports = { SECTIONS, settingsFor, setSettings, sendFor, runDue, viewPage, pinPost, chartRoute, preview, buildModel, buildSummary, renderHtml, renderText, chartSvg, chartPng, _test: { pickGames, shortLoc } };
