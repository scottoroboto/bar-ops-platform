// Schedule engine (docs/venue-control.md §5/§12 Phase 3: "Cron is evaluated
// by the agent in the site's own timezone, so open/close times follow DST
// without intervention. Typical rows: all TVs on at 10:45, all off at
// 01:30, Sunday NFL layout at 09:50.") Reads vc_schedules rows from the
// synced config (same cache.get('config') pattern as poller.js/tv-poller.js)
// rather than talking to Postgres directly -- the agent never does.
//
// Only a plain 5-field cron subset is supported: '*', a number, a
// comma-list, a range "a-b", and a step "*/n" or "a-b/n" -- enough for
// every schedule shape the spec's own examples use, without pulling in a
// cron library (the repo's own constraint is "exactly three runtime
// dependencies", already stretched once for `ws` -- not stretching it
// again for something this small).
//
// action_type "apply_layout" (Phase 5, docs/venue-control.md §12) runs the
// layout's items through lib/layouts.js -- the same execution path the
// staff Layouts tab's tap-to-apply and the admin capture/undo routes use,
// so a scheduled "Sunday NFL layout at 09:50" (§5's own example) behaves
// identically to a human tapping it.
const cache = require('./cache');
const directv = require('./drivers/directv');
const samsungWs = require('./drivers/samsung-ws');
const poller = require('./poller');
const tvPoller = require('./tv-poller');
const sync = require('./sync');
const layouts = require('./layouts');

const TICK_MS = 30 * 1000; // sub-minute so a minute is never skipped even with a little jitter
const BULK_TV_CONCURRENCY = 4; // docs/venue-control.md §7.2: "Bulk operations run with concurrency 4"

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ---------------------------------------------------------------- cron matching

function parseCronField(field, min, max) {
  const set = new Set();
  for (const part of String(field).split(',')) {
    let m;
    if (part === '*') { for (let v = min; v <= max; v++) set.add(v); continue; }
    if ((m = part.match(/^\*\/(\d+)$/))) { const step = Number(m[1]); for (let v = min; v <= max; v += step) set.add(v); continue; }
    if ((m = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/))) {
      const a = Number(m[1]), b = Number(m[2]), step = Number(m[3] || 1);
      for (let v = a; v <= b; v += step) set.add(v);
      continue;
    }
    if ((m = part.match(/^(\d+)$/))) { set.add(Number(m[1])); continue; }
    throw new Error(`Unsupported cron field segment "${part}".`);
  }
  return set;
}

function cronMatches(cronExpr, parts) {
  const fields = String(cronExpr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron_expr "${cronExpr}" must have exactly 5 fields (minute hour dom month dow).`);
  const [mi, hr, dom, mo, dow] = fields;
  return (
    parseCronField(mi, 0, 59).has(parts.minute) &&
    parseCronField(hr, 0, 23).has(parts.hour) &&
    parseCronField(dom, 1, 31).has(parts.dom) &&
    parseCronField(mo, 1, 12).has(parts.month) &&
    parseCronField(dow, 0, 6).has(parts.dow)
  );
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Reads the current wall-clock time in the site's own IANA timezone via
// Intl (stdlib, no package) rather than a fixed UTC offset -- this is what
// makes DST transitions "just work" the way the spec calls for.
function nowPartsInZone(timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'America/Los_Angeles',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const parts = dtf.formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')),
    dom: Number(get('day')),
    month: Number(get('month')),
    dow: WEEKDAY_INDEX[get('weekday')],
    minuteKey: `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`,
  };
}

// ---------------------------------------------------------------- concurrency-limited map

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); } catch (err) { results[i] = { error: err.message }; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------- action execution

function currentTvs() {
  const config = cache.get('config') || {};
  return config.tvs || [];
}

function currentSources() {
  const config = cache.get('config') || {};
  return config.sources || [];
}

function tvTargets(payload) {
  const all = currentTvs().filter((t) => t.enabled !== false);
  if (Array.isArray(payload.tv_ids) && payload.tv_ids.length) {
    const ids = new Set(payload.tv_ids.map(Number));
    return all.filter((t) => ids.has(Number(t.id)));
  }
  if (payload.zone_id != null) {
    return all.filter((t) => Number(t.zone_id) === Number(payload.zone_id));
  }
  return all; // no zone_id/tv_ids given -- whole site, per §8.2's POST /api/tvs/bulk/power shape
}

async function runTvsPower(payload) {
  if (payload.state !== 'on' && payload.state !== 'off') {
    throw new Error(`tvs_power payload needs "state": "on" or "off" (got ${JSON.stringify(payload.state)}).`);
  }
  const targets = tvTargets(payload).filter((t) => t.ip);
  const results = await mapWithConcurrency(targets, BULK_TV_CONCURRENCY, async (tv) => {
    const result = await samsungWs.setPower(tv, payload.state);
    if (result.token && result.token !== tv.ws_token) {
      sync.reportTvToken(tv.id, result.token).catch((err) => console.error('[scheduler] failed to push captured ws_token:', err.message));
    }
    await tvPoller.pollNow(tv.id).catch(() => {});
    return { id: tv.id, name: tv.name, ...result };
  });
  const ok = results.filter((r) => r.ok).length;
  return `${ok}/${results.length} TV(s) confirmed ${payload.state}`;
}

async function runSourceTune(payload) {
  const slots = Array.isArray(payload.slots) ? payload.slots : payload.slot != null ? [payload.slot] : [];
  if (!slots.length) throw new Error('source_tune payload needs "slot" or "slots".');
  if (!payload.major) throw new Error('source_tune payload needs "major".');
  const sources = currentSources();
  const results = await Promise.all(slots.map(async (slot) => {
    const source = sources.find((s) => Number(s.slot) === Number(slot));
    if (!source) return { slot, ok: false, error: `No source at slot ${slot}.` };
    if (source.kind !== 'directv' || !source.ip) return { slot, ok: false, error: `Source at slot ${slot} isn't a configured DirecTV receiver.` };
    try {
      await directv.tune(source.ip, source.port || 8080, payload.major, payload.minor);
      await poller.pollNow(slot);
      return { slot, ok: true };
    } catch (err) {
      return { slot, ok: false, error: err.message };
    }
  }));
  const ok = results.filter((r) => r.ok).length;
  return `${ok}/${results.length} source(s) tuned to ${payload.major}${payload.minor ? `.${payload.minor}` : ''}`;
}

