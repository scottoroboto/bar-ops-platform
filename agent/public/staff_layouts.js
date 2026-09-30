// Staff Layouts tab (docs/venue-control.md §10/§12 Phase 5: "Layouts tab --
// saved room presets, one tap to apply, with a 15-second undo bar rather
// than a confirmation dialog. Confirmation before the fact trains people to
// tap through it; undo after the fact actually gets used."). Same local-API
// shape as sources.js/tvs.js -- never talks to devices directly, only to
// this agent's own /api/layouts.
let LAYOUTS = [];
let SOURCES = [];
let TVS = [];
// Getting in (cloud patch_036): no PIN. The Bar Ops app's TV Staff tile
// sends the person here with a signed pass in the URL fragment
// (#pass=...). We keep it in this browser until it runs out, strip it
// from the address bar, and send it on every local API call. When the
// box rejects it (expired, wrong site, bad signature) the gate comes back
// and points at the app. Nothing here talks to the cloud.
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
function passLine() {
  const info = STAFF_PASS ? passInfo(STAFF_PASS) : null;
  if (!info) return '';
  const until = new Date(info.exp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${info.name || 'Staff'} · until ${until}`;
}

function enter() {
  if (!STAFF_PASS) return showGate('');
  api('/api/layouts').then((layouts) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    LAYOUTS = layouts;
    renderLayouts();
    loadNames(); // non-blocking -- only needed to label items by name in the apply progress list
    refreshEvents(true);
    refreshLightRoutines();
    if (eventsTimer) clearInterval(eventsTimer);
    eventsTimer = setInterval(() => { refreshEvents(true); refreshLightRoutines(); }, 15000);
    updateTopbarClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(updateTopbarClock, 15000);
  }).catch((e) => {
    forgetPass();
    STAFF_PASS = '';
    showGate(/PASS_REQUIRED|401/.test(e.message) ? 'Your TV session has ended. Open TV Staff from the Bar Ops app again.' : escapeHtml(e.message));
  });
}
enter();

let clockTimer = null;
let eventsTimer = null;

// Topbar clock -- same shared header as staff_sources.html; see that file's
// staff_sources.js for the fuller comment on why this isn't a live seconds
// ticker.
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

// Layout items only carry target_type/target_id -- these two existing
// endpoints (already loaded by the Sources/TVs tabs) are what resolve those
// ids into the names the progress list shows. Best-effort: if this fails,
// resolveItemName() falls back to "source #4" / "TV #4" rather than blocking
// apply on it.
async function loadNames() {
  try { SOURCES = await api('/api/sources'); } catch (e) { SOURCES = []; }
  try { TVS = await api('/api/tvs'); } catch (e) { TVS = []; }
}

function resolveItemName(item) {
  if (item.target_type === 'source') {
    const s = SOURCES.find((ss) => Number(ss.id) === Number(item.target_id));
    return s ? s.label : `source #${item.target_id}`;
  }
  const t = TVS.find((tt) => Number(tt.id) === Number(item.target_id));
  return t ? t.name : `TV #${item.target_id}`;
}

