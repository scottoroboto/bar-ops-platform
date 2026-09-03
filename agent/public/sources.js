// Staff Sources tab (docs/venue-control.md §10/§12 Phase 2: "staff Sources
// tab"). Talks only to this agent's own local API (/api/sources,
// /api/favorites), never straight to a receiver from the browser and never
// to Supabase -- same "local UI, local API" shape as discovery.js.
let STAFF_PIN = '';
let SOURCES = [];
let FAVORITES = [];
let refreshTimer = null;

function submitPin() {
  STAFF_PIN = document.getElementById('pinInput').value;
  // GET /api/sources is harmless and always returns 200 (an empty array is
  // still success), so a clean response here is proof the PIN was accepted.
  api('/api/sources').then((sources) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = '';
    SOURCES = sources;
    renderSources();
    loadFavorites();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshSources, 15000); // matches the agent poller's own 15s cadence
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

async function refreshSources() {
  try {
    SOURCES = await api('/api/sources');
    renderSources();
  } catch (e) {
    // A transient failure here shouldn't yank the page out from under
    // someone mid-tap -- just leave the last-known state showing.
  }
}

function liveBadge(live) {
  if (!live) return '<span class="badge wait">not polled yet</span>';
  if (!live.ok) return `<span class="badge off">unreachable</span>`;
  const ch = live.major != null ? `${live.major}${live.minor != null ? '.' + live.minor : ''}` : '?';
  const state = live.active === false ? ' (standby)' : '';
  return `<span class="badge on">showing ${escapeHtml(String(ch))}${state}</span>`;
}

function renderSources() {
  document.getElementById('refreshedAt').textContent = `— updated ${new Date().toLocaleTimeString()}`;
  const box = document.getElementById('sourcesBox');
  if (!SOURCES.length) { box.innerHTML = '<p class="muted">No sources configured yet. Add one from TSB Platform: Venue Control &rarr; Sources.</p>'; return; }
  box.innerHTML = SOURCES.map((s) => `
    <div class="source-row">
      <div class="source-top">
        <div class="source-name">${escapeHtml(s.label)} <span class="muted">· slot ${s.slot} · ${escapeHtml(s.qam_channel)}</span></div>
        ${liveBadge(s.live)}
      </div>
      ${s.kind !== 'directv' ? `<p class="muted">${escapeHtml(s.kind)} — not controllable from here yet.</p>` : `
      <div class="source-controls">
        <input type="text" id="chan_${s.slot}" placeholder="e.g. 206 or 206.1">
        <button class="small" onclick="goToChannel(${s.slot})">Go</button>
        <button class="small" onclick="sendKey(${s.slot}, 'guide')">Guide</button>
        <button class="small" onclick="sendKey(${s.slot}, 'info')">Info</button>
      </div>`}
    </div>
  `).join('');
}

function parseChannel(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const [major, minor] = trimmed.split('.');
  if (!major || !/^\d+$/.test(major)) return null;
  return { major: Number(major), minor: minor && /^\d+$/.test(minor) ? Number(minor) : undefined };
}

async function goToChannel(slot) {
  const input = document.getElementById(`chan_${slot}`);
  const parsed = parseChannel(input.value);
  if (!parsed) { alert('Enter a channel like 206 or 206.1'); return; }
  try {
    await api(`/api/sources/${slot}/tune`, { method: 'POST', body: JSON.stringify(parsed) });
    input.value = '';
    await refreshSources();
  } catch (e) {
    alert(e.message);
  }
}

async function sendKey(slot, key) {
  try {
    await api(`/api/sources/${slot}/key`, { method: 'POST', body: JSON.stringify({ key }) });
  } catch (e) {
    alert(e.message);
  }
}

async function loadFavorites() {
  try {
    FAVORITES = await api('/api/favorites');
    renderFavorites();
  } catch (e) {
    // Favorites are a convenience on top of manual tuning, which still
    // works -- fail quietly rather than blocking the page on this.
  }
}

function renderFavorites() {
  const card = document.getElementById('favCard');
  if (!FAVORITES.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  document.getElementById('favGrid').innerHTML = FAVORITES.map((f, i) => `
    <button class="fav-btn" style="${f.color ? `border-color:${escapeHtml(f.color)};` : ''}" onclick="openTuneFav(${i})">
      <span class="cat">${escapeHtml(f.category)}</span>
      <span>${escapeHtml(f.name)}</span>
    </button>
  `).join('');
}

let TUNE_FAV = null;

function openTuneFav(i) {
  TUNE_FAV = FAVORITES[i];
  document.getElementById('tuneFavTitle').textContent = `Tune to ${TUNE_FAV.name}`;
  document.getElementById('tuneFavMsg').innerHTML = '';
  const directvSources = SOURCES.filter((s) => s.kind === 'directv');
  document.getElementById('tuneFavChecks').innerHTML = directvSources.length
    ? directvSources.map((s) => `
        <label style="display:flex; align-items:center; gap:8px; padding:4px 0;">
          <input type="checkbox" class="tuneFavCheck" value="${s.slot}" checked>
          ${escapeHtml(s.label)} <span class="muted">(slot ${s.slot})</span>
        </label>
      `).join('')
    : '<p class="muted">No DirecTV receivers configured yet.</p>';
  document.getElementById('tuneFavDialog').showModal();
}

async function submitTuneFav() {
  const slots = Array.from(document.querySelectorAll('.tuneFavCheck:checked')).map((el) => Number(el.value));
  if (!slots.length) { document.getElementById('tuneFavMsg').innerHTML = '<div class="msg error">Pick at least one receiver.</div>'; return; }
  try {
    const { results } = await api('/api/sources/bulk/tune', {
      method: 'POST',
      body: JSON.stringify({ slots, major: TUNE_FAV.major, minor: TUNE_FAV.minor }),
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      document.getElementById('tuneFavMsg').innerHTML = `<div class="msg error">${failed.length} of ${results.length} failed: ${escapeHtml(failed.map((f) => `slot ${f.slot} (${f.error})`).join(', '))}</div>`;
    } else {
      document.getElementById('tuneFavDialog').close();
    }
    await refreshSources();
  } catch (e) {
    document.getElementById('tuneFavMsg').innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}
