// Events (patch_043): a temporary override on part of the room. "Scenes
// are how the bar normally looks, events are what's on tonight."
//
// An event is a named list of items (same shape as a scene's: tune this
// receiver, put these TVs on that slot and on) plus when it runs and what
// happens after. The box is the only thing that starts or ends one:
//
//   - start: at start_time on its date/days (tick() below), or when staff
//     tap Apply now. Before running the items we snapshot what those TVs
//     and sources were doing, so "put back how they were" can undo it.
//   - end: at end_time, or when staff tap End. after_mode says whether to
//     replay the snapshot (restore), do nothing (leave), or apply a scene.
//
// Conflicts: two events wanting the same TV at once. At start time we do
// not guess -- the staff TVs tab shows a popup (Switch / Stay / Split)
// with a countdown; no answer means Stay, and the new event waits in line
// behind the one running (applied when it ends, if still in its window).
// "Split" alternates the shared TVs down the TV list: 1st stays, 2nd goes
// to the new event, 3rd stays...
//
// Running state lives here in memory and is written up to the cloud
// (vc_events.running_since / running_snapshot) so a box restart mid-event
// recovers it from the next config pull and still ends the event right.
const cache = require('./cache');
const layouts = require('./layouts');
const poller = require('./poller');
const tvPoller = require('./tv-poller');
const sync = require('./sync');

const CONFLICT_COUNTDOWN_MS = 90 * 1000;   // scheduled start with a conflict waits this long for an answer
const CATCH_UP_MINUTES = 10;                // a start missed while the box was down still fires within this window
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const RUNNING = new Map();   // event id -> { since, snapshot, items, endsAt, actor }
const DEFERRED = new Map();  // event id -> { behind: Set<event id>, endsAt, actor }
let PENDING = null;          // { event_id, name, conflicts:[{id,name}], shared_tv_ids, expires_at, actor, source }
const lastStartedKey = new Map(); // event id -> occurrence key already fired
let seeded = false;

function currentConfig() { return cache.get('config') || {}; }
function timezone() { const c = currentConfig(); return (c.site && c.site.timezone) || 'America/Chicago'; }

// ---------------------------------------------------------------- time in the bar's zone

function partsInZone(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const parts = dtf.formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hhmm: `${get('hour')}:${get('minute')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    dow: DAY_NAMES.indexOf(get('weekday')),
  };
}

// Bar-local "YYYY-MM-DD" + "HH:MM" -> epoch ms, DST-correct, without a
// library: start from the UTC guess, measure how far off it lands in the
// zone, correct once (twice around a DST switch).
function zonedToEpoch(dateStr, hhmm, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = partsInZone(new Date(guess), tz);
    const [gy, gm, gd] = p.date.split('-').map(Number);
    const asUtc = Date.UTC(gy, gm - 1, gd, Math.floor(p.minutes / 60), p.minutes % 60);
    const diff = Date.UTC(y, mo - 1, d, h, mi) - asUtc;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// When does an event applied now end? Scheduled kinds end at end_time
// (today's, or tomorrow's if that's already past -- a 7 PM to 1 AM fight
// started at 9 PM ends at 1 AM). Manual events run until End is tapped.
function endsAtFor(event, now = new Date()) {
  if (!event.end_time) return null;
  const tz = timezone();
  const p = partsInZone(now, tz);
  let at = zonedToEpoch(p.date, event.end_time, tz);
  if (at <= now.getTime()) at = zonedToEpoch(addDays(p.date, 1), event.end_time, tz);
  return at;
}

// ---------------------------------------------------------------- reading events

function itemsFor(config, eventId) {
  return (config.event_items || [])
    .filter((it) => Number(it.event_id) === Number(eventId))
    .sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
}

function tvIdsOfItems(items) {
  return [...new Set(items.filter((it) => it.target_type === 'tv').map((it) => Number(it.target_id)))];
}

function runningInfo(id) {
  const r = RUNNING.get(Number(id));
  if (!r) return null;
  return { running: true, running_since: r.since, ends_at: r.endsAt ? new Date(r.endsAt).toISOString() : null, tv_ids: tvIdsOfItems(r.items), actor: r.actor || null };
}

function listEvents() {
  const config = currentConfig();
  return (config.events || []).map((e) => {
    const items = itemsFor(config, e.id);
    const run = runningInfo(e.id);
    const deferred = DEFERRED.get(Number(e.id));
    return {
      ...e, items, tv_ids: tvIdsOfItems(items),
      running: !!run, running_since: run ? run.running_since : null, ends_at: run ? run.ends_at : null, running_tv_ids: run ? run.tv_ids : [],
      waiting_behind: deferred ? [...deferred.behind].map((id) => { const o = (config.events || []).find((x) => Number(x.id) === id); return o ? o.name : `#${id}`; }) : [],
    };
  });
}

