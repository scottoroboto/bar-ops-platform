// Staff Map tab (patch_068): the drawn floor plan with every TV on it and
// the games strip on top. Hold a game and drop it on a TV: if a receiver
// is already showing that game the TV just switches to it; otherwise the
// bartender is asked which receiver to put the game on (the app never
// retunes a receiver on its own). Tap a TV to pick any receiver for it.
// Talks only to this agent's local API, same as the Sources and TVs tabs.
let SOURCES = [];
let TVS = [];
let LAYOUT = null;
let refreshTimer = null;
let CAN_EDIT = false;
// Flip (turn the map 180°) is gone (Scotto, 2026-10-20): the T1 map is
// drawn the way his floor plan faces, and that's the only way it shows.
try { localStorage.removeItem('vc_map_flip'); } catch (e) { /* private mode */ }
// Edit mode (owner/manager): drag TVs and labels, add a TV, link a dot to
// a TV in the inventory, delete, then Save to the cloud.
let EDIT = null; // { layout (working copy), sel: n|null, dirty }
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
  // A pass handed over by the Bar Ops app is this person's own: drop any
  // bar-iPad base pass left on this device, or staff_pass_boot.js would
  // swap the owner's pass back out for it on the next page.
  if (!barIpad) try { localStorage.removeItem('vc_base_pass'); localStorage.removeItem('vc_mgr_seen'); } catch (e) { /* ignore */ }
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
function passLine() {
  const info = STAFF_PASS ? passInfo(STAFF_PASS) : null;
  if (!info) return '';
  const until = new Date(info.exp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${info.name || 'Staff'} · until ${until}`;
}


let clockTimer = null;

// Topbar clock (screens/01-staff-sources.html's header) -- pure client-side
// display, no server round-trip. Updated on the same cadence as everything
// else on this page rather than every second; a bar's channel-control
// screen doesn't need a ticking seconds display.
function updateTopbarClock() {
  const now = new Date();
  const day = document.getElementById('tbDay');
  const time = document.getElementById('tbTime');
  const date = document.getElementById('tbDate');
  if (!day) return;
  day.textContent = now.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
  time.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  date.textContent = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-staff-pass': STAFF_PASS, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { forgetPass(); STAFF_PASS = ''; showGate('Your TV session has ended. Open TV Staff from the Bar Ops app again.'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}


function enter() {
  if (!STAFF_PASS) return showGate('');
  api('/api/sources').then(async (sources) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    SOURCES = sources;
    await Promise.all([loadTvs(), loadLayout()]);
    renderMap();
    fillSourceTitles();
    updateTopbarClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(updateTopbarClock, 15000);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshSources, 15000);
  }).catch((e) => {
    forgetPass();
    STAFF_PASS = '';
    showGate(/PASS_REQUIRED|401/.test(e.message) ? 'Your TV session has ended. Open TV Staff from the Bar Ops app again.' : escapeHtml(e.message));
  });
}
enter();

async function refreshSources() {
  try {
    SOURCES = await api('/api/sources');
    await loadTvs();
    if (!LAYOUT) await loadLayout();
    renderMap();
    fillSourceTitles();
  } catch (e) { /* next tick */ }
}
async function loadTvs() {
  try { TVS = await api('/api/tvs'); } catch (e) { /* keep the last list */ }
}
async function loadLayout() {
  try { const r = await api('/api/map'); LAYOUT = r.layout || null; CAN_EDIT = !!r.canEdit; } catch (e) { LAYOUT = null; }
}
// Positions are percent of the map, as stored.
function fx(x) { return x; }
function fy(y) { return y; }
// The map's width over height: a drawn plan's own shape, else 10:7.
function mapAspect(L) { return L && L.plan && L.plan.w && L.plan.h ? L.plan.w / L.plan.h : 10 / 7; }
// The games strip calls these by name (it was written for the Sources tab).
function renderSources() { renderMap(); }

// ---------------------------------------------------------------- lookups
// Same rules as staff_tvs.js: a TV's commanded slot is the truth when we
// have one, else its default source, labeled unconfirmed.
function currentSourceInfo(t) {
  if (t.live && t.live.slot != null) return { slot: Number(t.live.slot), confirmed: true };
  if (t.default_source_slot != null) return { slot: Number(t.default_source_slot), confirmed: false };
  return { slot: null, confirmed: false };
}
function tvsOnSlot(slot) { return TVS.filter((t) => currentSourceInfo(t).slot === Number(slot)); }
function sourceForSlot(slot) { return SOURCES.find((s) => Number(s.slot) === Number(slot)); }
function isSlotDead(slot) {
  const s = sourceForSlot(slot);
  if (!s || (s.kind !== 'directv' && s.kind !== 'roku')) return false;
  return !(s.live && s.live.ok);
}
function tvName(t) { return t.tag || t.name; }
// The number in "TV 12": the name decides, the tag only fills in when
// the name has no number (a bar that names TVs by spot and tags them).
function tvNumber(t) {
  const m = String(t.name || '').match(/^\s*TV[\s-]*(\d+)\s*$/i) || String(t.tag || '').match(/^\s*TV[\s-]*(\d+)\s*$/i);
  return m ? Number(m[1]) : null;
}
// The inventory TV a map dot stands for: by id when the layout says, else
// by number ("TV 12" on the map is the TV named or tagged "TV 12").
function tvForDot(d) {
  if (d.tvId != null) return TVS.find((t) => Number(t.id) === Number(d.tvId)) || null;
  return TVS.find((t) => tvNumber(t) === Number(d.n)) || null;
}
function tvById(id) { return TVS.find((t) => Number(t.id) === Number(id)) || null; }

// One colour per receiver so every TV on the same receiver matches.
const SLOT_COLORS = ['#4DD8FF', '#FFB020', '#39FF88', '#FF3BD4', '#B48CFF', '#FF8A78', '#7FD7F0', '#F5E663', '#8CFFC6', '#FF9FE0', '#9FB4FF', '#FFD08C'];
function slotColor(slot) {
  if (slot == null) return '#55556a';
  const list = SOURCES.filter((s) => s.kind === 'directv' || s.kind === 'roku').map((s) => Number(s.slot)).sort((a, b) => a - b);
  const i = list.indexOf(Number(slot));
  return i < 0 ? '#8a8aa0' : SLOT_COLORS[i % SLOT_COLORS.length];
}

// ---------------------------------------------------------------- titles
// Live program titles per receiver, same call as the Sources tab.
const SOURCE_TITLES = new Map();
let titleFillToken = 0;
async function fillSourceTitles() {
  const myToken = ++titleFillToken;
  const targets = SOURCES.filter((s) => s.kind === 'directv' && s.live && s.live.ok && s.live.active !== false && s.live.major != null);
  await Promise.all(targets.map(async (s) => {
    try {
      const info = await api(`/api/sources/${s.slot}/proginfo?major=${encodeURIComponent(s.live.major)}${s.live.minor != null ? `&minor=${encodeURIComponent(s.live.minor)}` : ''}`);
      if (myToken !== titleFillToken) return;
      SOURCE_TITLES.set(Number(s.slot), { title: info.title || '', callsign: info.callsign || '', next: info.next || null, at: Date.now() });
    } catch (e) { /* keep the last known title */ }
  }));
  if (myToken === titleFillToken) renderMap();
}
function formatChannel(live) {
  if (!live || live.major == null) return '';
  return live.minor != null ? `${live.major}-${live.minor}` : String(live.major);
}
function callsignForSlot(slot) {
  const t = SOURCE_TITLES.get(Number(slot));
  const s = sourceForSlot(slot);
  return (t && t.callsign) || (s && s.label) || '';
}
function sourceNowInfo(s) {
  const live = s.live;
  if (s.kind === 'roku') {
    if (!live || !live.ok) return { headline: 'Not responding', sub: s.label };
    if (live.appId == null) return { headline: 'Idle', sub: 'home screen' };
    return { headline: live.appName || `App ${live.appId}`, sub: 'streaming' };
  }
  if (s.kind !== 'directv') return { headline: s.label, sub: s.kind };
  if (!live || !live.ok) return { headline: 'Not responding', sub: s.label };
  if (live.active === false) return { headline: 'Asleep', sub: s.label };
  const t = SOURCE_TITLES.get(Number(s.slot)) || {};
  return { headline: t.title || s.label, sub: t.callsign || formatChannel(live) || s.label };
}
// Short text for a TV dot: the game's teams if the receiver is on a game,
// else the channel's callsign.
function dotText(slot) {
  const g = typeof gameOnSlot === 'function' ? gameOnSlot(slot) : null;
  if (g) return `${g.away.abbr || ''} ${g.home.abbr || ''}`.trim();
  const cs = callsignForSlot(slot);
  return cs.replace(/HD$/i, '').slice(0, 7);
}

// ---------------------------------------------------------------- render
const TV_WORK = new Map(); // tv id -> { status, error, at }
function setTvWork(id, status, error) {
  TV_WORK.set(Number(id), { status, error, at: Date.now() });
  if (status !== 'working') setTimeout(() => { const w = TV_WORK.get(Number(id)); if (w && w.status === status) { TV_WORK.delete(Number(id)); renderMap(); } }, status === 'done' ? 4000 : 12000);
}

function renderMap() {
  const box = document.getElementById('mapBox');
  const rail = document.getElementById('mapRcvs');
  if (!box) return;
  if (!LAYOUT || !Array.isArray(LAYOUT.tvs)) {
    box.innerHTML = '<p class="muted" style="padding:16px;">No map drawn for this bar yet.</p>';
    if (rail) rail.innerHTML = '';
    renderMapBar();
    return;
  }
  const L = EDIT ? EDIT.layout : LAYOUT;
  const plan = L.plan ? planSvg(L.plan) : '';
  const items = (L.items || []).map((it) => {
    const cls = `map-item ${it.type}${it.outer ? ' outer' : ''}${it.type === 'door' && (it.w || 0) === 0 ? ' v' : ''}${EDIT && it.type === 'label' ? ' draggable' : ''}`;
    const style = `left:${fx(it.x, it.w)}%;top:${fy(it.y, it.h)}%;width:${it.w || 0}%;height:${it.h || 0}%`;
    const text = it.text ? `<span>${escapeHtml(it.text)}</span>` : '';
    return `<div class="${cls}" data-item="${escapeHtml(it.id)}" style="${style}">${text}</div>`;
  }).join('');
  const dots = L.tvs.map((d) => {
    const t = tvForDot(d);
    const cls = ['map-tv'];
    let slot = null; let text = ''; let title = `TV ${d.n}`;
    if (!t) { cls.push('unset'); title += ' — not set up in Venue Control'; }
    else {
      const info = currentSourceInfo(t);
      slot = info.slot;
      const s = slot != null ? sourceForSlot(slot) : null;
      const work = TV_WORK.get(Number(t.id));
      if (work) cls.push(`work-${work.status}`);
      if (t.live && t.live.ok && (t.live.power === 'off' || t.live.power === 'standby')) cls.push('off');
      if (slot != null && isSlotDead(slot)) { cls.push('dead'); text = '✕'; }
      else if (slot == null) text = '—';
      else text = dotText(slot);
      title = `${tvName(t)}${s ? ` · ${s.label}` : ''}`;
    }
    let attrs;
    if (EDIT) { if (EDIT.sel === d.n) cls.push('sel'); attrs = `data-n="${Number(d.n)}"`; }
    else attrs = t ? `data-tv="${t.id}" data-slot="${slot == null ? '' : slot}" onclick="openTvSheet(${Number(t.id)})"` : `onclick="gamesToast('TV ${Number(d.n)} isn’t set up in Venue Control yet.', true)"`;
    // A TV on a drawn plan hangs on its wall: a bar the way it's mounted
    // and its number beside it (the "B" map, 2026-10-20).
    if (d.o) {
      cls.push('wall', `o-${d.o}`, `s-${d.s || 'b'}`);
      return `<button type="button" class="${cls.join(' ')}" style="left:${fx(d.x)}%;top:${fy(d.y)}%;--c:${slotColor(slot)}" title="${escapeHtml(title)}" ${attrs}><i class="bar"></i><span class="n">${cls.includes('dead') ? '✕' : Number(d.n)}</span></button>`;
    }
    return `<button type="button" class="${cls.join(' ')}" style="left:${fx(d.x)}%;top:${fy(d.y)}%;--c:${slotColor(slot)}" title="${escapeHtml(title)}" ${attrs}><span class="n">${Number(d.n)}</span><span class="src">${escapeHtml(EDIT && !t ? 'no TV' : text)}</span></button>`;
  }).join('');
  box.innerHTML = plan + items + dots;
  box.style.aspectRatio = String(mapAspect(L));
  box.classList.toggle('editing', !!EDIT);
  renderMapBar();
  fitMap();
  if (rail) rail.innerHTML = SOURCES.filter((s) => s.kind === 'directv').map((s) => {
    const now = sourceNowInfo(s);
    const g = typeof gameOnSlot === 'function' ? gameOnSlot(s.slot) : null;
    const n = tvsOnSlot(s.slot).length;
    const dead = !(s.live && s.live.ok);
    return `<button type="button" class="map-rcv source-card${dead ? ' dead' : ''}" data-slot="${Number(s.slot)}" data-kind="directv" style="--c:${slotColor(s.slot)}" onclick="flashSlotTvs(${Number(s.slot)})">
      <span class="r">${escapeHtml(s.label)} <i>${escapeHtml(String(s.qam_channel || '').replace(/\.1$/, ''))}</i></span>
      <span class="h">${escapeHtml(g ? `${g.away.name} @ ${g.home.name}` : now.headline)}</span>
      <span class="s">${escapeHtml(g ? `${now.sub} · ${typeof statusText === 'function' ? statusText(g) : ''}` : now.sub)} · ${n} TV${n === 1 ? '' : 's'}</span>
    </button>`;
  }).join('');
}

// A drawn floor plan: walls, inner lines, solid areas and labels, in the
// plan's own units, stretched to the map box.
function planSvg(P) {
  const paths = (list, cls) => (list || []).map((d) => `<path class="${cls}" d="${escapeHtml(d)}"/>`).join('');
  const labels = (P.labels || []).map((l) => `<text class="${l.big ? 'big' : 'small'}" x="${Number(l.x)}" y="${Number(l.y)}"${l.rot ? ` transform="rotate(${Number(l.rot)} ${Number(l.x)} ${Number(l.y)})"` : ''}>${escapeHtml(l.t)}</text>`).join('');
  return `<svg class="map-plan" viewBox="0 0 ${Number(P.w)} ${Number(P.h)}" preserveAspectRatio="none" aria-hidden="true">${paths(P.fills, 'fill')}${paths(P.lines, 'line')}${paths(P.walls, 'wall')}${labels}</svg>`;
}

// Size the map so the strip, the map and the receiver rail all fit on the
// screen with nothing to scroll (an iPad in landscape at the bar).
function fitMap() {
  const box = document.getElementById('mapBox');
  const rail = document.getElementById('mapRcvs');
  const row = box && box.parentElement;
  if (!box || !row) return;
  const top = row.getBoundingClientRect().top + window.scrollY;
  const avail = Math.max(240, window.innerHeight - top - 22);
  const side = window.innerWidth > 760; // rail beside the map, else under it
  const railW = side ? 236 : 0;
  const aspect = mapAspect(EDIT ? EDIT.layout : LAYOUT);
  const width = Math.min(row.clientWidth - railW, Math.round(avail * aspect));
  box.style.width = `${width}px`;
  if (rail) rail.style.maxHeight = side ? `${Math.round(width / aspect)}px` : '';
}
window.addEventListener('resize', () => fitMap());

// The row above the map: Channel guide for everyone, Edit for owner/manager.
function renderMapBar() {
  const bar = document.getElementById('mapBar');
  if (!bar) return;
  if (EDIT) {
    const sel = EDIT.sel != null ? EDIT.layout.tvs.find((t) => t.n === EDIT.sel) : null;
    bar.innerHTML = `
      <span class="map-bar-note">Editing: drag a TV or a label. Tap a TV to renumber, link or remove it.</span>
      <button type="button" class="map-bar-btn" onclick="editAddTv()">+ TV</button>
      ${sel ? `<button type="button" class="map-bar-btn" onclick="openEditTvSheet(${sel.n})">TV ${sel.n}…</button>` : ''}
      <span class="map-bar-gap"></span>
      <button type="button" class="map-bar-btn" onclick="editCancel()">Cancel</button>
      <button type="button" class="map-bar-btn go" onclick="editSave()" ${EDIT.dirty ? '' : 'disabled'}>Save map</button>`;
  } else {
    bar.innerHTML = `
      <span class="map-bar-note">Hold a game, then drop it on a TV. Tap a TV to pick what it shows.${CAN_EDIT ? '' : ` <i>${escapeHtml(whoLine())} · Edit map needs the owner or a manager (open TV Staff from the Bar Ops app).</i>`}</span>
      <span class="map-bar-gap"></span>
      <button type="button" class="map-bar-btn" onclick="openChannelGuide()" title="What's on every DirecTV channel right now, and put one on a receiver">Channel guide</button>
      ${CAN_EDIT && LAYOUT ? '<button type="button" class="map-bar-btn" onclick="editStart()">Edit map</button>' : ''}`;
  }
}

// Who this page thinks is here, from the pass: "Scotto · owner".
function whoLine() {
  const info = STAFF_PASS ? passInfo(STAFF_PASS) : null;
  if (!info) return 'No pass';
  const role = info.actor === 'admin' ? 'owner' : info.actor === 'device' ? 'bar iPad' : info.actor || 'staff';
  return `${info.name || 'Staff'} · ${role}`;
}

function editStart() {
  if (!LAYOUT) return;
  EDIT = { layout: JSON.parse(JSON.stringify(LAYOUT)), sel: null, dirty: false };
  renderMap();
}
function editCancel() { EDIT = null; renderMap(); }
async function editSave() {
  if (!EDIT) return;
  try {
    const r = await api('/api/map', { method: 'POST', body: JSON.stringify({ layout: EDIT.layout }) });
    LAYOUT = r.layout || EDIT.layout;
    EDIT = null;
    gamesToast('Map saved.');
  } catch (e) {
    gamesToast(`Couldn’t save the map: ${e.message}`, true);
  }
  renderMap();
}
function editTouch() { if (EDIT) { EDIT.dirty = true; renderMapBar(); } }

// Add a TV dot with the next free number, mid-map, and open its settings.
function editAddTv() {
  if (!EDIT) return;
  const used = new Set(EDIT.layout.tvs.map((t) => t.n));
  let n = 1; while (used.has(n)) n++;
  EDIT.layout.tvs.push(EDIT.layout.plan ? { n, x: 50, y: 50, o: 'h', s: 'b' } : { n, x: 50, y: 50 });
  EDIT.sel = n;
  editTouch();
  renderMap();
  openEditTvSheet(n);
}

// One dot's settings: number, which inventory TV it is, remove.
function openEditTvSheet(n) {
  if (!EDIT) return;
  const d = EDIT.layout.tvs.find((t) => t.n === Number(n));
  if (!d) return;
  EDIT.sel = d.n;
  const back = sheetBack();
  const linked = tvForDot(d);
  const onMap = new Set(EDIT.layout.tvs.filter((t) => t !== d).map((t) => { const x = tvForDot(t); return x ? Number(x.id) : null; }).filter((x) => x != null));
  const choices = TVS.filter((t) => t.enabled !== false).slice().sort((a, b) => (tvNumber(a) || 999) - (tvNumber(b) || 999) || String(a.name).localeCompare(String(b.name)));
  const opts = choices.map((t) => `<option value="${t.id}" ${linked && Number(linked.id) === Number(t.id) ? 'selected' : ''}>${escapeHtml(tvName(t))}${onMap.has(Number(t.id)) ? ' (on another dot)' : ''}</option>`).join('');
  back.innerHTML = `
    <div class="gm-sheet gm-confirm">
      <div class="gs-head"><span>Dot ${d.n}</span><button type="button" class="gs-x" onclick="closeMapSheet()">&times;</button></div>
      <div class="gs-label">Number on the map</div>
      <div class="map-edit-row"><input id="mapEditNum" inputmode="numeric" value="${d.n}"><span class="muted">Matches the TV named “TV ${d.n}” unless you link one below.</span></div>
      <div class="gs-label">Which TV is this</div>
      <div class="map-edit-row"><select id="mapEditLink"><option value="">By number (TV ${d.n})</option>${opts}</select></div>
      <p class="muted" style="margin:6px 0 0">${linked ? `Now: ${escapeHtml(tvName(linked))}` : `No TV named “TV ${d.n}” in Venue Control yet.`}</p>
      ${d.o ? `<div class="gs-label">How it hangs</div>
      <div class="map-edit-row"><select id="mapEditO"><option value="h" ${d.o === 'h' ? 'selected' : ''}>Left–right</option><option value="v" ${d.o === 'v' ? 'selected' : ''}>Up–down</option><option value="d" ${d.o === 'd' ? 'selected' : ''}>Angled</option></select>
        <select id="mapEditS"><option value="t" ${d.s === 't' ? 'selected' : ''}>Number above</option><option value="b" ${(d.s || 'b') === 'b' ? 'selected' : ''}>Number below</option><option value="l" ${d.s === 'l' ? 'selected' : ''}>Number left</option><option value="r" ${d.s === 'r' ? 'selected' : ''}>Number right</option></select></div>` : ''}
      <div class="mu-sheet-btns">
        <button type="button" class="mu-sheet-cancel" onclick="editRemoveTv(${d.n})">Remove dot</button>
        <button type="button" class="mu-sheet-go" onclick="editApplyTv(${d.n})">Done</button>
      </div>
    </div>`;
}
function editApplyTv(n) {
  const d = EDIT && EDIT.layout.tvs.find((t) => t.n === Number(n));
  if (!d) { closeMapSheet(); return; }
  const num = Number((document.getElementById('mapEditNum') || {}).value);
  const link = (document.getElementById('mapEditLink') || {}).value;
  if (!Number.isInteger(num) || num < 1 || num > 999) { gamesToast('A TV number is 1 to 999.', true); return; }
  if (num !== d.n && EDIT.layout.tvs.some((t) => t !== d && t.n === num)) { gamesToast(`TV ${num} is already on the map.`, true); return; }
  d.n = num;
  if (link) d.tvId = Number(link); else delete d.tvId;
  const o = (document.getElementById('mapEditO') || {}).value; const sd = (document.getElementById('mapEditS') || {}).value;
  if (d.o && o) d.o = o;
  if (d.o && sd) d.s = sd;
  EDIT.sel = num;
  editTouch();
  closeMapSheet();
  renderMap();
}
function editRemoveTv(n) {
  if (!EDIT) return;
  EDIT.layout.tvs = EDIT.layout.tvs.filter((t) => t.n !== Number(n));
  EDIT.sel = null;
  editTouch();
  closeMapSheet();
  renderMap();
}

// Dragging in edit mode: TV dots and labels.
const MDRAG = { on: false, kind: null, id: null, moved: false, x0: 0, y0: 0 };
function mapPct(ev) {
  const box = document.getElementById('mapBox');
  const r = box.getBoundingClientRect();
  let x = ((ev.clientX - r.left) / r.width) * 100;
  let y = ((ev.clientY - r.top) / r.height) * 100;
  return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
}
function initMapEditing() {
  const box = document.getElementById('mapBox');
  if (!box) return;
  box.addEventListener('pointerdown', (ev) => {
    if (!EDIT) return;
    const dot = ev.target.closest('.map-tv[data-n]');
    const lab = ev.target.closest('.map-item.label[data-item]');
    if (!dot && !lab) return;
    const p = mapPct(ev);
    if (dot) { const n = Number(dot.dataset.n); const d = EDIT.layout.tvs.find((t) => t.n === n); if (!d) return; EDIT.sel = n; MDRAG.kind = 'tv'; MDRAG.id = n; MDRAG.dx = p.x - d.x; MDRAG.dy = p.y - d.y; }
    else { const it = EDIT.layout.items.find((i) => i.id === lab.dataset.item); if (!it) return; MDRAG.kind = 'item'; MDRAG.id = it.id; MDRAG.dx = p.x - it.x; MDRAG.dy = p.y - it.y; }
    MDRAG.on = true; MDRAG.moved = false; MDRAG.x0 = ev.clientX; MDRAG.y0 = ev.clientY;
    try { box.setPointerCapture(ev.pointerId); } catch (e) { /* older Safari */ }
    ev.preventDefault();
    // No re-render here: iPad Safari stops sending the touch's moves if
    // the element under the finger is replaced. Just mark the selection.
    box.querySelectorAll('.map-tv.sel').forEach((el) => el.classList.remove('sel'));
    if (dot) dot.classList.add('sel');
    renderMapBar();
  });
  box.addEventListener('pointermove', (ev) => {
    if (!MDRAG.on || !EDIT) return;
    if (!MDRAG.moved && Math.abs(ev.clientX - MDRAG.x0) < 4 && Math.abs(ev.clientY - MDRAG.y0) < 4) return;
    MDRAG.moved = true;
    const p = mapPct(ev);
    if (MDRAG.kind === 'tv') { const d = EDIT.layout.tvs.find((t) => t.n === MDRAG.id); if (d) { d.x = Math.round((p.x - MDRAG.dx) * 10) / 10; d.y = Math.round((p.y - MDRAG.dy) * 10) / 10; } }
    else { const it = EDIT.layout.items.find((i) => i.id === MDRAG.id); if (it) { it.x = Math.round((p.x - MDRAG.dx) * 10) / 10; it.y = Math.round((p.y - MDRAG.dy) * 10) / 10; } }
    // cheap move: just the one element
    const el = MDRAG.kind === 'tv' ? box.querySelector(`.map-tv[data-n="${MDRAG.id}"]`) : box.querySelector(`.map-item[data-item="${MDRAG.id}"]`);
    const o = MDRAG.kind === 'tv' ? EDIT.layout.tvs.find((t) => t.n === MDRAG.id) : EDIT.layout.items.find((i) => i.id === MDRAG.id);
    if (el && o) { el.style.left = `${fx(o.x, MDRAG.kind === 'tv' ? 0 : o.w)}%`; el.style.top = `${fy(o.y, MDRAG.kind === 'tv' ? 0 : o.h)}%`; }
  });
  const end = (ev) => {
    if (!MDRAG.on) return;
    MDRAG.on = false;
    const wasTap = !MDRAG.moved && MDRAG.kind === 'tv';
    if (MDRAG.moved) editTouch();
    if (wasTap) openEditTvSheet(MDRAG.id); else renderMap();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}
initMapEditing();

// ---------------------------------------------------------------- lens
// While a game is dragged over the map, a circle above the finger shows
// that part of the floor plan at double size with the TV it would land
// on lit magenta (the "lens" board Scotto picked, Oct 2026). The lens is
// a scaled copy of the map taken when the finger first comes over it.
const LENS = { el: null, inner: null, label: null, hit: null, sw: 0, sh: 0 };
const LENS_D = 210;   // diameter on screen
const LENS_ZOOM = 2;
const LENS_LIFT = 96; // the circle sits this far above the finger

function lensShow() {
  const box = document.getElementById('mapBox');
  if (!box || LENS.el) return;
  const r = box.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'map-lens';
  el.style.width = `${LENS_D}px`; el.style.height = `${LENS_D}px`;
  const clip = document.createElement('div');
  clip.className = 'map-lens-clip';
  const inner = document.createElement('div');
  inner.className = 'map-lens-inner';
  inner.style.width = `${r.width}px`; inner.style.height = `${r.height}px`;
  inner.innerHTML = box.innerHTML;
  inner.querySelectorAll('.gm-drop').forEach((x) => x.classList.remove('gm-drop'));
  inner.querySelectorAll('[onclick]').forEach((x) => x.removeAttribute('onclick'));
  const label = document.createElement('div');
  label.className = 'map-lens-label';
  clip.appendChild(inner); el.appendChild(clip); el.appendChild(label);
  document.body.appendChild(el);
  LENS.el = el; LENS.inner = inner; LENS.label = label; LENS.hit = null; LENS.sw = r.width; LENS.sh = r.height;
  if (typeof DRAG === 'object') DRAG.lens = true;
}
function lensHide() {
  if (LENS.el) LENS.el.remove();
  LENS.el = null; LENS.inner = null; LENS.label = null; LENS.hit = null;
  if (typeof DRAG === 'object') { DRAG.lens = false; if (DRAG.ghost) DRAG.ghost.style.visibility = ''; }
}
function onGameDragMove(x, y, target, g) {
  const box = document.getElementById('mapBox');
  if (!box || EDIT) { lensHide(); return; }
  const r = box.getBoundingClientRect();
  const over = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  if (!over) { lensHide(); return; }
  if (!LENS.el) lensShow();
  const el = LENS.el;
  const R = LENS_D / 2;
  // Where the circle goes: above the finger, kept on screen.
  let cx = x; let cy = y - LENS_LIFT;
  if (cy - R < 4) cy = y + LENS_LIFT; // near the top edge, show it below
  cx = Math.max(R + 4, Math.min(window.innerWidth - R - 4, cx));
  el.style.left = `${cx - R}px`; el.style.top = `${cy - R}px`;
  // The finger's point on the map lands at the circle's centre.
  const px = x - r.left; const py = y - r.top;
  LENS.inner.style.transform = `translate(${R - px * LENS_ZOOM}px, ${R - py * LENS_ZOOM}px) scale(${LENS_ZOOM})`;
  // Light the same dot in the copy.
  const id = target && target.dataset && target.dataset.tv != null ? target.dataset.tv : null;
  if (id !== LENS.hit) {
    LENS.inner.querySelectorAll('.gm-drop').forEach((d) => d.classList.remove('gm-drop'));
    if (id != null) { const d = LENS.inner.querySelector(`.map-tv[data-tv="${id}"]`); if (d) d.classList.add('gm-drop'); }
    LENS.hit = id;
  }
  const t = id != null ? tvById(id) : null;
  const who = g ? `${g.away.abbr || g.away.name} @ ${g.home.abbr || g.home.name}` : '';
  LENS.label.textContent = t ? `${who} → ${tvName(t)}` : who;
  LENS.label.classList.toggle('on', !!t);
  if (typeof DRAG === 'object' && DRAG.ghost) DRAG.ghost.style.visibility = 'hidden';
}
function onGameDragEnd() { lensHide(); }

// Tap a receiver in the rail: light up its TVs for a moment.
function flashSlotTvs(slot) {
  document.querySelectorAll('.map-tv.hl').forEach((el) => el.classList.remove('hl'));
  const els = document.querySelectorAll(`.map-tv[data-slot="${Number(slot)}"]`);
  els.forEach((el) => el.classList.add('hl'));
  const s = sourceForSlot(slot);
  gamesToast(els.length ? `${s ? s.label : `Slot ${slot}`} is on ${els.length} TV${els.length === 1 ? '' : 's'}` : `${s ? s.label : `Slot ${slot}`} isn’t on any TV`);
  setTimeout(() => els.forEach((el) => el.classList.remove('hl')), 2500);
}

// ---------------------------------------------------------------- actions
async function switchTv(t, slot, g) {
  const s = sourceForSlot(slot);
  setTvWork(t.id, 'working');
  renderMap();
  try {
    await api(`/api/tvs/${t.id}/slot`, { method: 'POST', body: JSON.stringify({ slot }) });
    setTvWork(t.id, 'done');
    gamesToast(`${tvName(t)} → ${s ? s.label : `slot ${slot}`}${g ? ` · ${g.away.abbr || g.away.name} @ ${g.home.abbr || g.home.name}` : ''}`);
    if (t.live) t.live.slot = slot; // show it at once; the next refresh confirms
  } catch (e) {
    setTvWork(t.id, 'failed', e.message);
    gamesToast(`${tvName(t)}: ${e.message}`, true);
  }
  renderMap();
  loadTvs().then(renderMap);
}

// A game dropped on a TV (called from staff_games.js's drag code).
async function dropGameOnTv(g, tvId) {
  const t = tvById(tvId);
  if (!t) return;
  if (!t.channel_capable) { gamesToast(`${tvName(t)} can’t change channel from here.`, true); return; }
  const showing = slotsShowing(g);
  if (showing.length) {
    // Prefer the receiver this TV is already on, then the one with the most TVs.
    const cur = currentSourceInfo(t).slot;
    const pick = showing.find((s) => Number(s.slot) === cur) || showing.slice().sort((a, b) => tvsOnSlot(b.slot).length - tvsOnSlot(a.slot).length)[0];
    if (Number(pick.slot) === cur) { gamesToast(`${tvName(t)} is already on ${pick.label} with that game.`); return; }
    await switchTv(t, Number(pick.slot), g);
    return;
  }
  openPutOnSheet(g, t);
}

// ---------------------------------------------------------------- sheets
function sheetBack() {
  let back = document.getElementById('mapSheetBack');
  if (!back) {
    back = document.createElement('div');
    back.id = 'mapSheetBack';
    back.className = 'gm-sheet-back';
    back.addEventListener('click', (e) => { if (e.target === back) closeMapSheet(); });
    document.body.appendChild(back);
  }
  back.style.display = 'flex';
  return back;
}
function closeMapSheet() { const b = document.getElementById('mapSheetBack'); if (b) b.style.display = 'none'; PUTON = null; }

let PUTON = null; // { gameId, tvId, slot }

function rcvRowHtml(s, sel, extra) {
  const now = sourceNowInfo(s);
  const g = typeof gameOnSlot === 'function' ? gameOnSlot(s.slot) : null;
  const n = tvsOnSlot(s.slot).length;
  const down = !(s.live && s.live.ok);
  return `<button type="button" class="gs-rcv${sel ? ' sel' : ''}${g ? ' has' : ''}${down ? ' down' : ''}" style="--c:${slotColor(s.slot)}" onclick="${extra}">
      <span class="slot" style="color:var(--c)">${escapeHtml(s.label)} · ${escapeHtml(String(s.qam_channel || '').replace(/\.1$/, ''))}</span>
      <span class="t">${escapeHtml(down ? 'Not responding' : g ? `${g.away.name} @ ${g.home.name}` : now.headline)}</span>
      <span class="s">${escapeHtml(n ? `${n} TV${n === 1 ? '' : 's'}: ${tvsOnSlot(s.slot).map(tvName).join(', ')}` : 'No TVs on it')}</span>
    </button>`;
}

// "No receiver has this game": pick one to put it on, then the TV follows.
function openPutOnSheet(g, t) {
  const rcvs = SOURCES.filter((s) => s.kind === 'directv' && s.live && s.live.ok);
  if (!rcvs.length) { gamesToast('No DirecTV receiver is answering.', true); return; }
  // Best guess: fewest TVs watching, and not already on a game people watch.
  const cost = (s) => { const n = tvsOnSlot(s.slot).length; const g2 = typeof gameOnSlot === 'function' ? gameOnSlot(s.slot) : null; return n * 10 + (g2 && n ? 100 : 0) + (Number(s.slot) === currentSourceInfo(t).slot ? -1 : 0); };
  const sorted = rcvs.slice().sort((a, b) => cost(a) - cost(b));
  PUTON = { gameId: g.id, tvId: t.id, slot: Number(sorted[0].slot) };
  renderPutOnSheet();
}
function renderPutOnSheet() {
  if (!PUTON) return;
  const g = gameById(PUTON.gameId);
  const t = tvById(PUTON.tvId);
  if (!g || !t) { closeMapSheet(); return; }
  const back = sheetBack();
  const label = `${g.away.abbr || g.away.name} @ ${g.home.abbr || g.home.name}`;
  const rcvs = SOURCES.filter((s) => s.kind === 'directv' && s.live && s.live.ok);
  const cost = (s) => { const n = tvsOnSlot(s.slot).length; const g2 = typeof gameOnSlot === 'function' ? gameOnSlot(s.slot) : null; return n * 10 + (g2 && n ? 100 : 0); };
  const rows = rcvs.slice().sort((a, b) => cost(a) - cost(b)).map((s) => rcvRowHtml(s, Number(s.slot) === PUTON.slot, `PUTON.slot=${Number(s.slot)};renderPutOnSheet()`)).join('');
  const pick = sourceForSlot(PUTON.slot);
  const others = pick ? tvsOnSlot(pick.slot).filter((x) => Number(x.id) !== Number(t.id)) : [];
  const ch = g.channel;
  const future = g.state === 'pre' && new Date(g.start).getTime() - Date.now() > 2 * 60000;
  back.innerHTML = `
    <div class="gm-sheet">
      <div class="gs-head"><span>Put a game on ${escapeHtml(tvName(t))}</span><button type="button" class="gs-x" onclick="closeMapSheet()">&times;</button></div>
      <p class="map-sheet-lead"><b>${escapeHtml(label)}</b> isn’t on any receiver yet${ch ? ` (channel ${escapeHtml(String(ch.major))}${ch.confirmed ? ' ✓' : ''})` : ''}. Pick a receiver to put it on; ${escapeHtml(tvName(t))} switches to that receiver.</p>
      ${ch ? '' : `<p class="map-sheet-warn">No DirecTV channel is known for this game yet${g.blocked ? ` — channel ${escapeHtml(String(g.blocked.major))} is showing ${escapeHtml(g.blocked.showing)}` : ''}. Open the game on the Sources tab to set one.</p>`}
      <div class="gs-label">Receiver</div>
      <div class="gs-rcvs">${rows}</div>
      ${others.length ? `<p class="map-sheet-warn">Also changes ${escapeHtml(others.map(tvName).join(', '))} — they’re on ${escapeHtml(pick.label)} too.</p>` : ''}
      <div class="mu-sheet-btns">
        <button type="button" class="mu-sheet-cancel" onclick="closeMapSheet()">Cancel</button>
        <button type="button" class="mu-sheet-go" ${ch && pick ? '' : 'disabled'} onclick="putOnGo()">${future ? `At ${escapeHtml(timeOf(g.start))}: ` : ''}${escapeHtml(pick ? pick.label : 'Receiver')} → ${escapeHtml(tvName(t))}</button>
      </div>
    </div>`;
}
async function putOnGo() {
  if (!PUTON) return;
  const g = gameById(PUTON.gameId);
  const t = tvById(PUTON.tvId);
  const slot = PUTON.slot;
  closeMapSheet();
  if (!g || !t) return;
  const opt = tvOptions(g)[0];
  const future = g.state === 'pre' && new Date(g.start).getTime() - Date.now() > 2 * 60000;
  const ok = await putGameOn(g, [slot], opt, future ? 'start' : 'now');
  if (ok) await switchTv(t, slot, g);
}

// Tap a TV: what it's on, and every receiver to pick from.
let TVSHEET = null;
function openTvSheet(id) {
  const t = tvById(id);
  if (!t) return;
  TVSHEET = Number(id);
  renderTvSheet();
}
function renderTvSheet() {
  const t = tvById(TVSHEET);
  if (!t) { closeMapSheet(); return; }
  const back = sheetBack();
  const cur = currentSourceInfo(t).slot;
  const rcvs = SOURCES.filter((s) => (s.kind === 'directv' || s.kind === 'roku' || s.kind === 'static') && s.qam_channel);
  const rows = rcvs.map((s) => rcvRowHtml(s, Number(s.slot) === cur, `tvSheetPick(${Number(s.slot)})`)).join('');
  const curS = cur != null ? sourceForSlot(cur) : null;
  const now = curS ? sourceNowInfo(curS) : null;
  back.innerHTML = `
    <div class="gm-sheet">
      <div class="gs-head"><span>${escapeHtml(tvName(t))}${t.zone_id != null && typeof zoneName === 'function' ? ` · ${escapeHtml(zoneName(t.zone_id))}` : ''}</span><button type="button" class="gs-x" onclick="closeMapSheet()">&times;</button></div>
      <p class="map-sheet-lead">Now: <b>${escapeHtml(curS ? `${curS.label} — ${now.headline}` : 'no source recorded')}</b>${!t.channel_capable ? ' · this TV can’t change channel from here' : ''}</p>
      <div class="gs-label">Tap a receiver to put it on ${escapeHtml(tvName(t))}</div>
      <div class="gs-rcvs">${rows || '<p class="muted">No sources set up.</p>'}</div>
      <div class="mu-sheet-btns"><button type="button" class="mu-sheet-cancel" onclick="closeMapSheet()">Close</button></div>
    </div>`;
}
async function tvSheetPick(slot) {
  const t = tvById(TVSHEET);
  closeMapSheet();
  if (!t) return;
  if (!t.channel_capable) { gamesToast(`${tvName(t)} can’t change channel from here.`, true); return; }
  if (currentSourceInfo(t).slot === Number(slot)) { gamesToast(`${tvName(t)} is already on ${sourceForSlot(slot)?.label || slot}.`); return; }
  await switchTv(t, Number(slot), typeof gameOnSlot === 'function' ? gameOnSlot(slot) : null);
}
