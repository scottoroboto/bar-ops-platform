// Staff TVs tab -- rebuilt 2026-09-06 to match screens/05-staff-tvs.html and
// screens/06-staff-remote-tv.html exactly (Scotto: "Build exactly what I
// designed"), replacing the earlier per-TV power/volume/mute grid with a
// "pick a source -> pick the TVs to move -> commit" bulk re-routing tool.
// Same shape as sources.js/the old tvs.js: local API only (/api/tvs,
// /api/sources, /api/zones), never a direct browser->device connection.
let STAFF_PIN = '';
let TVS = [];
let ZONES = [];
let SOURCES = [];
let refreshTimer = null;
let clockTimer = null;

function submitPin() {
  STAFF_PIN = document.getElementById('pinInput').value;
  api('/api/tvs').then(async (tvs) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    TVS = tvs;
    try { ZONES = await api('/api/zones'); } catch (e) { ZONES = []; }
    try { SOURCES = await api('/api/sources'); } catch (e) { SOURCES = []; }
    renderPage();
    fillSourceTitles();
    updateTopbarClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(updateTopbarClock, 15000);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshAll, 15000);
  }).catch(() => {
    document.getElementById('pinMsg').innerHTML = '<div class="msg error">Incorrect PIN.</div>';
  });
}

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
document.getElementById('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-staff-pin': STAFF_PIN, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
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
    fillSourceTitles();
  } catch (e) {
    // Transient failure -- leave the last-known state showing rather than
    // yanking the page out from under someone mid-tap.
  }
}

// ---------------------------------------------------------------------
// Shared lookups (mirrors sources.js's own currentSourceInfo/tvsOnSlot so
// both pages agree on what "this TV's current source" means).
// ---------------------------------------------------------------------
function currentSourceInfo(t) {
  if (t.live && t.live.slot != null) return { slot: Number(t.live.slot), confirmed: true };
  if (t.default_source_slot != null) return { slot: Number(t.default_source_slot), confirmed: false };
  return { slot: null, confirmed: false };
}

function tvsOnSlot(slot) {
  return TVS.filter((t) => currentSourceInfo(t).slot === Number(slot));
}

function sourceForSlot(slot) {
  return SOURCES.find((s) => Number(s.slot) === Number(slot));
}

// A slot reads "dead" only for the kinds that can actually go unreachable
// (directv/roku) -- static content and open/spare slots are never "dead".
function isSlotDead(slot) {
  const s = sourceForSlot(slot);
  if (!s) return false;
  if (s.kind !== 'directv' && s.kind !== 'roku') return false;
  return !(s.live && s.live.ok);
}

function tvIsDeadSourced(t) {
  const info = currentSourceInfo(t);
  return info.slot != null && isSlotDead(info.slot);
}

function qamForSlot(slot) {
  const s = sourceForSlot(slot);
  return s ? s.qam_channel : null;
}

function callsignForSlot(slot) {
  const t = SOURCE_TITLES.get(Number(slot));
  const s = sourceForSlot(slot);
  return (t && t.callsign) || (s && s.label) || '';
}

// ---------------------------------------------------------------------
// Live program titles for the source rail's headline (same
// /api/sources/:slot/proginfo call and "keep last-known" behavior as
// staff_sources.js's fillSourceTitles -- this rail shows the identical
// live headline data the Sources tab already fetches, just in a one-line
// row instead of a card).
// ---------------------------------------------------------------------
const SOURCE_TITLES = new Map();
let titleFillToken = 0;

async function fillSourceTitles() {
  const myToken = ++titleFillToken;
  const targets = SOURCES.filter((s) => s.kind === 'directv' && s.live && s.live.ok && s.live.active !== false && s.live.major != null);
  await Promise.all(targets.map(async (s) => {
    try {
      const info = await api(`/api/sources/${s.slot}/proginfo?major=${encodeURIComponent(s.live.major)}${s.live.minor != null ? `&minor=${encodeURIComponent(s.live.minor)}` : ''}`);
      if (myToken !== titleFillToken) return;
      SOURCE_TITLES.set(Number(s.slot), { title: info && info.title, callsign: info && info.callsign });
    } catch (e) {
      // Leave whatever title this slot already had.
    }
  }));
  if (myToken === titleFillToken && !TV_REMOTE_OPEN) renderSourceColumn();
}