function getEvent(idParam) {
  const config = currentConfig();
  const e = (config.events || []).find((x) => Number(x.id) === Number(idParam));
  if (!e) throw new Error(`No event with id ${idParam}.`);
  return { ...e, items: itemsFor(config, e.id) };
}

function pendingConflict() {
  if (!PENDING) return null;
  return { ...PENDING, seconds_left: Math.max(0, Math.round((PENDING.expires_at - Date.now()) / 1000)) };
}

// TVs another running event currently holds -- restore/scene at this
// event's end skips them so we never yank a TV out from under the event
// that took it over (switch) or shares it (split).
function tvsHeldByOthers(exceptId) {
  const held = new Set();
  for (const [id, r] of RUNNING) {
    if (Number(id) === Number(exceptId)) continue;
    for (const tvId of tvIdsOfItems(r.items)) held.add(tvId);
  }
  return held;
}

function conflictsFor(event, items) {
  const wanted = new Set(tvIdsOfItems(items));
  const out = [];
  const shared = new Set();
  for (const [id, r] of RUNNING) {
    if (Number(id) === Number(event.id)) continue;
    const overlap = tvIdsOfItems(r.items).filter((tvId) => wanted.has(tvId));
    if (!overlap.length) continue;
    const other = (currentConfig().events || []).find((x) => Number(x.id) === Number(id));
    out.push({ id: Number(id), name: other ? other.name : `#${id}`, tv_ids: overlap });
    overlap.forEach((t) => shared.add(t));
  }
  return { conflicts: out, sharedTvIds: [...shared] };
}

// ---------------------------------------------------------------- capture

// Builds an event's items from what the highlighted TVs are doing right
// now -- or, when the manager picked a source in column 1 without
// committing it, from that source instead: those TVs on that slot, the
// receiver on the channel given (defaults to whatever it's on now).
// Nothing is sent to any device here; the items are saved for later.
function buildItems({ tvIds, slot, major, minor, appId }) {
  const config = currentConfig();
  const ids = (tvIds || []).map(Number);
  const tvs = (config.tvs || []).filter((t) => ids.includes(Number(t.id)));
  if (!tvs.length) throw new Error('Highlight at least one TV first.');
  const items = [];
  const slotsNeeded = new Set();
  const tvItems = [];
  for (const tv of tvs) {
    const live = tvPoller.getState(tv.id);
    let useSlot = slot != null ? Number(slot) : (live && live.slot != null ? Number(live.slot) : (tv.default_source_slot != null ? Number(tv.default_source_slot) : null));
    if (tv.ip) tvItems.push({ target_type: 'tv', target_id: tv.id, action: { op: 'power', state: 'on' }, step_order: 1 });
    if (useSlot != null && tv.channel_capable) {
      tvItems.push({ target_type: 'tv', target_id: tv.id, action: { op: 'select_slot', slot: useSlot }, step_order: 2 });
      slotsNeeded.add(useSlot);
    }
  }
  for (const s of slotsNeeded) {
    const source = (config.sources || []).find((x) => Number(x.slot) === Number(s));
    if (!source) continue;
    const live = poller.getState(source.slot) || {};
    if (source.kind === 'directv') {
      const useMajor = (slot != null && Number(slot) === Number(s) && major) ? Number(major) : live.major;
      if (useMajor == null) continue;
      const useMinor = (slot != null && Number(slot) === Number(s) && major) ? (minor != null ? Number(minor) : null) : (live.minor ?? null);
      items.push({ target_type: 'source', target_id: source.id, action: { op: 'tune', major: useMajor, minor: useMinor }, step_order: 0 });
    } else if (source.kind === 'roku') {
      const useApp = (slot != null && Number(slot) === Number(s) && appId) ? String(appId) : live.appId;
      if (useApp == null) continue;
      items.push({ target_type: 'source', target_id: source.id, action: { op: 'launch', app_id: useApp }, step_order: 0 });
    }
  }
  items.push(...tvItems);
  if (!items.length) throw new Error('None of those TVs has an address or a source to capture yet.');
  return items;
}