function actionLabel(action) {
  if (!action) return '';
  if (action.op === 'tune') return `tune ${action.major}${action.minor != null ? '.' + action.minor : ''}`;
  if (action.op === 'launch') return 'launch app';
  if (action.op === 'power') return `power ${action.state}`;
  if (action.op === 'select_slot') return `source → slot ${action.slot}`;
  return action.op || '';
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

function fmtClock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Events (shared code in staff_events.js; this page draws the list) ----
function renderEventsSection() {
  const box = document.getElementById('eventsBox');
  if (!box) return;
  const evs = EVENTS.events || [];
  if (!evs.length) {
    box.innerHTML = `<p class="muted">${EVENTS.is_manager ? 'No events yet. On the TVs tab, highlight the TVs for one (pick a source first if it should change channel) and tap Capture event.' : 'No events set up. A manager captures them from the TVs tab.'}</p>`;
    return;
  }
  box.innerHTML = evs.map((e) => `
    <div class="layout-row ev-row ${e.running ? 'running' : ''}">
      <div class="ev-main">
        <div class="layout-name ev-name">${escapeHtml(e.name)}${e.enabled === false ? ' <span class="layout-count">(off)</span>' : ''}</div>
        <div class="layout-count ev-when">${escapeHtml(eventWhen(e))} · ${e.tv_ids.length} TV${e.tv_ids.length === 1 ? '' : 's'}</div>
      </div>
      ${EVENTS.is_manager && !e.running ? `<button class="ghost" onclick="openEditEvent(${e.id})">Edit</button>` : ''}
      ${e.running
        ? `<button class="off" onclick="confirmEndEvent(${e.id})">End</button>`
        : `<button class="primary" ${e.items.length ? '' : 'disabled'} onclick="confirmApplyEvent(${e.id})">Apply</button>`}
    </div>`).join('');
}
// The shared events code expects these from its host page.
function renderBulkProgress(title, rows) { renderApplyProgress(title, rows, null); }
function flashAttention(text) {
  const box = document.getElementById('attentionFlash');
  if (!box) return;
  const note = document.createElement('div');
  note.className = 'attention-flash';
  note.textContent = text;
  box.replaceChildren(note);
  setTimeout(() => { if (note.parentNode) note.remove(); }, 8000);
}
async function refreshAll() {
  try { LAYOUTS = await api('/api/layouts'); renderLayouts(); } catch (e) { /* keep last */ }
  await refreshEvents(true);
  refreshLightRoutines();
}

// ---- light routines (lib/lights.js via /api/lights) ----
let LIGHT_VIEW = null;
async function refreshLightRoutines() {
  if (!document.getElementById('lightRoutinesBox')) return; // Events page shares this script
  try { LIGHT_VIEW = await api('/api/lights'); renderLightRoutines(); } catch (e) { /* no lights on this box yet */ }
}
function lightWhen(part) {
  if (!part || part.kind === 'none') return '—';
  const at = part.at ? new Date(part.at).toLocaleTimeString('en-US', { timeZone: LIGHT_VIEW.timezone, hour: 'numeric', minute: '2-digit' }) : null;
  if (part.kind === 'time') return at || fmtClock(part.time);
  const off = Number(part.offset) || 0;
  const word = part.kind[0].toUpperCase() + part.kind.slice(1) + (off ? ` ${off < 0 ? '−' : '+'}${Math.abs(off)}` : '');
  return at ? `${word} (${at})` : word;
}
function renderLightRoutines() {
  const card = document.getElementById('lightRoutinesCard');
  const box = document.getElementById('lightRoutinesBox');
  const list = (LIGHT_VIEW && LIGHT_VIEW.routines) || [];
  card.style.display = list.length ? '' : 'none';
  const days = (d) => (d.length === 7 ? 'every day' : d.map((x) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]).join(', '));
  box.innerHTML = list.map((r) => `
    <div class="layout-row">
      <div>
        <div class="layout-name">${escapeHtml(r.name)}${r.enabled ? '' : ' <span class="layout-count">(paused)</span>'}</div>
        <div class="layout-count">On ${escapeHtml(lightWhen(r.on))} → off ${escapeHtml(lightWhen(r.off))} · ${escapeHtml(days(r.days || []))} · ${r.count} light${r.count === 1 ? '' : 's'}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="primary" ${r.count ? '' : 'disabled'} onclick="runLightRoutine(${Number(r.id)}, true)">Run ON</button>
        <button ${r.count ? '' : 'disabled'} onclick="runLightRoutine(${Number(r.id)}, false)">Run OFF</button>
      </div>
    </div>`).join('');
}
async function runLightRoutine(id, on) {
  const r = (LIGHT_VIEW.routines || []).find((x) => x.id === id);
  if (!on && !confirm(`Turn off every light in "${r ? r.name : 'this routine'}"?`)) return;
  try {
    const res = await api(`/api/lights/routines/${id}/run`, { method: 'POST', body: JSON.stringify({ on }) });
    flashAttention(res.ok ? `${r ? r.name : 'Routine'}: lights ${on ? 'on' : 'off'}.` : `Couldn’t reach: ${res.failed.join(', ')}`);
    refreshLightRoutines();
  } catch (e) { flashAttention(e.message); }
}

function renderLayouts() {
  const box = document.getElementById('layoutsBox');
  if (!box) return; // the Events page shares this script and has no scenes list
  if (!LAYOUTS.length) {
    box.innerHTML = '<p class="muted">No routines yet. A manager can capture one from the TVs tab (Capture routine) once the room looks right, or add one in TV Admin &rarr; Routines.</p>';
    return;
  }
  box.innerHTML = LAYOUTS.map((l) => `
    <div class="layout-row">
      <div>
        <div class="layout-name">${escapeHtml(l.name)}${l.enabled === false ? ' <span class="layout-count">(off)</span>' : ''}</div>
        ${l.description ? `<div class="layout-desc">${escapeHtml(l.description)}</div>` : ''}
        <div class="layout-count">${l.daily_time ? `daily at ${fmtClock(l.daily_time)} · ` : ''}${l.kind === 'all_off' ? 'every TV off' : `${l.items.length} item${l.items.length === 1 ? '' : 's'}`}</div>
      </div>
      <button class="primary" ${l.items.length ? '' : 'disabled'} onclick="applyLayout(${l.id})">Apply</button>
    </div>
  `).join('');
}

// ---- apply + 15s undo bar ----
let undoTimer = null;
let undoCountdownTimer = null;
let undoSnapshot = null;
let undoLabel = '';

