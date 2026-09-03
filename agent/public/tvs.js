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
    document.getElementById('app').style.display = '';
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
    return `
      <div class="zone-header">
        <h2 style="margin:0;">${escapeHtml(name)}</h2>
        <div class="zone-actions">
          <button class="small" onclick="bulkPower('on', '${key}')">Zone on</button>
          <button class="small hold-danger" data-zone="${key}" data-hold-action="off"><span class="hold-fill"></span><span class="hold-label">Hold: Zone off</span></button>
        </div>
      </div>
      ${tvs.map((t) => `
        <div class="tv-row">
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
