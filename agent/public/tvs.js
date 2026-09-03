// Staff TVs tab (docs/venue-control.md §10/§12 Phase 3: "TV power").
// Same shape as sources.js: local API only (/api/tvs, /api/zones), never a
// direct browser->TV connection.
let STAFF_PIN = '';
let TVS = [];
let ZONES = [];
let refreshTimer = null;

function submitPin() {
  STAFF_PIN = document.getElementById('pinInput').value;
  api('/api/tvs').then((tvs) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = '';
    TVS = tvs;
    loadZonesThenRender();
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
          </div>`}
        </div>
      `).join('')}
    `;
  }).join('');
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
