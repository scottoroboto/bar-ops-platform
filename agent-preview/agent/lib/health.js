// A9 AV Device Health (docs/venue-control-gui-reconciliation.md) — pushes
// TV/source reachability up to TSB Platform's monitored_systems/
// system_status/system_alerts tables (server/monitoring.js's
// reportAvHealth()) so equipment problems show on the cloud admin's
// Device Health tab and fire the same alert-open/close/notify pipeline as
// every other monitored category (network/hvac/refrigeration/etc) — a new
// 'av' category feeding the platform's existing monitoring system, not a
// separate one.
//
// Deliberately reuses lib/poller.js's and lib/tv-poller.js's own in-memory
// state rather than polling anything itself — those already know per-
// device reachability every 15-20s to serve the local staff UI, so this
// just samples that state once a minute and reports it up. A device with
// no control path yet (TV control_method 'unknown'/'none', a static/spare
// source slot) never appears in either poller's state, so it's silently
// left out here too — there's nothing to say about equipment nothing can
// reach, and reporting a meaningless 'unknown' status for every unwired
// slot would just be noise on the cloud dashboard.
const cache = require('./cache');
const sourcePoller = require('./poller');
const tvPoller = require('./tv-poller');
const sync = require('./sync');

const REPORT_INTERVAL_MS = 60 * 1000; // matches the cloud's own monitoring poll cadence (server/index.js)
const FIRST_REPORT_DELAY_MS = 20 * 1000; // let the pollers complete at least one cycle first

function tvStatus(state) {
  if (!state.ok) return 'offline';
  if (state.power === 'unreachable') return 'offline';
  return 'online'; // on/standby/off are all commanded states, not equipment failures
}

function sourceStatus(state) {
  return state.ok ? 'online' : 'offline';
}

function tvName(tv, state) {
  if (!tv) return `TV ${state.id}`;
  return tv.tag ? `${tv.name} (${tv.tag})` : tv.name;
}

function buildItems() {
  const config = cache.get('config') || {};
  const tvsById = new Map((config.tvs || []).map((t) => [Number(t.id), t]));
  const sourcesBySlot = new Map((config.sources || []).map((s) => [Number(s.slot), s]));

  const items = [];

  for (const state of tvPoller.getAllState()) {
    const tv = tvsById.get(state.id);
    items.push({
      targetType: 'tv',
      targetId: state.id,
      name: tvName(tv, state),
      status: tvStatus(state),
      detail: { power: state.power, error: state.error || null, updatedAt: state.updatedAt },
    });
  }

  for (const state of sourcePoller.getAllState()) {
    const source = sourcesBySlot.get(state.slot);
    items.push({
      targetType: 'source',
      targetId: state.slot,
      name: source ? source.label : `Source slot ${state.slot}`,
      status: sourceStatus(state),
      detail: { kind: state.kind, active: state.active, error: state.error || null, updatedAt: state.updatedAt },
    });
  }

  return items;
}

async function reportOnce() {
  const items = buildItems();
  if (!items.length) return; // nothing pollable yet -- no TVs/sources with a control path configured
  try {
    await sync.pushHealth(items);
  } catch (err) {
    console.error('[health] push failed (will retry next cycle):', err.message);
  }
}

let timer = null;

function start() {
  if (timer) return;
  setTimeout(() => { reportOnce().catch(() => {}); }, FIRST_REPORT_DELAY_MS);
  timer = setInterval(() => {
    reportOnce().catch(() => {});
  }, REPORT_INTERVAL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, reportOnce, buildItems };