// ---------------------------------------------------------------------
// Page state: which source is picked (left rail), which TVs are selected
// to move onto it (right grid) -- independent of each other, set in
// either order -- plus the TV Remote's own open/aimed state.
// ---------------------------------------------------------------------
let PICKED_SLOT = null;
let SELECTED_TV_IDS = new Set();
let collapsedZones = new Set();
let TV_REMOTE_OPEN = false;
let REMOTE_TARGETS = new Set();
let remoteKeyBuffer = [];
let remoteKeyBufferDisplay = '';
let remoteIdleTimer = null;

function renderPage() {
  renderSourceColumn();
  renderTvsColumn();
}

// =======================================================================
// LEFT COLUMN -- source rail (1 - Pick a source) or, when the TV Remote is
// open, the remote panel takes its place entirely (screens/06).
// =======================================================================
function renderSourceColumn() {
  const box = document.getElementById('tvsColSource');
  if (TV_REMOTE_OPEN) {
    box.innerHTML = tvRemotePanelHtml();
    const input = document.getElementById('remoteTvKeypadDisplay');
    if (input) input.value = remoteKeyBufferDisplay;
    return;
  }
  if (!SOURCES.length) { box.innerHTML = '<p class="muted">No sources configured yet. Add one from TSB Platform: Venue Control &rarr; Sources.</p>'; return; }
  box.innerHTML = `
    <div class="tvs-col-header"><span class="tvs-col-title">1 &middot; Pick a source</span></div>
    <div class="tvsrc-scroll"><div class="tvsrc-list">${SOURCES.map(sourceRowHtml).join('')}</div></div>`;
}

// One row per configured source. State language mirrors the Sources page's
// card grid (asleep/alert/idle/static/open) -- this is the same real data,
// just a compact 40px row instead of a card.
function sourceRowHtml(s) {
  const slot = Number(s.slot);
  const count = tvsOnSlot(slot).length;
  const picked = slot === PICKED_SLOT;

  if (s.kind === 'spare') {
    return `<div class="tvsrc-row sc-open no-tap"><span class="tvsrc-slot">${escapeHtml(s.qam_channel || '')}</span><span class="tvsrc-title">Open slot</span></div>`;
  }

  if (s.kind === 'static') {
    return `<button type="button" class="tvsrc-row sc-static${picked ? ' picked' : ''}" onclick="tvsrcTap(${slot})">
      <span class="tvsrc-slot">${escapeHtml(s.qam_channel || '')}</span>
      <span class="tvsrc-title">${escapeHtml(s.label)}</span>
      <span class="tvsrc-count">${count}</span>
    </button>`;
  }

  const live = s.live;

  if (s.kind === 'directv') {
    if (!live || !live.ok) {
      return `<button type="button" class="tvsrc-row sc-alert" onclick="tvsrcTap(${slot})" title="Tap to check again">
        <span class="tvsrc-slot">${escapeHtml(s.qam_channel || '')}</span>
        <span class="tvsrc-title">Not responding</span>
        <span class="tvsrc-count">${count}</span>
      </button>`;
    }
    if (live.active === false) {
      return `<button type="button" class="tvsrc-row sc-asleep" onclick="tvsrcTap(${slot})" title="Tap to wake">
        <span class="tvsrc-slot">${escapeHtml(s.qam_channel || '')}</span>
        <span class="tvsrc-title">Asleep</span>
        <span class="tvsrc-callsign">tap to wake</span>
        <span class="tvsrc-count">${count}</span>
      </button>`;
    }
    const t = SOURCE_TITLES.get(slot) || {};
    const headline = t.title || s.label;
    const callsign = t.callsign || s.label;
    return `<button type="button" class="tvsrc-row${picked ? ' picked' : ''}" onclick="tvsrcTap(${slot})">
      <span class="tvsrc-slot">${escapeHtml(s.qam_channel || '')}</span>
      <span class="tvsrc-title">${escapeHtml(headline)}</span>
      <span class="tvsrc-callsign">${escapeHtml(callsign)}</span>
      <span class="tvsrc-count">${count}</span>
    </button>`;
  }

  // roku
  if (!live || !live.ok) {
    return `<button type="button" class="tvsrc-row sc-alert" onclick="tvsrcTap(${slot})" title="Tap to check again">
      <span class="tvsrc-slot roku">${escapeHtml(s.qam_channel || '')}</span>
      <span class="tvsrc-title">Not responding</span>
      <span class="tvsrc-count">${count}</span>
    </button>`;
  }
  if (live.appId == null) {
    return `<button type="button" class="tvsrc-row sc-idle" onclick="tvsrcTap(${slot})">
      <span class="tvsrc-slot roku">${escapeHtml(s.qam_channel || '')}</span>
      <span class="tvsrc-title">Idle</span>
      <span class="tvsrc-callsign">${escapeHtml(s.label)}</span>
      <span class="tvsrc-count">${count}</span>
    </button>`;
  }
  return `<button type="button" class="tvsrc-row${picked ? ' picked' : ''}" onclick="tvsrcTap(${slot})">
    <span class="tvsrc-slot roku">${escapeHtml(s.qam_channel || '')}</span>
    <span class="tvsrc-title">${escapeHtml(live.appName || `App ${live.appId}`)}</span>
    <span class="tvsrc-callsign">${escapeHtml(s.label)}</span>
    <span class="tvsrc-count">${count}</span>
  </button>`;
}

