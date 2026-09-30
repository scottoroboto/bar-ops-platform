// TP-Link Kasa smart plugs (the EP25s on the bars' neon signs), local
// control only -- no TP-Link cloud, so signs keep switching with the
// internet down. Kasa speaks the same JSON "IOT" commands over two wires:
//
//   XOR   9999/tcp, older firmware. Each byte XOR'd with the previous
//         ciphertext byte (seed 171), 4-byte length prefix.
//   KLAP  80/http, newer firmware (EP25 hardware 2.x). Two-step seed
//         handshake proves both sides know the same credential hash, then
//         every request is AES-128-CBC with a per-message sequence number
//         and a SHA-256 signature. This is TP-Link's "KLAP v1" as used by
//         Kasa (IOT.KLAP) devices; the credential hash is
//         md5(md5(username) + md5(password)).
//
// A plug that was never linked to a Kasa account answers the blank
// credential; one set up through the Kasa app answers that account, and
// some answer TP-Link's setup default. The handshake tells us which, so we
// try them in turn and remember what worked per plug.
const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const os = require('os');

const XOR_PORT = 9999;
const DISCOVERY_PORT_2 = 20002;
const REQUEST_TIMEOUT_MS = 4000;
// TP-Link's own setup default for Kasa devices (python-kasa ships the same pair).
const KASA_SETUP_CREDS = { username: 'kasa@tp-link.net', password: 'kasaSetup' };
// Probes for newer Kasa/Tapo firmware on UDP 20002/20004: the old fixed
// 16-byte one, and the current one -- a 16-byte header (version 2, probe,
// CRC32 over the whole datagram) carrying an RSA public key, which is what
// the TP-Link apps and python-kasa send now. The plain fields we need (ip,
// mac, model, encryption scheme) come back unencrypted either way.
const DISCOVERY_QUERY_2 = Buffer.from('020000010000000000000000463cb5d3', 'hex');
const DISCOVERY_PORT_3 = 20004;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

let rsaQuery = null;
function rsaDiscoveryQuery() {
  if (rsaQuery) return rsaQuery;
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const body = Buffer.from(JSON.stringify({ params: { rsa_key: publicKey.export({ type: 'spki', format: 'pem' }) } }));
  const header = Buffer.alloc(16);
  header.writeUInt8(2, 0);            // version
  header.writeUInt8(0, 1);            // message type
  header.writeUInt16BE(1, 2);         // op code: probe
  header.writeUInt16BE(body.length, 4);
  header.writeUInt8(17, 6);           // flags
  header.writeUInt8(0, 7);
  header.writeUInt32BE(crypto.randomBytes(4).readUInt32BE(0), 8); // serial
  header.writeUInt32BE(0x5a6b7c8d, 12); // CRC placeholder, then the real one
  const q = Buffer.concat([header, body]);
  q.writeUInt32BE(crc32(q), 12);
  rsaQuery = q;
  return q;
}

const md5 = (b) => crypto.createHash('md5').update(b).digest();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function normalizeMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.length === 12 ? hex.match(/../g).join(':') : null;
}

// ---- XOR ------------------------------------------------------------------
function xorEncrypt(buf) {
  let key = 171;
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) { out[i] = buf[i] ^ key; key = out[i]; }
  return out;
}
function xorDecrypt(buf) {
  let key = 171;
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) { out[i] = buf[i] ^ key; key = buf[i]; }
  return out;
}

function xorRequest(host, port, obj, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const payload = xorEncrypt(Buffer.from(JSON.stringify(obj)));
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    const done = (err, val) => { sock.destroy(); clearTimeout(timer); if (err) reject(err); else resolve(val); };
    const timer = setTimeout(() => done(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs);
    sock.on('connect', () => sock.write(frame));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        try { done(null, JSON.parse(xorDecrypt(buf.subarray(4, 4 + buf.readUInt32BE(0))).toString())); } catch (e) { done(e); }
      }
    });
    sock.on('error', (e) => done(e));
  });
}

// ---- KLAP -----------------------------------------------------------------
function authHash({ username, password }) {
  return md5(Buffer.concat([md5(Buffer.from(username || '')), md5(Buffer.from(password || ''))]));
}

class KlapSession {
  constructor(localSeed, remoteSeed, userHash) {
    const base = Buffer.concat([localSeed, remoteSeed, userHash]);
    this.key = sha256(Buffer.concat([Buffer.from('lsk'), base])).subarray(0, 16);
    const fullIv = sha256(Buffer.concat([Buffer.from('iv'), base]));
    this.iv = fullIv.subarray(0, 12);
    this.seq = fullIv.readInt32BE(28);
    this.sig = sha256(Buffer.concat([Buffer.from('ldk'), base])).subarray(0, 28);
  }
  ivFor(seq) {
    const s = Buffer.alloc(4);
    s.writeInt32BE(seq, 0);
    return { ivSeq: Buffer.concat([this.iv, s]), seqBuf: s };
  }
  encrypt(obj) {
    this.seq = this.seq === 0x7fffffff ? -0x80000000 : this.seq + 1;
    const { ivSeq, seqBuf } = this.ivFor(this.seq);
    const c = crypto.createCipheriv('aes-128-cbc', this.key, ivSeq);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
    const signature = sha256(Buffer.concat([this.sig, seqBuf, ct]));
    return { body: Buffer.concat([signature, ct]), seq: this.seq };
  }
  decrypt(buf, seq) {
    const { ivSeq } = this.ivFor(seq);
    const d = crypto.createDecipheriv('aes-128-cbc', this.key, ivSeq);
    return JSON.parse(Buffer.concat([d.update(buf.subarray(32)), d.final()]).toString());
  }
}

