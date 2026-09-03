// Placeholder page — the real Venue Control app (device discovery, source/TV
// control, layouts, schedules) is not built yet; see docs/venue-control.md.
// This page exists now only to claim the Apps Home tile and prove the
// device-gating works, so the tile isn't sitting there unprotected while
// the real build waits on an on-site agent host.
//
// Gating is device-based, not role-based: the owner can open this from
// anywhere, but everyone else only sees/reaches it from a browser already
// marked as the location's trusted shared device (see getTrustedDeviceInfo()
// in common.js) — same mechanism as PIN-only login on a shared bar iPad,
// reused here instead of building a second pairing system.

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

(async function init() {
  const person = requireAuth();
  if (!person) return;

  const trustedDevice = await getTrustedDeviceInfo();
  const allowed = person.role === 'owner' || !!trustedDevice;

  if (!allowed) {
    document.getElementById('app').innerHTML =
      '<div class="card"><p>Venue Control is only available on the location\'s trusted device, or to the owner.</p>' +
      '<p><a href="/dashboard.html">Back to home</a></p></div>';
    return;
  }

  renderTopbar('Venue Control');

  const noteEl = document.getElementById('deviceNote');
  if (trustedDevice) {
    noteEl.textContent = `This device is trusted for ${trustedDevice.locationName}.`;
  } else if (person.role === 'owner') {
    noteEl.textContent = 'Viewing as owner — this browser is not a trusted device.';
  }

  // Sites admin (owner-only, regardless of device trust — this is setup,
  // not day-to-day TV control) — per-location on/off switch for Venue
  // Control, independent of a location's own active/archived state
  // (locations.active). Lets a location like Ticket 3, which is inactive
  // platform-wide, still be turned on here individually.
  if (person.role === 'owner') {
    document.getElementById('sitesCard').style.display = '';
    document.getElementById('sourcesCard').style.display = '';
    document.getElementById('favoritesCard').style.display = '';
    await loadSites();
  }
})();

let SITES = [];

