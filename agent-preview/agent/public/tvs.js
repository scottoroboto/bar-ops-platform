// Staff TVs tab (docs/venue-control.md §10/§12 Phase 3: "TV power").
// Same shape as sources.js: local API only (/api/tvs, /api/zones), never a
// direct browser->TV connection.
let STAFF_PIN = '';
let TVS = [];
let ZONES = [];
let SOURCES = [];
let refreshTimer = null;

function submitPin() {
  STAFF_PIN = document.getElementById('pinInput').value;
  api('/api/tvs').then((tvs) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    TVS = tvs;
    loadZonesThenRender();
    loadSources();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshTvs, 20000); // matches lib/tv-poller.js's own 20s cadence
  }).catch(() => {
    document.getElementById('pinMsg').innerHTML = '<div class="msg error">Incorrect PIN.</div>';
  });
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

async function loadZonesThenRender() {
  try { ZONES = await api('/api/zones'); } catch (e) { ZONES = []; }
  renderTvs();
}

// Phase 4 (docs/venue-control.md §12: "TV source selection") -- reuses the
// same local /api/sources the Sources tab already exposes, so the picker
// shows the real slot/label/qam_channel list without a second endpoint.
async function loadSources() {
  try { SOURCES = await api('/api/sources'); } catch (e) { SOURCES = []; }
}

function sourceLabel(slot) {
  if (slot == null) return null;
  const s = SOURCES.find((ss) => Number(ss.slot) === Number(slot));
  return s ? `${s.label} (slot ${s.slot})` : `slot ${slot}`;
}

// live.slot is the last slot this TV was actually *commanded* to (set the
// moment a select-channel command is sent, not verified afterward -- see
// samsung-ws.js's selectChannel). Before any command has been sent this
// session, fall back to the TV's own default_source_slot as a best guess,
// clearly labeled as such rather than presented as fact.
function currentSourceInfo(t) {
  if (t.live && t.live.slot != null) return { slot: t.live.slot, confirmed: true };
  if (t.default_source_slot != null) return { slot: t.default_source_slot, confirmed: false };
  return null;
}

async function refreshTvs() {
  try {
    TVS = await api('/api/tvs');
    renderTvs();
  } catch (e) {
    // Transient failure -- leave the last-known state showing rather than
    // yanking the page out from under someone mid-tap.
  }
}

function liveBadge(live) {
  if (!live) return '<span class="badge wait">not polled yet</span>';
  if (!live.ok && live.power === 'unreachable') return '<span class="badge off">unreachable</span>';
  if (live.power === 'on') return '<span class="badge on">on</span>';
  if (live.power === 'standby') return '<span class="badge wait">standby</span>';
  return '<span class="badge off">unreachable</span>';
}

// Zone-collapse (docs/venue-control-gui-reconciliation.md §3/§5: "no zone-collapse or
// adaptive grid density... required for 67-TV sites"). Collapsed state lives only in
// memory for this page load -- a refresh (F5) re-expands everything, which is fine
// since it's a viewing convenience, not a saved preference. Kept as a Set of zone keys
// ('unassigned' or a numeric zone id as a string) rather than resetting on every 20s
// poll refresh, so toggling a zone open doesn't get clobbered by the next refreshTvs().
let collapsedZones = new Set();

function toggleZoneCollapse(key) {
  if (collapsedZones.has(key)) collapsedZones.delete(key);
  else collapsedZones.add(key);
  renderTvs();
}

function setAllZonesCollapsed(collapsed, keys) {
  if (collapsed) keys.forEach((k) => collapsedZones.add(k));
  else collapsedZones.clear();
  renderTvs();
}

function allZoneKeys() {
  const keys = new Set();
  for (const tv of TVS) keys.add(tv.zone_id == null ? 'unassigned' : String(tv.zone_id));
  return Array.from(keys);
}

// Per-zone counts shown next to the zone name at all times (even collapsed), so a
// screen full of zones stays scannable without expanding every one to see what's on.
function zoneCounts(tvs) {
  let on = 0, off = 0, unreachable = 0;
  for (const t of tvs) {
    const p = t.live && t.live.power;
    if (t.live && !t.live.ok && p === 'unreachable') unreachable++;
    else if (p === 'on') on++;
    else if (p === 'standby') off++;
    else if (p === undefined || p === null) { /* not polled yet -- not counted either way */ }
    else unreachable++;
  }
  return { total: tvs.length, on, off, unreachable };
}