// Tap dispatch -- not responding rechecks now, asleep wakes, anything else
// (live directv/roku, static) picks that source as the commit target.
async function tvsrcTap(slot) {
  const s = sourceForSlot(slot);
  if (!s) return;
  if ((s.kind === 'directv' || s.kind === 'roku') && (!s.live || !s.live.ok)) { refreshAll(); return; }
  if (s.kind === 'directv' && s.live && s.live.active === false) {
    try { await api(`/api/sources/${slot}/key`, { method: 'POST', body: JSON.stringify({ key: 'poweron' }) }); } catch (e) { alert(e.message); }
    setTimeout(refreshAll, 800);
    return;
  }
  PICKED_SLOT = slot;
  renderPage();
}

// =======================================================================
// RIGHT COLUMN -- zone-grouped TV chip grid (2 - Pick the TVs to move) or,
// with the TV Remote open, the same grid in "tap to aim" mode (screens/06:
// "the source highlight switches off entirely").
// =======================================================================

// Only channel-capable TVs can actually be re-routed by POST
// /api/tvs/bulk/slot (agent/server.js filters on t.channel_capable) -- the
// pick-a-source grid only ever shows TVs that command can reach. The TV
// Remote fans out power/volume/key presses to every TV regardless (same as
// the physical remote works on any smart TV), so it shows all of them.
function pickableTvs() {
  return TVS.filter((t) => t.ip && t.channel_capable);
}
function remoteableTvs() {
  return TVS.filter((t) => t.ip);
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
  const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'unassigned') return 1;
    if (b === 'unassigned') return -1;
    return zoneName(Number(a)).localeCompare(zoneName(Number(b)));
  });
  return orderedKeys.map((key) => ({ key, name: key === 'unassigned' ? 'Unassigned' : zoneName(Number(key)), tvs: groups.get(key) }));
}

function renderTvsColumn() {
  const box = document.getElementById('tvsColTvs');
  const tvs = TV_REMOTE_OPEN ? remoteableTvs() : pickableTvs();
  const groups = groupByZone(tvs);

  const pickedLabel = PICKED_SLOT != null ? `${callsignForSlot(PICKED_SLOT)} ${qamForSlot(PICKED_SLOT) || ''}`.trim() : '';

  const header = TV_REMOTE_OPEN
    ? `<div class="tvs-col-header">
        <span class="tvs-col-title">Tap TVs to aim the remote</span>
        <div class="tvs-legend"><span class="swatch"><span class="sw-box sel"></span><span class="lbl">receiving the remote</span></span></div>
      </div>`
    : `<div class="tvs-col-header">
        <span class="tvs-col-title">2 &middot; Pick the TVs to move</span>
        <div class="tvs-legend">
          <span class="swatch"><span class="sw-box on"></span><span class="lbl">already on${pickedLabel ? ` ${escapeHtml(pickedLabel)}` : ' picked source'}</span></span>
          <span class="swatch"><span class="sw-box sel"></span><span class="lbl">selected to move</span></span>
        </div>
      </div>`;

  const groupsHtml = groups.length
    ? groups.map((g) => zoneGroupHtml(g)).join('')
    : '<p class="muted">No TVs configured yet. Add one from TSB Platform: Venue Control &rarr; TVs.</p>';

  box.innerHTML = header + `<div class="tvz-scroll">${groupsHtml}</div>` + commitBarHtml();
}

