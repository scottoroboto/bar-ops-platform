// Samsung TV driver (docs/venue-control.md §7.2) -- the primary control
// path. Two things live in one file rather than being split further: the
// plain-HTTP PowerState read (`http://<ip>:8001/api/v2/`, the same endpoint
// agent/lib/discovery/scanner.js already probes during discovery) and the
// WebSocket remote-control channel used to send key presses. SmartThings
// (drivers/samsung-st.js) and WoL (drivers/wol.js) are separate modules;
// this file is the one that decides *when* to reach for each, per the
// discrete-power algorithm in §7.2.
//
// Port note: the spec text describes samsung_ws_plain as `ws://<ip>:8001`
// while agent/lib/discovery/scanner.js's buildControlMethods() proposes
// port 8002 for both token and plain variants when a device is first
// adopted. `vc_tvs.ws_port` exists precisely to let an owner correct that
// guess per-TV, so this driver honors it when set and only falls back to a
// per-control_method default (token: 8002/wss, plain: 8001/ws) otherwise.
const WebSocket = require('ws');
const wol = require('./wol');
const samsungSt = require('./samsung-st');

const HTTP_TIMEOUT_MS = 3000; // a genuinely off TV drops off the network fast -- no reason to wait as long as DirecTV's 4s
const WS_TIMEOUT_MS = 8000; // generous: first-ever pairing waits on a human tapping "Allow" on the TV screen
const APP_NAME = 'TSB Venue Control';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function fetchWithTimeout(url, opts = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- identity / state

async function identify(tv) {
  try {
    const res = await fetchWithTimeout(`http://${tv.ip}:8001/api/v2/`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    const device = data.device || data;
    return {
      name: device.name || null,
      modelName: device.modelName || null,
      wifiMac: device.wifiMac || null,
      tokenAuthSupport: device.TokenAuthSupport ?? data.TokenAuthSupport ?? null,
    };
  } catch {
    return null;
  }
}

// 'on' | 'standby' | 'unreachable'. "standby" means networked but the
// screen's off (modern Tizen sets stay reachable on this endpoint even
// powered down, which is exactly what makes WoL/WS wake possible at all);
// "unreachable" covers a fully network-dead set as well as a genuine
// connectivity problem -- the discrete-power algorithm below treats both
// the same way (not already-on, can't confirm already-off either).
async function getPowerState(tv) {
  if (!tv.ip) return 'unreachable';
  try {
    const res = await fetchWithTimeout(`http://${tv.ip}:8001/api/v2/`);
    if (!res.ok) return 'unreachable';
    const data = await res.json().catch(() => null);
    const device = data && (data.device || data);
    const raw = device && device.PowerState;
    if (raw === 'on') return 'on';
    if (raw === 'off') return 'standby';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

async function getState(tv) {
  return { power: await getPowerState(tv) };
}

// ---------------------------------------------------------------- WS remote control

function wsUrlFor(tv) {
  const name = Buffer.from(APP_NAME).toString('base64');
  if (tv.control_method === 'samsung_ws_token') {
    const port = tv.ws_port || 8002;
    const tokenQs = tv.ws_token ? `&token=${encodeURIComponent(tv.ws_token)}` : '';
    return `wss://${tv.ip}:${port}/api/v2/channels/samsung.remote.control?name=${name}${tokenQs}`;
  }
  const port = tv.ws_port || 8001;
  return `ws://${tv.ip}:${port}/api/v2/channels/samsung.remote.control?name=${name}`;
}

// Opens the remote-control WS channel, waits for the ms.channel.connect
// handshake (which is where a fresh pairing hands back a token -- see
// §7.2), sends one key press, and closes. Returns the token if the TV sent
// one, so callers can persist it onto vc_tvs.ws_token for next time. The
// self-signed-cert TLS relaxation is scoped to this one connection via the
// `rejectUnauthorized: false` socket option, not a process-wide setting.
function sendKey(tv, key, hold = 'keyPress') {
  if (tv.control_method !== 'samsung_ws_token' && tv.control_method !== 'samsung_ws_plain') {
    return Promise.reject(new Error(`TV control_method "${tv.control_method}" has no WS remote-control path.`));
  }
  if (!tv.ip) return Promise.reject(new Error('TV has no IP address configured.'));

  return new Promise((resolve, reject) => {
    let settled = false;
    let capturedToken = null;
    const url = wsUrlFor(tv);
    const ws = new WebSocket(url, tv.control_method === 'samsung_ws_token' ? { rejectUnauthorized: false } : undefined);

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing/closed */ }
      if (err) reject(err); else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error(`Samsung WS ${tv.ip} timed out after ${WS_TIMEOUT_MS}ms -- if this is the first connection, check the TV screen for an "Allow this device?" prompt.`)), WS_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.event === 'ms.channel.connect') {
        capturedToken = (msg.data && msg.data.token) || null;
        sendClick();
      } else if (msg.event === 'ms.channel.unauthorized' || msg.event === 'ms.channel.timeOut') {
        finish(new Error(`Samsung WS ${tv.ip} rejected the connection (${msg.event}) -- token may be stale; re-pairing may be needed.`));
      }
    });

    function sendClick() {
      const payload = JSON.stringify({
        method: 'ms.remote.control',
        params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
      });
      ws.send(payload, (err) => {
        if (err) return finish(err);
        // Give the TV a beat to actually act on the key before we tear the
        // socket down -- closing immediately after send has been known to
        // drop the command on some Tizen versions.
        setTimeout(() => finish(null, { ok: true, token: capturedToken }), 200);
      });
    }

    ws.on('open', () => {
      // samsung_ws_plain has no ms.channel.connect handshake to wait for --
      // send immediately. samsung_ws_token waits for the connect event
      // above (which is also where a first-time pairing prompt resolves).
      if (tv.control_method === 'samsung_ws_plain') sendClick();
    });

    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish(new Error(`Samsung WS ${tv.ip} closed before completing.`)));
  });
}

