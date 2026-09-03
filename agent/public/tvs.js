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
    const zid = key === 'unassigned' ? '' : key;
    const name = key === 'unassigned' ? 'Unassigned' : zoneName(Number(key));
    return `
      <div class="zone-header">
        <h2 style="margin:0;">${escapeHtml(name)}</h2>
        <div class="zone-actions">
          <button class="small" onclick="bulkPower('on', ${zid || 'null'})">Zone on</button>
          <button class="small" onclick="bulkPower('off', ${zid || 'null'})">Zone off</button>
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
            <button class="small" onclick="power(${t.id}, 'on')">On</button>
            <button class="small" onclick="power(${t.id}, 'off')">Off</button>
            ${t.volume_capable !== false ? `
            <button class="small" onclick="volume(${t.id}, 'down')">Vol &minus;</button>
            <button class="small" onclick="volume(${t.id}, 'up')">Vol +</button>
            <button class="small" onclick="volume(${t.id}, 'mute')">Mute</button>` : ''}
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
    await api(`/api/tvs/${id}/volume`, { method: 'POST', body: JSON.stringify({ op }) });
  } catch (e) {
    alert(e.message);
  }
}

async function bulkPower(state, zoneId) {
  const body = { state };
  if (zoneId != null) body.zone_id = zoneId;
  try {
    const { results } = await api('/api/tvs/bulk/power', { method: 'POST', body: JSON.stringify(body) });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) alert(`${failed.length} of ${results.length} TV(s) didn't confirm ${state}: ${failed.map((f) => f.name || f.id).join(', ')}`);
    await refreshTvs();
  } catch (e) {
    alert(e.message);
  }
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
