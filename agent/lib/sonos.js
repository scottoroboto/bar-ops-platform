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
const cache = require('./cache');

const SOAP_TIMEOUT_MS = 4000;
const POLL_MS = 5000;
const DISCOVER_EVERY_MS = 60000;

let player = null;              // { ip, name, model } once found
let state = { ok: false, error: 'Looking for the Sonos…', transport: null, track: null, station: null, updatedAt: null };
let favorites = [];             // [{ id, title, art, uri, meta, service }]
let favoritesAt = 0;
let timer = null;
let lastStationDidl = '';        // the playing station's own metadata, for auto-save
const autoSaveTried = new Set(); // station ids already tried this run (one try each)
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
    const stationDidl = unesc(tag(mi, 'CurrentURIMetaData') || '');
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
    lastStationDidl = stationDidl;
    learnPandora(currentUri, stationDidl);
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
  // Sonos hands back at most 100 per Browse, so page until it's all here
  // (the bar's Pandora account has 100+ stations).
  let didl = '';
  for (let start = 0; start < 2000;) {
    const xml = await soap(p.ip, 'ContentDirectory', 'Browse', {
      ObjectID: 'FV:2', BrowseFlag: 'BrowseDirectChildren', Filter: '*', StartingIndex: start, RequestedCount: 100, SortCriteria: '',
    });
    didl += unesc(tag(xml, 'Result') || '');
    const got = Number(tag(xml, 'NumberReturned')) || 0;
    const total = Number(tag(xml, 'TotalMatches')) || 0;
    start += got;
    if (!got || start >= total) break;
  }
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
  for (const f of items) if (learnPandora(f.uri, f.meta)) break;
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

// ---------------------------------------------------------------- auto-save
// "Play it once and it's on the list" (Scotto, 2026-10-04): a Pandora
// station playing on the bar's Sonos that isn't in My Sonos gets added
// there, so a station someone made in the Sonos app shows up on the iPad
// without a second step. Pandora's Shuffle and anything that isn't a
// Pandora station are left alone. Adding uses ContentDirectory
// CreateObject on FV:2 (the call the Sonos desktop app makes; not in
// Sonos's public docs), with the URI and metadata exactly as the player
// reported them. One try per station per run, so a refusal can't loop.
function pandoraStationId(uri) {
  const m = /^x-sonosapi-radio:([^?]+)/i.exec(String(uri || ''));
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[1]); } catch (e) { return null; }
  return /^ST:/i.test(id) ? id.toUpperCase() : null;
}

function isFavorite(uri) {
  const id = pandoraStationId(uri);
  const base = String(uri).split('?')[0];
  return favorites.some((f) => f.uri && (f.uri.split('?')[0] === base || (id && pandoraStationId(f.uri) === id)));
}

