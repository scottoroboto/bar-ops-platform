// Staff Music tab (Sept 2026): Pandora on the bar's Sonos. Left: now
// playing with artwork, play / pause / skip. Right: one tile per station
// saved under My Sonos in the Sonos app, tap to switch. Nothing else on
// purpose -- thumbs, search and new stations live in the Pandora app, and
// volume lives on the mixer. Local API only (/api/music/*).
let MUSIC = null;
let refreshTimer = null;
let clockTimer = null;
let MUSIC_BUSY = null;   // 'play' | 'pause' | 'next' | 'previous' | station id while a command runs

// ---- getting in: identical to the other staff pages
const PASS_KEY = 'vc_staff_pass';
function readPassFromUrl() {
  const m = (location.hash || '').match(/[#&]pass=([^&]+)/);
  if (!m) return null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  return decodeURIComponent(m[1]);
}
function passInfo(pass) {
  try { return JSON.parse(atob(pass.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; }
}
function storedPass() {
  try {
    const p = localStorage.getItem(PASS_KEY) || '';
    const info = p ? passInfo(p) : null;
    return (info && info.exp > Date.now()) ? p : '';
  } catch (e) { return ''; }
}
function rememberPass(p) { try { localStorage.setItem(PASS_KEY, p); } catch (e) { /* private mode */ } }
function forgetPass() { try { localStorage.removeItem(PASS_KEY); } catch (e) { /* ignore */ } }
let STAFF_PASS = readPassFromUrl() || storedPass();
if (STAFF_PASS) rememberPass(STAFF_PASS);

function showGate(reason) {
  document.getElementById('pinGate').style.display = '';
  document.getElementById('app').style.display = 'none';
  const msg = document.getElementById('pinMsg');
  if (msg) msg.innerHTML = reason ? `<div class="msg error">${reason}</div>` : '';
  fetch('/api/status').then((r) => r.json()).then((s) => {
    const a = document.getElementById('openFromApp');
    if (a && s.cloudUrl) a.href = s.cloudUrl.replace(/\/$/, '') + '/tv-staff.html';
  }).catch(() => {});
}

function enter() {
  if (!STAFF_PASS) return showGate('');
  api('/api/music/state').then((m) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    MUSIC = m;
    renderPage();
    updateTopbarClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(updateTopbarClock, 15000);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshAll, 5000);
  }).catch((e) => {
    forgetPass();
    STAFF_PASS = '';
    showGate(/PASS_REQUIRED|401/.test(e.message) ? 'Your TV session has ended. Open TV Staff from the Bar Ops app again.' : escapeHtml(e.message));
  });
}
enter();

function updateTopbarClock() {
  const now = new Date();
  const day = document.getElementById('tbDay');
  if (!day) return;
  day.textContent = now.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
  document.getElementById('tbTime').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  document.getElementById('tbDate').textContent = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-staff-pass': STAFF_PASS, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { forgetPass(); STAFF_PASS = ''; showGate('Your TV session has ended. Open TV Staff from the Bar Ops app again.'); }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshAll() {
  try {
    const before = MUSIC ? `${MUSIC.currentFavoriteId}|${(MUSIC.favorites || []).length}` : '';
    MUSIC = await api('/api/music/state');
    renderNowPlaying();
    const after = `${MUSIC.currentFavoriteId}|${(MUSIC.favorites || []).length}`;
    if (after !== before && document.activeElement !== document.getElementById('muFilter')) renderStations();
  } catch (e) { /* keep last-known */ }
}

// ---- render ------------------------------------------------------------
function renderPage() { renderNowPlaying(); renderStations(); }

function renderNowPlaying() {
  const box = document.getElementById('muNowPlaying');
  const m = MUSIC || {};
  const who = m.player ? `${escapeHtml(m.player.name)} · Sonos` : 'Sonos';
  if (!m.ok) {
    box.innerHTML = `<div class="tvs-col-header"><span class="tvs-col-title">Now playing</span><span class="mu-who">${who}</span></div>
      <div class="mu-empty"><p class="muted">${escapeHtml(m.error || 'The music player isn\'t answering.')}</p>
      <p class="muted">Check the Sonos has power and a network cable. The Sonos app on this iPad still works in the meantime.</p></div>`;
    return;
  }
  const t = m.track || {};
  const station = m.station && m.station.title ? m.station.title : (m.transport === 'STOPPED' ? 'Nothing playing' : '');
  const busy = (k) => (MUSIC_BUSY === k ? ' busy' : '');
  box.innerHTML = `
    <div class="tvs-col-header"><span class="tvs-col-title">Now playing</span><span class="mu-who">${who}</span></div>
    <div class="mu-art">${t.art ? `<img src="${escapeHtml(t.art)}" alt="">` : '<div class="mu-art-blank"></div>'}</div>
    <div class="mu-song">${escapeHtml(t.title || (m.playing ? '…' : 'Paused'))}</div>
    <div class="mu-artist">${escapeHtml(t.artist || '')}</div>
    <div class="mu-station">${station ? `<b>STATION</b>${escapeHtml(station)}` : ''}</div>
    <div class="mu-transport">
      <button class="mu-tb${busy('previous')}" onclick="musicCmd('previous')" title="Previous">&#9198;</button>
      ${m.playing
        ? `<button class="mu-tb mu-play${busy('pause')}" onclick="musicCmd('pause')">&#10074;&#10074; PAUSE</button>`
        : `<button class="mu-tb mu-play${busy('play')}" onclick="musicCmd('play')">&#9654; PLAY</button>`}
      <button class="mu-tb${busy('next')}" onclick="musicCmd('next')">&#9197; SKIP</button>
    </div>
    <div class="mu-foot muted">Thumbs, search and new stations: the Pandora app on this iPad. Volume: the mixer.</div>`;
}

let STATION_FILTER = '';
let STATION_SORT = 'az';   // 'az' | 'sonos' (the order in My Sonos)

// Scrollable list like the Pandora app: small art, station name, the
// playing one lit; a filter box narrows it as you type. A–Z by default,
// or the order the owner arranged in My Sonos.
function renderStations() {
  const box = document.getElementById('muStations');
  const m = MUSIC || {};
  const all = m.favorites || [];
  const q = STATION_FILTER.trim().toLowerCase();
  let favs = q ? all.filter((f) => (f.title || '').toLowerCase().includes(q)) : all.slice();
  if (STATION_SORT === 'az') favs.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
  const header = `<div class="tvs-col-header">
    <span class="tvs-col-title">Stations</span>
    <span class="mu-who">${all.length} on the account</span>
  </div>
  <div class="mu-tools">
    <input id="muFilter" type="search" placeholder="Find a station…" value="${escapeHtml(STATION_FILTER)}" oninput="setStationFilter(this.value)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <button type="button" class="mu-sort${STATION_SORT === 'az' ? ' on' : ''}" onclick="setStationSort('az')">A–Z</button>
    <button type="button" class="mu-sort${STATION_SORT === 'sonos' ? ' on' : ''}" onclick="setStationSort('sonos')">My order</button>
  </div>`;
  if (!all.length) {
    box.innerHTML = header + `<p class="muted" style="margin-top:12px;">No stations yet. In the Sonos app, play a Pandora station and add it to My Sonos. It shows up here within a minute.</p>`;
    return;
  }
  if (!favs.length) {
    box.innerHTML = header + `<p class="muted" style="margin-top:12px;">Nothing matches "${escapeHtml(STATION_FILTER)}".</p>`;
    return;
  }
  const rows = favs.map((f) => {
    const now = m.currentFavoriteId && f.id === m.currentFavoriteId;
    return `<button type="button" class="mu-row${now ? ' now' : ''}${MUSIC_BUSY === f.id ? ' busy' : ''}" onclick="musicStation('${escapeHtml(f.id).replace(/'/g, '&#39;')}')">
      <span class="mu-row-art">${f.art ? `<img src="${escapeHtml(f.art)}" alt="">` : '<span class="blank"></span>'}</span>
      <span class="mu-row-name">${escapeHtml(f.title)}</span>
      <span class="mu-row-tag">${now ? 'PLAYING' : (f.service ? escapeHtml(f.service) : '')}</span>
    </button>`;
  }).join('');
  box.innerHTML = header + `<div class="tvz-scroll mu-list">${rows}</div>`;
}

function setStationFilter(v) {
  STATION_FILTER = v || '';
  const el = document.getElementById('muFilter');
  const pos = el ? el.selectionStart : null;
  renderStations();
  const again = document.getElementById('muFilter');
  if (again) { again.focus(); if (pos != null) try { again.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
}
function setStationSort(s) { STATION_SORT = s; renderStations(); }

// ---- actions ----------------------------------------------------------
async function musicCmd(action) {
  if (MUSIC_BUSY) return;
  MUSIC_BUSY = action; renderNowPlaying();
  try {
    const r = await api(`/api/music/${action}`, { method: 'POST' });
    if (r.state) MUSIC = { ...MUSIC, ...r.state };
  } catch (e) { alert(e.message); }
  MUSIC_BUSY = null; renderPage();
  setTimeout(refreshAll, 1500);
}

async function musicStation(id) {
  if (MUSIC_BUSY) return;
  MUSIC_BUSY = id; renderStations();
  try {
    const r = await api('/api/music/station', { method: 'POST', body: JSON.stringify({ id }) });
    if (r.state) MUSIC = { ...MUSIC, ...r.state, currentFavoriteId: id };
  } catch (e) { alert(e.message); }
  MUSIC_BUSY = null; renderPage();
  setTimeout(refreshAll, 2000);
}
