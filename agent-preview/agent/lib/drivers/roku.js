// Roku ECP driver (docs/venue-control.md §7.3, Phase 6): "ECP on port 8060 --
// a clean, documented, local REST API. Nearly free to implement." Spec lists
// four endpoints explicitly (device-info, apps, keypress/Home, launch/<id>);
// this file also calls /query/active-app, which isn't named in §7.3 but is
// the only way to answer "what's this Roku showing right now" -- the same
// question getTuned() answers for DirecTV in drivers/directv.js and the
// question the poller (lib/poller.js) and layout capture (lib/layouts.js)
// both need answered for a Roku source the same way they need it for a
// DirecTV one. Unlike directv.js there is no per-IP request queue here:
// SHEF's "single-threaded, bursts cause hangs" constraint (§7.1) is a
// documented DirecTV/SHEF quirk, not a general one, and nothing in ECP's
// docs asks for it -- if a real Roku turns out to need the same treatment,
// add the queue then rather than guessing at it now.
//
// ECP responses are XML, not JSON (the one place this driver's shape has to
// diverge from directv.js's shefGet()). No XML parsing library is added for
// four small, fixed tag shapes -- parseTag()/parseApps() below are plain
// regexes against well-formed ECP output, not a general XML parser.
const TIMEOUT_MS = 4000; // same rationale as directv.js: a device that's
                          // asleep or gone should time out, not hang the
                          // caller indefinitely.
const DEFAULT_PORT = 8060;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------- XML helpers
//
// Pulls the text content of the first <tagName>...</tagName> in a flat XML
// document (device-info's shape -- no nesting, no repeated tags). Returns
// null rather than throwing when the tag is missing, since not every Roku
// firmware/model populates every field (e.g. a stick vs. a Roku TV).
function parseTag(xml, tagName) {
  const m = xml.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`));
  return m ? m[1] : null;
}

// Parses every <app id="..." ...>Name</app> element out of /query/apps (or
// the single one inside /query/active-app's <active-app>...</active-app>
// wrapper -- same element shape either way). The home screen reports as
// <app>Roku</app> with no id attribute, which callers treat as "nothing is
// running" rather than a literal launchable app.
function parseApps(xml) {
  const apps = [];
  const appRe = /<app([^>]*)>([^<]*)<\/app>/g;
  let m;
  while ((m = appRe.exec(xml))) {
    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = a[2];
    apps.push({
      id: attrs.id || null,
      type: attrs.type || null,
      version: attrs.version || null,
      name: m[2].trim(),
    });
  }
  return apps;
}

// -------------------------------------------------------------- raw commands

async function ecpGet(ip, port, pathAndQuery) {
  const url = `http://${ip}:${port}${pathAndQuery}`;
  const res = await fetchWithTimeout(url, {}, TIMEOUT_MS);
  if (!res.ok) throw new Error(`Roku ${ip} ${pathAndQuery} -> HTTP ${res.status}`);
  return res.text();
}

// POST endpoints (keypress, launch) return an empty 200/202 body on success
// -- nothing to parse, a non-OK status is the only failure signal ECP gives.
async function ecpPost(ip, port, pathAndQuery) {
  const url = `http://${ip}:${port}${pathAndQuery}`;
  const res = await fetchWithTimeout(url, { method: 'POST' }, TIMEOUT_MS);
  if (!res.ok) throw new Error(`Roku ${ip} ${pathAndQuery} -> HTTP ${res.status}`);
  return true;
}

function getDeviceInfo(ip, port = DEFAULT_PORT) {
  return ecpGet(ip, port, '/query/device-info').then((xml) => ({
    powerMode: parseTag(xml, 'power-mode'), // "PowerOn" | "DisplayOff" | "Ready" | "Headless" -- vocabulary varies by model/firmware
    name: parseTag(xml, 'user-device-name') || parseTag(xml, 'friendly-device-name'),
    modelName: parseTag(xml, 'model-name'),
    serialNumber: parseTag(xml, 'serial-number'),
    softwareVersion: parseTag(xml, 'software-version'),
    raw: xml,
  }));
}

function getApps(ip, port = DEFAULT_PORT) {
  return ecpGet(ip, port, '/query/apps').then(parseApps);
}

// The home screen (nothing launched) answers with a bare <app>Roku</app> --
// no id attribute -- which is reported here as { id: null, name: 'Roku' }
// rather than folded into an error, since "on the home screen" is a normal,
// pollable state, not a failure.
function getActiveApp(ip, port = DEFAULT_PORT) {
  return ecpGet(ip, port, '/query/active-app').then((xml) => {
    const apps = parseApps(xml);
    return apps[0] || { id: null, type: null, version: null, name: null };
  });
}

// §7.3 lists POST /keypress/Home explicitly; every other ECP key (Select,
// Up/Down/Left/Right, Play, Rev, Fwd, Back, InstantReplay, Info, Search) uses
// the identical POST /keypress/<Key> shape, so this isn't hardcoded to just
// Home -- callers (agent/server.js, lib/layouts.js) pass whatever key name
// the staff UI or a layout action asks for.
function keypress(ip, port, key) {
  return ecpPost(ip, port, `/keypress/${encodeURIComponent(key)}`);
}

function launch(ip, port, appId) {
  return ecpPost(ip, port, `/launch/${encodeURIComponent(appId)}`);
}

// -------------------------------------------------------------- driver shape
//
// identify()/getState() match every other §7 driver's interface (see
// directv.js's own comment on this). getState() folds device-info's power
// reading together with the active app in one call, since both questions
// ("is it on" and "what's it showing") answer the same "what's this source
// doing right now" question the poller asks once per cycle.
async function identify(ip, port = DEFAULT_PORT) {
  const info = await getDeviceInfo(ip, port);
  return {
    name: info.name,
    modelName: info.modelName,
    serialNumber: info.serialNumber,
    softwareVersion: info.softwareVersion,
  };
}

async function getState(ip, port = DEFAULT_PORT) {
  const info = await getDeviceInfo(ip, port);
  const active = await getActiveApp(ip, port);
  return {
    powerMode: info.powerMode,
    on: info.powerMode ? info.powerMode === 'PowerOn' : null, // null when the field is absent rather than assuming a meaning
    appId: active.id,
    appName: active.name,
  };
}

module.exports = {
  getDeviceInfo,
  getApps,
  getActiveApp,
  keypress,
  launch,
  identify,
  getState,
};
