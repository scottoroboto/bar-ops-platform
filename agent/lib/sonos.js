// Sonos driver (Sept 2026): the bar's music. A Sonos Connect / Port on the
// AV VLAN plays Pandora itself; this file only talks to it over the local
// UPnP control API (plain SOAP on port 1400, no cloud, no Sonos account
// needed here). Station switching uses Sonos FAVORITES ("My Sonos" in the
// Sonos app): every Pandora station the owner saves there becomes a tile.
// That's the same path node-sonos / Home Assistant use to start a station,
// and it works for any service, not just Pandora.
//
// No volume on purpose (Scotto: the mixer owns volume; the Sonos line-out
// is set to Fixed). Mute isn't exposed either -- Pause is the "stop it".
const dgram = require('dgram');
const config = require('../config');

const SOAP_TIMEOUT_MS = 4000;
const POLL_MS = 5000;
const DISCOVER_EVERY_MS = 60000;

let player = null;              // { ip, name, model } once found
let state = { ok: false, error: 'Looking for the Sonos…', transport: null, track: null, station: null, updatedAt: null };
let favorites = [];             // [{ id, title, art, uri, meta, service }]
let favoritesAt = 0;
let timer = null;
let lastDiscoverAt = 0;

// ---------------------------------------------------------------- SOAP
const SERVICES = {
  AVTransport: { path: '/MediaRenderer/AVTransport/Control', urn: 'urn:schemas-upnp-org:service:AVTransport:1' },
  RenderingControl: { path: '/MediaRenderer/RenderingControl/Control', urn: 'urn:schemas-upnp-org:service:RenderingControl:1' },
  ContentDirectory: { path: '/MediaServer/ContentDirectory/Control', urn: 'urn:schemas-upnp-org:service:ContentDirectory:1' },
  DeviceProperties: { path: '/DeviceProperties/Control', urn: 'urn:schemas-upnp-org:service:DeviceProperties:1' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function unesc(s) {
  return String(s == null ? '' : s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
}

async function soap(ip, service, action, args = {}) {
  const svc = SERVICES[service];
  const body = Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${svc.urn}">${body}</u:${action}></s:Body></s:Envelope>`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), SOAP_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${ip}:${config.SONOS_PORT}${svc.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${svc.urn}#${action}"` },
      body: envelope,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const code = tag(text, 'errorCode') || res.status;
      throw new Error(`Sonos ${action} failed (${code})`);
    }
    return text;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- discovery
// SSDP M-SEARCH for ZonePlayers; SONOS_IP in .env skips this. One player
// per bar is the setup, so the first answer wins.
function discover() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from([
      'M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2',
      'ST: urn:schemas-upnp-org:device:ZonePlayer:1', '', '',
    ].join('\r\n'));
    let done = false;
    const finish = (ip) => { if (done) return; done = true; try { sock.close(); } catch (e) { /* closed */ } resolve(ip); };
    sock.on('message', (buf, rinfo) => {
      if (/ZonePlayer/i.test(buf.toString())) finish(rinfo.address);
    });
    sock.on('error', () => finish(null));
    sock.bind(() => {
      try { sock.setBroadcast(true); sock.send(msg, 0, msg.length, 1900, '239.255.255.250'); } catch (e) { finish(null); }
    });
    setTimeout(() => finish(null), 2500);
  });
}

async function describe(ip) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), SOAP_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${ip}:${config.SONOS_PORT}/xml/device_description.xml`, { signal: controller.signal });
    const xml = await res.text();
    let name = tag(xml, 'roomName') || tag(xml, 'friendlyName') || 'Sonos';
    try { const z = await soap(ip, 'DeviceProperties', 'GetZoneAttributes'); name = unesc(tag(z, 'CurrentZoneName') || name); } catch (e) { /* keep description name */ }
    return { ip, name, model: tag(xml, 'modelName') || 'Sonos' };
  } finally {
    clearTimeout(t);
  }
}

async function ensurePlayer() {
  if (player) return player;
  if (Date.now() - lastDiscoverAt < 15000) return null;
  lastDiscoverAt = Date.now();
  const ip = config.SONOS_IP || await discover();
  if (!ip) return null;
  try { player = await describe(ip); console.log(`[sonos] using ${player.name} (${player.model}) at ${player.ip}`); } catch (e) { player = null; }
  return player;
}

// ---------------------------------------------------------------- state
function parseTrack(meta) {
  if (!meta) return null;
  const xml = unesc(meta);
  const art = tag(xml, 'upnp:albumArtURI');
  return {
    title: unesc(tag(xml, 'dc:title') || ''),
    artist: unesc(tag(xml, 'dc:creator') || ''),
    album: unesc(tag(xml, 'upnp:album') || ''),
    art: art ? (art.startsWith('http') ? unesc(art) : `http://${player.ip}:${config.SONOS_PORT}${unesc(art)}`) : null,
    streamContent: unesc(tag(xml, 'r:streamContent') || ''),
  };
}

async function readState() {
  const p = await ensurePlayer();
  if (!p) { state = { ...state, ok: false, error: 'No Sonos found on this network yet.', updatedAt: new Date().toISOString() }; return state; }
  try {
    const [ti, pi, mi] = await Promise.all([
      soap(p.ip, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 }),
      soap(p.ip, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }),
      soap(p.ip, 'AVTransport', 'GetMediaInfo', { InstanceID: 0 }),
    ]);
    const transport = tag(ti, 'CurrentTransportState') || 'STOPPED';
    const track = parseTrack(tag(pi, 'TrackMetaData'));
    const stationMeta = parseTrack(tag(mi, 'CurrentURIMetaData'));
    const currentUri = unesc(tag(mi, 'CurrentURI') || '');
    // Radio streams put "Artist - Title" in r:streamContent and the station
    // in dc:title of the same block; Pandora on Sonos fills dc:title/creator
    // properly, so prefer those and fall back to streamContent.
    let t = track;
    if (t && !t.title && t.streamContent) {
      const [a, ...rest] = t.streamContent.split(' - ');
      t = { ...t, artist: rest.length ? a : '', title: rest.length ? rest.join(' - ') : a };
    }
    state = {
      ok: true, error: null, transport,
      playing: transport === 'PLAYING' || transport === 'TRANSITIONING',
      track: t && (t.title || t.artist) ? { title: t.title, artist: t.artist, album: t.album, art: t.art } : null,
      station: stationMeta && stationMeta.title ? { title: stationMeta.title, uri: currentUri } : (currentUri ? { title: null, uri: currentUri } : null),
      player: { name: p.name, model: p.model, ip: p.ip },
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    state = { ...state, ok: false, error: err.message, updatedAt: new Date().toISOString() };
    if (/ECONNREFUSED|EHOSTUNREACH|abort|fetch failed/i.test(err.message) && Date.now() - lastDiscoverAt > DISCOVER_EVERY_MS) player = null; // let discovery find it again (new IP)
  }
  return state;
}