function zoneGroupHtml(g) {
  const collapsed = collapsedZones.has(g.key);
  const deadCount = g.tvs.filter(tvIsDeadSourced).length;
  const deadNote = !TV_REMOTE_OPEN && deadCount ? `<span class="tvz-dead-note">${deadCount} on a dead source</span>` : '';

  if (collapsed) {
    const slots = new Set(g.tvs.map((t) => currentSourceInfo(t).slot).filter((s) => s != null));
    let note;
    if (slots.size === 1) note = `collapsed — all on ${escapeHtml(qamForSlot(Array.from(slots)[0]) || '')}`;
    else if (slots.size === 0) note = 'collapsed — no source set';
    else note = `collapsed — ${slots.size} different sources`;
    return `<div class="tvz-group">
      <div class="tvz-header collapsed">
        <button class="zone-toggle" onclick="toggleZoneCollapse('${g.key}')" title="Expand ${escapeHtml(g.name)}"><span class="chev">&#9660;</span></button>
        <span class="tvz-name">${escapeHtml(g.name)}</span><span class="tvz-count">${g.tvs.length}</span>${deadNote}
        <span class="tvz-collapsed-note">${note}</span>
      </div>
    </div>`;
  }

  return `<div class="tvz-group">
    <div class="tvz-header">
      <button class="zone-toggle" onclick="toggleZoneCollapse('${g.key}')" title="Collapse ${escapeHtml(g.name)}"><span class="chev">&#9660;</span></button>
      <span class="tvz-name">${escapeHtml(g.name)}</span><span class="tvz-count">${g.tvs.length}</span>${deadNote}
    </div>
    <div class="tv-chip-grid">${g.tvs.map(chipHtml).join('')}</div>
  </div>`;
}

function toggleZoneCollapse(key) {
  if (collapsedZones.has(key)) collapsedZones.delete(key);
  else collapsedZones.add(key);
  renderTvsColumn();
}

function chipHtml(t) {
  const info = currentSourceInfo(t);
  const dead = tvIsDeadSourced(t);
  const aimed = TV_REMOTE_OPEN && REMOTE_TARGETS.has(Number(t.id));
  const selected = !TV_REMOTE_OPEN && SELECTED_TV_IDS.has(Number(t.id));
  const pickedOn = !TV_REMOTE_OPEN && PICKED_SLOT != null && info.slot === PICKED_SLOT;

  const classes = ['tv-chip'];
  if (dead) classes.push('dead-source');
  if (pickedOn && !selected) classes.push('picked-on');
  if (selected || aimed) classes.push('remote-target');

  const qam = info.slot != null ? (qamForSlot(info.slot) || '') : '';
  const tag = t.tag || t.name;
  let sourceLine;
  if (info.slot == null) sourceLine = 'no source';
  else if (dead) sourceLine = 'no signal';
  else sourceLine = `${callsignForSlot(info.slot)} ${qam}`.trim();

  const onclick = TV_REMOTE_OPEN ? `toggleRemoteTarget(${t.id})` : `toggleTvSelected(${t.id})`;
  return `<button type="button" class="${classes.join(' ')}" onclick="${onclick}">
    <span class="chip-qam">${escapeHtml(qam)}</span>
    <span class="chip-tag">${escapeHtml(tag)}</span>
    <span class="chip-source">${escapeHtml(sourceLine)}</span>
  </button>`;
}

function toggleTvSelected(id) {
  id = Number(id);
  if (SELECTED_TV_IDS.has(id)) SELECTED_TV_IDS.delete(id);
  else SELECTED_TV_IDS.add(id);
  renderTvsColumn();
}

