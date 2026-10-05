// Staff Power tab (Sept 2026, Scotto's "rack + floor" pick from four
// concepts): every device's live power state on one screen. Receivers and
// Rokus on the left with Wake / Off per box, TVs by zone on the right where
// a tap SELECTS a tile (it never fires), then Turn ON / Turn OFF (hold) at
// the bottom acts on the selection; each zone header has its own ON / OFF
// (hold). Same rules as the rest of the staff app: separate ON and OFF, OFF
// always on a hold, unreachable never drawn like off. Local API only.
let TVS = [];
let ZONES = [];
let SOURCES = [];
let refreshTimer = null;
let clockTimer = null;
const SELECTED = new Set();       // tv ids picked on the floor
let BUSY = null;                  // { label, total, done, failed } while a bulk call runs
let BUSY_CLEAR_TIMER = null;

// ---- getting in: identical to staff_tvs.js (signed pass in #pass=, kept in localStorage)
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
  api('/api/tvs').then(async (tvs) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    TVS = tvs;
    try { ZONES = await api('/api/zones'); } catch (e) { ZONES = []; }
    try { SOURCES = await api('/api/sources'); } catch (e) { SOURCES = []; }
    renderPage();
    updateTopbarClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(updateTopbarClock, 15000);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshAll, 10000);
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
    const [tvs, sources] = await Promise.all([api('/api/tvs'), api('/api/sources')]);
    TVS = tvs;
    SOURCES = sources;
    renderPage();
  } catch (e) {
    // transient -- keep the last-known screen rather than blanking it mid-tap
  }
}

// ---- state language --------------------------------------------------
// TV: 'on' | 'off' | 'unr'. The Samsung driver answers on / standby /
// unreachable; standby is "off" here, and a set that doesn't answer at all
// is drawn red, never dim, so "not answering" can't be mistaken for "off".
function tvState(t) {
  const live = t.live;
  if (!t.ip) return 'unr';
  if (!live) return 'unr';
  if (live.power === 'on') return 'on';
  if (live.power === 'standby' || live.power === 'off') return 'off';
  return 'unr';
}
const TV_STATE_LABEL = { on: 'on', off: 'off', unr: 'no answer' };

// Receiver: 'on' | 'asleep' | 'nr' (+ Roku: 'idle' when no app is up)
function sourceState(s) {
  const live = s.live;
  if (!live || !live.ok) return 'nr';
  if (s.kind === 'directv') return live.active === false ? 'asleep' : 'on';
  if (s.kind === 'roku') return live.appId == null ? 'idle' : 'on';
  return 'on';
}

function zoneName(id) {
  if (id == null) return 'Unassigned';
  const z = ZONES.find((zz) => Number(zz.id) === Number(id));
  return z ? z.name : 'Unassigned';
}
function groupByZone(tvs) {
  const groups = new Map();
  for (const tv of tvs) {
    const key = tv.zone_id == null ? 'unassigned' : String(tv.zone_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tv);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'unassigned') return 1;
    if (b === 'unassigned') return -1;
    // The zones' order from TV Admin (its arrows); ZONES comes sorted.
    const ia = ZONES.findIndex((z) => String(z.id) === a), ib = ZONES.findIndex((z) => String(z.id) === b);
    return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib) || zoneName(Number(a)).localeCompare(zoneName(Number(b)));
  });
  return keys.map((key) => ({ key, name: key === 'unassigned' ? 'Unassigned' : zoneName(Number(key)), tvs: groups.get(key) }));
}
function allTvIds() { return TVS.filter((t) => t.ip).map((t) => Number(t.id)); }

// ---- render ----------------------------------------------------------
function renderPage() {
  renderRack();
  renderFloor();
}

function renderRack() {
  const box = document.getElementById('pwRack');
  const rows = SOURCES.filter((s) => s.kind === 'directv' || s.kind === 'roku');
  const onCount = rows.filter((s) => sourceState(s) === 'on').length;
  if (!rows.length) {
    box.innerHTML = '<div class="tvs-col-header"><span class="tvs-col-title">Rack · Receivers</span></div><p class="muted">No receivers configured yet.</p>';
    return;
  }
  box.innerHTML = `
    <div class="tvs-col-header"><span class="tvs-col-title">Rack · Receivers</span><span class="pw-rack-count">${onCount} of ${rows.length} on</span></div>
    <div class="pw-rack-scroll">${rows.map(rackRowHtml).join('')}</div>
    <div class="pw-rack-bar">
      <span class="lbl">All receivers</span>
      <button class="pw-btn pw-on" onclick="wakeReceivers()">WAKE</button>
      <button class="pw-btn pw-off hold-danger" data-hold-action="rack-standby"><span class="hold-fill"></span><span class="hold-label">STANDBY <span class="hold-chip">HOLD</span></span></button>
    </div>`;
}

