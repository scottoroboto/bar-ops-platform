// SmartThings cloud (docs/venue-control.md §7.2): discrete power (switch
// on/off -- a real discrete command, not a toggle) and volume. Never used
// for channels.
//
// Power-on through SmartThings is how the TVs that ignore Wake-on-LAN over
// Wi-Fi get turned on (TV 6, the Patio TVs and Putt Putt at T1, 2026-10-06:
// the SmartThings app turns TV 6 on when the Pi's wake-up can't). Samsung's
// servers keep a line to the set while it's off.
//
// Sign-in: SmartThings website tokens (PATs) made after 2024 expire in 24
// hours, so the box signs in once with an OAuth app (tools/smartthings.js)
// and keeps the session itself: the access token lasts 24h, the refresh
// token 30 days and is replaced on every refresh, so the box refreshes at
// least weekly even when nobody uses a TV. A PAT in SMARTTHINGS_TOKEN
// still works for a quick test.
//
// Which SmartThings device is which TV: tv.st_device_id from TV Admin, or
// the box's own list matched by tools/smartthings.js (cache
// "smartthingsDevices", Bar Ops TV id -> SmartThings device id).
const cache = require('../cache');
const { SMARTTHINGS_TOKEN } = require('../../config');

const ROOT = process.env.SMARTTHINGS_ROOT || 'https://api.smartthings.com'; // override only for tests
const BASE_URL = `${ROOT}/v1`;
const OAUTH_URL = `${ROOT}/oauth`;
const REDIRECT_URI = 'https://httpbin.org/get'; // the code shows up on that page for copying
const SCOPES = 'r:devices:* x:devices:*';
const TIMEOUT_MS = 6000; // cloud round-trip, more slack than the LAN drivers get
const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

function auth() { return cache.get('smartthingsAuth') || null; } // { clientId, clientSecret, access, refresh, expiresAt, refreshedAt }
function configured() { return !!((auth() && auth().refresh) || SMARTTHINGS_TOKEN); }

function deviceIdFor(tv) {
  if (!tv) return null;
  if (tv.st_device_id) return tv.st_device_id;
  const map = cache.get('smartthingsDevices') || {};
  return map[String(tv.id)] || null;
}

function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function tokenRequest(a, form) {
  const res = await fetchWithTimeout(`${OAUTH_URL}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ ...form, client_id: a.clientId }).toString(),
  }, 12000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`SmartThings sign-in: ${data.error_description || data.error || `HTTP ${res.status}`} (HTTP ${res.status}, ${JSON.stringify(data).slice(0, 300)})`);
  const next = {
    ...a,
    access: data.access_token,
    refresh: data.refresh_token || a.refresh, // single-use: always keep the new one
    expiresAt: Date.now() + (Number(data.expires_in) || 86400) * 1000,
    refreshedAt: Date.now(),
  };
  cache.set('smartthingsAuth', next);
  return next;
}

// Link URL for the one-time sign-in (tools/smartthings.js).
function authorizeUrl(clientId) {
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI, scope: SCOPES });
  return `${OAUTH_URL}/authorize?${q.toString()}`;
}

// Creates the box's OAuth app on the SmartThings account (what the
// SmartThings CLI's "apps:create" -> OAuth-In App does), using a website
// token that's only needed this once. Returns { clientId, clientSecret }.
async function createApp(websiteToken, label) {
  const name = `barops-${String(label || 'box').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Math.random().toString(36).slice(2, 7)}`;
  const res = await fetchWithTimeout(`${BASE_URL}/apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${websiteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appName: name,
      displayName: `Bar Ops ${label || ''}`.trim(),
      description: 'Bar Ops venue control: turns TVs on and off.',
      appType: 'API_ONLY',
      classifications: ['CONNECTED_SERVICE'],
      singleInstance: true,
      oauth: { clientName: `Bar Ops ${label || ''}`.trim(), scope: SCOPES.split(' '), redirectUris: [REDIRECT_URI] },
    }),
  }, 15000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.oauthClientId) {
    const why = (data.error && (data.error.message || JSON.stringify(data.error.details || data.error))) || `HTTP ${res.status}`;
    const hint = res.status === 403 || res.status === 401
      ? ' -- the token needs every box under Apps ticked, including "Manage all apps" (w:apps). Make a new one with all boxes ticked.'
      : '';
    throw new Error(`SmartThings didn't create the app (HTTP ${res.status}): ${why}${hint}\nFull answer: ${JSON.stringify(data).slice(0, 600)}`);
  }
  return { clientId: data.oauthClientId, clientSecret: data.oauthClientSecret, appId: data.app && data.app.appId };
}