// ---------------------------------------------------------------- apply / end

function pushState(id, body) {
  return sync.reportEventState(id, body).catch((err) => console.error(`[events] failed to push state for #${id}:`, err.message));
}

function summarize(results) {
  const ok = results.filter((r) => r.ok).length;
  return `${ok}/${results.length} item(s) succeeded`;
}

// choice: undefined (ask if there's a conflict), 'switch', 'stay', 'split'.
// Returns { started: true, ... } or { conflict } or { deferred: true }.
async function applyEvent(idParam, { actor, choice, source } = {}) {
  const event = getEvent(idParam);
  if (RUNNING.has(Number(event.id))) throw new Error(`"${event.name}" is already running.`);
  if (event.enabled === false && source === 'schedule') return { skipped: 'disabled' };
  let items = event.items;
  if (!items.length) throw new Error(`"${event.name}" has nothing captured.`);

  const { conflicts, sharedTvIds } = conflictsFor(event, items);
  if (conflicts.length && !choice) {
    PENDING = {
      event_id: Number(event.id), name: event.name, conflicts, shared_tv_ids: sharedTvIds,
      expires_at: Date.now() + CONFLICT_COUNTDOWN_MS, actor: actor || null, source: source || 'manual',
    };
    console.log(`[events] "${event.name}" conflicts with ${conflicts.map((c) => `"${c.name}"`).join(', ')} -- waiting for a choice`);
    return { conflict: pendingConflict() };
  }
  if (PENDING && Number(PENDING.event_id) === Number(event.id)) PENDING = null;

  if (conflicts.length && choice === 'stay') {
    DEFERRED.set(Number(event.id), { behind: new Set(conflicts.map((c) => c.id)), endsAt: endsAtFor(event), actor: actor || null });
    console.log(`[events] "${event.name}" waits behind ${conflicts.map((c) => `"${c.name}"`).join(', ')}`);
    return { deferred: true, behind: conflicts.map((c) => c.name) };
  }

  if (conflicts.length && choice === 'split') {
    // Alternate the shared TVs down the TV list: 1st stays, 2nd moves, ...
    const order = (currentConfig().tvs || []).map((t) => Number(t.id));
    const sharedSorted = [...sharedTvIds].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const moving = new Set(sharedSorted.filter((_, i) => i % 2 === 1));
    items = items.filter((it) => it.target_type !== 'tv' || !sharedTvIds.includes(Number(it.target_id)) || moving.has(Number(it.target_id)));
    if (!tvIdsOfItems(items).length) throw new Error('Splitting left no TVs for this event.');
  }

  let snapshot = layouts.snapshotBefore(items);
  if (conflicts.length && choice === 'switch') {
    // The shared TVs' "how they were" is what they were before the OLD
    // event took them, not the old event's channel -- borrow its snapshot.
    for (const c of conflicts) {
      const old = RUNNING.get(Number(c.id));
      if (!old) continue;
      snapshot = snapshot.filter((s) => !(s.target_type === 'tv' && c.tv_ids.includes(Number(s.target_id))));
      snapshot.push(...old.snapshot.filter((s) => s.target_type === 'tv' && c.tv_ids.includes(Number(s.target_id))));
    }
  }

  const since = new Date().toISOString();
  const endsAt = endsAtFor(event);
  RUNNING.set(Number(event.id), { since, snapshot, items, endsAt, actor: actor || null });
  DEFERRED.delete(Number(event.id));

  if (conflicts.length && choice === 'switch') {
    for (const c of conflicts) {
      if (RUNNING.has(c.id)) await endEvent(c.id, { actor, reason: `switched to "${event.name}"` }).catch((err) => console.error('[events] end during switch failed:', err.message));
    }
  }

  // Tell the cloud before the devices are touched, so a box that dies
  // mid-apply still recovers a running event with its snapshot.
  pushState(event.id, { running: true, running_since: since, running_snapshot: { snapshot, items, ends_at: endsAt, actor: actor || null }, last_run_at: since, last_result: 'starting' });
  const results = await layouts.runItems(items);
  const resultText = `started: ${summarize(results)}`;
  console.log(`[events] "${event.name}" ${resultText}`);
  // Ended (or switched away) while the items were still going out? Then
  // endEvent already told the cloud it stopped -- don't overwrite that.
  const still = RUNNING.get(Number(event.id));
  if (still && still.since === since) {
    pushState(event.id, { running: true, running_since: since, running_snapshot: { snapshot, items, ends_at: endsAt, actor: actor || null }, last_result: resultText });
  }
  return { started: true, event_id: Number(event.id), name: event.name, results, ends_at: endsAt ? new Date(endsAt).toISOString() : null };
}

