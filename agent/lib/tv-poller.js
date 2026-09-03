// TV state poller -- same shape as lib/poller.js (DirecTV), but for TVs.
// Only polls power state via the plain HTTP PowerState read
// (samsung-ws.js's getPowerState -- a single GET, not a WS connection), so
// this stays cheap even at ~50 TVs. TVs with control_method "unknown" or
// "none" are skipped: there's nothing to poll yet (discovery hasn't
// determined a control path, or the set genuinely has none), and polling
// them would just be a guaranteed-timeout HTTP call every cycle for no
// benefit -- they still show up in /api/tvs, just with live: null.
const cache = require('./cache');
const samsungWs = require('./drivers/samsung-ws');

const POLL_INTERVAL_MS = 20 * 1000;
const STAGGER_STEP_MS = 300;
const POLLABLE_METHODS = new Set(['samsung_ws_token', 'samsung_ws_plain', 'samsung_legacy', 'smartthings']);

const state = new Map(); // tv id (number) -> { id, power, updatedAt, ok, error }

function currentTvs() {
  const config = cache.get('config') || {};
  return (config.tvs || []).filter((t) => t.enabled !== false && t.ip && POLLABLE_METHODS.has(t.control_method));
}

async function pollOne(tv) {
  const id = Number(tv.id);
  try {
    const power = await samsungWs.getPowerState(tv);
    state.set(id, { id, power, updatedAt: new Date().toISOString(), ok: true, error: null });
  } catch (err) {
    const prev = state.get(id);
    state.set(id, {
      id,
      power: prev ? prev.power : 'unreachable',
      updatedAt: new Date().toISOString(),
      ok: false,
      error: err.message,
    });
  }
}

async function pollAll() {
  const tvs = currentTvs();
  await Promise.all(tvs.map((tv, i) =>
    new Promise((resolve) => setTimeout(resolve, i * STAGGER_STEP_MS)).then(() => pollOne(tv))
  ));
}

function getState(id) {
  return state.get(Number(id)) || null;
}

function getAllState() {
  return Array.from(state.values());
}

// Forces an immediate re-read of one TV, bypassing the poll cadence --
// called right after a power command so the staff UI reflects the real
// result within a couple seconds rather than waiting for the next tick.
async function pollNow(id) {
  const config = cache.get('config') || {};
  const tv = (config.tvs || []).find((t) => Number(t.id) === Number(id));
  if (!tv) throw new Error(`No TV with id ${id} in the synced config.`);
  await pollOne(tv);
  return getState(id);
}

let timer = null;

function start() {
  if (timer) return;
  pollAll().catch((err) => console.error('[tv-poller] initial poll failed:', err.message));
  timer = setInterval(() => {
    pollAll().catch((err) => console.error('[tv-poller] poll failed:', err.message));
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, getState, getAllState, pollNow };