function rackRowHtml(s) {
  const st = sourceState(s);
  const live = s.live || {};
  let stateText;
  if (st === 'nr') stateText = 'not answering';
  else if (st === 'asleep') stateText = 'asleep';
  else if (st === 'idle') stateText = 'idle';
  else if (s.kind === 'roku') stateText = live.appName || 'on';
  else stateText = live.major != null ? `ch ${live.major}` : 'on';
  const slot = escapeHtml(String(s.qam_channel || s.slot).replace(/\.1$/, ''));
  const wake = s.kind === 'directv'
    ? `<button class="pw-mini" onclick="receiverKey(${Number(s.slot)}, 'poweron')">WAKE</button>`
    : `<button class="pw-mini" onclick="receiverKey(${Number(s.slot)}, 'Home')">HOME</button>`;
  const off = s.kind === 'directv'
    ? `<button class="pw-mini pw-mini-off" onclick="receiverKey(${Number(s.slot)}, 'poweroff')">OFF</button>`
    : '';
  return `<div class="pw-rk pw-rk-${st}">
    <span class="tvsrc-slot${s.kind === 'roku' ? ' roku' : ''}">${slot}</span>
    <span class="nm">${escapeHtml(String(s.label).replace(/^Directv Rcvr /i, 'Rcvr '))}</span>
    <span class="st">${escapeHtml(stateText)}</span>
    <span class="b">${wake}${off}</span>
  </div>`;
}

function renderFloor() {
  const box = document.getElementById('pwFloor');
  const tvs = TVS.filter((t) => t.ip);
  const groups = groupByZone(tvs);
  const header = `<div class="tvs-col-header">
    <span class="tvs-col-title">Floor · TVs</span>
    <div class="tvs-legend">
      <span class="swatch"><span class="sw-box pw-sw-on"></span><span class="lbl">on</span></span>
      <span class="swatch"><span class="sw-box pw-sw-off"></span><span class="lbl">off</span></span>
      <span class="swatch"><span class="sw-box pw-sw-unr"></span><span class="lbl">not answering</span></span>
      <span class="swatch"><span class="sw-box sel"></span><span class="lbl">selected</span></span>
    </div>
  </div>`;
  const body = groups.length
    ? groups.map(zoneGroupHtml).join('')
    : '<p class="muted">No TVs with an address yet. Add them from TV Admin in the Bar Ops app.</p>';
  box.innerHTML = header + `<div class="tvz-scroll">${body}</div>` + commitBarHtml();
}

function zoneGroupHtml(g) {
  const on = g.tvs.filter((t) => tvState(t) === 'on').length;
  const unr = g.tvs.filter((t) => tvState(t) === 'unr').length;
  const off = g.tvs.length - on - unr;
  const zoneKey = g.key === 'unassigned' ? null : Number(g.key);
  const ids = g.tvs.map((t) => Number(t.id));
  return `<div class="tvz-group">
    <div class="tvz-header pw-zh">
      <span class="tvz-name">${escapeHtml(g.name)}</span><span class="tvz-count">${g.tvs.length}</span>
      <span class="pw-zstat"><b>${on} on</b> · <em>${off} off</em>${unr ? ` · <u>${unr} no answer</u>` : ''}</span>
      <span class="sp"></span>
      <button class="pw-btn pw-on pw-btn-sm" onclick="powerTvs('on', ${JSON.stringify(ids)}, '${escapeHtml(g.name).replace(/'/g, '&#39;')}')">ON</button>
      <button class="pw-btn pw-off pw-btn-sm hold-danger" data-hold-action="zone-off" data-zone="${zoneKey == null ? '' : zoneKey}"><span class="hold-fill"></span><span class="hold-label">OFF <span class="hold-chip">HOLD</span></span></button>
    </div>
    <div class="tv-chip-grid">${g.tvs.map(chipHtml).join('')}</div>
  </div>`;
}

function chipHtml(t) {
  const st = tvState(t);
  const sel = SELECTED.has(Number(t.id));
  const classes = ['tv-chip', 'pw-chip', `pw-${st}`];
  if (sel) classes.push('remote-target');
  return `<button type="button" class="${classes.join(' ')}" onclick="toggleSelected(${Number(t.id)})">
    <span class="chip-tag">${escapeHtml(t.tag || t.name)}</span>
    <span class="chip-source">${TV_STATE_LABEL[st]}</span>
  </button>`;
}

function commitBarHtml() {
  const picked = TVS.filter((t) => SELECTED.has(Number(t.id)));
  const names = picked.map((t) => t.tag || t.name).join(', ');
  const n = picked.length;
  let left;
  if (BUSY) {
    left = `<span class="cb-names pw-busy">${escapeHtml(BUSY.label)} — ${BUSY.done + BUSY.failed} of ${BUSY.total}${BUSY.failed ? `, <u>${BUSY.failed} failed</u>` : ''}</span>`;
  } else if (n) {
    left = `<span class="cb-count">${n} TV${n === 1 ? '' : 's'}</span><span class="cb-names">selected — ${escapeHtml(names)}</span>`;
  } else {
    left = `<span class="cb-names">Tap TVs to pick them, or use a zone's ON / OFF.</span>`;
  }
  return `<div class="tvs-commit-bar">
    <div class="cb-left">${left}</div>
    <div class="cb-right">
      <button class="cb-clear" onclick="clearSelected()" ${n ? '' : 'disabled'}>Clear</button>
      <button class="cb-commit" onclick="powerTvs('on', selectedIds(), 'Selected TVs')" ${n && !BUSY ? '' : 'disabled'}>Turn ON</button>
      <button class="cb-secondary pw-off hold-danger" data-hold-action="selected-off" ${n && !BUSY ? '' : 'disabled'}><span class="hold-fill"></span><span class="hold-label">Turn OFF <span class="hold-chip">HOLD</span></span></button>
    </div>
  </div>`;
}