async function post(url, body, cookie, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await fetch(url, {
    method: 'POST', body,
    headers: { 'content-type': 'application/octet-stream', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, setCookie: res.headers.get('set-cookie') || '' };
}

const sessions = new Map(); // "host:port" -> { session, cookie, expiresAt, credIndex }

async function klapHandshake(host, port, credsList) {
  const base = `http://${host}:${port}/app`;
  const localSeed = crypto.randomBytes(16);
  const h1 = await post(`${base}/handshake1`, localSeed);
  if (h1.status !== 200 || h1.buf.length < 48) throw Object.assign(new Error(`handshake1 HTTP ${h1.status}`), { code: 'KLAP_HANDSHAKE' });
  const remoteSeed = h1.buf.subarray(0, 16);
  const serverHash = h1.buf.subarray(16, 48);
  const sid = /TP_SESSIONID=([^;,\s]+)/.exec(h1.setCookie);
  const timeout = /TIMEOUT=(\d+)/.exec(h1.setCookie);
  const cookie = sid ? `TP_SESSIONID=${sid[1]}` : '';
  const idx = credsList.findIndex((c) => sha256(Buffer.concat([localSeed, authHash(c)])).equals(serverHash));
  if (idx < 0) throw Object.assign(new Error('This plug wants a Kasa account login the Pi does not have.'), { code: 'KLAP_AUTH' });
  const userHash = authHash(credsList[idx]);
  const h2 = await post(`${base}/handshake2`, sha256(Buffer.concat([remoteSeed, userHash])), cookie);
  if (h2.status !== 200) throw Object.assign(new Error(`handshake2 HTTP ${h2.status}`), { code: 'KLAP_HANDSHAKE' });
  const ttl = timeout ? Number(timeout[1]) : 3600;
  return { session: new KlapSession(localSeed, remoteSeed, userHash), cookie, expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000, credIndex: idx };
}

async function klapRequest(host, port, obj, credsList) {
  const key = `${host}:${port}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let s = sessions.get(key);
    if (!s || s.expiresAt < Date.now()) {
      s = await klapHandshake(host, port, credsList);
      sessions.set(key, s);
    }
    const { body, seq } = s.session.encrypt(obj);
    const res = await post(`http://${host}:${port}/app/request?seq=${seq}`, body, s.cookie);
    if (res.status === 200) return s.session.decrypt(res.buf, seq);
    sessions.delete(key); // expired or rejected session: handshake again once
    if (attempt === 1) throw Object.assign(new Error(`request HTTP ${res.status}`), { code: 'KLAP_REQUEST' });
  }
  return null;
}

// ---- One plug -------------------------------------------------------------
// `plug` is { ip, protocol?, http_port?, xor_port? } -- protocol is what the
// last successful call used ('klap' | 'xor'); unknown means try KLAP, then XOR.
let accountCreds = null; // { username, password } when a plug is linked to a Kasa account
function setAccount(creds) {
  accountCreds = creds && creds.username ? creds : null;
  sessions.clear();
}
function credsList() {
  return [{ username: '', password: '' }, KASA_SETUP_CREDS, ...(accountCreds ? [accountCreds] : [])];
}

const detected = new Map(); // ip -> 'klap' | 'xor'

async function request(plug, obj) {
  const host = plug.ip;
  if (!host) throw Object.assign(new Error('No address for this plug yet.'), { code: 'NO_IP' });
  const order = (plug.protocol || detected.get(host)) === 'xor' ? ['xor', 'klap'] : ['klap', 'xor'];
  let lastErr = null;
  for (const proto of order) {
    try {
      const out = proto === 'klap'
        ? await klapRequest(host, plug.http_port || 80, obj, credsList())
        : await xorRequest(host, plug.xor_port || XOR_PORT, obj);
      detected.set(host, proto);
      return { proto, out };
    } catch (e) {
      lastErr = e;
      if (e.code === 'KLAP_AUTH') break; // it IS a KLAP plug; XOR won't help
    }
  }
  throw lastErr;
}

function readInfo(out) {
  const sys = (out && out.system && out.system.get_sysinfo) || {};
  const rt = out && out.emeter && out.emeter.get_realtime;
  let watts = null;
  if (rt && (rt.err_code === 0 || rt.err_code === undefined)) {
    if (rt.power_mw !== undefined) watts = Math.round(rt.power_mw / 100) / 10;
    else if (rt.power !== undefined) watts = Math.round(rt.power * 10) / 10;
  }
  return {
    on: sys.relay_state === 1,
    alias: sys.alias || null,
    model: sys.model || null,
    mac: normalizeMac(sys.mac || sys.mic_mac),
    rssi: sys.rssi !== undefined ? sys.rssi : null,
    ledOff: sys.led_off === 1,
    watts,
  };
}

async function getInfo(plug) {
  const { proto, out } = await request(plug, { system: { get_sysinfo: {} }, emeter: { get_realtime: {} } });
  return { ...readInfo(out), protocol: proto };
}

async function setPower(plug, on) {
  const { out } = await request(plug, { system: { set_relay_state: { state: on ? 1 : 0 } } });
  const r = out && out.system && out.system.set_relay_state;
  if (r && r.err_code) throw Object.assign(new Error(`Plug refused (${r.err_code})`), { code: 'REFUSED' });
  return true;
}

// "Blink to find": flash the sign itself twice, then leave it as it was.
async function blink(plug) {
  const before = (await getInfo(plug)).on;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 2; i++) {
    await setPower(plug, !before); await pause(900);
    await setPower(plug, before); await pause(900);
  }
  return before;
}