// ---------------------------------------------------------------------
// Sticky commit bar -- "Change N TVs to X" (POST /api/tvs/bulk/slot) in
// pick-a-source mode; "N TVs receiving the remote" with Clear / Select
// whole zone in TV Remote mode. Same bar, different content, exactly like
// screens/05 vs screens/06.
// ---------------------------------------------------------------------
function commitBarHtml() {
  if (TV_REMOTE_OPEN) {
    const n = REMOTE_TARGETS.size;
    const names = Array.from(REMOTE_TARGETS).map((id) => { const t = TVS.find((tt) => Number(tt.id) === Number(id)); return t ? (t.tag || t.name) : null; }).filter(Boolean);
    return `<div class="tvs-commit-bar">
      <div class="cb-left">
        ${n ? `<span class="cb-count">${n} TV${n === 1 ? '' : 's'}</span><span class="cb-names">receiving the remote — ${escapeHtml(names.join(', '))}</span>` : '<span class="cb-names">No TVs selected — tap one or more to aim the remote.</span>'}
      </div>
      <div class="cb-right">
        <button class="cb-clear" onclick="clearRemoteTargets()">Clear</button>
        <button class="cb-secondary" onclick="selectWholeZoneForRemote()">Select whole zone</button>
      </div>
    </div>`;
  }

  const n = SELECTED_TV_IDS.size;
  const names = Array.from(SELECTED_TV_IDS).map((id) => { const t = TVS.find((tt) => Number(tt.id) === Number(id)); return t ? (t.tag || t.name) : null; }).filter(Boolean);
  const pickedLabel = PICKED_SLOT != null ? `${callsignForSlot(PICKED_SLOT)} ${qamForSlot(PICKED_SLOT) || ''}`.trim() : null;
  const canCommit = n > 0 && PICKED_SLOT != null;
  return `<div class="tvs-commit-bar">
    <div class="cb-left">
      ${n ? `<span class="cb-count">${n} TV${n === 1 ? '' : 's'}</span><span class="cb-names">selected — ${escapeHtml(names.join(', '))}</span>` : '<span class="cb-names">No TVs selected — tap TVs to pick which ones move.</span>'}
    </div>
    <div class="cb-right">
      <button class="cb-clear" onclick="clearTvSelection()">Clear</button>
      <button class="cb-commit" ${canCommit ? '' : 'disabled'} onclick="commitSlotChange()">${n && pickedLabel ? `Change ${n} TV${n === 1 ? '' : 's'} to ${escapeHtml(pickedLabel)}` : 'Pick a source and TVs'}</button>
    </div>
  </div>`;
}

function clearTvSelection() {
  SELECTED_TV_IDS.clear();
  renderTvsColumn();
}

async function commitSlotChange() {
  if (PICKED_SLOT == null || !SELECTED_TV_IDS.size) return;
  const targetIds = Array.from(SELECTED_TV_IDS);
  const targets = targetIds.map((id) => TVS.find((t) => Number(t.id) === Number(id))).filter(Boolean);
  const label = `${callsignForSlot(PICKED_SLOT)} ${qamForSlot(PICKED_SLOT) || ''}`.trim();
  renderBulkProgress(`Moving to ${label}`, targets.map((t) => ({ id: t.id, name: t.tag || t.name, status: 'working' })));
  try {
    const { results } = await api('/api/tvs/bulk/slot', { method: 'POST', body: JSON.stringify({ slot: PICKED_SLOT, tv_ids: targetIds }) });
    const rows = targets.map((t) => {
      const r = results.find((rr) => Number(rr.id) === Number(t.id));
      if (!r) return { id: t.id, name: t.tag || t.name, status: 'failed', error: 'No result reported.' };
      return { id: t.id, name: t.tag || t.name, status: r.ok ? 'done' : 'failed', error: r.error };
    });
    renderBulkProgress(`Moving to ${label}`, rows, () => commitSlotChange());
    // Only drop the TVs that actually confirmed -- a failed one stays selected
    // so both the chip grid and the Retry button above still point at it,
    // instead of Retry silently no-op'ing on an emptied selection.
    rows.filter((r) => r.status === 'done').forEach((r) => SELECTED_TV_IDS.delete(Number(r.id)));
    await refreshAll();
  } catch (e) {
    renderBulkProgress(`Moving to ${label}`, targets.map((t) => ({ id: t.id, name: t.tag || t.name, status: 'failed', error: e.message })), () => commitSlotChange());
  }
}

