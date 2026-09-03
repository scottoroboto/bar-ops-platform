// Whole-room layouts (docs/venue-control.md §5/§12 Phase 5: "Whole-room
// presets with capture-current-state..."). A layout is an ordered list of
// items -- { target_type: 'source'|'tv', target_id, action, step_order } --
// read from the synced config the same way every other lib/* module reads
// its own slice (cache.get('config'); the agent never talks to Postgres
// directly). This module owns the one execution path for "run this
// layout," shared by:
//   - agent/server.js's staff-facing POST /api/layouts/:id/apply
//   - agent/server.js's admin-only POST /api/admin/layouts/:id/capture
//     (captureCurrentState()) and the undo replay route (replay())
//   - lib/scheduler.js's "apply_layout" schedule action
//
// target_id for a source item is the source's actual vc_sources.id (see
// §5's own example: { "target_type": "source", "target_id": 4, ... }), NOT
// its slot -- every route through Phase 4 keyed sources purely by slot, so
// GET /api/venue/agent/config had to be extended to send source ids too
// (see server/index.js's Phase 5 comment on that map()).
const cache = require('./cache');
const directv = require('./drivers/directv');
const samsungWs = require('./drivers/samsung-ws');
const poller = require('./poller');
const tvPoller = require('./tv-poller');
const sync = require('./sync');

const CONCURRENCY = 4; // matches every other bulk operation in this app (§7.2)

function currentConfig() {
  return cache.get('config') || {};
}

function itemsForLayout(config, layoutId) {
  return (config.layout_items || [])
    .filter((it) => Number(it.layout_id) === Number(layoutId))
    .sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
}

function listLayouts() {
  const config = currentConfig();
  return (config.layouts || []).map((l) => ({ ...l, items: itemsForLayout(config, l.id) }));
}

function getLayout(idParam) {
  const id = Number(idParam);
  const config = currentConfig();
  const layout = (config.layouts || []).find((l) => Number(l.id) === id);
  if (!layout) throw new Error(`No layout with id ${idParam}.`);
  return { ...layout, items: itemsForLayout(config, id) };
}

// Same gate as agent/server.js's requireChannelCapable -- duplicated
// rather than imported to avoid a circular require (server.js requires
// this module, not the other way around).
function requireChannelCapable(tv) {
  if (!tv.channel_capable) {
    throw new Error(`"${tv.name}" isn't marked channel-capable yet -- see TVs → Channel capable in TSB Platform.`);
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

async function runOneItem(item) {
  const config = currentConfig();
  if (item.target_type === 'source') {
    const source = (config.sources || []).find((s) => Number(s.id) === Number(item.target_id));
    if (!source) return { ok: false, target_type: 'source', target_id: item.target_id, error: 'Source no longer exists.' };
    if (item.action.op !== 'tune') return { ok: false, target_type: 'source', target_id: item.target_id, error: `Unsupported source action "${item.action.op}".` };
    if (source.kind !== 'directv' || !source.ip) return { ok: false, target_type: 'source', target_id: item.target_id, label: source.label, error: `Source "${source.label}" isn't a configured DirecTV receiver.` };
    try {
      await directv.tune(source.ip, source.port || 8080, item.action.major, item.action.minor);
      await poller.pollNow(source.slot);
      return { ok: true, target_type: 'source', target_id: item.target_id, slot: source.slot, label: source.label };
    } catch (err) {
      return { ok: false, target_type: 'source', target_id: item.target_id, label: source.label, error: err.message };
    }
  }
  if (item.target_type === 'tv') {
    const tv = (config.tvs || []).find((t) => Number(t.id) === Number(item.target_id));
    if (!tv) return { ok: false, target_type: 'tv', target_id: item.target_id, error: 'TV no longer exists.' };
    if (!tv.ip) return { ok: false, target_type: 'tv', target_id: item.target_id, name: tv.name, error: `"${tv.name}" has no IP address configured yet.` };
    try {
      if (item.action.op === 'power') {
        const result = await samsungWs.setPower(tv, item.action.state);
        if (result.token && result.token !== tv.ws_token) sync.reportTvToken(tv.id, result.token).catch((err) => console.error('[layouts] failed to push captured ws_token:', err.message));
        await tvPoller.pollNow(tv.id).catch(() => {});
        return { ok: result.ok, target_type: 'tv', target_id: item.target_id, name: tv.name, state: item.action.state };
      }
      if (item.action.op === 'select_slot') {
        const source = (config.sources || []).find((s) => Number(s.slot) === Number(item.action.slot));
        if (!source) return { ok: false, target_type: 'tv', target_id: item.target_id, name: tv.name, error: `No source at slot ${item.action.slot}.` };
        requireChannelCapable(tv);
        const result = await samsungWs.selectChannel(tv, source.qam_channel);
        if (result.token && result.token !== tv.ws_token) sync.reportTvToken(tv.id, result.token).catch((err) => console.error('[layouts] failed to push captured ws_token:', err.message));
        tvPoller.reportSlot(tv.id, item.action.slot);
        sync.reportTvSlot(tv.id, item.action.slot).catch((err) => console.error('[layouts] failed to push last_known_slot:', err.message));
        return { ok: result.ok, target_type: 'tv', target_id: item.target_id, name: tv.name, slot: Number(item.action.slot) };
      }
      return { ok: false, target_type: 'tv', target_id: item.target_id, name: tv.name, error: `Unsupported TV action "${item.action.op}".` };
    } catch (err) {
      return { ok: false, target_type: 'tv', target_id: item.target_id, name: tv.name, error: err.message };
    }
  }
  return { ok: false, error: `Unknown target_type "${item.target_type}".` };
}

// Runs items grouped by step_order -- each group in parallel (concurrency
// 4), groups themselves run in ascending step_order so a layout that,
// say, tunes receivers in step 0 and turns TVs on in step 1 does so in
// that order, while items that share a step (e.g. every TV in the room)
// fan out together instead of one-at-a-time.
async function runItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.step_order || 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const results = [];
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    results.push(...(await mapWithConcurrency(groups.get(key), CONCURRENCY, runOneItem)));
  }
  return results;
}