async function runApplyLayout(payload) {
  if (payload.layout_id == null) throw new Error('apply_layout payload needs "layout_id".');
  const { name, results } = await layouts.apply(payload.layout_id);
  const ok = results.filter((r) => r.ok).length;
  return `layout "${name}" applied: ${ok}/${results.length} item(s) succeeded`;
}

async function runSchedule(schedule) {
  const payload = schedule.payload || {};
  let resultText;
  try {
    if (schedule.action_type === 'tvs_power') resultText = await runTvsPower(payload);
    else if (schedule.action_type === 'source_tune') resultText = await runSourceTune(payload);
    else if (schedule.action_type === 'apply_layout') resultText = await runApplyLayout(payload);
    else resultText = `Unknown action_type "${schedule.action_type}" -- nothing run.`;
  } catch (err) {
    resultText = `Failed: ${err.message}`;
  }
  console.log(`[scheduler] "${schedule.name}" (#${schedule.id}) fired: ${resultText}`);
  sync.reportScheduleResult(schedule.id, resultText).catch((err) => console.error('[scheduler] failed to push result to cloud:', err.message));
}

// ---------------------------------------------------------------- tick loop

const lastFiredKey = new Map(); // schedule id -> minuteKey already fired for, so a 30s tick never double-fires within one minute

async function tick() {
  const config = cache.get('config') || {};
  const schedules = (config.schedules || []).filter((s) => s.enabled !== false);
  if (!schedules.length) return;
  const timezone = (config.site && config.site.timezone) || 'America/Los_Angeles';
  const parts = nowPartsInZone(timezone);
  for (const schedule of schedules) {
    if (lastFiredKey.get(schedule.id) === parts.minuteKey) continue;
    let matched;
    try {
      matched = cronMatches(schedule.cron_expr, parts);
    } catch (err) {
      console.error(`[scheduler] schedule #${schedule.id} "${schedule.name}" has a bad cron_expr: ${err.message}`);
      continue;
    }
    if (!matched) continue;
    lastFiredKey.set(schedule.id, parts.minuteKey);
    runSchedule(schedule).catch((err) => console.error(`[scheduler] schedule #${schedule.id} threw unexpectedly:`, err.message));
  }
}

let timer = null;

function start() {
  if (timer) return;
  tick().catch((err) => console.error('[scheduler] initial tick failed:', err.message));
  timer = setInterval(() => { tick().catch((err) => console.error('[scheduler] tick failed:', err.message)); }, TICK_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, cronMatches, parseCronField, nowPartsInZone, tick };
