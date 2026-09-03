// SmartThings cloud fallback (docs/venue-control.md §7.2): "Genuinely good at
// discrete power (switch/on, switch/off -- a real discrete command, not a
// toggle) and volume. Weak and inconsistent at tuning the built-in cable
// tuner to a sub-channel. Used as the power fallback and never as the
// primary channel path." So this module only ever does power + volume --
// there is no tune/channel function here, deliberately.
//
// Needs a personal access token (SmartThings PAT, capability:switch and
// capability:audioVolume/audioMute scopes) in SMARTTHINGS_TOKEN. Same
// "simulated/no-op until configured" shape as the rest of this platform's
// optional integrations (see notify.js's Twilio gate in the main repo) --
// every function below throws a clear, catchable "not configured" error
// rather than silently doing nothing, because the caller (samsung-ws.js)
// needs to know whether this fallback is actually usable before deciding
// whether a power/volume operation truly failed.
const { SMARTTHINGS_TOKEN } = require('../../config');

const BASE_URL = 'https://api.smartthings.com/v1';
const TIMEOUT_MS = 6000; // cloud round-trip, more slack than the LAN drivers get

function configured() {
  return !!SMARTTHINGS_TOKEN;
}

function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function requireConfigured() {
  if (!configured()) {
    throw new Error('SmartThings is not configured (SMARTTHINGS_TOKEN unset) -- this fallback path is unavailable.');
  }
}

async function sendCommand(deviceId, capability, command, args = []) {
  requireConfigured();
  if (!deviceId) throw new Error('No SmartThings device id configured for this TV.');
  const res = await fetchWithTimeout(`${BASE_URL}/devices/${encodeURIComponent(deviceId)}/commands`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SMARTTHINGS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: [{ component: 'main', capability, command, arguments: args }] }),
  });
  if (!res.ok) throw new Error(`SmartThings ${capability}/${command} -> HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res.json().catch(() => ({}));
}

async function getSwitchState(deviceId) {
  requireConfigured();
  if (!deviceId) throw new Error('No SmartThings device id configured for this TV.');
  const res = await fetchWithTimeout(`${BASE_URL}/devices/${encodeURIComponent(deviceId)}/components/main/capabilities/switch/status`, {
    headers: { Authorization: `Bearer ${SMARTTHINGS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`SmartThings switch status -> HTTP ${res.status}`);
  const data = await res.json();
  return data && data.switch && data.switch.value; // 'on' | 'off'
}

// audioMute status readback -- this is what makes mute/unmute a real
// discrete operation over SmartThings instead of a blind toggle, the same
// way getSwitchState (above) could for power. 'muted' | 'unmuted' | null
// (capability not reported, e.g. this device doesn't expose audioMute).
async function getMuteState(deviceId) {
  requireConfigured();
  if (!deviceId) throw new Error('No SmartThings device id configured for this TV.');
  const res = await fetchWithTimeout(`${BASE_URL}/devices/${encodeURIComponent(deviceId)}/components/main/capabilities/audioMute/status`, {
    headers: { Authorization: `Bearer ${SMARTTHINGS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`SmartThings audioMute status -> HTTP ${res.status}`);
  const data = await res.json();
  return (data && data.mute && data.mute.value) || null; // 'muted' | 'unmuted'
}

function switchOn(deviceId) { return sendCommand(deviceId, 'switch', 'on'); }
function switchOff(deviceId) { return sendCommand(deviceId, 'switch', 'off'); }
function volumeUp(deviceId) { return sendCommand(deviceId, 'audioVolume', 'volumeUp'); }
function volumeDown(deviceId) { return sendCommand(deviceId, 'audioVolume', 'volumeDown'); }
// The audioMute capability has discrete mute/unmute commands (not just a
// toggle) -- setMute() below only ever sent 'mute' regardless of which way
// the caller wanted to go, which was a real bug in samsung-ws.js's volume
// dispatch, not a SmartThings limitation. Kept as an alias for the one
// existing caller; new code should call mute()/unmute() directly.
function mute(deviceId) { return sendCommand(deviceId, 'audioMute', 'mute'); }
function unmute(deviceId) { return sendCommand(deviceId, 'audioMute', 'unmute'); }
function setMute(deviceId) { return mute(deviceId); }

module.exports = {
  configured, getSwitchState, getMuteState, switchOn, switchOff, volumeUp, volumeDown, mute, unmute, setMute,
};