async function endEvent(idParam, { actor, reason } = {}) {
  const id = Number(idParam);
  const run = RUNNING.get(id);
  if (!run) throw new Error('That event is not running.');
  const config = currentConfig();
  const event = (config.events || []).find((x) => Number(x.id) === id) || { id, name: `#${id}`, after_mode: 'restore' };
  RUNNING.delete(id);
  const held = tvsHeldByOthers(id);
  const notHeld = (it) => it.target_type !== 'tv' || !held.has(Number(it.target_id));
  let results = [];
  let how = 'left as is';
  try {
    if (event.after_mode === 'restore') {
      results = await layouts.runItems((run.snapshot || []).filter(notHeld));
      how = `put back: ${summarize(results)}`;
    } else if (event.after_mode === 'scene' && event.after_layout_id) {
      const scene = layouts.getLayout(event.after_layout_id);
      results = await layouts.runItems(scene.items.filter(notHeld));
      how = `scene "${scene.name}": ${summarize(results)}`;
    }
  } catch (err) {
    how = `after-step failed: ${err.message}`;
  }
  const endedAt = new Date().toISOString();
  const resultText = `ended${reason ? ` (${reason})` : ''}, ${how}`;
  console.log(`[events] "${event.name}" ${resultText}`);
  pushState(id, { running: false, last_ended_at: endedAt, last_result: resultText });
  releaseDeferred().catch((err) => console.error('[events] deferred start failed:', err.message));
  return { ended: true, event_id: id, name: event.name, results, how };
}

// A "stay" answer parks the new event behind the running one(s). Once
// those have ended, start it -- if it is still inside its own window.
async function releaseDeferred() {
  for (const [id, d] of [...DEFERRED]) {
    if ([...d.behind].some((b) => RUNNING.has(Number(b)))) continue;
    DEFERRED.delete(id);
    if (d.endsAt && Date.now() >= d.endsAt) { console.log(`[events] #${id} waited past its own end -- not started`); continue; }
    await applyEvent(id, { actor: d.actor, choice: 'stay', source: 'deferred' }).catch((err) => console.error(`[events] deferred #${id} failed:`, err.message));
  }
}