// ---- Discovery ------------------------------------------------------------
// UDP, answered by the plugs themselves: the XOR sysinfo query on 9999 and
// the fixed probe on 20002. Broadcast only reaches the Pi's own subnet, and
// the plugs may sit on another VLAN (like the TVs), so every address in the
// given /24s also gets a direct probe -- two small packets each.
function hostsIn(cidr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(String(cidr).trim());
  if (!m) return [];
  const bits = Number(m[5]);
  if (bits < 22 || bits > 30) return [];
  const base = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net0 = base & mask;
  const size = 2 ** (32 - bits);
  const out = [];
  for (let i = 1; i < size - 1; i++) {
    const n = (net0 + i) >>> 0;
    out.push(`${n >>> 24}.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`);
  }
  return out;
}

function localSubnets() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address.replace(/\.\d+$/, '.0/24'));
    }
  }
  return out;
}

function discover({ ranges = [], timeoutMs = 3500, xorPort = XOR_PORT, port2 = DISCOVERY_PORT_2 } = {}) {
  return new Promise((resolve) => {
    const found = new Map(); // mac -> device
    const sock = dgram.createSocket('udp4');
    const add = (dev) => {
      if (!dev.mac) return;
      found.set(dev.mac, { ...(found.get(dev.mac) || {}), ...dev });
    };
    sock.on('message', (msg, rinfo) => {
      try {
        if (rinfo.port === port2 || rinfo.port === DISCOVERY_PORT_3 || (msg.length > 16 && msg[0] === 0x02)) {
          const j = JSON.parse(msg.subarray(16).toString());
          const r = j.result || {};
          const schm = r.mgt_encrypt_schm || {};
          add({
            mac: normalizeMac(r.mac), ip: r.ip || rinfo.address, model: r.device_model || null,
            deviceType: r.device_type || null,
            protocol: String(schm.encrypt_type || '').toUpperCase() === 'KLAP' ? 'klap' : null,
            http_port: schm.http_port || 80,
          });
        } else {
          const j = JSON.parse(xorDecrypt(msg).toString());
          const sys = (j.system && j.system.get_sysinfo) || {};
          add({ mac: normalizeMac(sys.mac || sys.mic_mac), ip: rinfo.address, model: sys.model || null, alias: sys.alias || null, protocol: 'xor', on: sys.relay_state === 1 });
        }
      } catch (e) { /* not a Kasa answer */ }
    });
    sock.on('error', () => {});
    sock.bind(() => {
      sock.setBroadcast(true);
      const q1 = xorEncrypt(Buffer.from(JSON.stringify({ system: { get_sysinfo: {} } })));
      const q2 = rsaDiscoveryQuery();
      const targets = new Set(['255.255.255.255']);
      for (const r of new Set([...ranges, ...localSubnets()])) {
        const hosts = hostsIn(r);
        hosts.forEach((h) => targets.add(h));
        if (hosts.length) targets.add(hosts[hosts.length - 1].replace(/\d+$/, (n) => String(Number(n) + 1)));
      }
      const list = [...targets];
      let i = 0;
      // Pace the sweep a little so a /22 doesn't burst 2,000 packets at once.
      const tick = setInterval(() => {
        for (let k = 0; k < 64 && i < list.length; k++, i++) {
          sock.send(q1, xorPort, list[i], () => {});
          sock.send(DISCOVERY_QUERY_2, port2, list[i], () => {});
          sock.send(q2, port2, list[i], () => {});
          if (port2 === DISCOVERY_PORT_2) sock.send(q2, DISCOVERY_PORT_3, list[i], () => {});
        }
        if (i >= list.length) clearInterval(tick);
      }, 20);
      setTimeout(() => { clearInterval(tick); try { sock.close(); } catch (e) { /* closed */ } resolve([...found.values()]); }, timeoutMs);
    });
  });
}

module.exports = {
  getInfo, setPower, blink, discover, setAccount, normalizeMac, hostsIn,
  // exported for tests
  _internal: { crc32, rsaDiscoveryQuery, xorEncrypt, xorDecrypt, authHash, KlapSession, KASA_SETUP_CREDS },
};