async function signIn(clientId, clientSecret, code) {
  return tokenRequest({ clientId, clientSecret }, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
}

let refreshing = null;
async function refresh() {
  const a = auth();
  if (!a || !a.refresh) throw new Error('SmartThings is not signed in on this box (node tools/smartthings.js).');
  if (!refreshing) refreshing = tokenRequest(a, { grant_type: 'refresh_token', refresh_token: a.refresh }).finally(() => { refreshing = null; });
  return refreshing;
}

async function accessToken() {
  const a = auth();
  if (a && a.refresh) {
    if (a.access && a.expiresAt - Date.now() > 5 * 60 * 1000) return a.access;
    return (await refresh()).access;
  }
  if (SMARTTHINGS_TOKEN) return SMARTTHINGS_TOKEN;
  throw new Error('SmartThings is not set up on this box -- this power-on path is unavailable.');
}

// Keep the 30-day refresh token alive even if nobody turns a TV on.
setInterval(() => {
  const a = auth();
  if (a && a.refresh && Date.now() - (a.refreshedAt || 0) > REFRESH_EVERY_MS) {
    refresh().catch((err) => console.warn('[smartthings] refresh:', err.message));
  }
}, 6 * 60 * 60 * 1000).unref();

async function api(path, opts = {}) {
  const res = await fetchWithTimeout(`${BASE_URL}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401 && auth() && auth().refresh) {
    await refresh(); // token pulled early; one retry with a fresh one
    return api(path, opts);
  }
  if (!res.ok) throw new Error(`SmartThings ${path} -> HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res.json().catch(() => ({}));
}

async function sendCommand(deviceId, capability, command, args = []) {
  if (!deviceId) throw new Error('No SmartThings device for this TV.');
  return api(`/devices/${encodeURIComponent(deviceId)}/commands`, {
    method: 'POST',
    body: JSON.stringify({ commands: [{ component: 'main', capability, command, arguments: args }] }),
  });
}

async function getSwitchState(deviceId) {
  if (!deviceId) throw new Error('No SmartThings device for this TV.');
  const data = await api(`/devices/${encodeURIComponent(deviceId)}/components/main/capabilities/switch/status`);
  return data && data.switch && data.switch.value; // 'on' | 'off'
}

// 'muted' | 'unmuted' | null (capability not reported for this device).
async function getMuteState(deviceId) {
  if (!deviceId) throw new Error('No SmartThings device for this TV.');
  const data = await api(`/devices/${encodeURIComponent(deviceId)}/components/main/capabilities/audioMute/status`);
  return (data && data.mute && data.mute.value) || null;
}

// Every TV on the SmartThings account: [{ deviceId, label, name }].
async function listTvs() {
  const out = [];
  let path = '/devices?capability=switch';
  while (path) {
    const data = await api(path);
    for (const d of data.items || []) {
      const tv = (d.ocf && /tv/i.test(d.ocf.deviceType || '')) || /tv/i.test(`${d.deviceTypeName || ''} ${d.name || ''}`)
        || (d.components || []).some((c) => (c.categories || []).some((k) => /television/i.test(k.name)));
      if (tv) out.push({ deviceId: d.deviceId, label: d.label || d.name, name: d.name, locationId: d.locationId });
    }
    const next = data._links && data._links.next && data._links.next.href;
    path = next ? next.replace(BASE_URL, '') : null;
  }
  return out;
}

// { locationId: name } for the account's SmartThings locations (homes).
async function locations() {
  const data = await api('/locations');
  const out = {};
  for (const l of data.items || []) out[l.locationId] = l.name;
  return out;
}

function switchOn(deviceId) { return sendCommand(deviceId, 'switch', 'on'); }
function switchOff(deviceId) { return sendCommand(deviceId, 'switch', 'off'); }
function volumeUp(deviceId) { return sendCommand(deviceId, 'audioVolume', 'volumeUp'); }
function volumeDown(deviceId) { return sendCommand(deviceId, 'audioVolume', 'volumeDown'); }
function mute(deviceId) { return sendCommand(deviceId, 'audioMute', 'mute'); }
function unmute(deviceId) { return sendCommand(deviceId, 'audioMute', 'unmute'); }
function setMute(deviceId) { return mute(deviceId); }

module.exports = {
  configured, deviceIdFor, authorizeUrl, createApp, signIn, refresh, listTvs, locations, REDIRECT_URI,
  getSwitchState, getMuteState, switchOn, switchOff, volumeUp, volumeDown, mute, unmute, setMute,
};
