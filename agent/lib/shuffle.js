// Shuffle a favorites list (Oct 2026): Pandora stations are endless, so
// "shuffle the list" means one song from one station, then a different
// random station from the same list, and so on. The loop watches the
// Sonos state the poller already reads: when the playing track changes
// (a song ended) it jumps to another station in the list. Tapping any
// station by hand, or the Sonos app moving to something not in the list,
// turns it off. Survives a restart through the cache.
const cache = require('./cache');

let S = cache.get('musicShuffle') || null;   // { listId, listName, keys: [station key], current, songs, startedAt }
let lastTrack = null;        // "title|artist" of the song we're waiting on
let awaitFirst = false;      // just switched: the next track we see is the station's first song
let busy = false;
let deps = null;             // { sonos, stations(), playStation(id), log }

function init(d) { deps = d; }
function status() {
  return S ? { on: true, listId: S.listId, listName: S.listName, songs: S.songs || 0, startedAt: S.startedAt } : { on: false };
}
function save() { cache.set('musicShuffle', S); }
function trackKey(st) { const t = st && st.track; return t && (t.title || t.artist) ? `${t.title}|${t.artist}` : null; }

function pickNext() {
  const keys = (S.keys || []).filter((k) => k !== S.current);
  const pool = keys.length ? keys : (S.keys || []);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Station ids change (a Pandora station becomes a favorite), so the list
// is kept by station key and resolved to a playable id each time.
async function playKey(key) {
  const st = deps.stations().find((s) => s.key === key);
  if (!st) throw new Error('Station is no longer on the account.');
  await deps.playStation(st.id, { fromShuffle: true });
  S.current = key;
  awaitFirst = true;
  lastTrack = null;
}

async function start({ list, stations }) {
  const keys = [];
  const byUri = new Map(stations.map((s) => [s.uri, s]));
  for (const x of list.stations || []) { const s = byUri.get(x.uri); if (s && !keys.includes(s.key)) keys.push(s.key); }
  if (keys.length < 2) throw new Error('Put at least two stations in the list to shuffle it.');
  S = { listId: String(list.id), listName: list.name, keys, current: null, songs: 0, startedAt: new Date().toISOString() };
  save();
  // Already on a station in the list: keep it and switch when its song ends.
  const now = deps.sonos.currentStationKey();
  const state = deps.sonos.getState();
  if (now && keys.includes(now) && state.playing) { S.current = now; lastTrack = trackKey(state); awaitFirst = !lastTrack; save(); return status(); }
  busy = true;
  try { await playKey(pickNext()); save(); } finally { busy = false; }
  return status();
}

function stop(reason) {
  if (S && deps && deps.log) deps.log(`[shuffle] off (${reason}) after ${S.songs || 0} song(s) of ${S.listName}`);
  S = null; lastTrack = null; awaitFirst = false; save();
  return status();
}

// Every few seconds from server.js.
async function tick() {
  if (!S || busy || !deps) return;
  const state = deps.sonos.getState();
  if (!state.ok) return;
  const now = deps.sonos.currentStationKey();
  // Someone (the Sonos app, a tap we didn't see) moved off the list.
  if (now && !S.keys.includes(now)) { stop('moved off the list'); return; }
  if (S.current && now !== S.current) return; // the poller hasn't caught up with our switch yet
  if (!state.playing) return;            // paused or stopped: wait, don't switch
  const key = trackKey(state);
  if (!key) return;
  if (awaitFirst) { lastTrack = key; awaitFirst = false; return; }
  if (!lastTrack) { lastTrack = key; return; }
  if (key === lastTrack) return;
  // The song changed: that one is done, on to another station.
  S.songs = (S.songs || 0) + 1;
  busy = true;
  try { await playKey(pickNext()); save(); }
  catch (err) { if (deps.log) deps.log(`[shuffle] switch failed: ${err.message}`); lastTrack = key; }
  finally { busy = false; }
}

module.exports = { init, start, stop, tick, status };
