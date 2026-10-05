// Staff Music tab (Sept 2026): Pandora on the bar's Sonos. Left: now
// playing with artwork, play / pause / skip. Right: every station on the
// bar's Pandora account (when the box is linked to it) plus anything in
// My Sonos, tap to switch; "+ Add station" searches Pandora and makes a
// new one (Oct 2026). Volume lives on the mixer. Local API only
// (/api/music/*).
let MUSIC = null;
let refreshTimer = null;
let clockTimer = null;
let MUSIC_BUSY = null;   // 'play' | 'pause' | 'next' | 'previous' | station id while a command runs

// ---- getting in: identical to the other staff pages
const PASS_KEY = 'vc_staff_pass';
function readPassFromUrl() {
  // A bar iPad's permanent pass rides in the query (?barpass=): Add to Home
  // Screen keeps that part of the address for certain (patch_053).
  const q = (location.search || '').match(/[?&]barpass=([^&]+)/);
  if (q) return decodeURIComponent(q[1]);
  const m = (location.hash || '').match(/[#&]pass=([^&]+)/);
  if (!m) return null;
  // A bar iPad's permanent pass stays in the address so Add to Home Screen
  // saves it (patch_053); everyone else's is wiped from the address bar.
  let barIpad = false;
  try { barIpad = JSON.parse(atob(decodeURIComponent(m[1]).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).actor === 'device'; } catch (e) { /* not a pass */ }
  if (!barIpad) try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
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

async function refreshAll(force) {
  try {
    const before = MUSIC ? `${MUSIC.currentFavoriteId}|${(MUSIC.favorites || []).length}` : '';
    MUSIC = await api('/api/music/state');
    renderNowPlaying();
    const after = `${MUSIC.currentFavoriteId}|${(MUSIC.favorites || []).length}`;
    if (force || (after !== before && document.activeElement !== document.getElementById('muFilter'))) renderStations();
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
    <div class="mu-foot muted">${m.pandora && m.pandora.enabled ? 'New stations: + Add station.' : 'New stations: the Sonos app.'} Volume: the mixer.</div>`;
}

let STATION_FILTER = '';
let STATION_SORT = 'az';       // 'az' | 'list:<id>' | 'deleted-stations'
let FAV_MENU_OPEN = false;
let SHEET = null;              // { kind: 'save', station } | { kind: 'newlist', station?, copyOf? } | { kind: 'listmenu', list }
let IS_OWNER = false;

function liveLists() { return ((MUSIC && MUSIC.lists) || []).filter((l) => !l.deleted_at); }
function deletedLists() { return ((MUSIC && MUSIC.lists) || []).filter((l) => l.deleted_at); }
function listById(id) { return ((MUSIC && MUSIC.lists) || []).find((l) => String(l.id) === String(id)) || null; }
function currentList() { return STATION_SORT.startsWith('list:') ? listById(STATION_SORT.slice(5)) : null; }

// Scrollable list like the Pandora app: small art, station name, the
// playing one lit; a find box narrows it as you type. Sorted A–Z, or
// showing one person's favorites list, or the Deleted stations folder.
function renderStations() {
  const box = document.getElementById('muStations');
  const m = MUSIC || {};
  IS_OWNER = !!m.isOwner;
  const all = m.favorites || [];
  const list = currentList();
  const showingDeleted = STATION_SORT === 'deleted-stations';
  let favs;
  if (list) {
    const byUri = new Map(all.map((f) => [f.uri, f]));
    favs = (list.stations || []).map((st) => byUri.get(st.uri) || { id: null, uri: st.uri, title: st.title, art: null, missing: true });
  } else if (showingDeleted) {
    favs = m.hiddenStations || [];
  } else {
    favs = all.slice().sort((a, b) => (b.shuffle ? 1 : 0) - (a.shuffle ? 1 : 0) || sortKey(a.title).localeCompare(sortKey(b.title), undefined, { sensitivity: 'base' }));
  }
  const q = STATION_FILTER.trim().toLowerCase();
  if (q) favs = favs.filter((f) => (f.title || '').toLowerCase().includes(q));

  const favLabel = list ? `★ ${escapeHtml(list.name)}` : showingDeleted ? 'Deleted stations' : '★ Favorites';
  const header = `<div class="tvs-col-header">
    <span class="tvs-col-title">Stations</span>
    <span class="mu-who">${list ? `${(list.stations || []).length} in ${escapeHtml(list.name)}'s list` : showingDeleted ? `${(m.hiddenStations || []).length} deleted` : `${all.length} on the account`}</span>
  </div>
  <div class="mu-tools">
    <input id="muFilter" type="search" placeholder="Find a station…" value="${escapeHtml(STATION_FILTER)}" oninput="setStationFilter(this.value)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <button type="button" class="mu-sort${STATION_SORT === 'az' ? ' on' : ''}" onclick="setStationSort('az')">A–Z</button>
    <div class="mu-favwrap">
      <button type="button" class="mu-sort mu-favbtn${list || showingDeleted ? ' on' : ''}" onclick="toggleFavMenu()">${favLabel} &#9662;</button>
      ${FAV_MENU_OPEN ? favMenuHtml() : ''}
    </div>
    ${list ? `<button type="button" class="mu-sort" onclick="openSheet({ kind: 'listmenu', list: listById('${list.id}') })" title="Copy or delete this list">&#8943;</button>` : ''}
    ${m.pandora && m.pandora.enabled ? `<button type="button" class="mu-sort mu-add" onclick="openSheet({ kind: 'add' })">&#65291; Add station</button>` : ''}
  </div>
  ${m.pandora && m.pandora.enabled && m.pandora.error ? `<p class="mu-hint muted">Pandora: ${escapeHtml(m.pandora.error)}${m.pandora.count ? ' Showing the last list it sent.' : ''}</p>` : ''}`;

  if (!all.length && !showingDeleted) {
    box.innerHTML = header + `<p class="muted" style="margin-top:12px;">No stations yet. ${m.pandora && m.pandora.enabled ? 'Tap + Add station to make one, or check the Pandora account on this box.' : 'In the Sonos app, play a Pandora station once (or add it to My Sonos). It shows up here within a minute.'}</p>` + sheetHtml();
    return;
  }
  let body;
  if (!favs.length) {
    body = `<p class="muted" style="margin-top:12px;">${q ? `Nothing matches "${escapeHtml(STATION_FILTER)}".` : list ? 'Nothing in this list yet. Press and hold any station to save it here.' : showingDeleted ? 'Nothing deleted.' : 'No stations.'}</p>`;
  } else {
    // A–Z bar down the right of the full list (not a person's list or a
    // search): tap or slide a finger down it to jump to that letter.
    const withIndex = !list && !showingDeleted && !q && favs.length > 12;
    const rows = favs.map((f) => rowHtml(f, list, showingDeleted, withIndex ? (f.shuffle ? '★' : letterOf(f.title)) : null)).join('');
    if (withIndex) {
      const have = new Set(favs.map((f) => letterOf(f.title)));
      const bar = AZ_LETTERS.map((l) => `<span data-az="${l}" class="${have.has(l) ? '' : 'off'}">${l}</span>`).join('');
      body = `<div class="mu-listwrap"><div class="tvz-scroll mu-list">${rows}</div><div class="mu-az" aria-label="Jump to letter">${bar}</div><div class="mu-az-bubble" id="muAzBubble"></div></div>`;
    } else {
      body = `<div class="tvz-scroll mu-list">${rows}</div>`;
    }
  }
  const hint = !list && !showingDeleted && liveLists().length === 0
    ? `<p class="mu-hint muted">Press and hold a station to save it to a favorites list.</p>` : '';
  // Keep the list where it was when it redraws (a station change redraws it).
  const oldList = box.querySelector('.mu-list');
  const keepTop = oldList ? oldList.scrollTop : 0;
  box.innerHTML = header + hint + body + sheetHtml();
  const newList = box.querySelector('.mu-list');
  if (newList && keepTop) newList.scrollTop = keepTop;
}

// ---- A–Z bar -----------------------------------------------------------
const AZ_LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
// "*NSync Radio" files under N and "The Weeknd Radio" under T; anything
// starting with a number goes under #.
function sortKey(title) { return String(title || '').replace(/^[^a-z0-9]+/i, ''); }
function letterOf(title) {
  const c = sortKey(title).charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}
function azJump(letter) {
  const list = document.querySelector('#muStations .mu-list');
  if (!list) return;
  const i = AZ_LETTERS.indexOf(letter);
  for (let k = i; k < AZ_LETTERS.length; k += 1) {
    const row = list.querySelector(`.mu-row[data-l="${AZ_LETTERS[k] === '#' ? '#' : AZ_LETTERS[k]}"]`);
    if (row) {
      if (list.scrollHeight > list.clientHeight + 4) list.scrollTop = row.offsetTop - list.offsetTop;
      else row.scrollIntoView({ block: 'start' });
      break;
    }
  }
  const bubble = document.getElementById('muAzBubble');
  if (bubble) { bubble.textContent = letter; bubble.classList.add('on'); clearTimeout(azJump.t); azJump.t = setTimeout(() => bubble.classList.remove('on'), 600); }
}
let azDragging = false;
function azAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const span = el && el.closest && el.closest('.mu-az [data-az]');
  if (span && span.dataset.az !== azAt.last) { azAt.last = span.dataset.az; azJump(span.dataset.az); }
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.mu-az')) return;
  e.preventDefault();
  azDragging = true; azAt.last = null;
  azAt(e.clientX, e.clientY);
});
document.addEventListener('pointermove', (e) => { if (azDragging) { e.preventDefault(); azAt(e.clientX, e.clientY); } });
['pointerup', 'pointercancel'].forEach((ev) => document.addEventListener(ev, () => { azDragging = false; }));

function rowHtml(f, list, showingDeleted, letter) {
  const m = MUSIC || {};
  const now = f.id && m.currentFavoriteId && f.id === m.currentFavoriteId;
  const busy = MUSIC_BUSY === f.id;
  let right;
  if (showingDeleted) {
    right = `<span class="mu-row-acts"><button type="button" class="mu-mini" onclick="event.stopPropagation(); stationRestore('${escapeHtml(f.uri)}')">RESTORE</button>${IS_OWNER ? `<button type="button" class="mu-mini danger" onclick="event.stopPropagation(); stationPurge('${escapeHtml(f.uri)}', '${escapeHtml(f.id || '')}', '${escapeHtml(f.title).replace(/'/g, '&#39;')}')">REMOVE FOR GOOD</button>` : ''}</span>`;
  } else if (list) {
    right = `<span class="mu-row-acts">${now ? '<span class="mu-row-tag on">PLAYING</span>' : ''}<button type="button" class="mu-star on" title="Remove from ${escapeHtml(list.name)}'s list" onclick="event.stopPropagation(); listRemove('${list.id}', '${escapeHtml(f.uri)}')">&#9733;</button></span>`;
  } else {
    right = `<span class="mu-row-tag${now ? ' on' : ''}">${now ? 'PLAYING' : (f.service ? escapeHtml(f.service) : '')}</span>`;
  }
  const playable = !!f.id && !f.missing && !showingDeleted;
  // A div, not a button: the star / restore buttons live inside the row and
  // a button can't contain buttons (the parser would split them apart).
  return `<div role="button" tabindex="0" class="mu-row${now ? ' now' : ''}${busy ? ' busy' : ''}${f.missing ? ' missing' : ''}"${letter ? ` data-l="${letter}"` : ''} data-uri="${escapeHtml(f.uri)}" data-id="${escapeHtml(f.id || '')}" data-title="${escapeHtml(f.title)}" ${playable ? `onclick="rowTap(this)"` : ''}>
    <span class="mu-row-art">${f.art ? `<img src="${escapeHtml(f.art)}" alt="" onerror="this.remove()">` : '<span class="blank"></span>'}</span>
    <span class="mu-row-name">${escapeHtml(f.title)}${f.missing ? ' <small>no longer in My Sonos</small>' : ''}</span>
    ${right}
  </div>`;
}

function favMenuHtml() {
  const lists = liveLists();
  const dead = deletedLists();
  const hiddenCount = ((MUSIC && MUSIC.hiddenStations) || []).length;
  return `<div class="mu-menu" onclick="event.stopPropagation()">
    <button type="button" class="mu-menu-item create" onclick="openSheet({ kind: 'newlist' })">&#65291; Create your favorites list</button>
    ${lists.map((l) => `<button type="button" class="mu-menu-item${STATION_SORT === 'list:' + l.id ? ' on' : ''}" onclick="setStationSort('list:${l.id}')">&#9733; ${escapeHtml(l.name)} <span class="n">${(l.stations || []).length}</span></button>`).join('')}
    ${!lists.length ? '<div class="mu-menu-empty muted">No lists yet</div>' : ''}
    <div class="mu-menu-sep"></div>
    ${hiddenCount ? `<button type="button" class="mu-menu-item dim${STATION_SORT === 'deleted-stations' ? ' on' : ''}" onclick="setStationSort('deleted-stations')">Deleted stations <span class="n">${hiddenCount}</span></button>` : ''}
    ${dead.length ? `<div class="mu-menu-label muted">Deleted lists</div>` + dead.map((l) => `<div class="mu-menu-item dim static">&#9733; ${escapeHtml(l.name)} <span class="n">${(l.stations || []).length}</span>
        <span class="acts"><button type="button" class="mu-mini" onclick="listOp('${l.id}', 'restore')">RESTORE</button>${IS_OWNER ? `<button type="button" class="mu-mini danger" onclick="listOp('${l.id}', 'purge')">REMOVE</button>` : ''}</span></div>`).join('') : ''}
    ${!hiddenCount && !dead.length ? '<div class="mu-menu-empty muted">Nothing deleted</div>' : ''}
  </div>`;
}

// Bottom sheet: save a station to one list, name a new list, or copy /
// delete the list being viewed.
function sheetHtml() {
  if (!SHEET) return '';
  const lists = liveLists();
  let inner;
  if (SHEET.kind === 'save') {
    const st = SHEET.station;
    inner = `<div class="mu-sheet-title">Save to favorites</div><div class="mu-sheet-sub">${escapeHtml(st.title)}</div>
      <div class="mu-sheet-list">
        ${lists.map((l) => { const has = (l.stations || []).some((x) => x.uri === st.uri); return `<button type="button" class="mu-sheet-row${has ? ' has' : ''}" onclick="listAdd('${l.id}', '${escapeHtml(st.uri)}', '${escapeHtml(st.title).replace(/'/g, '&#39;')}')">&#9733; ${escapeHtml(l.name)}${has ? '<span class="n">already in this list</span>' : ''}</button>`; }).join('')}
        <button type="button" class="mu-sheet-row create" onclick="openSheet({ kind: 'newlist', station: SHEET.station })">&#65291; New list…</button>
        ${!STATION_SORT.startsWith('list:') && !(STATION_SORT === 'deleted-stations') ? `<button type="button" class="mu-sheet-row dim" onclick="stationHide('${escapeHtml(st.uri)}', '${escapeHtml(st.title).replace(/'/g, '&#39;')}')">Remove from the main list (goes to Deleted stations)</button>` : ''}
      </div>`;
  } else if (SHEET.kind === 'newlist') {
    inner = `<div class="mu-sheet-title">${SHEET.copyOf ? 'Copy list as' : 'New favorites list'}</div>
      <div class="mu-sheet-sub">${SHEET.copyOf ? 'The copy gets its own name; the original stays until you delete it.' : 'Your name works best: Scott, Mindy, Barry.'}</div>
      <input id="muNewListName" type="text" maxlength="40" placeholder="List name" autocomplete="off" autocapitalize="words">
      <div class="mu-sheet-btns"><button type="button" class="mu-sheet-cancel" onclick="closeSheet()">Cancel</button><button type="button" class="mu-sheet-go" onclick="listCreate()">Create</button></div>`;
  } else if (SHEET.kind === 'add') {
    const a = ADD;
    let rows;
    if (a.busy) rows = `<p class="muted">${a.busy === 'search' ? 'Searching Pandora…' : 'Making the station…'}</p>`;
    else if (a.error) rows = `<p class="muted">${escapeHtml(a.error)}</p>`;
    else if (a.q && !a.results.length) rows = `<p class="muted">Nothing on Pandora matches "${escapeHtml(a.q)}".</p>`;
    else rows = a.results.map((r, i) => `<button type="button" class="mu-sheet-row mu-add-row" onclick="addStationFrom(${i})">
        <span class="mu-row-art">${r.art ? `<img src="${escapeHtml(r.art)}" alt="" onerror="this.remove()">` : '<span class="blank"></span>'}</span>
        <span class="mu-add-text"><b>${escapeHtml(r.name)}</b><small>${escapeHtml(r.kind)}${r.sub ? ' · ' + escapeHtml(r.sub) : ''}</small></span></button>`).join('');
    inner = `<div class="mu-sheet-title">Add a station</div>
      <div class="mu-sheet-sub">Type an artist, song or genre. Tap one and Pandora makes a station from it, plays it here, and adds it to the list.</div>
      <input id="muAddQuery" type="search" placeholder="e.g. Zac Brown Band" value="${escapeHtml(a.q)}" oninput="addSearchInput(this.value)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <div class="mu-sheet-list" style="margin-top:10px;">${rows}</div>`;
  } else if (SHEET.kind === 'listmenu') {
    const l = SHEET.list;
    inner = `<div class="mu-sheet-title">${escapeHtml(l.name)}'s list</div><div class="mu-sheet-sub">${(l.stations || []).length} station${(l.stations || []).length === 1 ? '' : 's'}</div>
      <div class="mu-sheet-list">
        <button type="button" class="mu-sheet-row" onclick="openSheet({ kind: 'newlist', copyOf: '${l.id}' })">Copy this list under a new name</button>
        <button type="button" class="mu-sheet-row dim" onclick="listOp('${l.id}', 'delete')">Delete this list (goes to Deleted lists)</button>
      </div>`;
  }
  return `<div class="mu-sheet-back" onclick="closeSheet()"><div class="mu-sheet" onclick="event.stopPropagation()">${inner}${SHEET.kind !== 'newlist' ? '<button type="button" class="mu-sheet-cancel wide" onclick="closeSheet()">Cancel</button>' : ''}</div></div>`;
}

function openSheet(sheet) {
  SHEET = sheet; FAV_MENU_OPEN = false;
  if (sheet.kind === 'add') ADD = { q: '', results: [], busy: null, error: null, seq: 0 };
  renderStations();
  const inp = document.getElementById('muNewListName') || document.getElementById('muAddQuery');
  if (inp) inp.focus();
}
function closeSheet() { SHEET = null; renderStations(); }
function toggleFavMenu() { FAV_MENU_OPEN = !FAV_MENU_OPEN; renderStations(); }
document.addEventListener('click', (e) => { if (FAV_MENU_OPEN && !e.target.closest('.mu-favwrap')) { FAV_MENU_OPEN = false; renderStations(); } });

function setStationFilter(v) {
  STATION_FILTER = v || '';
  const el = document.getElementById('muFilter');
  const pos = el ? el.selectionStart : null;
  renderStations();
  const again = document.getElementById('muFilter');
  if (again) { again.focus(); if (pos != null) try { again.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
}
function setStationSort(s) { STATION_SORT = s; FAV_MENU_OPEN = false; renderStations(); }

// Tap plays; press-and-hold (550ms) opens the Save sheet. A hold that
// fires swallows the click that follows it.
const HOLD_MS = 550;
let holdTimer = null; let holdFired = false; let holdRow = null;
document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.mu-row'); if (!row || e.target.closest('button.mu-star, button.mu-mini')) return;
  holdRow = row; holdFired = false;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdFired = true; row.classList.add('held');
    if (STATION_SORT !== 'deleted-stations') openSheet({ kind: 'save', station: { uri: row.dataset.uri, title: row.dataset.title, id: row.dataset.id } });
  }, HOLD_MS);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => document.addEventListener(ev, () => { clearTimeout(holdTimer); if (holdRow) holdRow.classList.remove('held'); }));
document.addEventListener('pointermove', (e) => { if (holdRow && e.buttons && Math.abs(e.movementY) > 6) clearTimeout(holdTimer); });
function rowTap(row) { if (holdFired) { holdFired = false; return; } musicStation(row.dataset.id); }

// ---- + Add station (Pandora search) -------------------------------------
let ADD = { q: '', results: [], busy: null, error: null, seq: 0 };
let addTimer = null;
function renderAddSheet() {
  const inp = document.getElementById('muAddQuery');
  const pos = inp ? inp.selectionStart : null;
  renderStations();
  const again = document.getElementById('muAddQuery');
  if (again) { again.focus(); if (pos != null) try { again.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
}
function addSearchInput(v) {
  ADD.q = v || '';
  clearTimeout(addTimer);
  if (!ADD.q.trim()) { ADD.results = []; ADD.error = null; ADD.busy = null; renderAddSheet(); return; }
  addTimer = setTimeout(async () => {
    const seq = ++ADD.seq;
    ADD.busy = 'search'; ADD.error = null; renderAddSheet();
    try {
      const r = await api('/api/music/pandora/search?q=' + encodeURIComponent(ADD.q.trim()));
      if (seq !== ADD.seq) return;
      ADD.results = r.results || [];
    } catch (e) { if (seq === ADD.seq) ADD.error = e.message; }
    if (seq === ADD.seq) { ADD.busy = null; renderAddSheet(); }
  }, 450);
}
async function addStationFrom(i) {
  const pick = ADD.results[i];
  if (!pick || ADD.busy) return;
  ADD.busy = 'create'; renderAddSheet();
  try {
    const r = await api('/api/music/pandora/add', { method: 'POST', body: JSON.stringify({ pandoraId: pick.pandoraId, name: pick.name }) });
    SHEET = null; ADD.busy = null;
    STATION_FILTER = '';
    await refreshAll(true);
    renderPage();
    if (!r.playing) alert(`"${r.station.title}" was added to the Pandora account but didn't start: ${r.playError || 'unknown error'}`);
  } catch (e) { ADD.busy = null; ADD.error = e.message; renderAddSheet(); }
}

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

async function listCreate() {
  const inp = document.getElementById('muNewListName');
  const name = inp ? inp.value.trim() : '';
  if (!name) { if (inp) inp.focus(); return; }
  try {
    const r = await api('/api/music/lists', { method: 'POST', body: JSON.stringify({ name, copyOf: SHEET && SHEET.copyOf }) });
    const st = SHEET && SHEET.station;
    if (st && r.id) await api(`/api/music/lists/${r.id}/stations`, { method: 'POST', body: JSON.stringify({ add: { uri: st.uri, title: st.title } }) });
    SHEET = null;
    await refreshAll(true);
    if (r.id) STATION_SORT = 'list:' + r.id;
    renderStations();
  } catch (e) { alert(e.message); }
}
async function listAdd(listId, uri, title) {
  try { await api(`/api/music/lists/${listId}/stations`, { method: 'POST', body: JSON.stringify({ add: { uri, title } }) }); SHEET = null; await refreshAll(true); renderStations(); }
  catch (e) { alert(e.message); }
}
async function listRemove(listId, uri) {
  try { await api(`/api/music/lists/${listId}/stations`, { method: 'POST', body: JSON.stringify({ remove: uri }) }); await refreshAll(true); renderStations(); }
  catch (e) { alert(e.message); }
}
async function listOp(listId, op) {
  if (op === 'purge' && !confirm('Remove this list for good? This cannot be undone.')) return;
  try {
    await api(`/api/music/lists/${listId}/${op}`, { method: 'POST' });
    SHEET = null; FAV_MENU_OPEN = false;
    if (op !== 'restore' && STATION_SORT === 'list:' + listId) STATION_SORT = 'az';
    await refreshAll(true); renderStations();
  } catch (e) { alert(e.message); }
}
async function stationHide(uri, title) {
  try { await api('/api/music/hidden/hide', { method: 'POST', body: JSON.stringify({ uri, title }) }); SHEET = null; await refreshAll(true); renderStations(); }
  catch (e) { alert(e.message); }
}
async function stationRestore(uri) {
  try { await api('/api/music/hidden/restore', { method: 'POST', body: JSON.stringify({ uri }) }); await refreshAll(true); renderStations(); }
  catch (e) { alert(e.message); }
}
async function stationPurge(uri, favoriteId, title) {
  if (!confirm(`Remove "${title}" from My Sonos for good? It can be added back from the Sonos app later.`)) return;
  try { await api('/api/music/hidden/purge', { method: 'POST', body: JSON.stringify({ uri, favoriteId, title }) }); await refreshAll(true); renderStations(); }
  catch (e) { alert(e.message); }
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