async function autoSaveStation() {
  const st = state.station;
  if (!state.ok || !state.playing || !st || !st.uri || !st.title || !player) return null;
  const id = pandoraStationId(st.uri);
  if (!id || /shuffle|quickmix/i.test(st.title)) return null;
  if (!favoritesAt || autoSaveTried.has(id) || isFavorite(st.uri)) return null;
  autoSaveTried.add(id);
  const scheme = st.uri.split(':')[0];
  const art = (/<upnp:albumArtURI>([\s\S]*?)<\/upnp:albumArtURI>/.exec(lastStationDidl) || [])[1];
  const elements = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
    + 'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
    + '<item id="" restricted="true">'
    + `<dc:title>${esc(st.title)}</dc:title>`
    + '<upnp:class>object.itemobject.item.sonos-favorite</upnp:class>'
    + '<r:ordinal>-1</r:ordinal>'
    + (art ? `<upnp:albumArtURI>${art}</upnp:albumArtURI>` : '')
    + `<res protocolInfo="${esc(scheme)}:*:*:*">${esc(st.uri)}</res>`
    + '<r:type>instance</r:type><r:description>Pandora</r:description>'
    + `<r:resMD>${esc(lastStationDidl)}</r:resMD>`
    + '</item></DIDL-Lite>';
  try {
    await soap(player.ip, 'ContentDirectory', 'CreateObject', { ContainerID: 'FV:2', Elements: elements });
    console.log(`[sonos] saved "${st.title}" to My Sonos (played on the Sonos, wasn't a favorite)`);
    await readFavorites(true).catch(() => {});
    return st.title;
  } catch (err) {
    console.warn(`[sonos] couldn't save "${st.title}" to My Sonos: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- Pandora by id
// lib/pandora.js gives station ids straight from the account; to play one
// the Sonos needs a URI + metadata in its own Pandora format, which carries
// this household's account number (sn) and service token. Those are
// copied from any Pandora station the Sonos has played or saved, and kept
// in the cache so a restart doesn't forget them. Until one has been seen,
// Sonos's usual values are tried (sid 236, sn 1).
let pandoraTpl = cache.get('sonosPandoraTemplate') || null;
function learnPandora(uri, didl) {
  if (!pandoraStationId(uri) || !didl) return false;
  const q = new URLSearchParams(String(uri).split('?')[1] || '');
  const desc = (/<desc\b[^>]*>([\s\S]*?)<\/desc>/.exec(didl) || [])[1];
  const itemPrefix = (/<item\b[^>]*\bid="([0-9a-fA-F]{8})ST/.exec(didl) || [])[1];
  const tpl = {
    sid: q.get('sid') || '236', flags: q.get('flags') || '8300', sn: q.get('sn') || '1',
    desc: desc || 'SA_RINCON60423_X_#Svc60423-0-Token', itemPrefix: itemPrefix || '100c206c',
  };
  if (JSON.stringify(tpl) !== JSON.stringify(pandoraTpl)) { pandoraTpl = tpl; cache.set('sonosPandoraTemplate', tpl); }
  return true;
}

function pandoraUri(stationId) {
  const t = pandoraTpl || { sid: '236', flags: '8300', sn: '1' };
  return `x-sonosapi-radio:ST%3a${encodeURIComponent(stationId)}?sid=${t.sid}&flags=${t.flags}&sn=${t.sn}`;
}

async function playPandoraStation({ stationId, name, art }) {
  const p = await ensurePlayer();
  if (!p) throw new Error('No Sonos found on this network.');
  const t = pandoraTpl || { desc: 'SA_RINCON60423_X_#Svc60423-0-Token', itemPrefix: '100c206c' };
  const uri = pandoraUri(stationId);
  const didl = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
    + 'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
    + `<item id="${t.itemPrefix}ST%3a${esc(encodeURIComponent(stationId))}" parentID="0" restricted="true">`
    + `<dc:title>${esc(name)}</dc:title>`
    + '<upnp:class>object.item.audioItem.audioBroadcast.#station</upnp:class>'
    + (art ? `<upnp:albumArtURI>${esc(art)}</upnp:albumArtURI>` : '')
    + `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${esc(t.desc)}</desc>`
    + '</item></DIDL-Lite>';
  try {
    await soap(p.ip, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: uri, CurrentURIMetaData: didl });
    await soap(p.ip, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
  } catch (err) {
    if (!pandoraTpl) throw new Error(`The Sonos wouldn't start it (${err.message}). Play any Pandora station once from the Sonos app so the box learns this account's settings, then try again.`);
    throw err;
  }
  await readState().catch(() => {});
  return { state, station: name };
}

// What's playing, as a key the station list can match: "ST:<id>" for a
// Pandora station, else the URI without its query string.
function currentStationKey() {
  const uri = state.station && state.station.uri;
  if (!uri) return null;
  return pandoraStationId(uri) || String(uri).split('?')[0];
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
  const tick = () => readState().then(() => readFavorites().catch(() => {})).then(() => autoSaveStation()).catch(() => {});
  tick();
  timer = setInterval(tick, POLL_MS);
  console.log(config.SONOS_IP ? `[sonos] polling ${config.SONOS_IP}` : '[sonos] no SONOS_IP set — will look for a player on the network');
}

module.exports = {
  start, getState, getFavorites, readFavorites, currentFavoriteId, transport, playFavorite, readState, removeFavorite,
  autoSaveStation, pandoraStationId, playPandoraStation, currentStationKey, learnPandora,
};