// ---- selection --------------------------------------------------------
function toggleSelected(id) {
  id = Number(id);
  if (SELECTED.has(id)) SELECTED.delete(id); else SELECTED.add(id);
  renderFloor();
}
function clearSelected() { SELECTED.clear(); renderFloor(); }
function selectedIds() { return Array.from(SELECTED); }

// ---- actions ----------------------------------------------------------
// One bulk call for any set of TVs (topbar all, a zone, the selection). The
// box fans out with concurrency 4 and returns a per-TV result table; the
// commit bar shows the tally while it runs and for a few seconds after.
async function powerTvs(state, ids, label) {
  ids = (ids || []).map(Number).filter((id) => TVS.some((t) => Number(t.id) === id && t.ip));
  if (!ids.length || BUSY) return;
  BUSY = { label: `${label} — turning ${state}`, total: ids.length, done: 0, failed: 0 };
  renderFloor();
  try {
    const { results } = await api('/api/tvs/bulk/power', { method: 'POST', body: JSON.stringify({ state, tv_ids: ids }) });
    for (const r of results || []) { if (r.ok) BUSY.done += 1; else BUSY.failed += 1; }
    BUSY.label = `${label} — ${state === 'on' ? 'on' : 'off'}`;
  } catch (e) {
    BUSY.failed = ids.length;
    BUSY.label = `${label} — ${e.message}`;
  }
  if (state === 'off' || BUSY.failed === 0) SELECTED.clear();
  renderFloor();
  if (BUSY_CLEAR_TIMER) clearTimeout(BUSY_CLEAR_TIMER);
  BUSY_CLEAR_TIMER = setTimeout(() => { BUSY = null; renderFloor(); }, 4000);
  refreshAll();
}

async function receiverKey(slot, key) {
  try {
    await api(`/api/sources/${slot}/key`, { method: 'POST', body: JSON.stringify({ key }) });
  } catch (e) {
    alert(e.message);
  }
  setTimeout(refreshAll, 1200);
}

async function wakeReceivers() {
  const boxes = SOURCES.filter((s) => s.kind === 'directv');
  await Promise.all(boxes.map((s) => api(`/api/sources/${s.slot}/key`, { method: 'POST', body: JSON.stringify({ key: 'poweron' }) }).catch(() => null)));
  setTimeout(refreshAll, 1500);
}
async function standbyReceivers() {
  const boxes = SOURCES.filter((s) => s.kind === 'directv');
  await Promise.all(boxes.map((s) => api(`/api/sources/${s.slot}/key`, { method: 'POST', body: JSON.stringify({ key: 'poweroff' }) }).catch(() => null)));
  setTimeout(refreshAll, 1500);
}

// ---- press-and-hold (every OFF on this page) ------------------------------
// Same 900ms fill as the TVs page, delegated at document level so it works
// on buttons renderFloor() re-renders every refresh. data-hold-action says
// what fires when the fill completes.
const HOLD_MS = 900;
let holdState = null;

function holdFire(btn) {
  const action = btn.getAttribute('data-hold-action');
  if (action === 'all-off') return powerTvs('off', allTvIds(), 'All TVs');
  if (action === 'selected-off') return powerTvs('off', selectedIds(), 'Selected TVs');
  if (action === 'zone-off') {
    const z = btn.getAttribute('data-zone');
    const ids = TVS.filter((t) => t.ip && (z === '' ? t.zone_id == null : Number(t.zone_id) === Number(z))).map((t) => Number(t.id));
    return powerTvs('off', ids, z === '' ? 'Unassigned' : zoneName(Number(z)));
  }
  if (action === 'rack-standby') return standbyReceivers();
  return null;
}

function holdStart(btn) {
  holdCancel();
  if (btn.disabled) return;
  const fill = btn.querySelector('.hold-fill');
  const startedAt = performance.now();
  function step(now) {
    const pct = Math.min(1, (now - startedAt) / HOLD_MS);
    if (fill) fill.style.width = `${pct * 100}%`;
    if (pct >= 1) {
      holdState = null;
      if (fill) fill.style.width = '0%';
      holdFire(btn);
      return;
    }
    holdState.raf = requestAnimationFrame(step);
  }
  holdState = { btn, raf: requestAnimationFrame(step) };
}
function holdCancel() {
  if (!holdState) return;
  cancelAnimationFrame(holdState.raf);
  const fill = holdState.btn.querySelector('.hold-fill');
  if (fill) fill.style.width = '0%';
  holdState = null;
}
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.hold-danger');
  if (btn) { e.preventDefault(); holdStart(btn); }
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => document.addEventListener(ev, () => holdCancel()));