function hideUndoBar() {
  clearTimeout(undoTimer);
  clearInterval(undoCountdownTimer);
  undoTimer = null;
  undoCountdownTimer = null;
  undoSnapshot = null;
  document.getElementById('undoBar').classList.remove('show');
}

function showUndoBar(label, snapshot) {
  hideUndoBar();
  undoSnapshot = snapshot;
  undoLabel = label;
  const UNDO_WINDOW_MS = 15000;
  const deadline = Date.now() + UNDO_WINDOW_MS;
  document.getElementById('undoText').textContent = `Applied "${label}".`;
  const tick = () => {
    const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    document.getElementById('undoCountdown').textContent = `Undo available for ${secs}s`;
    if (secs <= 0) hideUndoBar();
  };
  tick();
  undoCountdownTimer = setInterval(tick, 250);
  undoTimer = setTimeout(hideUndoBar, UNDO_WINDOW_MS);
  document.getElementById('undoBar').classList.add('show');
}

// Named live-ish progress list instead of a blocking alert() (§9: "13 done,
// 1 working, 1 failed, each device named"). The apply endpoint returns every
// item's result in one response rather than streaming them, so this can't
// show true per-item timing -- every targeted item shows "Working…" the
// moment the tap lands, then flips to Done/Failed together once the response
// comes back. Still names every item and never collapses to one pass/fail
// verdict for the whole layout.
async function applyLayout(id) {
  const layout = LAYOUTS.find((l) => Number(l.id) === Number(id));
  const items = layout ? layout.items : [];
  const pendingRows = items.map((it) => ({ name: resolveItemName(it), detail: actionLabel(it.action), status: 'working' }));
  renderApplyProgress(layout ? layout.name : 'Routine', pendingRows, id);

  try {
    const result = await api(`/api/layouts/${id}/apply`, { method: 'POST' });
    // runItems() preserves item order (grouped by step_order, index-preserving
    // concurrency), so results[i] corresponds to items[i] -- used only as a
    // fallback for the rare case a result has no label/name of its own
    // (target no longer exists).
    const rows = result.results.map((r, i) => ({
      name: r.label || r.name || (items[i] ? resolveItemName(items[i]) : `${r.target_type || 'item'} #${r.target_id}`),
      detail: items[i] ? actionLabel(items[i].action) : '',
      status: r.ok ? 'done' : 'failed',
      error: r.error,
    }));
    renderApplyProgress(result.name, rows, id);
    // Only offer undo if there's actually a prior-state snapshot to restore
    // to -- a layout applied to a room the agent has no live readings for
    // yet has nothing meaningful to undo back to.
    if (result.undo && result.undo.length) showUndoBar(result.name, result.undo);
  } catch (e) {
    renderApplyProgress(layout ? layout.name : 'Routine', pendingRows.map((r) => ({ ...r, status: 'failed', error: e.message })), id);
  }
}

function renderApplyProgress(layoutName, rows, layoutId) {
  const box = document.getElementById('applyProgress');
  const done = rows.filter((r) => r.status === 'done').length;
  const failed = rows.filter((r) => r.status === 'failed');
  const working = rows.filter((r) => r.status === 'working').length;
  const summary = working
    ? `Applying "${escapeHtml(layoutName)}"…`
    : `"${escapeHtml(layoutName)}": ${done} of ${rows.length} done${failed.length ? `, ${failed.length} failed` : ''}.`;

  box.innerHTML = `
    <div class="card">
      <h2 style="margin:0 0 8px;">${escapeHtml(layoutName)}</h2>
      <div class="progress-list">
        ${rows.map((r) => `
          <div class="progress-row">
            <span>${escapeHtml(r.name)}${r.detail ? ` <span class="muted">(${escapeHtml(r.detail)})</span>` : ''}</span>
            <span class="pstate ${r.status}">${r.status === 'working' ? 'Working…' : r.status === 'done' ? 'Done' : 'Failed' + (r.error ? `: ${escapeHtml(r.error)}` : '')}</span>
          </div>`).join('')}
      </div>
      <div class="progress-summary">${summary}</div>
      ${failed.length && working === 0 ? `
      <div class="failure-banner">
        <span class="text">${failed.length} item${failed.length === 1 ? '' : 's'} didn't apply.</span>
        <div class="actions">
          ${layoutId != null ? `<button class="small" onclick="applyLayout(${layoutId})">Retry</button>` : ''}
          <button class="small" onclick="document.getElementById('applyProgress').innerHTML=''">Dismiss</button>
        </div>
      </div>` : ''}
    </div>`;
}

async function undoApply() {
  if (!undoSnapshot) return;
  const snapshot = undoSnapshot;
  const label = undoLabel;
  hideUndoBar();
  try {
    await api('/api/layouts/replay', { method: 'POST', body: JSON.stringify({ items: snapshot, label: `undo: ${label}` }) });
  } catch (e) {
    alert(`Undo failed: ${e.message}`);
  }
}
