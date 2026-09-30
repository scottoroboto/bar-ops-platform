// Lights: the Kasa plugs on the neon signs (cloud patch_049). This box does
// all the talking to the plugs and runs the light routines itself, so the
// signs come on at dusk and go off at closing with the internet down.
//
//   poll        every 20s, each plug's on/off + watts (drivers/kasa.js).
//               A plug that's on but drawing ~0 W is a sign that's out.
//   discover    every 15 min (and on "Find plugs" from TV Admin): UDP sweep
//               of the bar's subnets; new plugs go up to the cloud as
//               unnamed, moved ones get their new address.
//   schedule    every 30s: fire any routine or own-schedule ON/OFF whose
//               time passed since the last tick. Times are in the bar's
//               timezone; sunset/dusk/etc. come from lib/sun.js using the
//               bar's lat/long. Days name the day the lights come ON; an
//               OFF earlier than the ON is the next morning (2:15 AM).
//   manual      a tap on the iPad holds until the plug's next scheduled
//               ON/OFF, which then takes over again. Nothing to clear.
const cache = require('./cache');
const kasa = require('./drivers/kasa');
const { sunTimes } = require('./sun');
const activity = require('./activity');

const POLL_MS = 20 * 1000;
const STATUS_PUSH_MS = 60 * 1000;
const DISCOVER_MS = 15 * 60 * 1000;
const TICK_MS = 30 * 1000;
const LATE_LIMIT_MS = 15 * 60 * 1000; // after a restart, still fire events up to 15 min late
const CONCURRENCY = 6;
const DEAD_WATTS = 1; // on, but drawing under 1 W

const live = new Map();   // plugId -> { on, watts, reachable, fails, seenAt, error, protocol }
const manual = new Map(); // plugId -> { on, at, by }
let lastTick = Date.now() - 5 * 60 * 1000;
let lastPush = 0;
let timers = [];

const cfg = () => cache.get('config') || {};
const tz = () => (cfg().site && cfg().site.timezone) || 'America/Chicago';
const allPlugs = () => (cfg().plugs || []);
const routines = () => (cfg().light_routines || []);

// ---- Time in the bar's timezone -----------------------------------------
function localParts(instant, zone = tz()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function dowOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// Wall time on a bar-local date -> the actual instant (DST-safe: adjust by
// the zone's offset at that moment, twice).
function zonedInstant(date, hhmm, zone = tz()) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t), zone);
    const [py, pm, pd] = p.date.split('-').map(Number);
    t += want - Date.UTC(py, pm - 1, pd, p.hh, p.mm);
  }
  // A wall time that doesn't exist (2:15 AM the night clocks spring
  // forward) lands on the first real time after the gap: 3:15 AM.
  const p = localParts(new Date(t), zone);
  if (p.hh !== hh || p.mm !== mm) {
    const later = new Date(t + 3600000);
    const q = localParts(later, zone);
    if (q.hh === (hh + 1) % 24 && q.mm === mm) return later;
  }
  return new Date(t);
}

function sunFor(date) {
  const loc = cfg().location;
  if (!loc || loc.latitude == null) return null;
  return sunTimes(date, Number(loc.latitude), Number(loc.longitude));
}

// One ON or OFF moment of a schedule on a bar-local date, or null.
function eventAt(kind, time, offsetMin, date) {
  if (!kind || kind === 'none') return null;
  if (kind === 'time') return time ? zonedInstant(date, time) : null;
  const sun = sunFor(date);
  if (!sun || !sun[kind]) return null;
  return new Date(sun[kind].getTime() + (Number(offsetMin) || 0) * 60000);
}

// The ON/OFF pair a schedule makes for its ON-day `date` (null if it doesn't run that day).
function occurrence(s, date) {
  if (!Array.isArray(s.days) || !s.days.includes(dowOf(date))) return null;
  const on = eventAt(s.on_kind, s.on_time, s.on_offset_min, date);
  let off = eventAt(s.off_kind, s.off_time, s.off_offset_min, date);
  if (on && off && off <= on) off = eventAt(s.off_kind, s.off_time, s.off_offset_min, addDays(date, 1));
  if (!on && !off) return null;
  return { on, off };
}

// Every active schedule and the plugs it drives.
function schedules() {
  const plugs = allPlugs().filter((p) => p.name);
  const out = [];
  for (const r of routines()) {
    if (!r.enabled) continue;
    const ids = plugs.filter((p) => p.schedule_mode === 'routine' && Number(p.routine_id) === Number(r.id)).map((p) => p.id);
    out.push({ key: `r${r.id}`, kind: 'routine', routine: r, sched: r, plugIds: ids, label: r.name });
  }
  for (const p of plugs) {
    if (p.schedule_mode === 'own' && p.own) out.push({ key: `p${p.id}`, kind: 'own', sched: p.own, plugIds: [p.id], label: p.name });
  }
  return out;
}

