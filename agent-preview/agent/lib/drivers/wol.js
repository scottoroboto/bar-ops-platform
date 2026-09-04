// Wake-on-LAN -- the one "driver" self-contained enough to build in Phase 1
// alongside discovery itself (docs/venue-control.md lists `wol.js` under
// agent/lib/drivers/, and "wol" is one of discovery's own §9.2 test types).
// Unlike the DirecTV/Samsung drivers (Phase 2/6 -- real per-vendor command
// protocols), WoL is just a UDP broadcast of a fixed packet shape to a MAC
// address, so there's no reason to gate it behind a later phase.
const dgram = require('dgram');

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

// Sends the magic packet to the LAN broadcast address (255.255.255.255 by
// default -- works for any host on the agent's own subnet without needing
// to know the specific subnet broadcast address) on the conventional WoL
// port 9. Read-only from the network's point of view otherwise -- this is
// the one intentionally state-changing thing discovery's "wol" test does,
// and callers are expected to have already gated that behind the UI's
// disruptive-test confirmation per §9.2.
function sendMagicPacket(mac, { broadcast = '255.255.255.255', port = 9 } = {}) {
  return new Promise((resolve, reject) => {
    const packet = buildMagicPacket(mac);
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => { socket.close(); reject(err); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, broadcast, (err) => {
        socket.close();
        if (err) reject(err); else resolve({ ok: true, mac: normalizeMac(mac), broadcast, port });
      });
    });
  });
}

module.exports = { sendMagicPacket, buildMagicPacket };
