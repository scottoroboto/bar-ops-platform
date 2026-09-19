// Wake-on-LAN -- the one "driver" self-contained enough to build in Phase 1
// alongside discovery itself (docs/venue-control.md lists `wol.js` under
// agent/lib/drivers/, and "wol" is one of discovery's own §9.2 test types).
// Unlike the DirecTV/Samsung drivers (Phase 2/6 -- real per-vendor command
// protocols), WoL is just a UDP broadcast of a fixed packet shape to a MAC
// address, so there's no reason to gate it behind a later phase.
const dgram = require('dgram');
const os = require('os');

function normalizeMac(mac) {
  const clean = String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (clean.length !== 12) throw new Error(`Not a valid MAC address: ${mac}`);
  return clean;
}

function macToBytes(cleanMac) {
  const bytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) bytes[i] = parseInt(cleanMac.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function buildMagicPacket(mac) {
  const macBytes = macToBytes(normalizeMac(mac));
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

// Every IPv4 subnet-directed broadcast address this box sits on (e.g.
// 10.0.0.255 for 10.0.0.35/24). The limited broadcast 255.255.255.255 is
// not always forwarded onto a WiFi segment by a home/prosumer router, and
// a TV's WiFi radio in standby is the least forgiving listener there is,
// so the magic packet goes out every plausible way rather than one.
function localBroadcastAddresses() {
  const out = new Set();
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal || !net.netmask) continue;
      const ip = net.address.split('.').map(Number);
      const mask = net.netmask.split('.').map(Number);
      out.add(ip.map((octet, i) => (octet | (~mask[i] & 0xff))).join('.'));
    }
  }
  return Array.from(out);
}

function sendOnce(socket, packet, port, address) {
  return new Promise((resolve) => {
    socket.send(packet, 0, packet.length, port, address, (err) => resolve(!err));
  });
}

// Sends the magic packet on the conventional WoL port 9 to: the limited
// broadcast (255.255.255.255), every subnet-directed broadcast this box
// is on, and -- when the caller knows it -- the target's own last IP as a
// unicast (some APs deliver a unicast to a dozing client where they drop
// broadcasts). Three rounds, 100ms apart: a Samsung's standby WiFi radio
// wakes on a duty cycle and can miss a single packet. Read-only from the
// network's point of view otherwise -- this is the one intentionally
// state-changing thing discovery's "wol" test does, and callers are
// expected to have already gated that behind the UI's disruptive-test
// confirmation per §9.2.
async function sendMagicPacket(mac, { port = 9, ip = null, rounds = 3 } = {}) {
  const packet = buildMagicPacket(mac);
  const targets = new Set(['255.255.255.255', ...localBroadcastAddresses()]);
  if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) targets.add(ip);
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(() => { socket.setBroadcast(true); resolve(); });
  });
  let delivered = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      for (const address of targets) {
        if (await sendOnce(socket, packet, port, address)) delivered++;
      }
      if (round < rounds - 1) await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    socket.close();
  }
  if (!delivered) throw new Error('Wake-on-LAN packet could not be sent on any interface.');
  return { ok: true, mac: normalizeMac(mac), targets: Array.from(targets), port, rounds };
}

module.exports = { sendMagicPacket, buildMagicPacket, localBroadcastAddresses };
