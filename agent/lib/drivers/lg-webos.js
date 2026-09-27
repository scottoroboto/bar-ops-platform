// LG webOS TV driver (cloud patch_039, Scotto 2026-09-27). Same surface as
// samsung-ws.js so agent/server.js can treat a TV as a TV: identify,
// getPowerState, setPower, setVolume, setMute, sendKeySequence,
// selectChannel. LG's protocol is SSAP: a WebSocket on 3001 (wss, newer
// firmware) or 3000 (ws), a "register" handshake that the TV answers with
// an on-screen "Allow?" prompt the first time and a client-key afterwards,
// then JSON requests to ssap:// URIs. Key presses ride a second socket the
// TV hands out on request (the pointer input socket).
//
// The client key lives in vc_tvs.ws_token, the same column as Samsung's
// token, and comes back in result.token so agent/server.js's
// maybeReportToken pushes it to the cloud unchanged.
//
// Power: an LG that is off closes its ports, so "on" = the socket answers,
// "standby" = the host is up but refuses (Quick Start+ sets), "unreachable"
// = nothing there. Power-on is Wake-on-LAN only, like a Samsung in deep
// standby; power-off is a real request.
const net = require('net');
const WebSocket = require('ws');
const wol = require('./wol');

const CONNECT_TIMEOUT_MS = 1500;
const PAIR_TIMEOUT_MS = 30000;   // a person walking to the remote to press Yes
const REQUEST_TIMEOUT_MS = 6000;
const APP_NAME = 'TSB Venue Control';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const PERMISSIONS = [
  'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED', 'CONTROL_AUDIO',
  'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK',
  'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST',
  'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE',
  'READ_COUNTRY_INFO', 'READ_SETTINGS', 'CONTROL_TV_SCREEN', 'CONTROL_TV_STANDBY', 'CONTROL_FAVORITE_GROUP',
  'CONTROL_USER_DEFINED', 'CONTROL_BLUETOOTH', 'CONTROL_TIMER_INFO', 'CONTROL_RECORDING', 'READ_RECORDING_STATE',
  'WRITE_RECORDING_LIST', 'READ_RECORDING_LIST', 'READ_RECORDING_SCHEDULE', 'WRITE_RECORDING_SCHEDULE',
  'READ_STORAGE_DEVICE_LIST', 'READ_TV_PROGRAM_INFO', 'CONTROL_BOX_CHANNEL', 'READ_TV_ACR_AUTH_TOKEN',
  'READ_TV_CONTENT_STATE', 'READ_TV_CURRENT_TIME', 'ADD_LAUNCHER_CHANNEL', 'SET_CHANNEL_SKIP', 'RELEASE_CHANNEL_SKIP',
  'CONTROL_CHANNEL_BLOCK', 'DELETE_SELECT_CHANNEL', 'CONTROL_CHANNEL_GROUP', 'SCAN_TV_CHANNELS', 'CONTROL_TV_POWER', 'CONTROL_WOL',
];

// The signed manifest every open-source LG client ships (lgtv2, pywebostv,
// bscpylgtv). Some firmware insists on it for a PROMPT pairing; newer sets
// accept the plain manifest. register() tries plain first, then signed.
const SIGNED = {
  signed: {
    created: '20140509', appId: 'com.lge.test', vendorId: 'com.lge',
    localizedAppNames: { '': 'LG Remote App', 'ko-KR': '리모컨 앱', 'zxx-XX': 'ЛГ Rэмotэ AПП' },
    localizedVendorNames: { '': 'LG Electronics' },
    permissions: ['TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD', 'READ_INSTALLED_APPS', 'READ_LGE_SDX',
      'READ_NOTIFICATIONS', 'SEARCH', 'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER', 'READ_CURRENT_CHANNEL',
      'READ_RUNNING_APPS', 'READ_UPDATE_INFO', 'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME'],
    serial: '2f930e2d2cfe083771f68e4fe7bb22',
  },
  signatures: [{
    signatureVersion: 1,
    signature: 'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==',
  }],
};

function isLg(tv) { return tv && tv.control_method === 'lg_webos'; }

// ---------------------------------------------------------------- reachability