// Generic named-results progress card, reused for both source-slot commits
// and the topbar's ALL TVs ON/OFF (§9: never a blanket success/fail alert).
function renderBulkProgress(title, rows, retry) {
  const box = document.getElementById('bulkProgress');
  const done = rows.filter((r) => r.status === 'done').length;
  const failed = rows.filter((r) => r.status === 'failed');
  const working = rows.filter((r) => r.status === 'working').length;
  const summary = working
    ? `${title}…`
    : `${done} of ${rows.length} confirmed${failed.length ? `, ${failed.length} failed` : ''}.`;

  box.innerHTML = `
    <div class="card" style="margin-top:12px;">
      <h2 style="margin:0 0 8px;">${escapeHtml(title)}</h2>
      <div class="progress-list">
        ${rows.map((r) => `
          <div class="progress-row">
            <span>${escapeHtml(r.name || `TV ${r.id}`)}</span>
            <span class="pstate ${r.status}">${r.status === 'working' ? 'Sending…' : r.status === 'done' ? 'Done' : 'Failed' + (r.error ? `: ${escapeHtml(r.error)}` : '')}</span>
          </div>`).join('')}
      </div>
      <div class="progress-summary">${summary}</div>
      ${failed.length && working === 0 ? `
      <div class="failure-banner">
        <span class="text">${failed.length} TV${failed.length === 1 ? '' : 's'} didn't confirm.</span>
        <div class="actions">
          ${retry ? `<button class="small" id="bulkRetryBtn">Retry</button>` : ''}
          <button class="small" onclick="document.getElementById('bulkProgress').innerHTML=''">Dismiss</button>
        </div>
      </div>` : ''}
    </div>`;
  if (retry && failed.length && working === 0) {
    const btn = document.getElementById('bulkRetryBtn');
    if (btn) btn.onclick = retry;
  }
}

// ---------------------------------------------------------------------
// Topbar ALL TVs ON / ALL TVs OFF (hold). Always targets every TV -- the
// per-zone on/off buttons the old grid had are gone, per screens/05's
// header-only action set.
// ---------------------------------------------------------------------
async function bulkPower(state) {
  const targets = TVS.filter((t) => !!t.ip);
  renderBulkProgress(`All TVs — ${state === 'on' ? 'On' : 'Off'}`, targets.map((t) => ({ id: t.id, name: t.tag || t.name, status: 'working' })));
  try {
    const { results } = await api('/api/tvs/bulk/power', { method: 'POST', body: JSON.stringify({ state }) });
    const rows = targets.map((t) => {
      const r = results.find((rr) => Number(rr.target_id ?? rr.id) === Number(t.id));
      if (!r) return { id: t.id, name: t.tag || t.name, status: 'failed', error: 'No result reported.' };
      return { id: t.id, name: r.name || t.tag || t.name, status: r.ok ? 'done' : 'failed', error: r.error };
    });
    renderBulkProgress(`All TVs — ${state === 'on' ? 'On' : 'Off'}`, rows, () => bulkPower(state));
    await refreshAll();
  } catch (e) {
    renderBulkProgress(`All TVs — ${state === 'on' ? 'On' : 'Off'}`, targets.map((t) => ({ id: t.id, name: t.tag || t.name, status: 'failed', error: e.message })), () => bulkPower(state));
  }
}

// Press-and-hold (ALL TVs OFF, §6: press-and-hold, not a plain tap).
// Delegated to document level so it keeps working on the button
// renderPage() never actually replaces (it's static markup in
// staff_tvs.html, unlike the old per-zone hold buttons that got
// re-rendered every refresh).
const HOLD_MS = 900;
let holdState = null;