// ---------------------------------------------------------------- discrete power (§7.2)

// Reads state first, which is what makes this a real discrete operation
// rather than a blind toggle -- "all on" must never silently turn a TV off.
// `method` in the result records what actually achieved the change (or
// "none" if the TV was already in the requested state), and `state` is
// always the last real read, never an assumption.
async function setPower(tv, desiredState) {
  if (desiredState !== 'on' && desiredState !== 'off') {
    throw new Error(`Unknown power state "${desiredState}" -- expected "on" or "off".`);
  }
  const before = await getPowerState(tv);
  let method = 'none';
  let token = null;

  if (desiredState === 'on') {
    if (before === 'on') return { ok: true, requested: desiredState, state: 'on', changed: false, method: 'none' };
    if (tv.wol_enabled && tv.mac) {
      try { await wol.sendMagicPacket(tv.mac); method = 'wol'; await sleep(3000); } catch (err) { /* fall through to ST below */ }
    }
    let after = await getPowerState(tv);
    if (after !== 'on' && samsungSt.configured() && tv.st_device_id) {
      try {
        await samsungSt.switchOn(tv.st_device_id);
        method = method === 'none' ? 'smartthings' : `${method}+smartthings`;
        await sleep(1500);
        after = await getPowerState(tv);
      } catch (err) { /* report whatever we actually achieved */ }
    }
    return { ok: after === 'on', requested: desiredState, state: after, changed: after !== before, method };
  }

  // desiredState === 'off'
  if (before === 'standby' || before === 'unreachable') {
    return { ok: true, requested: desiredState, state: before, changed: false, method: 'none' };
  }
  let after = before;
  if (tv.control_method === 'samsung_ws_token' || tv.control_method === 'samsung_ws_plain') {
    try {
      const res = await sendKey(tv, 'KEY_POWER');
      token = res.token;
      method = 'ws';
      await sleep(1500);
      after = await getPowerState(tv);
    } catch (err) { /* fall through to ST below */ }
  }
  if (after === 'on' && samsungSt.configured() && tv.st_device_id) {
    try {
      await samsungSt.switchOff(tv.st_device_id);
      method = method === 'none' ? 'smartthings' : `${method}+smartthings`;
      await sleep(1500);
      after = await getPowerState(tv);
    } catch (err) { /* report whatever we actually achieved */ }
  }
  return { ok: after !== 'on', requested: desiredState, state: after, changed: after !== before, method, token };
}

async function setVolume(tv, op) {
  const keyMap = { up: 'KEY_VOLUP', down: 'KEY_VOLDOWN', mute: 'KEY_MUTE' };
  const key = keyMap[op];
  if (!key) throw new Error(`Unknown volume op "${op}" -- expected "up", "down", or "mute".`);

  if (tv.control_method === 'samsung_ws_token' || tv.control_method === 'samsung_ws_plain') {
    const res = await sendKey(tv, key);
    return { ok: true, method: 'ws', token: res.token };
  }
  if (samsungSt.configured() && tv.st_device_id) {
    if (op === 'up') await samsungSt.volumeUp(tv.st_device_id);
    else if (op === 'down') await samsungSt.volumeDown(tv.st_device_id);
    else await samsungSt.setMute(tv.st_device_id);
    return { ok: true, method: 'smartthings' };
  }
  throw new Error(`No volume control path available for this TV (control_method="${tv.control_method}"${samsungSt.configured() ? ', and no SmartThings device id set' : ', SmartThings not configured'}).`);
}

module.exports = { identify, getState, getPowerState, sendKey, setPower, setVolume };
