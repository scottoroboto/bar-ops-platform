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
const sonos = require('./sonos');

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

  // The bar's Sonos (Oct 2026: T1's Connect came back from a power cut as
  // "Unnamed Room" with its setup gone, and nobody knew until a bartender
  // tapped a station at noon). Reported once a Sonos has ever been found,
  // so a bar without one never shows an alert for it.
  const music = sonos.getState();
  if (music && music.player) {
    const site = (config.site || {}).name || 'the bar';
    let status = 'online'; let message = null;
    if (!music.ok) { status = 'offline'; message = `The Sonos at ${site} isn’t answering (${music.error || 'no reply'}).`; }
    else if (music.player.unnamed) { status = 'warning'; message = `The Sonos at ${site} lost its setup: it shows as "Unnamed Room" and can’t play. Set it up again in the Sonos app (Settings → Switch system → Set up a new system), add Pandora, play one station.`; }
    items.push({
      targetType: 'music', targetId: 'sonos', name: `Sonos (${music.player.name || 'music'})`, status, message,
      detail: { ip: music.player.ip, model: music.player.model, room: music.player.name, error: music.error || null, updatedAt: music.updatedAt },
    });
  }

  return items;
}

// The cloud answers every health push with the "attention" list -- TVs at
// this bar that have been unreachable 3+ minutes inside TV hours and
// aren't cleared (cloud patch_034). Cached so the staff page can read it
// from the box without a cloud round-trip per refresh.
function rememberAttention(list) {
  cache.set('attention', Array.isArray(list) ? list : []);
  cache.set('attentionAt', new Date().toISOString());
}
function getAttention() {
  return cache.get('attention') || [];
}

async function reportOnce() {
  const items = buildItems();
  if (!items.length) return; // nothing pollable yet -- no TVs/sources with a control path configured
  try {
    const data = await sync.pushHealth(items);
    if (data && Array.isArray(data.attention)) rememberAttention(data.attention);
  } catch (err) {
    console.error('[health] push failed (will retry next cycle):', err.message);
  }
}

// WAN ports (cable / fiber / cell) off the gateway, same cadence, only
// when this box has UDM credentials. Independent of the TV/source items
// so a bar with no TVs adopted yet still reports its lines.
const unifiLocal = require('./unifi-local');
let lastWanSig = null;
let lastWanError = null;
function noteWanError(msg) { if (msg !== lastWanError) { console.warn(`[health] ${msg}`); lastWanError = msg; } }
async function reportWans() {
  if (!unifiLocal.configured()) return;
  let wans;
  // UDM unreachable: say nothing to the cloud rather than guess, but say
  // it once in the log so a bad address or login isn't silent (Oct 2026).
  try { wans = await unifiLocal.wanLinks(); } catch (err) { noteWanError(`UniFi read failed: ${err.message}`); return; }
  if (!wans.length) { noteWanError('UniFi answered but listed no WAN links on the gateway.'); return; }
  let clients = null;
  try { clients = await unifiLocal.clientCount(); } catch (err) { noteWanError(`UniFi client count failed: ${err.message}`); }
  if (lastWanError) { console.log('[health] UniFi reads are working again'); lastWanError = null; }
  try {
    await sync.pushWans(wans, clients);
    const sig = wans.map((w) => `${w.port}:${w.up ? 'up' : 'down'}:${w.ip || ''}`).join(' ');
    if (sig !== lastWanSig) { console.log(`[health] wan links: ${sig}`); lastWanSig = sig; }
  } catch (err) {
    console.error('[health] wan push failed (will retry next cycle):', err.message);
  }
}

let timer = null;

function start() {
  if (timer) return;
  setTimeout(() => { reportOnce().catch(() => {}); reportWans().catch(() => {}); }, FIRST_REPORT_DELAY_MS);
  timer = setInterval(() => {
    reportOnce().catch(() => {});
    reportWans().catch(() => {});
  }, REPORT_INTERVAL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, reportOnce, reportWans, buildItems, getAttention, rememberAttention };