function holdStart(btn) {
  holdCancel();
  const fill = btn.querySelector('.hold-fill');
  const startedAt = performance.now();
  function step(now) {
    const pct = Math.min(1, (now - startedAt) / HOLD_MS);
    if (fill) fill.style.width = `${pct * 100}%`;
    if (pct >= 1) {
      holdState = null;
      if (fill) fill.style.width = '0%';
      bulkPower(btn.getAttribute('data-hold-action'));
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
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => {
  document.addEventListener(ev, () => holdCancel());
});

// =======================================================================
// TV Remote (screens/06-staff-remote-tv.html) -- takes over the entire
// left column in place of the source rail (Scotto: "the remote replaces
// the entire source box area"). Aimed by tapping TV chips on the right
// (REMOTE_TARGETS), same as the aim-by-tapping model the old full-screen
// overlay used, just relocated. Closes on the X or after 15s of no remote
// activity (Scotto: "User can close by hitting X or have the remote time
// out after 15 secs in[]activity") -- never on "channel changed", which
// was this round's first (superseded) idea.
// =======================================================================
function toggleTvRemote() {
  if (TV_REMOTE_OPEN) { closeTvRemote(); return; }
  TV_REMOTE_OPEN = true;
  REMOTE_TARGETS.clear();
  remoteKeyBuffer = [];
  remoteKeyBufferDisplay = '';
  document.getElementById('tvRemoteToggle').classList.add('open');
  resetRemoteIdleTimer();
  renderPage();
}

function closeTvRemote() {
  TV_REMOTE_OPEN = false;
  REMOTE_TARGETS.clear();
  if (remoteIdleTimer) { clearTimeout(remoteIdleTimer); remoteIdleTimer = null; }
  const toggle = document.getElementById('tvRemoteToggle');
  if (toggle) toggle.classList.remove('open');
  renderPage();
}

function resetRemoteIdleTimer() {
  if (remoteIdleTimer) clearTimeout(remoteIdleTimer);
  remoteIdleTimer = setTimeout(closeTvRemote, 15000);
}

function toggleRemoteTarget(id) {
  id = Number(id);
  resetRemoteIdleTimer();
  if (REMOTE_TARGETS.has(id)) REMOTE_TARGETS.delete(id);
  else REMOTE_TARGETS.add(id);
  renderPage();
}

function clearRemoteTargets() {
  resetRemoteIdleTimer();
  REMOTE_TARGETS.clear();
  renderPage();
}

// "Select whole zone" needs a zone to mean -- taken from whichever TV was
// aimed most recently rather than a separate zone picker.
function selectWholeZoneForRemote() {
  resetRemoteIdleTimer();
  if (!REMOTE_TARGETS.size) { alert('Tap at least one TV first so I know which zone you mean.'); return; }
  const anchor = TVS.find((t) => Number(t.id) === Number(Array.from(REMOTE_TARGETS).pop()));
  const zoneKey = anchor && anchor.zone_id != null ? Number(anchor.zone_id) : null;
  remoteableTvs().filter((t) => (t.zone_id == null ? null : Number(t.zone_id)) === zoneKey)
    .forEach((t) => REMOTE_TARGETS.add(Number(t.id)));
  renderPage();
}

// Icons lifted directly from screens/06-staff-remote-tv.html's own inline
// SVGs (currentColor so .on/.off/.small's existing text colors apply).
const ICON_POWER = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3v9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M6.5 6.8a7.5 7.5 0 1 0 11 0" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_VOL_UP = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M4 9.5h3.2L11.5 6v12L7.2 14.5H4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_VOL_DOWN = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M4 9.5h3.2L11.5 6v12L7.2 14.5H4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_MUTE = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M4 9.5h3.2L11.5 6v12L7.2 14.5H4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" stroke="#E05A47" stroke-width="1.9" stroke-linecap="round"/></svg>';
const ICON_UNMUTE = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M4 9.5h3.2L11.5 6v12L7.2 14.5H4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10" stroke="#6FBF52" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_INPUT = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 21h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_CHUP = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHDOWN = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M12 19l-6-6M12 19l6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function tvRemotePanelHtml() {
  const n = REMOTE_TARGETS.size;
  return `
    <div class="tv-remote-panel">
      <div class="remote-panel-header">
        <span class="title">TV</span>
        <button class="close" onclick="closeTvRemote()">&times;</button>
      </div>
      <hr>
      <div class="remote-grid cols-2">
        <button class="on" onclick="remoteTvPower('on')">${ICON_POWER}<span>POWER ON</span></button>
        <button class="off" onclick="remoteTvPower('off')">${ICON_POWER}<span>POWER OFF</span></button>
      </div>
      <div class="remote-grid cols-4">
        <button class="small" onclick="remoteTvVolume('up')">${ICON_VOL_UP}<span>VOL UP</span></button>
        <button class="small" onclick="remoteTvVolume('down')">${ICON_VOL_DOWN}<span>VOL DOWN</span></button>
        <button class="small" onclick="remoteTvVolume('mute')">${ICON_MUTE}<span>MUTE</span></button>
        <button class="small" onclick="remoteTvVolume('unmute')">${ICON_UNMUTE}<span>UNMUTE</span></button>
      </div>
      <div class="remote-grid cols-3">
        <button class="small" onclick="remoteTvKey('KEY_SOURCE')">${ICON_INPUT}<span>INPUT</span></button>
        <button class="small" onclick="remoteTvKey('KEY_CHUP')">${ICON_CHUP}<span>CH UP</span></button>
        <button class="small" onclick="remoteTvKey('KEY_CHDOWN')">${ICON_CHDOWN}<span>CH DOWN</span></button>
      </div>
      <input type="text" id="remoteTvKeypadDisplay" readonly placeholder="Type a channel" style="width:100%; text-align:center; font-size:20px; margin-top:12px;">
      <div class="remote-grid cols-3" style="margin-top:8px;">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => `<button class="keypad-digit" onclick="remoteTvKeypad('${d}')">${d}</button>`).join('')}
        <button class="keypad-digit" onclick="remoteTvKeypad('-')">&ndash;</button>
        <button class="keypad-digit" onclick="remoteTvKeypad('0')">0</button>
        <button class="primary" onclick="remoteTvKeypadEnter()">ENTER</button>
      </div>
      <div class="remote-footer">Every press goes to the ${n || 'highlighted'} ${n === 1 ? 'TV' : 'TVs'}.</div>
    </div>`;
}

async function bulkKeyToTargets(keys) {
  resetRemoteIdleTimer();
  if (!REMOTE_TARGETS.size) { alert('Tap at least one TV first.'); return; }
  try {
    await api('/api/tvs/bulk/key', { method: 'POST', body: JSON.stringify({ tv_ids: Array.from(REMOTE_TARGETS), keys }) });
  } catch (e) { alert(e.message); }
}

function remoteTvKey(key) { bulkKeyToTargets([key]); }

async function remoteTvPower(state) {
  resetRemoteIdleTimer();
  if (!REMOTE_TARGETS.size) { alert('Tap at least one TV first.'); return; }
  try {
    await api('/api/tvs/bulk/power', { method: 'POST', body: JSON.stringify({ state, tv_ids: Array.from(REMOTE_TARGETS) }) });
    await refreshAll();
  } catch (e) { alert(e.message); }
}

async function remoteTvVolume(op) {
  resetRemoteIdleTimer();
  if (!REMOTE_TARGETS.size) { alert('Tap at least one TV first.'); return; }
  try {
    await api('/api/tvs/bulk/volume', { method: 'POST', body: JSON.stringify({ op, tv_ids: Array.from(REMOTE_TARGETS) }) });
  } catch (e) { alert(e.message); }
}

function remoteTvKeypad(ch) {
  resetRemoteIdleTimer();
  remoteKeyBuffer.push(ch === '-' ? 'KEY_MINUS' : `KEY_${ch}`);
  remoteKeyBufferDisplay += ch;
  const input = document.getElementById('remoteTvKeypadDisplay');
  if (input) input.value = remoteKeyBufferDisplay;
}

async function remoteTvKeypadEnter() {
  resetRemoteIdleTimer();
  if (!remoteKeyBuffer.length) return;
  const keys = [...remoteKeyBuffer, 'KEY_ENTER'];
  remoteKeyBuffer = [];
  remoteKeyBufferDisplay = '';
  const input = document.getElementById('remoteTvKeypadDisplay');
  if (input) input.value = '';
  await bulkKeyToTargets(keys);
}