// Next ON and OFF after `now` for a schedule (looks a week ahead).
function nextEvents(sched, now = new Date()) {
  const today = localParts(now).date;
  let nextOn = null;
  let nextOff = null;
  for (let i = -1; i <= 7 && (!nextOn || !nextOff); i++) {
    const occ = occurrence(sched, addDays(today, i));
    if (!occ) continue;
    if (!nextOn && occ.on && occ.on > now) nextOn = occ.on;
    if (!nextOff && occ.off && occ.off > now) nextOff = occ.off;
  }
  return { on: nextOn, off: nextOff };
}

// Tonight's pair: the occurrence that's running now, else today's.
function currentOccurrence(sched, now = new Date()) {
  const today = localParts(now).date;
  const y = occurrence(sched, addDays(today, -1));
  if (y && y.off && y.off > now && (!y.on || y.on <= now)) return y;
  return occurrence(sched, today);
}

// ---- Talking to plugs -----------------------------------------------------
async function eachLimited(items, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

function plugById(id) { return allPlugs().find((p) => Number(p.id) === Number(id)); }

async function pollOne(p) {
  const st = live.get(p.id) || { fails: 0 };
  if (!p.ip) { live.set(p.id, { ...st, reachable: false, error: 'not found on the network yet' }); return; }
  try {
    const info = await kasa.getInfo(p);
    if (info.mac && p.mac && info.mac !== p.mac) throw Object.assign(new Error('a different plug answered at this address'), { code: 'MOVED' });
    live.set(p.id, { on: info.on, watts: info.watts, reachable: true, fails: 0, seenAt: Date.now(), error: null, protocol: info.protocol });
    if (info.protocol && info.protocol !== p.protocol) p.protocol = info.protocol;
  } catch (e) {
    const fails = (st.fails || 0) + 1;
    // One miss can be Wi-Fi noise; two in a row and it shows as NO ANSWER.
    live.set(p.id, { ...st, fails, reachable: fails < 2 ? !!st.reachable : false, error: e.message });
    if (e.code === 'MOVED') scheduleDiscover(5000);
  }
}

async function pollAll() {
  await eachLimited(allPlugs(), pollOne);
  if (Date.now() - lastPush > STATUS_PUSH_MS) {
    lastPush = Date.now();
    const states = allPlugs().map((p) => ({ id: p.id, ...(live.get(p.id) || {}) }));
    require('./sync').pushPlugStatus(states).catch(() => {});
  }
}

async function setPower(ids, on, { by = 'staff', why = 'manual' } = {}) {
  const failed = [];
  await eachLimited(ids.map(plugById).filter(Boolean), async (p) => {
    try {
      await kasa.setPower(p, on);
      // Watts from before the switch mean nothing now; a fresh reading
      // comes a few seconds later (a sign that just came on isn't "out").
      live.set(p.id, { ...(live.get(p.id) || {}), on, watts: on ? null : 0, reachable: true, fails: 0, seenAt: Date.now(), error: null });
      if (why === 'manual') manual.set(p.id, { on, at: Date.now(), by }); else manual.delete(p.id);
    } catch (e) {
      failed.push(p.name || p.mac);
    }
  });
  setTimeout(() => { eachLimited(ids.map(plugById).filter(Boolean), pollOne).catch(() => {}); }, 4000);
  return { ok: failed.length === 0, failed };
}

async function blink(id) {
  const p = plugById(id);
  if (!p) throw new Error('No such plug on this box yet — it syncs within 30 seconds.');
  if (!p.ip) throw new Error('This plug hasn’t been found on the network yet.');
  return kasa.blink(p);
}

// ---- Discovery ---------------------------------------------------------------
let discovering = null;
function rangesToSweep(extra = []) {
  const c = cfg();
  const set = new Set([...(extra || []), ...((c.site && c.site.scan_ranges) || [])]);
  for (const x of [...(c.tvs || []), ...(c.plugs || [])]) {
    const m = /^(\d+\.\d+\.\d+)\.\d+/.exec(String(x.ip || ''));
    if (m) set.add(`${m[1]}.0/24`);
  }
  return [...set];
}

async function discover(extraRanges) {
  if (discovering) return discovering;
  discovering = (async () => {
    const found = await kasa.discover({ ranges: rangesToSweep(extraRanges) });
    // Fix addresses locally right away; the cloud copy follows on the next pull.
    const config = cfg();
    let changed = false;
    for (const d of found) {
      const p = (config.plugs || []).find((x) => x.mac === d.mac);
      if (p && d.ip && p.ip !== d.ip) { p.ip = d.ip; changed = true; }
    }
    if (changed) cache.set('config', config);
    const sync = require('./sync');
    const r = await sync.pushPlugsSeen(found).catch((e) => ({ error: e.message }));
    return { found: found.length, added: r.added || 0, error: r.error || null, plugs: found };
  })();
  try { return await discovering; } finally { discovering = null; }
}

let discoverTimer = null;
function scheduleDiscover(ms) {
  if (discoverTimer) return;
  discoverTimer = setTimeout(() => { discoverTimer = null; discover().catch(() => {}); }, ms);
}

// ---- Schedule engine -------------------------------------------------------
async function tick() {
  const now = new Date();
  const from = new Date(Math.max(lastTick, now.getTime() - LATE_LIMIT_MS));
  lastTick = now.getTime();
  const today = localParts(now).date;
  for (const s of schedules()) {
    if (!s.plugIds.length) continue;
    for (const date of [addDays(today, -1), today]) {
      const occ = occurrence(s.sched, date);
      if (!occ) continue;
      for (const [which, at] of [['on', occ.on], ['off', occ.off]]) {
        if (!at || at <= from || at > now) continue;
        const r = await setPower(s.plugIds, which === 'on', { by: s.label, why: 'schedule' });
        activity.record(`lights.${s.kind}.${which}`, {
          actor: 'schedule', targetType: s.kind === 'routine' ? 'light_routine' : 'plug',
          targetId: s.kind === 'routine' ? s.routine.id : s.plugIds[0],
          detail: { name: s.label, plugs: s.plugIds.length, failed: r.failed }, result: r.ok ? 'ok' : 'partial',
        });
      }
    }
  }
}

// ---- What the iPad shows -----------------------------------------------------
function iso(d) { return d ? d.toISOString() : null; }

function view() {
  const now = new Date();
  const today = localParts(now).date;
  const sun = sunFor(today);
  const scheds = schedules();
  const routineOut = routines().map((r) => {
    const occ = currentOccurrence(r, now);
    const next = r.enabled ? nextEvents(r, now) : { on: null, off: null };
    const count = allPlugs().filter((p) => p.name && p.schedule_mode === 'routine' && Number(p.routine_id) === Number(r.id)).length;
    return {
      id: r.id, name: r.name, days: r.days, enabled: r.enabled, count,
      on: { kind: r.on_kind, time: r.on_time, offset: r.on_offset_min, at: iso(occ && occ.on) },
      off: { kind: r.off_kind, time: r.off_time, offset: r.off_offset_min, at: iso(occ && occ.off) },
      next_on: iso(next.on), next_off: iso(next.off),
    };
  });
  const plugsOut = allPlugs().filter((p) => p.name).map((p) => {
    const st = live.get(p.id) || {};
    const s = scheds.find((x) => x.plugIds.includes(p.id));
    const occ = s ? currentOccurrence(s.sched, now) : null;
    const next = s ? nextEvents(s.sched, now) : { on: null, off: null };
    const m = manual.get(p.id);
    // A manual tap holds until the plug's next scheduled change after it.
    let manualUntil = null;
    if (m && s) {
      const cand = [next.on, next.off].filter((d) => d && d.getTime() > m.at).sort((a, b) => a - b)[0];
      manualUntil = cand || null;
    }
    return {
      id: p.id, name: p.name, group: p.group_name || 'Lights', sort_order: p.sort_order,
      on: st.on === undefined ? null : st.on, watts: st.watts === undefined ? null : st.watts,
      reachable: !!st.reachable, error: st.reachable ? null : (st.error || 'checking…'),
      dead: !!(st.reachable && st.on && st.watts !== null && st.watts !== undefined && st.watts < DEAD_WATTS),
      schedule_mode: p.schedule_mode, routine_id: p.routine_id, routine_name: s && s.kind === 'routine' ? s.label : null,
      own: p.own, on_at: iso(occ && occ.on), off_at: iso(occ && occ.off),
      manual: m ? { on: m.on, by: m.by, until: iso(manualUntil) } : null,
    };
  });
  return {
    now: iso(now), timezone: tz(),
    sun: sun ? { sunrise: iso(sun.sunrise), sunset: iso(sun.sunset), dawn: iso(sun.dawn), dusk: iso(sun.dusk) } : null,
    routines: routineOut, plugs: plugsOut,
  };
}

function routinePlugIds(routineId) {
  return allPlugs().filter((p) => p.name && p.schedule_mode === 'routine' && Number(p.routine_id) === Number(routineId)).map((p) => p.id);
}

function start() {
  const safe = (fn) => () => fn().catch((e) => console.error('[lights]', e.message));
  timers.push(setInterval(safe(pollAll), POLL_MS));
  timers.push(setInterval(safe(tick), TICK_MS));
  timers.push(setInterval(safe(() => discover()), DISCOVER_MS));
  setTimeout(safe(async () => { if (allPlugs().length || (cfg().light_routines || []).length) await discover(); }), 20 * 1000);
  setTimeout(safe(pollAll), 3000);
}
function stop() { timers.forEach(clearInterval); timers = []; }

module.exports = {
  start, stop, view, setPower, blink, discover, pollAll, tick, routinePlugIds, plugById,
  // for tests
  _internal: { occurrence, nextEvents, zonedInstant, localParts, addDays, currentOccurrence, live, manual, setLastTick: (t) => { lastTick = t; } },
};
