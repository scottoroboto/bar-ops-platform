#!/usr/bin/env node
/*
 * Exercises the paths that are easy to get wrong: Samsung pairing, the remote
 * WebSocket, discrete power, and Wake-on-LAN. Doubles as a worked reference for
 * the agent's samsung-ws.js and wol.js drivers.
 *
 *   node test-devices.js
 */

'use strict';
const net = require('net');
const tls = require('tls');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');

const B = '127.0.0.';
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const bad = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); process.exitCode = 1; };

// --- tiny WebSocket client -------------------------------------------------
function wsConnect(host, port, pathname, { secure = true, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const opts = { host, port, rejectUnauthorized: false };
    const sock = secure ? tls.connect(opts) : net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeout);

    sock.on('error', (e) => { clearTimeout(t); reject(e); });
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      sock.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });

    let buf = Buffer.alloc(0), upgraded = false;
    const listeners = [];
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        upgraded = true;
        buf = buf.slice(i + 4);
        clearTimeout(t);
        resolve({
          send(obj) {
            const p = Buffer.from(JSON.stringify(obj));
            const mk = crypto.randomBytes(4);
            const masked = Buffer.from(p); for (let j = 0; j < masked.length; j++) masked[j] ^= mk[j % 4];
            const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length])
              : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(p.length); return b; })()]);
            sock.write(Buffer.concat([head, mk, masked]));
          },
          next(ms = 2500) {
            return new Promise((res) => {
              const to = setTimeout(() => res(null), ms);
              listeners.push((m) => { clearTimeout(to); res(m); });
            });
          },
          close() { sock.destroy(); },
        });
      }
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        const msg = buf.slice(off, off + len).toString();
        buf = buf.slice(off + len);
        const fn = listeners.shift();
        if (fn) fn(msg); else lastUnclaimed = msg;
      }
    });
    var lastUnclaimed = null;
  });
}

const get = (host, port, p) => new Promise((res) => {
  const r = http.get({ host, port, path: p, timeout: 3000 }, (x) => {
    let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res({ status: x.statusCode, body: b }));
  });
  r.on('timeout', () => { r.destroy(); res(null); });
  r.on('error', () => res(null));
});

function wol(macStr) {
  return new Promise((res) => {
    const m = Buffer.from(macStr.split(':').map((h) => parseInt(h, 16)));
    const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
    const s = dgram.createSocket('udp4');
    s.send(pkt, 9, '127.0.0.1', () => { s.close(); res(); });
  });
}

// --- tests -----------------------------------------------------------------
(async () => {
  console.log('\n  Samsung remote, pairing, discrete power and Wake-on-LAN\n');

  // 1. a paired token TV accepts the remote and hands back a token
  {
    const ws = await wsConnect(B + '121', 8002, '/api/v2/channels/samsung.remote.control?name=VmVudWU=');
    const hello = JSON.parse(await ws.next());
    hello.event === 'ms.channel.connect' && hello.data.token
      ? ok(`MB1 accepted the remote, token ${hello.data.token}`)
      : bad('MB1 did not hand back a token');

    ws.send({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: 'false', TypeOfCmd: 'SendRemoteKey' } });
    await ws.next(1200);
    const st = JSON.parse((await get(B + '121', 8001, '/sim/state')).body);
    st.volume === 1 ? ok('KEY_VOLUP landed — volume 0 -> 1') : bad(`volume did not move (${st.volume})`);
    ws.close();
  }

  // 2. QAM tuning by key codes: 12.1 = KEY_1 KEY_2 KEY_MINUS KEY_1 KEY_ENTER
  {
    const ws = await wsConnect(B + '122', 8002, '/api/v2/channels/samsung.remote.control?name=VmVudWU=');
    await ws.next();
    for (const k of ['KEY_1', 'KEY_2', 'KEY_MINUS', 'KEY_1', 'KEY_ENTER']) {
      ws.send({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: k, Option: 'false', TypeOfCmd: 'SendRemoteKey' } });
      await ws.next(600);
    }
    const st = JSON.parse((await get(B + '122', 8001, '/sim/state')).body);
    st.channel === '12.1' ? ok('MB2 tuned to QAM 12.1 by key codes') : bad(`channel is ${st.channel}, expected 12.1`);
    ws.close();
  }

  // 3. an un-accepted TV refuses, then works after Allow is pressed
  {
    const ws = await wsConnect(B + '133', 8002, '/api/v2/channels/samsung.remote.control?name=VmVudWU=');
    const m = JSON.parse(await ws.next());
    m.event === 'ms.channel.unauthorized'
      ? ok('MB13 refused the remote — needs Allow at the screen')
      : bad(`MB13 should have refused, got ${m.event}`);
    ws.close();

    await get(B + '133', 8001, '/sim/allow');            // stands in for tapping Allow
    const ws2 = await wsConnect(B + '133', 8002, '/api/v2/channels/samsung.remote.control?name=VmVudWU=');
    const m2 = JSON.parse(await ws2.next());
    m2.event === 'ms.channel.connect' ? ok('MB13 paired and accepted the remote') : bad('MB13 still refusing after Allow');
    ws2.close();
  }

  // 4. discrete power: POWEROFF twice must not turn it back on
  {
    const ws = await wsConnect(B + '123', 8002, '/api/v2/channels/samsung.remote.control?name=VmVudWU=');
    await ws.next();
    for (let i = 0; i < 2; i++) {
      ws.send({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_POWEROFF', Option: 'false', TypeOfCmd: 'SendRemoteKey' } });
      await ws.next(600);
    }
    const st = JSON.parse((await get(B + '123', 8001, '/sim/state')).body);
    st.power === 'standby'
      ? ok('KEY_POWEROFF is idempotent — twice still standby')
      : bad(`power is ${st.power}; a toggle would have flipped it back on`);
    ws.close();
  }

  // 5. a TV that is properly off answers nothing until Wake-on-LAN
  {
    const before = await get(B + '169', 8001, '/api/v2/');
    !before ? ok('BR9 is off — no answer on 8001, as a dark TV should be')
            : bad('BR9 answered while powered down');
    await wol('a4:6c:f1:30:00:22');
    await new Promise((r) => setTimeout(r, 400));
    const after = await get(B + '169', 8001, '/api/v2/');
    after && after.body.includes('Samsung')
      ? ok('Wake-on-LAN woke BR9 — it now answers')
      : bad('BR9 did not wake');
  }

  console.log(process.exitCode ? '\n  Some checks failed.\n' : '\n  All checks passed.\n');
})().catch((e) => { console.error('  ERROR', e.message); process.exit(1); });
