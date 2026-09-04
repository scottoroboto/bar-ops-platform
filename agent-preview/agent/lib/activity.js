// In-memory activity queue + periodic flush to the cloud (docs/venue-
// control.md §11: "All destructive admin actions write to vc_activity with
// actor and origin" -- extended here to the real day-to-day actions staff
// take from the local UI, since that's 90% of what happens and the whole
// point of an audit log for this app is "who turned off the TVs at 2am"
// style questions). Deliberately NOT exhaustive: volume/mute and DirecTV
// key presses (guide/info/up/down/...) are left out as too noisy to be
// worth auditing. Logged: TV power (single+bulk), TV source selection
// (single+bulk), source tune (single+bulk), and layout apply -- see the
// call sites in server.js and lib/scheduler.js.
//
// Queue-and-flush rather than pushing per-action: a burst of bulk-command
// results shouldn't mean a burst of HTTP calls, and losing the last few
// seconds of queued entries on a hard crash is an acceptable trade-off for
// an audit trail, not a source of truth -- same "best-effort" posture as
// reportTvToken/reportTvSlot in lib/sync.js.
const sync = require('./sync');

const queue = [];
const MAX_QUEUE = 500; // drop oldest rather than grow unbounded if the cloud is unreachable for a long stretch
const BATCH_SIZE = 200; // matches POST /api/venue/agent/activity's own per-call cap

// `actor` is passed in per-call (from req.vcActor, set by whichever PIN
// gate matched -- see requireStaffPin/requireAdminPin in server.js) rather
// than held as shared module state, since concurrent requests from
// different PINs (a staff iPad and an admin session at the same time)
// would otherwise race on a single mutable "current actor."
function record(action, { actor, targetType, targetId, detail, result } = {}) {
  queue.push({
    actor: actor || 'staff', origin: 'local', action,
    target_type: targetType || null, target_id: targetId != null ? Number(targetId) : null,
    detail: detail || {}, result: result || 'ok',
  });
  while (queue.length > MAX_QUEUE) queue.shift();
}

async function flush() {
  if (!queue.length) return;
  const batch = queue.splice(0, BATCH_SIZE);
  try {
    await sync.pushActivity(batch);
  } catch (err) {
    // Put it back at the front so the next flush retries it, rather than
    // silently losing it -- same drop-oldest cap as record() above if the
    // outage runs long enough to matter.
    queue.unshift(...batch);
    while (queue.length > MAX_QUEUE) queue.pop();
    console.error('[activity] flush failed (will retry):', err.message);
  }
}

let timer = null;
const FLUSH_MS = 30 * 1000; // matches lib/sync.js's own poll cadence

function start() {
  if (timer) return;
  timer = setInterval(() => { flush().catch((err) => console.error('[activity] flush error:', err.message)); }, FLUSH_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { record, flush, start, stop };
