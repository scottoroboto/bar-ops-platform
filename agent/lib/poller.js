// Source poller (docs/venue-control.md §7.1: "Poller: every 15 seconds,
// staggered across receivers, calling getTuned and mode. Results cached in
// memory and pushed to connected UIs.") -- "pushed to connected UIs" is the
// websocket upgrade path noted in §3/§14 as not needed for v1; for now the
// staff Sources API (agent/server.js) just reads this in-memory cache on
// every request, which is already sub-100ms on the LAN per §3's rationale
// for serving the staff UI locally at all.
//
// Reads its receiver list from the synced site config (lib/sync.js ->
// lib/cache.js's 'config' key) rather than holding its own list -- the
// config is refreshed every 30s independently, so a source added/removed
// in TSB Platform shows up here within one config-poll cycle with no
// restart needed.
const cache = require('./cache');
const directv = require('./drivers/directv');

const POLL_INTERVAL_MS = 15 * 1000;
const STAGGER_STEP_MS = 400; // spreads receivers across the poll window instead of firing them all at once

const state = new Map(); // slot (number) -> { slot, major, minor, active, updatedAt, ok, error }

function currentSources() {
  const config = cache.get('config') || {};
  return (config.sources || []).filter((s) => s.kind === 'directv' && s.enabled !== false && s.ip);
}

async function pollOne(source) {
  const slot = Number(source.slot);
  try {
    const s = await directv.getState(source.ip, source.port || 8080);
    state.set(slot, {
      slot,
      major: s.major,
      minor: s.minor,
      active: s.active,
      updatedAt: new Date().toISOString(),
      ok: true,
      error: null,
    });
  } catch (err) {
    // Keep the last-known channel on a failed poll rather than blanking it
    // -- a receiver that's briefly unreachable shouldn't make the UI forget
    // what it was last known to be showing. `ok: false` is what actually
    // signals the problem to the UI.
    const prev = state.get(slot);
    state.set(slot, {
      slot,
      major: prev ? prev.major : null,
      minor: prev ? prev.minor : null,
      active: null,
      updatedAt: new Date().toISOString(),
      ok: false,
      error: err.message,
    });
  }
}

async function pollAll() {
  const sources = currentSources();
  await Promise.all(sources.map((source, i) =>
    new Promise((resolve) => setTimeout(resolve, i * STAGGER_STEP_MS)).then(() => pollOne(source))
  ));
}

function getState(slot) {
  return state.get(Number(slot)) || null;
}

function getAllState() {
  return Array.from(state.values());
}

// Forces an immediate re-read of one source, bypassing the 15s cadence --
// called right after a tune/key command so the staff UI reflects the new
// channel within a couple seconds instead of waiting for the next tick.
async function pollNow(slot) {
  const source = currentSources().find((s) => Number(s.slot) === Number(slot));
  if (!source) throw new Error(`No enabled DirecTV source at slot ${slot}.`);
  await pollOne(source);
  return getState(slot);
}

let timer = null;

function start() {
  if (timer) return;
  pollAll().catch((err) => console.error('[poller] initial poll failed:', err.message));
  timer = setInterval(() => {
    pollAll().catch((err) => console.error('[poller] poll failed:', err.message));
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, getState, getAllState, pollNow };