function zoneCountHtml(counts) {
  const parts = [`${counts.total} TV${counts.total === 1 ? '' : 's'}`];
  if (counts.on) parts.push(`<span class="n-on">${counts.on} on</span>`);
  if (counts.off) parts.push(`<span class="n-off">${counts.off} off</span>`);
  if (counts.unreachable) parts.push(`<span class="n-unreachable">${counts.unreachable} unreachable</span>`);
  return `<span class="zone-count">${parts.join(' · ')}</span>`;
}

// Press-and-hold for destructive multi-TV off actions (§6: "ALL TVs OFF is
// press-and-hold (~1s), not a plain tap" -- applied here to zone-off too,
// same blast-radius shape as all-off). Delegated to document level so it
// keeps working on buttons renderTvs() replaces on every refresh, without
// re-binding listeners each time.
const HOLD_MS = 900;
let holdState = null; // { btn, raf, startedAt }

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
      const zoneAttr = btn.getAttribute('data-zone');
      bulkPower(btn.getAttribute('data-hold-action'), zoneAttr === '' ? null : zoneAttr);
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

function renderTvs() {
  document.getElementById('refreshedAt').textContent = `— updated ${new Date().toLocaleTimeString()}`;
  const box = document.getElementById('tvsBox');
  if (!TVS.length) { box.innerHTML = '<p class="muted">No TVs configured yet. Add one from TSB Platform: Venue Control &rarr; TVs.</p>'; return; }

  const zoneName = (id) => {
    if (id == null) return 'Unassigned';
    const z = ZONES.find((zz) => Number(zz.id) === Number(id));
    return z ? z.name : 'Unassigned';
  };
  const groups = new Map();
  for (const tv of TVS) {
    const key = tv.zone_id == null ? 'unassigned' : String(tv.zone_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tv);
  }
  const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'unassigned') return 1;
    if (b === 'unassigned') return -1;
    return zoneName(Number(a)).localeCompare(zoneName(Number(b)));
  });

  box.innerHTML = orderedKeys.map((key) => {
    const tvs = groups.get(key);
    // key is either 'unassigned' or a real zone id string -- both are passed
    // through to bulkPower as-is (as a JS string literal in the onclick/data
    // attribute) so it can resolve the right target set itself. Previously
    // this used a bare zid that was '' for Unassigned, which JS's `||`
    // silently rewrote to the literal null -- i.e. "Zone off" on Unassigned
    // was actually turning off every TV in the building. Fixed here by never
    // collapsing 'unassigned' down to an empty/null scope.
    const name = key === 'unassigned' ? 'Unassigned' : zoneName(Number(key));
    const collapsed = collapsedZones.has(key);
    const counts = zoneCounts(tvs);
    return `
      <div class="zone-header">
        <div class="zone-title">
          <button class="zone-toggle${collapsed ? ' collapsed' : ''}" onclick="toggleZoneCollapse('${key}')" title="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(name)}"><span class="chev">&#9660;</span></button>
          <h2 style="margin:0;">${escapeHtml(name)}</h2>
          ${zoneCountHtml(counts)}
        </div>
        <div class="zone-actions">
          <button class="small" onclick="bulkPower('on', '${key}')">Zone on</button>
          <button class="small hold-danger" data-zone="${key}" data-hold-action="off"><span class="hold-fill"></span><span class="hold-label">Hold: Zone off</span></button>
        </div>
      </div>
      <div class="zone-body${collapsed ? ' collapsed' : ''}">
        <div class="tv-grid">
          ${tvs.map((t) => `
            <div class="tv-tile">
              <div class="tv-top">
                <div class="tv-name">${escapeHtml(t.name)}${t.tag ? ` <span class="muted">(${escapeHtml(t.tag)})</span>` : ''}</div>
                ${liveBadge(t.live)}
              </div>
              ${t.control_method === 'unknown' || t.control_method === 'none' ? `<p class="muted">Control method not set up yet -- see TSB Platform: Venue Control &rarr; TVs.</p>` : `
              <div class="tv-controls">
                <button class="small on" onclick="power(${t.id}, 'on')">On</button>
                <button class="small off" onclick="power(${t.id}, 'off')">Off</button>
                ${t.volume_capable !== false ? `
                <button class="small" onclick="volume(${t.id}, 'down')">Vol &minus;</button>
                <button class="small" onclick="volume(${t.id}, 'up')">Vol +</button>
                <button class="small" onclick="volume(${t.id}, 'mute')">Mute</button>
                <button class="small" onclick="volume(${t.id}, 'unmute')">Unmute</button>
                <span class="muted" id="muteNote_${t.id}"></span>` : ''}
              </div>
              ${t.channel_capable ? renderSourceRow(t) : ''}`}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderSourceRow(t) {
  const info = currentSourceInfo(t);
  const label = info
    ? escapeHtml(sourceLabel(info.slot)) + (info.confirmed ? '' : ' <span class="muted">(usual, unconfirmed)</span>')
    : '<span class="muted">not set</span>';
  return `<div class="tv-source-row"><span class="muted">Source:</span> ${label}
    <button class="small" onclick="openSourcePicker(${t.id})">Change source</button>
  </div>`;
}

async function power(id, state) {
  try {
    await api(`/api/tvs/${id}/power`, { method: 'POST', body: JSON.stringify({ state }) });
    await refreshTvs();
  } catch (e) {
    alert(e.message);
  }
}

async function volume(id, op) {
  try {
    const { result } = await api(`/api/tvs/${id}/volume`, { method: 'POST', body: JSON.stringify({ op }) });
    // Mute/unmute is the one control this system can't always make fully
    // discrete (see samsung-ws.js's setMute -- most TVs' remotes only have a
    // toggle key with no readback). When the driver couldn't confirm it,
    // say so right on the row instead of quietly presenting a guess as fact.
    const note = document.getElementById(`muteNote_${id}`);
    if (note && (op === 'mute' || op === 'unmute')) {
      note.textContent = result && result.confirmed === false ? '(not confirmed by the TV)' : '';
    }
  } catch (e) {
    alert(e.message);
  }
}

// Bulk power reports named per-device results, never a blanket
// success/fail alert (§9). This system has no streaming channel to show
// true live per-device timing (the bulk endpoint returns all results at
// once), so "Sending…" appears for every targeted TV the moment the action
// starts, then flips to Done/Failed as soon as the response comes back --
// still names every device, just without a fake sense of granular timing.
// `scope` is null (every TV), 'unassigned' (TVs with no zone -- sent as an
// explicit tv_ids list since the bulk endpoint's zone_id filter has no way
// to mean "no zone"), or a real zone id (string or number).
async function bulkPower(state, scope) {
  const isUnassigned = scope === 'unassigned';
  const zoneId = scope == null || isUnassigned ? null : Number(scope);
  // Mirrors the server's own bulk/power target filter (agent/server.js: "enabled
  // !== false && t.ip") as closely as this client can -- ip is the one signal
  // available here too, so the progress list names the same TVs the request will
  // actually attempt rather than drifting from what the server does.
  let targets;
  if (isUnassigned) targets = TVS.filter((t) => t.zone_id == null);
  else if (zoneId != null) targets = TVS.filter((t) => Number(t.zone_id) === zoneId);
  else targets = TVS;
  targets = targets.filter((t) => !!t.ip);

  const scopeLabel = isUnassigned ? 'Unassigned' : zoneId == null ? 'All TVs' : (ZONES.find((z) => Number(z.id) === zoneId) || {}).name || 'Zone';
  renderBulkProgress(scopeLabel, state, scope, targets.map((t) => ({ id: t.id, name: t.name, status: 'working' })));

  const body = { state };
  if (isUnassigned) body.tv_ids = targets.map((t) => t.id);
  else if (zoneId != null) body.zone_id = zoneId;
  try {
    const { results } = await api('/api/tvs/bulk/power', { method: 'POST', body: JSON.stringify(body) });
    const rows = targets.map((t) => {
      const r = results.find((rr) => Number(rr.target_id ?? rr.id) === Number(t.id));
      if (!r) return { id: t.id, name: t.name, status: 'failed', error: 'No result reported.' };
      return { id: t.id, name: r.name || t.name, status: r.ok ? 'done' : 'failed', error: r.error };
    });
    renderBulkProgress(scopeLabel, state, scope, rows);
    await refreshTvs();
  } catch (e) {
    renderBulkProgress(scopeLabel, state, scope, targets.map((t) => ({ id: t.id, name: t.name, status: 'failed', error: e.message })));
  }
}

function renderBulkProgress(scopeLabel, state, scope, rows) {
  const box = document.getElementById('bulkProgress');
  const done = rows.filter((r) => r.status === 'done').length;
  const failed = rows.filter((r) => r.status === 'failed');
  const working = rows.filter((r) => r.status === 'working').length;
  const summary = working
    ? `Turning ${state === 'on' ? 'on' : 'off'} ${rows.length} TV${rows.length === 1 ? '' : 's'} in ${escapeHtml(scopeLabel)}…`
    : `${scopeLabel}: ${done} of ${rows.length} confirmed ${state}${failed.length ? `, ${failed.length} failed` : ''}.`;

  box.innerHTML = `
    <div class="card" style="margin-top:12px;">
      <h2 style="margin:0 0 8px;">${escapeHtml(scopeLabel)} — ${state === 'on' ? 'On' : 'Off'}</h2>
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
        <span class="text">${failed.length} TV${failed.length === 1 ? '' : 's'} didn't confirm ${state}.</span>
        <div class="actions">
          <button class="small" onclick="bulkPower('${state}', ${scope == null ? 'null' : `'${scope}'`})">Retry</button>
          <button class="small" onclick="document.getElementById('bulkProgress').innerHTML=''">Dismiss</button>
        </div>
      </div>` : ''}
    </div>`;
}

// Phase 4 (docs/venue-control.md §12: "TV source selection") -- the picker
// itself is a flat list of every configured source (not just DirecTV, so a
// spare/static slot can still be picked); tapping one sends the key-code
// sequence and closes on success, same "open, act, close" shape as the
// Sources tab's favorites picker.
let SOURCE_PICK_TV_ID = null;

function openSourcePicker(tvId) {
  SOURCE_PICK_TV_ID = tvId;
  const tv = TVS.find((t) => Number(t.id) === Number(tvId));
  document.getElementById('tvSourceTitle').textContent = tv ? `Choose a source for ${tv.name}` : 'Choose a source';
  document.getElementById('tvSourceMsg').innerHTML = '';
  document.getElementById('tvSourceGrid').innerHTML = SOURCES.length
    ? SOURCES.map((s) => `
        <button class="fav-btn" onclick="pickSource(${s.slot})">
          <span class="cat">slot ${s.slot}</span>
          <span>${escapeHtml(s.label)}</span>
        </button>`).join('')
    : '<p class="muted">No sources configured yet -- see TSB Platform: Venue Control &rarr; Sources.</p>';
  document.getElementById('tvSourceDialog').showModal();
}

async function pickSource(slot) {
  if (SOURCE_PICK_TV_ID == null) return;
  try {
    await api(`/api/tvs/${SOURCE_PICK_TV_ID}/slot`, { method: 'POST', body: JSON.stringify({ slot }) });
    document.getElementById('tvSourceDialog').close();
    await refreshTvs();
  } catch (e) {
    document.getElementById('tvSourceMsg').innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------
// TV remote (screens/06-staff-remote-tv.html) -- aimed by tapping TV chips
// rather than bound to one device like the source remotes (sources.js's
// openRemote). Every button here fans out to every TV currently in
// REMOTE_TARGETS via the two new bulk routes this round added
// (POST /api/tvs/bulk/key, .../bulk/volume) plus the existing bulk/power.
// "In remote mode the source highlight switches off entirely" -- the stage
// below shows only the aim highlight (.remote-target), nothing else.
// ---------------------------------------------------------------------
let TV_REMOTE_OPEN = false;
let REMOTE_TARGETS = new Set();
let remoteKeyBuffer = []; // internal KEY_* tokens for the typed-channel keypad
let remoteKeyBufferDisplay = '';

function openTvRemote() {
  TV_REMOTE_OPEN = true;
  REMOTE_TARGETS.clear();
  remoteKeyBuffer = [];
  remoteKeyBufferDisplay = '';
  document.getElementById('tvRemoteOverlay').classList.add('open');
  renderTvRemotePanel();
  renderTvRemoteStage();
}

function closeTvRemote() {
  TV_REMOTE_OPEN = false;
  document.getElementById('tvRemoteOverlay').classList.remove('open');
}

function toggleRemoteTarget(id) {
  // Normalize to Number before touching the Set -- t.id can arrive as a
  // JS string (Postgres bigint columns serialize as strings) while this
  // function's own `id` param is always a bare numeric literal (it's
  // embedded unquoted in the onclick="" attribute below). Without this,
  // the same TV can occupy two different-typed Set entries at once --
  // see selectWholeZoneForRemote's matching Number(t.id) normalization.
  id = Number(id);
  if (REMOTE_TARGETS.has(id)) REMOTE_TARGETS.delete(id);
  else REMOTE_TARGETS.add(id);
  renderTvRemoteStage();
  renderTvRemoteBar();
}

function clearRemoteTargets() {
  REMOTE_TARGETS.clear();
  renderTvRemoteStage();
  renderTvRemoteBar();
}

// "Select whole zone" needs a zone to mean -- taken from whichever TV was
// aimed most recently rather than a separate zone picker, since by the time
// someone reaches for this button they've almost always already tapped at
// least one TV in the zone they mean.
function selectWholeZoneForRemote() {
  if (!REMOTE_TARGETS.size) { alert('Tap at least one TV first so I know which zone you mean.'); return; }
  const anchor = TVS.find((t) => Number(t.id) === Number(Array.from(REMOTE_TARGETS).pop()));
  const zoneKey = anchor && anchor.zone_id != null ? Number(anchor.zone_id) : null;
  TVS.filter((t) => (t.zone_id == null ? null : Number(t.zone_id)) === zoneKey && t.ip)
    .forEach((t) => REMOTE_TARGETS.add(Number(t.id)));
  renderTvRemoteStage();
  renderTvRemoteBar();
}

function renderTvRemoteStage() {
  const stage = document.getElementById('tvRemoteStage');
  const zoneName = (id) => {
    if (id == null) return 'Unassigned';
    const z = ZONES.find((zz) => Number(zz.id) === Number(id));
    return z ? z.name : 'Unassigned';
  };
  const groups = new Map();
  for (const tv of TVS) {
    const key = tv.zone_id == null ? 'unassigned' : String(tv.zone_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tv);
  }
  const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'unassigned') return 1;
    if (b === 'unassigned') return -1;
    return zoneName(Number(a)).localeCompare(zoneName(Number(b)));
  });
  stage.innerHTML = `<div style="font-size:12px; font-weight:700; letter-spacing:0.1em; color:var(--muted); margin-bottom:8px;">TAP TVS TO AIM THE REMOTE</div>` +
    orderedKeys.map((key) => {
      const tvs = groups.get(key);
      const name = key === 'unassigned' ? 'Unassigned' : zoneName(Number(key));
      return `
        <div class="zone-header"><div class="zone-title"><h2 style="margin:0;">${escapeHtml(name)}</h2>${zoneCountHtml(zoneCounts(tvs))}</div></div>
        <div class="tv-grid">
          ${tvs.map((t) => {
            const info = currentSourceInfo(t);
            const chan = info ? sourceLabel(info.slot) : null;
            return `
            <div class="tv-tile${REMOTE_TARGETS.has(Number(t.id)) ? ' remote-target' : ''}" style="cursor:pointer;" onclick="toggleRemoteTarget(${t.id})">
              <div class="tv-top"><div class="tv-name">${escapeHtml(t.name)}${t.tag ? ` <span class="muted">(${escapeHtml(t.tag)})</span>` : ''}</div></div>
              <div class="muted" style="font-size:12px;">${chan ? escapeHtml(chan) : 'no source set'}</div>
            </div>`;
          }).join('')}
        </div>`;
    }).join('');
}

function renderTvRemoteBar() {
  const bar = document.getElementById('tvRemoteBar');
  if (!bar) return;
  const n = REMOTE_TARGETS.size;
  const names = Array.from(REMOTE_TARGETS).map((id) => (TVS.find((t) => Number(t.id) === Number(id)) || {}).name).filter(Boolean);
  bar.innerHTML = n
    ? `<span class="count">${n} TV${n === 1 ? '' : 's'}</span> receiving the remote — ${escapeHtml(names.join(', '))}`
    : `<span class="muted">No TVs selected — tap one or more to aim the remote.</span>`;
}

function renderTvRemotePanel() {
  document.getElementById('tvRemotePanelBody').innerHTML = `
    <div class="remote-grid cols-2">
      <button class="on" onclick="remoteTvPower('on')">POWER ON</button>
      <button class="off" onclick="remoteTvPower('off')">POWER OFF</button>
    </div>
    <div class="remote-grid cols-4">
      <button class="small" onclick="remoteTvVolume('up')">Vol +</button>
      <button class="small" onclick="remoteTvVolume('down')">Vol &minus;</button>
      <button class="small" onclick="remoteTvVolume('mute')">Mute</button>
      <button class="small" onclick="remoteTvVolume('unmute')">Unmute</button>
    </div>
    <div class="remote-grid cols-3">
      <button class="small" onclick="remoteTvKey('KEY_SOURCE')">Input</button>
      <button class="small" onclick="remoteTvKey('KEY_CHUP')">CH &#9650;</button>
      <button class="small" onclick="remoteTvKey('KEY_CHDOWN')">CH &#9660;</button>
    </div>
    <input type="text" id="remoteTvKeypadDisplay" readonly placeholder="Type a channel" style="width:100%; text-align:center; font-size:20px; margin-top:12px;">
    <div class="remote-grid cols-3" style="margin-top:8px;">
      ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => `<button onclick="remoteTvKeypad('${d}')">${d}</button>`).join('')}
      <button onclick="remoteTvKeypad('-')">&ndash;</button>
      <button onclick="remoteTvKeypad('0')">0</button>
      <button class="primary" onclick="remoteTvKeypadEnter()">Enter</button>
    </div>
    <div class="remote-footer">Every press goes to the highlighted TVs.</div>
    <div class="remote-bar" id="tvRemoteBar" style="margin-top:12px;"></div>
    <div style="display:flex; gap:8px; margin-top:8px;">
      <button class="small" onclick="clearRemoteTargets()">Clear</button>
      <button class="small" onclick="selectWholeZoneForRemote()">Select whole zone</button>
    </div>`;
  renderTvRemoteBar();
}

async function bulkKeyToTargets(keys) {
  if (!REMOTE_TARGETS.size) { alert('Tap at least one TV first.'); return; }
  try {
    await api('/api/tvs/bulk/key', { method: 'POST', body: JSON.stringify({ tv_ids: Array.from(REMOTE_TARGETS), keys }) });
  } catch (e) { alert(e.message); }
}

function remoteTvKey(key) { bulkKeyToTargets([key]); }

async function remoteTvPower(state) {
  if (!REMOTE_TARGETS.size) { alert('Tap at least one TV first.'); return; }
  try {
    await api('/api/tvs/bulk/power', { method: 'POST', body: JSON.stringify({ state, tv_ids: Array.from(REMOTE_TARGETS) }) });
    await refreshTvs();
    if (TV_REMOTE_OPEN) renderTvRemoteStage();
  } catch (e) { alert(e.message); }
}

async function remoteTvVolume(op) {
  if (!REMOTE_TARGETS.size) { alert('Tap at least one TV first.'); return; }
  try {
    await api('/api/tvs/bulk/volume', { method: 'POST', body: JSON.stringify({ op, tv_ids: Array.from(REMOTE_TARGETS) }) });
  } catch (e) { alert(e.message); }
}

function remoteTvKeypad(ch) {
  remoteKeyBuffer.push(ch === '-' ? 'KEY_MINUS' : `KEY_${ch}`);
  remoteKeyBufferDisplay += ch;
  document.getElementById('remoteTvKeypadDisplay').value = remoteKeyBufferDisplay;
}

async function remoteTvKeypadEnter() {
  if (!remoteKeyBuffer.length) return;
  const keys = [...remoteKeyBuffer, 'KEY_ENTER'];
  remoteKeyBuffer = [];
  remoteKeyBufferDisplay = '';
  document.getElementById('remoteTvKeypadDisplay').value = '';
  await bulkKeyToTargets(keys);
}