// ---------------------------------------------------------------- favorites
// ContentDirectory Browse of "FV:2" = the Sonos app's My Sonos list. Each
// item carries the URI + the metadata Sonos needs handed back to play it.
async function readFavorites(force = false) {
  const p = await ensurePlayer();
  if (!p) return favorites;
  if (!force && Date.now() - favoritesAt < 30000) return favorites;
  const xml = await soap(p.ip, 'ContentDirectory', 'Browse', {
    ObjectID: 'FV:2', BrowseFlag: 'BrowseDirectChildren', Filter: '*', StartingIndex: 0, RequestedCount: 200, SortCriteria: '',
  });
  const didl = unesc(tag(xml, 'Result') || '');
  const items = [];
  const re = /<item\b([^>]*)>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(didl))) {
    const attrs = m[1]; const body = m[2];
    const id = (/\bid="([^"]+)"/.exec(attrs) || [])[1] || '';
    const title = unesc(tag(body, 'dc:title') || '');
    const uri = unesc(tag(body, 'res') || '');
    const meta = unesc(tag(body, 'r:resMD') || '');
    const art = tag(body, 'upnp:albumArtURI');
    const desc = unesc(tag(body, 'r:description') || '');
    items.push({
      id, title, uri, meta, service: desc || null,
      art: art ? (art.startsWith('http') ? unesc(art) : `http://${p.ip}:${config.SONOS_PORT}${unesc(art)}`) : null,
    });
  }
  favorites = items;
  favoritesAt = Date.now();
  return favorites;
}

// ---------------------------------------------------------------- commands
async function transport(action) {
  const p = await ensurePlayer();
  if (!p) throw new Error('No Sonos found on this network.');
  const args = { InstanceID: 0 };
  if (action === 'Play') args.Speed = 1;
  try {
    await soap(p.ip, 'AVTransport', action, args);
  } catch (err) {
    // Some radio streams refuse Pause; Stop is the equivalent for them.
    if (action === 'Pause' && /701|failed/.test(err.message)) await soap(p.ip, 'AVTransport', 'Stop', { InstanceID: 0 });
    else throw err;
  }
  await readState().catch(() => {});
  return state;
}

async function playFavorite(id) {
  const p = await ensurePlayer();
  if (!p) throw new Error('No Sonos found on this network.');
  const favs = await readFavorites(true);
  const fav = favs.find((f) => f.id === id);
  if (!fav) throw new Error('That station is no longer in My Sonos.');
  await soap(p.ip, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: fav.uri, CurrentURIMetaData: fav.meta });
  await soap(p.ip, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
  await readState().catch(() => {});
  return { state, station: fav.title };
}

// Owner-only "remove for good": drops the favorite from My Sonos itself.
async function removeFavorite(id) {
  const p = await ensurePlayer();
  if (!p) throw new Error('No Sonos found on this network.');
  await soap(p.ip, 'ContentDirectory', 'DestroyObject', { ObjectID: id });
  await readFavorites(true).catch(() => {});
}

function getState() { return state; }
function getFavorites() { return favorites; }
function currentFavoriteId() {
  const uri = state.station && state.station.uri;
  if (!uri) return null;
  const hit = favorites.find((f) => f.uri && uri && (f.uri === uri || f.uri.split('?')[0] === uri.split('?')[0]));
  return hit ? hit.id : null;
}

function start() {
  if (timer) return;
  const tick = () => readState().then(() => readFavorites().catch(() => {})).catch(() => {});
  tick();
  timer = setInterval(tick, POLL_MS);
  console.log(config.SONOS_IP ? `[sonos] polling ${config.SONOS_IP}` : '[sonos] no SONOS_IP set — will look for a player on the network');
}

module.exports = { start, getState, getFavorites, readFavorites, currentFavoriteId, transport, playFavorite, readState, removeFavorite };