async function loadSites() {
  try {
    SITES = await api('/api/venue-control/sites');
    renderSitesList();
    populateSourcesLocationSelect();
  } catch (e) {
    document.getElementById('sitesList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function renderSitesList() {
  const el = document.getElementById('sitesList');
  if (!SITES.length) { el.innerHTML = '<p class="muted">No locations yet.</p>'; return; }
  el.innerHTML = SITES.map(s => {
    const on = !!s.site_enabled;
    return `
      <div class="list-row">
        <div class="name">${escapeHtml(s.location_name)}
          ${!s.location_active ? '<span class="badge off">location archived</span>' : ''}
          <span class="badge ${on ? 'on' : 'off'}">${on ? 'Venue Control on' : s.site_id ? 'Venue Control off' : 'not added'}</span>
        </div>
        <div class="stack-actions" style="margin-top:0;">
          ${on
            ? `<button class="small ghost" onclick="setSiteEnabled('${s.location_id}', false)">Turn off</button>`
            : `<button class="small secondary" style="margin-top:0;" onclick="setSiteEnabled('${s.location_id}', true)">${s.site_id ? 'Turn on' : 'Add to Venue Control'}</button>`}
        </div>
        ${on ? renderAgentRow(s) : ''}
        <div id="tokenBox_${s.location_id}"></div>
      </div>`;
  }).join('');
}

// Agent status line — only shown once a site is on (matches the routes:
// there's nothing on-site to talk to for a site that isn't). "not
// registered yet" is the expected state until Scotto sets up the on-site
// box (see agent/README.md) and it calls POST /api/venue/agent/register at
// least once. "online"/"offline" is a simple staleness check against the
// agent's own 30s heartbeat cadence, not a live push.
function renderAgentRow(s) {
  let statusText, statusClass;
  if (!s.agent_hostname) {
    statusText = 'not registered yet';
    statusClass = 'off';
  } else {
    const ageMs = Date.now() - new Date(s.agent_last_seen_at).getTime();
    const stale = ageMs > 2 * 60 * 1000; // more than ~4 missed 30s heartbeats
    statusText = `${stale ? 'offline' : 'online'} — ${escapeHtml(s.agent_hostname)}, last seen ${formatAgo(ageMs)}`;
    statusClass = stale ? 'off' : 'on';
  }
  return `
    <div class="muted" style="margin-top:8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
      <span>Agent: <span class="badge ${statusClass}">${statusText}</span></span>
      <button class="small ghost" onclick="generateAgentToken('${s.location_id}')">${s.has_agent_token ? 'Regenerate agent token' : 'Generate agent token'}</button>
    </div>`;
}

function formatAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// Shown exactly once, inline, right under the row it belongs to — the
// server never returns this token again after this response (only its
// hash is stored), so there's no "view token" to come back to later.
async function generateAgentToken(locationId) {
  const box = document.getElementById(`tokenBox_${locationId}`);
  try {
    const result = await withStepUp(() => api(`/api/venue-control/sites/${locationId}/agent-token`, { method: 'POST' }));
    box.innerHTML = `
      <div class="msg info" style="margin-top:8px;">
        <p style="margin:0 0 6px;"><strong>Copy this now — it won't be shown again.</strong> Paste it into the agent's <code>.env</code> file as <code>AGENT_TOKEN</code> (see agent/README.md).</p>
        <code style="display:block; padding:8px; background:rgba(0,0,0,0.25); border-radius:6px; word-break:break-all; user-select:all;">${escapeHtml(result.agentToken)}</code>
        <button class="small ghost" style="margin-top:6px;" onclick="document.getElementById('tokenBox_${locationId}').innerHTML=''">Done, I copied it</button>
      </div>`;
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function setSiteEnabled(locationId, enabled) {
  try {
    await withStepUp(() => api(`/api/venue-control/sites/${locationId}/set-enabled`, { method: 'POST', body: { enabled } }));
    showMsg(enabled ? 'Venue Control turned on for this location.' : 'Venue Control turned off for this location.', 'success');
    await loadSites();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---- Sources & Favorites admin (owner-only, Phase 2, docs/venue-control.md
// §12: "sources admin CRUD ... favorites CRUD with sort"). Both are scoped
// to whichever location is picked in the shared select above the two
// cards -- a location with Venue Control off doesn't show up in it, same
// gating as the Sites card. Both flow down to the agent's own cache
// through GET /api/venue/agent/config; nothing here talks to a receiver
// directly, that only happens from the agent's local Sources tab.
let SOURCES_ADMIN = [];
let FAVORITES_ADMIN = [];
let editingSourceId = null;
let editingFavoriteId = null;

function populateSourcesLocationSelect() {
  const select = document.getElementById('sourcesLocationSelect');
  const enabledSites = SITES.filter((s) => s.site_enabled);
  const prevValue = select.value;
  if (!enabledSites.length) {
    select.innerHTML = '<option value="">No locations have Venue Control on yet</option>';
    document.getElementById('sourcesList').innerHTML = '<p class="muted">Turn Venue Control on for a location above first.</p>';
    document.getElementById('favoritesList').innerHTML = '';
    return;
  }
  select.innerHTML = enabledSites.map((s) => `<option value="${s.location_id}">${escapeHtml(s.location_name)}</option>`).join('');
  const stillValid = enabledSites.some((s) => String(s.location_id) === prevValue);
  select.value = stillValid ? prevValue : enabledSites[0].location_id;
  onSourcesLocationChange();
}

function onSourcesLocationChange() {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  if (!locationId) return;
  editingSourceId = null;
  editingFavoriteId = null;
  loadSourcesAdmin(locationId);
  loadFavoritesAdmin(locationId);
}

function showSourceMsg(text, kind) {
  document.getElementById('sourceMsg').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

async function loadSourcesAdmin(locationId) {
  try {
    SOURCES_ADMIN = await api(`/api/venue-control/sites/${locationId}/sources`);
    renderSourcesList();
  } catch (e) {
    document.getElementById('sourcesList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function renderSourcesList() {
  const el = document.getElementById('sourcesList');
  if (!SOURCES_ADMIN.length) { el.innerHTML = '<p class="muted">No sources yet.</p>'; return; }
  el.innerHTML = SOURCES_ADMIN.map((s) => {
    if (s.id === editingSourceId) {
      return `
        <div class="list-row" style="flex-direction:column; align-items:stretch;">
          <input id="editSourceSlot" type="number" value="${s.slot}" placeholder="Slot">
          <input id="editSourceQam" value="${escapeHtml(s.qam_channel)}" placeholder="QAM channel" style="margin-top:8px;">
          <input id="editSourceLabel" value="${escapeHtml(s.label)}" placeholder="Label" style="margin-top:8px;">
          <select id="editSourceKind" style="margin-top:8px;">
            ${['directv', 'roku', 'static', 'spare'].map((k) => `<option value="${k}" ${s.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
          </select>
          <input id="editSourceIp" value="${escapeHtml(s.ip || '')}" placeholder="IP address" style="margin-top:8px;">
          <input id="editSourceReceiverId" value="${escapeHtml(s.receiver_id || '')}" placeholder="Receiver ID" style="margin-top:8px;">
          <input id="editSourceCard" value="${escapeHtml(s.access_card_id || '')}" placeholder="Access card #" style="margin-top:8px;">
          <div class="stack-actions">
            <button class="ghost small" onclick="cancelEditSource()">Cancel</button>
            <button class="primary small" style="margin-top:0;" onclick="saveEditSource('${s.id}')">Save</button>
          </div>
        </div>`;
    }
    return `
      <div class="list-row">
        <div class="name">${escapeHtml(s.label)} <span class="badge ${s.enabled ? 'on' : 'off'}">${s.enabled ? 'active' : 'archived'}</span>
          <div class="sub">slot ${s.slot} · ${escapeHtml(s.qam_channel)} · ${escapeHtml(s.kind)}${s.ip ? ' · ' + escapeHtml(s.ip) : ''}</div>
        </div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="startEditSource('${s.id}')">Edit</button>
          ${s.enabled
            ? `<button class="small ghost" onclick="archiveSource('${s.id}')">Archive</button>`
            : `<button class="small secondary" style="margin-top:0;" onclick="restoreSource('${s.id}')">Restore</button>`}
        </div>
      </div>`;
  }).join('');
}

function startEditSource(id) { editingSourceId = id; renderSourcesList(); }
function cancelEditSource() { editingSourceId = null; renderSourcesList(); }

async function saveEditSource(id) {
  const slot = Number(document.getElementById('editSourceSlot').value);
  const qamChannel = document.getElementById('editSourceQam').value.trim();
  const label = document.getElementById('editSourceLabel').value.trim();
  const kind = document.getElementById('editSourceKind').value;
  const ip = document.getElementById('editSourceIp').value.trim();
  const receiverId = document.getElementById('editSourceReceiverId').value.trim();
  const accessCardId = document.getElementById('editSourceCard').value.trim();
  if (!slot || !qamChannel || !label) { showSourceMsg('Slot, QAM channel, and label are required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/sources/${id}/update`, {
      method: 'POST',
      body: { slot, qamChannel, label, kind, ip: ip || null, receiverId: receiverId || null, accessCardId: accessCardId || null },
    }));
    editingSourceId = null;
    showSourceMsg('Source updated.', 'success');
    await loadSourcesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showSourceMsg(e.message, 'error');
  }
}

async function archiveSource(id) {
  try {
    await withStepUp(() => api(`/api/venue-control/sources/${id}/archive`, { method: 'POST' }));
    showSourceMsg('Source archived.', 'success');
    await loadSourcesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showSourceMsg(e.message, 'error');
  }
}

async function restoreSource(id) {
  try {
    await withStepUp(() => api(`/api/venue-control/sources/${id}/restore`, { method: 'POST' }));
    showSourceMsg('Source restored.', 'success');
    await loadSourcesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showSourceMsg(e.message, 'error');
  }
}

async function addSource() {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  const slot = Number(document.getElementById('newSourceSlot').value);
  const qamChannel = document.getElementById('newSourceQam').value.trim();
  const label = document.getElementById('newSourceLabel').value.trim();
  const kind = document.getElementById('newSourceKind').value;
  const ip = document.getElementById('newSourceIp').value.trim();
  const receiverId = document.getElementById('newSourceReceiverId').value.trim();
  const accessCardId = document.getElementById('newSourceCard').value.trim();
  if (!locationId) { showSourceMsg('Turn Venue Control on for a location first.', 'error'); return; }
  if (!slot || !qamChannel || !label) { showSourceMsg('Slot, QAM channel, and label are required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/sites/${locationId}/sources`, {
      method: 'POST',
      body: { slot, qamChannel, label, kind, ip: ip || null, receiverId: receiverId || null, accessCardId: accessCardId || null },
    }));
    document.getElementById('newSourceSlot').value = '';
    document.getElementById('newSourceQam').value = '';
    document.getElementById('newSourceLabel').value = '';
    document.getElementById('newSourceIp').value = '';
    document.getElementById('newSourceReceiverId').value = '';
    document.getElementById('newSourceCard').value = '';
    showSourceMsg('Source added.', 'success');
    await loadSourcesAdmin(locationId);
  } catch (e) {
    showSourceMsg(e.message, 'error');
  }
}

function showFavMsg(text, kind) {
  document.getElementById('favMsg').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

async function loadFavoritesAdmin(locationId) {
  try {
    FAVORITES_ADMIN = await api(`/api/venue-control/sites/${locationId}/favorites`);
    renderFavoritesList();
  } catch (e) {
    document.getElementById('favoritesList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function renderFavoritesList() {
  const el = document.getElementById('favoritesList');
  if (!FAVORITES_ADMIN.length) { el.innerHTML = '<p class="muted">No favorites yet.</p>'; return; }
  el.innerHTML = FAVORITES_ADMIN.map((f) => {
    if (f.id === editingFavoriteId) {
      return `
        <div class="list-row" style="flex-direction:column; align-items:stretch;">
          <input id="editFavName" value="${escapeHtml(f.name)}" placeholder="Name">
          <input id="editFavMajor" type="number" value="${f.major}" placeholder="Major" style="margin-top:8px;">
          <input id="editFavMinor" type="number" value="${f.minor != null ? f.minor : ''}" placeholder="Minor (optional)" style="margin-top:8px;">
          <input id="editFavCategory" value="${escapeHtml(f.category)}" placeholder="Category" style="margin-top:8px;">
          <input id="editFavColor" value="${escapeHtml(f.color || '')}" placeholder="Color" style="margin-top:8px;">
          <div class="stack-actions">
            <button class="ghost small" onclick="cancelEditFavorite()">Cancel</button>
            <button class="primary small" style="margin-top:0;" onclick="saveEditFavorite('${f.id}')">Save</button>
          </div>
        </div>`;
    }
    return `
      <div class="list-row">
        <div class="name">${escapeHtml(f.name)} <span class="badge ${f.enabled ? 'on' : 'off'}">${f.enabled ? 'active' : 'archived'}</span> ${f.site_id === null ? '<span class="badge off">shared</span>' : ''}
          <div class="sub">${escapeHtml(f.category)} · ch. ${f.major}${f.minor != null ? '.' + f.minor : ''}</div>
        </div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="moveFavorite('${f.id}','up')">▲</button>
          <button class="small ghost" onclick="moveFavorite('${f.id}','down')">▼</button>
          <button class="small ghost" onclick="startEditFavorite('${f.id}')">Edit</button>
          ${f.enabled
            ? `<button class="small ghost" onclick="archiveFavorite('${f.id}')">Archive</button>`
            : `<button class="small secondary" style="margin-top:0;" onclick="restoreFavorite('${f.id}')">Restore</button>`}
        </div>
      </div>`;
  }).join('');
}

function startEditFavorite(id) { editingFavoriteId = id; renderFavoritesList(); }
function cancelEditFavorite() { editingFavoriteId = null; renderFavoritesList(); }

async function saveEditFavorite(id) {
  const name = document.getElementById('editFavName').value.trim();
  const major = Number(document.getElementById('editFavMajor').value);
  const minorRaw = document.getElementById('editFavMinor').value;
  const category = document.getElementById('editFavCategory').value.trim() || 'Sports';
  const color = document.getElementById('editFavColor').value.trim();
  if (!name || !major) { showFavMsg('Name and channel are required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/favorites/${id}/update`, {
      method: 'POST',
      body: { name, major, minor: minorRaw ? Number(minorRaw) : null, category, color: color || null },
    }));
    editingFavoriteId = null;
    showFavMsg('Favorite updated.', 'success');
    await loadFavoritesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showFavMsg(e.message, 'error');
  }
}

async function archiveFavorite(id) {
  try {
    await withStepUp(() => api(`/api/venue-control/favorites/${id}/archive`, { method: 'POST' }));
    showFavMsg('Favorite archived.', 'success');
    await loadFavoritesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showFavMsg(e.message, 'error');
  }
}

async function restoreFavorite(id) {
  try {
    await withStepUp(() => api(`/api/venue-control/favorites/${id}/restore`, { method: 'POST' }));
    showFavMsg('Favorite restored.', 'success');
    await loadFavoritesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showFavMsg(e.message, 'error');
  }
}

async function moveFavorite(id, direction) {
  try {
    await withStepUp(() => api(`/api/venue-control/favorites/${id}/move`, { method: 'POST', body: { direction } }));
    await loadFavoritesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showFavMsg(e.message, 'error');
  }
}

async function addFavorite() {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  const name = document.getElementById('newFavName').value.trim();
  const major = Number(document.getElementById('newFavMajor').value);
  const minorRaw = document.getElementById('newFavMinor').value;
  const category = document.getElementById('newFavCategory').value.trim() || 'Sports';
  const color = document.getElementById('newFavColor').value.trim();
  const shared = document.getElementById('newFavShared').checked;
  if (!locationId) { showFavMsg('Turn Venue Control on for a location first.', 'error'); return; }
  if (!name || !major) { showFavMsg('Name and channel are required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/sites/${locationId}/favorites`, {
      method: 'POST',
      body: { name, major, minor: minorRaw ? Number(minorRaw) : null, category, color: color || null, shared },
    }));
    document.getElementById('newFavName').value = '';
    document.getElementById('newFavMajor').value = '';
    document.getElementById('newFavMinor').value = '';
    document.getElementById('newFavColor').value = '';
    document.getElementById('newFavShared').checked = false;
    showFavMsg('Favorite added.', 'success');
    await loadFavoritesAdmin(locationId);
  } catch (e) {
    showFavMsg(e.message, 'error');
  }
}