// Captures "what were these targets doing right before" for exactly the
// items a layout is about to touch -- purely in-memory, nothing persisted.
// §10: "one tap to apply, with a 15-second undo bar rather than a
// confirmation dialog." The staff Layouts tab holds this snapshot
// client-side and, if undo is tapped within the window, POSTs it straight
// back to replay() below -- it is never written to the database as a real
// layout of its own.
function snapshotBefore(items) {
  const config = currentConfig();
  const seen = new Set();
  const snap = [];
  let step = 0;
  for (const item of items) {
    const key = `${item.target_type}:${item.target_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.target_type === 'tv') {
      const live = tvPoller.getState(item.target_id);
      if (!live) continue;
      if (live.power && live.power !== 'unreachable') snap.push({ target_type: 'tv', target_id: item.target_id, action: { op: 'power', state: live.power === 'on' ? 'on' : 'off' }, step_order: step });
      if (live.slot != null) snap.push({ target_type: 'tv', target_id: item.target_id, action: { op: 'select_slot', slot: live.slot }, step_order: step + 1 });
    } else if (item.target_type === 'source') {
      const source = (config.sources || []).find((s) => Number(s.id) === Number(item.target_id));
      const live = source ? poller.getState(source.slot) : null;
      if (!live || live.major == null) continue;
      snap.push({ target_type: 'source', target_id: item.target_id, action: { op: 'tune', major: live.major, minor: live.minor }, step_order: step });
    }
  }
  return snap;
}

async function apply(idParam) {
  const layout = getLayout(idParam);
  const undo = snapshotBefore(layout.items);
  const results = await runItems(layout.items);
  return { layout_id: layout.id, name: layout.name, results, undo };
}

// Replays a raw items array exactly like apply() runs a layout's items --
// this is what the staff Layouts tab's undo bar calls with the snapshot
// apply() handed back, and it's also how a from-scratch capture's items
// could be dry-run tested. No layout lookup, no persistence.
async function replay(items) {
  if (!Array.isArray(items)) throw new Error('Missing "items" array.');
  return { results: await runItems(items) };
}

// Builds items from CURRENT live state -- the admin-only POST /api/admin/
// layouts/:id/capture route reads this and pushes the result to the cloud
// (sync.pushLayoutItems). Only includes targets the agent actually has
// fresh live data for; a source/TV that's never been polled, or has no
// prior reading, is left out rather than capturing a guess.
function captureCurrentState() {
  const config = currentConfig();
  const items = [];
  let step = 0;
  for (const source of config.sources || []) {
    const live = poller.getState(source.slot);
    if (!live || live.major == null) continue;
    items.push({ target_type: 'source', target_id: source.id, action: { op: 'tune', major: live.major, minor: live.minor }, step_order: step++ });
  }
  for (const tv of config.tvs || []) {
    const live = tvPoller.getState(tv.id);
    if (!live) continue;
    if (live.power && live.power !== 'unreachable') items.push({ target_type: 'tv', target_id: tv.id, action: { op: 'power', state: live.power === 'on' ? 'on' : 'off' }, step_order: step++ });
    if (live.slot != null) items.push({ target_type: 'tv', target_id: tv.id, action: { op: 'select_slot', slot: live.slot }, step_order: step++ });
  }
  return items;
}

module.exports = { listLayouts, getLayout, apply, replay, captureCurrentState, runOneItem, runItems };