// One TCP connect to the SSAP port: 'on' (accepted), 'standby' (refused —
// host up, TV asleep), 'unreachable' (nothing answered).
function probePort(ip, port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish('on'));
    sock.once('timeout', () => finish('unreachable'));
    sock.once('error', (err) => finish(err && err.code === 'ECONNREFUSED' ? 'standby' : 'unreachable'));
    sock.connect(port, ip);
  });
}

function candidatePorts(tv) {
  if (tv.ws_port) return [{ port: Number(tv.ws_port), secure: Number(tv.ws_port) === 3001 }];
  return [{ port: 3001, secure: true }, { port: 3000, secure: false }];
}

async function getPowerState(tv) {
  if (!tv.ip) return 'unreachable';
  let best = 'unreachable';
  for (const c of candidatePorts(tv)) {
    const r = await probePort(tv.ip, c.port);
    if (r === 'on') return 'on';
    if (r === 'standby') best = 'standby';
  }
  return best;
}

async function getState(tv) { return { power: await getPowerState(tv) }; }

// Discovery-time identity without pairing: just which SSAP port answers.
async function identify(ip) {
  for (const c of [{ port: 3001 }, { port: 3000 }]) {
    if ((await probePort(ip, c.port)) === 'on') return { ssapPort: c.port };
  }
  return null;
}

// ---------------------------------------------------------------- SSAP session

// Opens the socket, registers (pairing if the TV wants), and hands back a
// tiny session: request(uri, payload) and close(). The client key the TV
// issues (or re-confirms) is on session.token.
async function openSession(tv, { pairTimeoutMs = PAIR_TIMEOUT_MS } = {}) {
  if (!tv.ip) throw new Error('TV has no IP address configured.');
  let lastErr = null;
  for (const c of candidatePorts(tv)) {
    for (const withSignature of [false, true]) {
      try {
        return await connectAndRegister(tv, c, withSignature, pairTimeoutMs);
      } catch (err) {
        lastErr = err;
        if (err.code === 'CONNECT') break; // this port doesn't answer; try the next one, not the signed manifest
        if (err.code !== 'REGISTER') throw err;
      }
    }
  }
  throw lastErr || new Error(`LG ${tv.ip}: no SSAP port answered.`);
}

function connectAndRegister(tv, c, withSignature, pairTimeoutMs) {
  return new Promise((resolve, reject) => {
    const url = `${c.secure ? 'wss' : 'ws'}://${tv.ip}:${c.port}`;
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 4000 });
    let settled = false;
    let seq = 0;
    const pending = new Map(); // id -> { resolve, reject, timer }
    let token = tv.ws_token || null;
    let promptShown = false;
    const fail = (err, code) => { if (!settled) { settled = true; if (code) err.code = code; try { ws.close(); } catch (e) { /* ignore */ } reject(err); } };
    const regTimer = setTimeout(() => fail(new Error(promptShown
      ? `LG ${tv.ip}: nobody pressed Yes on the TV's "Allow?" prompt in time -- try again with the remote in hand.`
      : `LG ${tv.ip}: no answer to the pairing request.`), 'REGISTER'), pairTimeoutMs);

    ws.on('error', (err) => fail(new Error(`LG ${tv.ip} isn't reachable on ${c.port} (${err.code || err.message}) -- TV may be off; an LG that is off closes its network ports, so power it on first (Wake-on-LAN if it is set up).`), 'CONNECT'));
    ws.on('close', () => {
      if (!settled) fail(new Error(`LG ${tv.ip} closed the connection before registering.`), 'REGISTER');
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('LG connection closed.')); }
      pending.clear();
    });
    ws.on('open', () => {
      const payload = {
        forcePairing: false, pairingType: 'PROMPT',
        manifest: { manifestVersion: 1, appVersion: '1.1', permissions: PERMISSIONS, ...(withSignature ? SIGNED : {}) },
      };
      if (token) payload['client-key'] = token;
      ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch (e) { return; }
      if (!settled) {
        if (msg.type === 'response' && msg.id === 'register_0') { promptShown = true; return; } // "look at the TV"
        if (msg.type === 'registered') {
          clearTimeout(regTimer);
          const key = msg.payload && msg.payload['client-key'];
          if (key) token = key;
          settled = true;
          resolve({
            token, port: c.port,
            request(uri, reqPayload) {
              return new Promise((res, rej) => {
                const id = `req_${++seq}`;
                const timer = setTimeout(() => { pending.delete(id); rej(new Error(`LG ${tv.ip}: ${uri} timed out.`)); }, REQUEST_TIMEOUT_MS);
                pending.set(id, { resolve: res, reject: rej, timer });
                ws.send(JSON.stringify({ type: 'request', id, uri, payload: reqPayload || {} }));
              });
            },
            close() { try { ws.close(); } catch (e) { /* ignore */ } },
          });
          return;
        }
        if (msg.type === 'error') {
          clearTimeout(regTimer);
          fail(new Error(`LG ${tv.ip} refused registration: ${msg.error || 'unknown error'}${withSignature ? '' : ' (retrying with the signed manifest)'}`), 'REGISTER');
        }
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'error' || (msg.payload && msg.payload.returnValue === false)) {
        p.reject(new Error(`LG ${tv.ip}: ${msg.error || (msg.payload && msg.payload.errorText) || 'request failed'}`));
      } else {
        p.resolve(msg.payload || {});
      }
    });
  });
}

