// DirecTV SHEF driver (docs/venue-control.md §7.1) -- plain HTTP GET to port
// 8080, verified working against a real H25 at Ticket 3 (see §2's captured
// sample). This is the control-plane driver used by the poller and the
// staff Sources API; it's deliberately separate from
// lib/discovery/scanner.js's probeDirectv(), which only does a bare
// getVersion() for classification during a scan and has no reason to share
// this file's per-receiver queue.
//
// Same shape as every driver per §7: identify(), getState(), plus the
// capability methods a receiver actually has (tune, processKey, getProgInfo).
const TIMEOUT_MS = 4000; // §7.1: "a sleeping or rebooting receiver *hangs*
                          // rather than refusing, so timeouts matter more
                          // than error handling."
const MIN_GAP_MS = 350;  // §7.1: "SHEF is single-threaded. Requests to one
                          // receiver must be serialized with a ~350ms
                          // minimum gap. Bursts cause hangs, not errors."
const DEFAULT_PORT = 8080;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- queueing
//
// One queue per receiver IP so "different receivers are independent and can
// be driven in parallel" (§7.1) falls out naturally -- each IP gets its own
// chain, and chains for different IPs never wait on each other. Within one
// receiver's chain, each call waits for MIN_GAP_MS to have elapsed since the
// *start* of the previous call before firing, which is what keeps SHEF from
// seeing a burst.
const receiverQueues = new Map(); // ip -> { chain: Promise, lastStartedAt: number }

function scheduleForReceiver(ip, fn) {
  const state = receiverQueues.get(ip) || { chain: Promise.resolve(), lastStartedAt: 0 };
  const result = state.chain.then(async () => {
    const wait = Math.max(0, state.lastStartedAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await sleep(wait);
    state.lastStartedAt = Date.now();
    return fn();
  });
  // The chain itself must never reject, or every call queued after a
  // failure would be skipped -- callers still see the real rejection via
  // `result`, this is purely for sequencing the next item.
  state.chain = result.then(() => undefined, () => undefined);
  receiverQueues.set(ip, state);
  return result;
}

// ------------------------------------------------------------------ SHEF GET
//
// Every SHEF response carries its real result in an inner `status.code`
// (§7.1: "Responses carry status.code inside a 200 body. Check the inner
// code, not just the HTTP status."), so a non-200 inner code is surfaced as
// a thrown error the same as an HTTP-level failure -- callers don't need to
// separately check both.
async function shefGet(ip, port, pathAndQuery) {
  const url = `http://${ip}:${port}${pathAndQuery}`;
  const res = await fetchWithTimeout(url, {}, TIMEOUT_MS);
  if (!res.ok) throw new Error(`DirecTV ${ip} ${pathAndQuery} -> HTTP ${res.status}`);
  const data = await res.json();
  const code = data && data.status && data.status.code;
  if (typeof code === 'number' && code !== 200) {
    throw new Error(`DirecTV ${ip} ${pathAndQuery} -> status ${code} ${(data.status.msg || '').trim()}`.trim());
  }
  return data;
}

function queuedGet(ip, port, pathAndQuery) {
  return scheduleForReceiver(ip, () => shefGet(ip, port, pathAndQuery));
}

// -------------------------------------------------------------- raw commands

function getVersion(ip, port = DEFAULT_PORT) {
  return queuedGet(ip, port, '/info/getVersion');
}

function getMode(ip, port = DEFAULT_PORT) {
  return queuedGet(ip, port, '/info/mode');
}

function getTuned(ip, port = DEFAULT_PORT) {
  return queuedGet(ip, port, '/tv/getTuned');
}

// Reads any channel's program info without tuning to it (§2's second
// finding) -- major is required, minor is omitted for satellite channels
// per §7.1's "minor is omitted for satellite channels."
function getProgInfo(ip, port, major, minor) {
  const q = minor != null ? `?major=${encodeURIComponent(major)}&minor=${encodeURIComponent(minor)}` : `?major=${encodeURIComponent(major)}`;
  return queuedGet(ip, port, `/tv/getProgInfo${q}`);
}

function tune(ip, port, major, minor) {
  const q = minor != null ? `?major=${encodeURIComponent(major)}&minor=${encodeURIComponent(minor)}` : `?major=${encodeURIComponent(major)}`;
  return queuedGet(ip, port, `/tv/tune${q}`);
}

function processKey(ip, port, key, hold = 'keyPress') {
  return queuedGet(ip, port, `/remote/processKey?key=${encodeURIComponent(key)}&hold=${encodeURIComponent(hold)}`);
}

// -------------------------------------------------------------- driver shape
//
// identify()/getState() match the generic driver interface every §7 driver
// exposes. Both fields below are read defensively (?. and fallbacks) rather
// than assumed to be named exactly this way in every firmware revision --
// the one real sample we have (§2) only shows getVersion's shape in detail,
// not getMode's/getTuned's, so exact field names for those two are our best
// reading of the SHEF docs rather than something captured from hardware.
// Confirm against a real receiver before relying on any field not covered
// by getVersion.
async function identify(ip, port = DEFAULT_PORT) {
  const version = await getVersion(ip, port);
  return {
    receiverId: version.receiverId || null,
    accessCardId: version.accessCardId || null,
    serialNum: null, // /info/getSerialNum not called here -- identify() stays
                      // to the single getVersion() round trip; callers that
                      // need the serial call getSerialNum() separately.
    softwareVersion: version.stbSoftwareVersion || null,
    shefVersion: version.version || null,
  };
}

// SHEF's "no minor/sub-channel" sentinel -- a satellite channel with no
// minor number reports minor: 65535 (0xFFFF) rather than omitting the field
// or sending null. Confirmed against the device simulator, which emulates
// this convention deliberately. Every minor value read off the wire needs
// to pass through this before it reaches a caller, or "no minor channel"
// renders as a literal ".65535" in the staff UI.
const NO_MINOR = 65535;
function normalizeMinor(minor) {
  return minor != null && minor !== NO_MINOR ? minor : null;
}

async function getState(ip, port = DEFAULT_PORT) {
  // Sequential, not Promise.all -- both calls go through the same
  // per-receiver queue regardless, so parallelizing here would just make
  // them wait on each other anyway; sequential reads more clearly.
  const mode = await getMode(ip, port);
  const tuned = await getTuned(ip, port);
  return {
    active: mode && typeof mode.mode === 'number' ? mode.mode === 0 : null, // 0 = active per SHEF convention; null if unrecognized
    major: tuned.major != null ? tuned.major : null,
    minor: normalizeMinor(tuned.minor),
    raw: { mode, tuned },
  };
}

function getSerialNum(ip, port = DEFAULT_PORT) {
  return queuedGet(ip, port, '/info/getSerialNum');
}

module.exports = {
  getVersion,
  getSerialNum,
  getMode,
  getTuned,
  getProgInfo,
  tune,
  processKey,
  identify,
  getState,
};