async function resolveConflict(choice, { actor } = {}) {
  if (!PENDING) throw new Error('Nothing is waiting for an answer.');
  if (!['switch', 'stay', 'split'].includes(choice)) throw new Error('choice must be switch, stay or split.');
  const p = PENDING;
  PENDING = null;
  return applyEvent(p.event_id, { actor: actor || p.actor, choice, source: p.source });
}

// ---------------------------------------------------------------- tick (called by lib/scheduler.js every 30s)

function seedFromConfig() {
  if (seeded) return;
  const config = currentConfig();
  if (!config.events) return;
  seeded = true;
  for (const e of config.events) {
    if (!e.running_since || RUNNING.has(Number(e.id))) continue;
    const snap = e.running_snapshot || {};
    RUNNING.set(Number(e.id), { since: e.running_since, snapshot: snap.snapshot || [], items: snap.items || itemsFor(config, e.id), endsAt: snap.ends_at || endsAtFor(e), actor: snap.actor || null });
    console.log(`[events] recovered running event "${e.name}" from the cloud`);
  }
}

function dueToStart(e, p, tz) {
  if (e.enabled === false || !e.start_time || e.kind === 'manual') return null;
  if (e.kind === 'once') {
    const d = String(e.event_date || '').slice(0, 10);
    if (d !== p.date) return null;
  } else if (e.kind === 'weekly') {
    if (!(e.days || []).map(Number).includes(p.dow)) return null;
  } else return null;
  const startAt = zonedToEpoch(p.date, e.start_time, tz);
  const now = Date.now();
  if (now < startAt || now >= startAt + CATCH_UP_MINUTES * 60 * 1000) return null;
  return `${p.date}T${e.start_time}`;
}

async function tick() {
  seedFromConfig();
  const config = currentConfig();
  const tz = timezone();
  const p = partsInZone(new Date(), tz);

  if (PENDING && Date.now() >= PENDING.expires_at) {
    console.log(`[events] no answer for "${PENDING.name}" -- staying on the current event`);
    await resolveConflict('stay').catch((err) => console.error('[events] auto-stay failed:', err.message));
  }

  for (const [id, r] of [...RUNNING]) {
    if (r.endsAt && Date.now() >= r.endsAt) {
      await endEvent(id, { reason: 'end time' }).catch((err) => console.error(`[events] scheduled end of #${id} failed:`, err.message));
    }
  }

  for (const e of config.events || []) {
    if (RUNNING.has(Number(e.id)) || DEFERRED.has(Number(e.id))) continue;
    if (PENDING && Number(PENDING.event_id) === Number(e.id)) continue;
    const key = dueToStart(e, p, tz);
    if (!key || lastStartedKey.get(Number(e.id)) === key) continue;
    lastStartedKey.set(Number(e.id), key);
    // Ends before it starts (box was down past end_time)? Skip.
    const endsAt = endsAtFor(e);
    const startAt = zonedToEpoch(p.date, e.start_time, tz);
    if (endsAt && endsAt - startAt > 24 * 3600 * 1000) continue;
    await applyEvent(e.id, { actor: 'schedule', source: 'schedule' }).catch((err) => console.error(`[events] scheduled start of "${e.name}" failed:`, err.message));
  }
}

module.exports = {
  listEvents, getEvent, buildItems, applyEvent, endEvent, resolveConflict, pendingConflict, tick,
  // for tests
  _internal: { RUNNING, DEFERRED, zonedToEpoch, partsInZone, endsAtFor, reset() { RUNNING.clear(); DEFERRED.clear(); PENDING = null; lastStartedKey.clear(); seeded = false; }, setPending(v) { PENDING = v; } },
};