// One request on a fresh session. Returns { payload, token }.
async function once(tv, uri, payload, opts) {
  const s = await openSession(tv, opts);
  try {
    const out = await s.request(uri, payload);
    return { payload: out, token: s.token };
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------- remote keys

// Samsung-style key names (what the staff remote panel sends) -> LG's
// pointer-socket button names.
const KEY_MAP = {
  KEY_VOLUP: 'VOLUMEUP', KEY_VOLDOWN: 'VOLUMEDOWN', KEY_MUTE: 'MUTE',
  KEY_CHUP: 'CHANNELUP', KEY_CHDOWN: 'CHANNELDOWN', KEY_ENTER: 'ENTER', KEY_MINUS: 'DASH',
  KEY_UP: 'UP', KEY_DOWN: 'DOWN', KEY_LEFT: 'LEFT', KEY_RIGHT: 'RIGHT', KEY_RETURN: 'BACK', KEY_HOME: 'HOME',
  KEY_MENU: 'MENU', KEY_INFO: 'INFO', KEY_EXIT: 'EXIT', KEY_PLAY: 'PLAY', KEY_PAUSE: 'PAUSE', KEY_STOP: 'STOP',
  KEY_RED: 'RED', KEY_GREEN: 'GREEN', KEY_YELLOW: 'YELLOW', KEY_BLUE: 'BLUE',
};
for (let d = 0; d <= 9; d++) KEY_MAP[`KEY_${d}`] = String(d);

function lgButton(key) {
  if (KEY_MAP[key]) return KEY_MAP[key];
  if (/^[A-Z0-9_]+$/.test(String(key))) return String(key).replace(/^KEY_/, ''); // already an LG name
  throw new Error(`No LG button for key "${key}".`);
}

async function sendKeySequence(tv, keys, { interKeyDelayMs = 200 } = {}) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('No keys to send.');
  const buttons = keys.map(lgButton);
  const s = await openSession(tv);
  try {
    const { socketPath } = await s.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    if (!socketPath) throw new Error(`LG ${tv.ip}: no pointer input socket offered.`);
    await new Promise((resolve, reject) => {
      const ptr = new WebSocket(socketPath, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      const timer = setTimeout(() => { ptr.terminate(); reject(new Error(`LG ${tv.ip}: key press timed out.`)); }, REQUEST_TIMEOUT_MS + buttons.length * interKeyDelayMs);
      ptr.on('error', (err) => { clearTimeout(timer); reject(new Error(`LG ${tv.ip}: pointer socket error (${err.message}).`)); });
      ptr.on('open', async () => {
        try {
          for (const b of buttons) { ptr.send(`type:button\nname:${b}\n\n`); await sleep(interKeyDelayMs); }
          clearTimeout(timer); ptr.close(); resolve();
        } catch (err) { clearTimeout(timer); reject(err); }
      });
    });
    return { ok: true, token: s.token, keysSent: keys };
  } finally {
    s.close();
  }
}

function sendKey(tv, key) { return sendKeySequence(tv, [key]); }

// ---------------------------------------------------------------- volume / mute

async function setVolume(tv, op) {
  if (op === 'mute' || op === 'unmute') return setMute(tv, op === 'mute');
  const uri = { up: 'ssap://audio/volumeUp', down: 'ssap://audio/volumeDown' }[op];
  if (!uri) throw new Error(`Unknown volume op "${op}" -- expected "up", "down", "mute", or "unmute".`);
  const { token } = await once(tv, uri);
  return { ok: true, method: 'ssap', token };
}

// LG reads mute back, so this is a real discrete operation.
async function setMute(tv, desiredMuted) {
  const s = await openSession(tv);
  try {
    const before = await s.request('ssap://audio/getVolume');
    const beforeMuted = typeof before.muted === 'boolean' ? before.muted : (before.volumeStatus && before.volumeStatus.muteStatus);
    if (beforeMuted === desiredMuted) return { ok: true, muted: desiredMuted, changed: false, confirmed: true, method: 'none', token: s.token };
    await s.request('ssap://audio/setMute', { mute: !!desiredMuted });
    const after = await s.request('ssap://audio/getVolume');
    const afterMuted = typeof after.muted === 'boolean' ? after.muted : (after.volumeStatus && after.volumeStatus.muteStatus);
    return { ok: afterMuted === desiredMuted, muted: afterMuted, changed: afterMuted !== beforeMuted, confirmed: typeof afterMuted === 'boolean', method: 'ssap', token: s.token };
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------- power

async function setPower(tv, desiredState) {
  if (desiredState !== 'on' && desiredState !== 'off') throw new Error(`Unknown power state "${desiredState}" -- expected "on" or "off".`);
  const before = await getPowerState(tv);
  if (desiredState === 'on') {
    if (before === 'on') return { ok: true, requested: 'on', state: 'on', changed: false, method: 'none' };
    let after = before;
    let method = 'none';
    if (tv.wol_enabled && tv.mac) {
      // Same loop as the Samsung path: keep sending the wake while polling,
      // an LG's Wi-Fi radio in standby listens in duty cycles too.
      method = 'wol';
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await wol.sendMagicPacket(tv.mac, { ip: tv.ip }).catch(() => {});
        await sleep(2000);
        after = await getPowerState(tv);
        if (after === 'on') break;
      }
    }
    return { ok: after === 'on', requested: 'on', state: after, changed: after !== before, method,
      ...(after !== 'on' && !(tv.wol_enabled && tv.mac) ? { note: 'An LG can only be woken over the network with Wake-on-LAN: turn on "Mobile TV On" / "Quick Start+" on the set and enable WoL for it in TV Admin.' } : {}) };
  }
  if (before !== 'on') return { ok: true, requested: 'off', state: before, changed: false, method: 'none' };
  const { token } = await once(tv, 'ssap://system/turnOff');
  await sleep(2000);
  const after = await getPowerState(tv);
  return { ok: after !== 'on', requested: 'off', state: after, changed: after !== before, method: 'ssap', token };
}

// ---------------------------------------------------------------- channel

// "12.1" -> LG's "12-1". A plain "14" stays "14".
function lgChannelNumber(qamChannel) {
  const str = String(qamChannel == null ? '' : qamChannel).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error(`QAM channel "${qamChannel}" isn't in a recognized major[.minor] format (e.g. "14" or "12.1").`);
  return str.replace('.', '-');
}

// Unlike a Samsung, an LG reports the channel it landed on, so this
// confirms the change instead of trusting the key presses.
async function selectChannel(tv, qamChannel) {
  const wanted = lgChannelNumber(qamChannel);
  const s = await openSession(tv);
  try {
    await s.request('ssap://tv/openChannel', { channelNumber: wanted });
    await sleep(1500);
    let landed = null;
    try { const cur = await s.request('ssap://tv/getCurrentChannel'); landed = cur.channelNumber || null; } catch (e) { /* older firmware: no readback */ }
    return { ok: landed == null ? true : landed === wanted, requested: qamChannel, landed, method: 'ssap', confirmed: landed != null, token: s.token };
  } finally {
    s.close();
  }
}

module.exports = { isLg, identify, getState, getPowerState, sendKey, sendKeySequence, setPower, setVolume, setMute, selectChannel, lgChannelNumber, openSession };
