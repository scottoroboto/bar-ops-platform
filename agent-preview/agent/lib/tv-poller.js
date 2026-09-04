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

const state = new Map(); // tv id (number) -> { id, power, updatedAt, ok, error, slot, slotUpdatedAt }

function currentTvs() {
  const config = cache.get('config') || {};
  return (config.tvs || []).filter((t) => t.enabled !== false && t.ip && POLLABLE_METHODS.has(t.control_method));
}

// Power is actively polled (below); slot/channel has no equivalent readback
// -- Samsung exposes no "what's the tuner showing" endpoint -- so slot is
// purely "last commanded", set by reportSlot() right after a §7.2 channel-
// select command succeeds. Every power poll must preserve whatever slot
// value is already cached rather than overwriting it with nothing. On the
// very first poll after an agent restart there's no in-memory slot yet, so
// fall back to vc_tvs.last_known_slot (synced down in the site config) --
// a best-effort "probably still showing this" rather than leaving it blank
// until the next real command.
async function pollOne(tv) {
  const id = Number(tv.id);
  const prev = state.get(id);
  const fallbackSlot = tv.last_known_slot != null ? Number(tv.last_known_slot) : null;
  const slot = prev ? prev.slot : fallbackSlot;
  const slotUpdatedAt = prev ? prev.slotUpdatedAt : null;
  try {
    const power = await samsungWs.getPowerState(tv);
    state.set(id, { id, power, updatedAt: new Date().toISOString(), ok: true, error: null, slot, slotUpdatedAt });
  } catch (err) {
    state.set(id, {
      id,
      power: prev ? prev.power : 'unreachable',
      updatedAt: new Date().toISOString(),
      ok: false,
      error: err.message,
      slot,
      slotUpdatedAt,
    });
  }
}

// Called right after a successful §7.2 channel-select command (agent/
// server.js's /api/tvs/:id/slot and bulk/slot). Merges into whatever power
// state is already cached rather than replacing it, since a channel-select
// command says nothing about power state.
function reportSlot(id, slot) {
  const key = Number(id);
  const prev = state.get(key) || { id: key, power: 'unreachable', updatedAt: null, ok: false, error: null, slot: null, slotUpdatedAt: null };
  state.set(key, { ...prev, slot: Number(slot), slotUpdatedAt: new Date().toISOString() });
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

module.exports = { start, stop, getState, getAllState, pollNow, reportSlot };
