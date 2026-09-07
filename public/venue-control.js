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
  //
  // The nine admin sections used to all render at once in one long scroll
  // (docs/venue-control-gui-reconciliation.md §1: "Ten sections in one
  // scroll. That is a sidebar or tab set, not a column.") -- now they're
  // tabbed panels (see showVcPanel() below), so this just reveals the
  // shared #adminArea shell (location picker + tab bar + panels) once,
  // rather than un-hiding each card individually.
  if (person.role === 'owner') {
    document.getElementById('adminArea').style.display = '';
    initVcTabs();
    await loadSites();
  }
})();

// ---- Section tabs (docs/venue-control-gui-reconciliation.md §5 item 5:
// "Admin page restructure — sidebar/sections instead of one scroll"). Purely
// a visibility layer over the existing cards/lists/forms -- none of the
// CRUD logic below changed to make room for this, only how each panel is
// shown or hidden. Defaults to the Sites tab; clicking a tab just toggles
// .active on the matching button and panel via CSS (see
// venue-control-admin.css's .vc-panel/.vc-tab rules).
function initVcTabs() {
  document.getElementById('vcTabs').querySelectorAll('.vc-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.panel === 'sites');
  });
  document.querySelectorAll('.vc-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === 'sites');
  });
}

function showVcPanel(name) {
  document.getElementById('vcTabs').querySelectorAll('.vc-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.panel === name);
  });
  document.querySelectorAll('.vc-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === name);
  });
}

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
  editingZoneId = null;
  editingTvId = null;
  TV_SELECTED.clear();
  TV_ZONE_FILTER = 'all';
  DISCOVERY_ADOPT_OPEN_ID = null;
  if (DISCOVERY_POLL_TIMER) { clearTimeout(DISCOVERY_POLL_TIMER); DISCOVERY_POLL_TIMER = null; }
  loadDiscoveryAdmin(locationId);

  // Several tabs now cross-reference each other's data (Zones shows a TV
  // count, TVs joins in Device Health's live status, Activity resolves
  // ids to names) -- each loader still renders itself immediately so the
  // tab isn't empty while other calls are in flight, but these fire off a
  // second, fully-informed re-render once everything it depends on has
  // actually landed, rather than trusting whatever order the requests
  // happen to resolve in.
  const sourcesP = loadSourcesAdmin(locationId);
  loadFavoritesAdmin(locationId);
  const zonesP = loadZonesAdmin(locationId);
  const tvsP = loadTvsAdmin(locationId);
  const healthP = loadHealthAdmin(locationId);
  const layoutsP = loadLayoutsAdmin(locationId);
  loadSchedulesAdmin(locationId);
  loadBackupsAdmin(locationId);

  Promise.all([zonesP, tvsP, healthP]).then(() => { renderZonesList(); renderTvZoneChips(); renderTvsList(); renderHealthList(); });
  Promise.all([sourcesP, zonesP, tvsP, layoutsP]).then(() => loadActivityAdmin(locationId));
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
          <input id="editSourcePort" type="number" value="${s.port || ''}" placeholder="Port (8080 directv / 8060 roku)" style="margin-top:8px;">
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
        <div class="name">${escapeHtml(s.label)} <span class="badge ${s.enabled ? 'on' : 'off'}">${s.enabled ? 'active' : 'archived'}</span> ${kindBadge(s.kind)}
          <div class="sub">slot ${s.slot} · ${escapeHtml(s.qam_channel)}${s.ip ? ' · ' + escapeHtml(s.ip) + ':' + escapeHtml(String(s.port || '')) : ''}</div>
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

// A spare slot should read as "available," not "broken" (docs/venue-
// control-ui.md, A5): DirecTV green, Roku blue, static/spare grey — matches
// the admin CSS's .badge.kind-* classes.
function kindBadge(kind) {
  return `<span class="badge kind-${escapeHtml(kind)}">${escapeHtml(kind.toUpperCase())}</span>`;
}

function startEditSource(id) { editingSourceId = id; renderSourcesList(); }
function cancelEditSource() { editingSourceId = null; renderSourcesList(); }

async function saveEditSource(id) {
  const slot = Number(document.getElementById('editSourceSlot').value);
  const qamChannel = document.getElementById('editSourceQam').value.trim();
  const label = document.getElementById('editSourceLabel').value.trim();
  const kind = document.getElementById('editSourceKind').value;
  const ip = document.getElementById('editSourceIp').value.trim();
  const port = Number(document.getElementById('editSourcePort').value) || null;
  const receiverId = document.getElementById('editSourceReceiverId').value.trim();
  const accessCardId = document.getElementById('editSourceCard').value.trim();
  if (!slot || !qamChannel || !label) { showSourceMsg('Slot, QAM channel, and label are required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/sources/${id}/update`, {
      method: 'POST',
      body: { slot, qamChannel, label, kind, ip: ip || null, port, receiverId: receiverId || null, accessCardId: accessCardId || null },
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
  const port = Number(document.getElementById('newSourcePort').value) || null;
  const receiverId = document.getElementById('newSourceReceiverId').value.trim();
  const accessCardId = document.getElementById('newSourceCard').value.trim();
  if (!locationId) { showSourceMsg('Turn Venue Control on for a location first.', 'error'); return; }
  if (!slot || !qamChannel || !label) { showSourceMsg('Slot, QAM channel, and label are required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/sites/${locationId}/sources`, {
      method: 'POST',
      body: { slot, qamChannel, label, kind, ip: ip || null, port, receiverId: receiverId || null, accessCardId: accessCardId || null },
    }));
    document.getElementById('newSourceSlot').value = '';
    document.getElementById('newSourceQam').value = '';
    document.getElementById('newSourceLabel').value = '';
    document.getElementById('newSourceIp').value = '';
    document.getElementById('newSourcePort').value = '';
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

// ---- Zones, TVs & Schedules admin (owner-only, Phase 3, docs/venue-control.md
// §12: "zones, bulk and per-zone operations, schedules"). Same shared
// location select as Sources/Favorites above. All three flow down to the
// agent through GET /api/venue/agent/config; the agent's own TVs tab is
// where day-to-day power control actually happens.
let ZONES_ADMIN = [];
let TVS_ADMIN = [];
let SCHEDULES_ADMIN = [];
let editingZoneId = null;
let editingTvId = null;
let editingScheduleId = null;

function showZoneMsg(text, kind) {
  document.getElementById('zoneMsg').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

async function loadZonesAdmin(locationId) {
  try {
    ZONES_ADMIN = await api(`/api/venue-control/sites/${locationId}/zones`);
    renderZonesList();
    populateZoneSelects();
  } catch (e) {
    document.getElementById('zonesList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function populateZoneSelects() {
  const options = '<option value="">Unassigned</option>' + ZONES_ADMIN.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join('');
  const tvSelect = document.getElementById('newTvZone');
  if (tvSelect) tvSelect.innerHTML = options;
  const schedSelect = document.getElementById('newSchedTvZone');
  if (schedSelect) schedSelect.innerHTML = '<option value="">All zones</option>' + ZONES_ADMIN.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join('');
}

function renderZonesList() {
  const el = document.getElementById('zonesList');
  if (!ZONES_ADMIN.length) { el.innerHTML = '<p class="muted">No zones yet.</p>'; return; }
  el.innerHTML = ZONES_ADMIN.map((z, i) => {
    const tvCount = TVS_ADMIN.filter((t) => t.enabled && String(t.zone_id) === String(z.id)).length;
    if (z.id === editingZoneId) {
      return `
        <div class="list-row" style="flex-direction:column; align-items:stretch;">
          <input id="editZoneName" value="${escapeHtml(z.name)}" placeholder="Name">
          <div class="stack-actions">
            <button class="ghost small" onclick="cancelEditZone()">Cancel</button>
            <button class="primary small" style="margin-top:0;" onclick="saveEditZone('${z.id}')">Save</button>
          </div>
        </div>`;
    }
    return `
      <div class="list-row">
        <div class="name">${escapeHtml(z.name)}
          <div class="sub">${tvCount} TV${tvCount === 1 ? '' : 's'}</div>
        </div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="moveZone('${z.id}','up')" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
          <button class="small ghost" onclick="moveZone('${z.id}','down')" ${i === ZONES_ADMIN.length - 1 ? 'disabled' : ''}>&#9660;</button>
          <button class="small ghost" onclick="startEditZone('${z.id}')">Edit</button>
          <button class="small ghost" onclick="deleteZone('${z.id}')">Delete</button>
        </div>
      </div>`;
  }).join('');
}

// Reorders by swapping the two zones' sort_order the same way moveFavorite()
// and monitoring.js's own moveSystem() already do it elsewhere in this
// codebase -- vc_zones already has a sort_order column and the update route
// already accepts sortOrder, this just wires up a client for it (A7: "order
// here is the order staff see on the TVs tab" -- Favorites got a reorder
// control when this was first built, Zones never did).
async function moveZone(id, direction) {
  const idx = ZONES_ADMIN.findIndex((z) => String(z.id) === String(id));
  if (idx === -1) return;
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= ZONES_ADMIN.length) return;
  const a = ZONES_ADMIN[idx], b = ZONES_ADMIN[swapIdx];
  try {
    await withStepUp(() => api(`/api/venue-control/zones/${a.id}/update`, { method: 'POST', body: { sortOrder: swapIdx } }));
    await withStepUp(() => api(`/api/venue-control/zones/${b.id}/update`, { method: 'POST', body: { sortOrder: idx } }));
    await loadZonesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showZoneMsg(e.message, 'error');
  }
}

function startEditZone(id) { editingZoneId = id; renderZonesList(); }
function cancelEditZone() { editingZoneId = null; renderZonesList(); }

async function saveEditZone(id) {
  const name = document.getElementById('editZoneName').value.trim();
  if (!name) { showZoneMsg('Name is required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/zones/${id}/update`, { method: 'POST', body: { name } }));
    editingZoneId = null;
    showZoneMsg('Zone updated.', 'success');
    await loadZonesAdmin(document.getElementById('sourcesLocationSelect').value);
    await loadTvsAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showZoneMsg(e.message, 'error');
  }
}

async function deleteZone(id) {
  try {
    await withStepUp(() => api(`/api/venue-control/zones/${id}/delete`, { method: 'POST' }));
    showZoneMsg('Zone deleted. Any TVs in it are now unassigned.', 'success');
    await loadZonesAdmin(document.getElementById('sourcesLocationSelect').value);
    await loadTvsAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showZoneMsg(e.message, 'error');
  }
}

async function addZone() {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  const name = document.getElementById('newZoneName').value.trim();
  if (!locationId) { showZoneMsg('Turn Venue Control on for a location first.', 'error'); return; }
  if (!name) { showZoneMsg('Name is required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/sites/${locationId}/zones`, { method: 'POST', body: { name } }));
    document.getElementById('newZoneName').value = '';
    showZoneMsg('Zone added.', 'success');
    await loadZonesAdmin(locationId);
  } catch (e) {
    showZoneMsg(e.message, 'error');
  }
}

function showTvMsg(text, kind) {
  document.getElementById('tvMsg').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

async function loadTvsAdmin(locationId) {
  try {
    TVS_ADMIN = await api(`/api/venue-control/sites/${locationId}/tvs`);
    renderTvsList();
  } catch (e) {
    document.getElementById('tvsList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function zoneName(zoneId) {
  if (zoneId == null) return 'Unassigned';
  const z = ZONES_ADMIN.find((zz) => String(zz.id) === String(zoneId));
  return z ? z.name : 'Unassigned';
}

const CONTROL_METHODS = ['unknown', 'samsung_ws_token', 'samsung_ws_plain', 'samsung_legacy', 'smartthings', 'wol_only', 'none'];

// ---- TVs: zone/status filter chips + search + multi-select bulk bar (A6).
// Device Health's own data is reused here rather than adding a new
// endpoint -- monitored_systems.external_ref is that row's vc_tvs.id (see
// server/monitoring.js), so a TV's live status is just a lookup by id,
// joined in at render time.
let TV_ZONE_FILTER = 'all'; // 'all' | a zone id | 'needs-attention' | 'never-paired'
let TV_SEARCH = '';
let TV_SELECTED = new Set();

function tvHealthFor(tvId) {
  return (HEALTH_SYSTEMS || []).find((h) => h.kind === 'vc_tv' && String(h.external_ref) === String(tvId));
}

// "Needs attention" = reporting anything other than online, or has no
// control method set up at all (can't be turned on/off from here yet
// regardless of what Device Health says). "Never paired" is the samsung_ws_token
// devices that haven't completed the TV's own "Allow this device?" handshake --
// the same condition Device Health's "warning" status represents for a TV.
function tvNeedsAttention(t) {
  const h = tvHealthFor(t.id);
  return (h && h.last_status && h.last_status !== 'online') || t.control_method === 'unknown';
}
function tvNeverPaired(t) {
  const h = tvHealthFor(t.id);
  return t.control_method === 'samsung_ws_token' && h && h.last_status === 'warning';
}

function renderTvZoneChips() {
  const el = document.getElementById('tvZoneChips');
  if (!el) return;
  const chips = [{ id: 'all', label: 'All zones' }]
    .concat(ZONES_ADMIN.map((z) => ({ id: String(z.id), label: z.name })))
    .concat([{ id: 'needs-attention', label: 'Needs attention', warn: true }, { id: 'never-paired', label: 'Never paired', warn: true }]);
  el.innerHTML = chips.map((c) => `<button type="button" class="vc-filter-chip${c.warn ? ' warn' : ''}${TV_ZONE_FILTER === c.id ? ' active' : ''}" onclick="setTvZoneFilter('${c.id}')">${escapeHtml(c.label)}</button>`).join('');
}

function setTvZoneFilter(id) { TV_ZONE_FILTER = id; renderTvZoneChips(); renderTvsList(); }
function onTvFilterChange() { TV_SEARCH = document.getElementById('tvSearch').value.trim().toLowerCase(); renderTvsList(); }

function filteredTvs() {
  return TVS_ADMIN.filter((t) => {
    if (TV_ZONE_FILTER === 'needs-attention' && !tvNeedsAttention(t)) return false;
    if (TV_ZONE_FILTER === 'never-paired' && !tvNeverPaired(t)) return false;
    if (TV_ZONE_FILTER !== 'all' && TV_ZONE_FILTER !== 'needs-attention' && TV_ZONE_FILTER !== 'never-paired' && String(t.zone_id) !== TV_ZONE_FILTER) return false;
    if (TV_SEARCH) {
      const hay = `${t.name} ${t.tag || ''} ${t.ip || ''}`.toLowerCase();
      if (!hay.includes(TV_SEARCH)) return false;
    }
    return true;
  });
}

function tvStateBadge(t) {
  const h = tvHealthFor(t.id);
  if (!t.enabled) return '';
  if (!h || !h.last_status) return '<span class="badge state-off">no data yet</span>';
  if (h.last_status === 'online') return '<span class="badge state-on">online</span>';
  if (h.last_status === 'warning') return '<span class="badge state-warning">needs pairing</span>';
  return '<span class="badge state-danger">not responding</span>';
}

function toggleTvSelect(id, checked) {
  if (checked) TV_SELECTED.add(String(id)); else TV_SELECTED.delete(String(id));
  renderTvBulkBar();
}

function renderTvBulkBar() {
  const bar = document.getElementById('tvBulkBar');
  if (!bar) return;
  const n = TV_SELECTED.size;
  bar.hidden = n === 0;
  if (n === 0) return;
  document.getElementById('tvBulkCount').textContent = `${n} TV${n === 1 ? '' : 's'} selected`;
  const zoneSelect = document.getElementById('tvBulkZoneSelect');
  zoneSelect.innerHTML = '<option value="">Move to zone…</option><option value="__unassigned__">Unassigned</option>'
    + ZONES_ADMIN.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join('');
}

async function bulkMoveTvsToZone() {
  const val = document.getElementById('tvBulkZoneSelect').value;
  if (!val) { showTvMsg('Pick a zone first.', 'error'); return; }
  const zoneId = val === '__unassigned__' ? null : val;
  const ids = Array.from(TV_SELECTED);
  try {
    await withStepUp(() => Promise.all(ids.map((id) => api(`/api/venue-control/tvs/${id}/update`, { method: 'POST', body: { zoneId } }))));
    showTvMsg(`Moved ${ids.length} TV${ids.length === 1 ? '' : 's'}.`, 'success');
    TV_SELECTED.clear();
    await loadTvsAdmin(document.getElementById('sourcesLocationSelect').value);
    renderTvBulkBar();
  } catch (e) {
    showTvMsg(e.message, 'error');
  }
}

async function bulkSetTvControlMethod() {
  const method = document.getElementById('tvBulkControlSelect').value;
  if (!method) { showTvMsg('Pick a control method first.', 'error'); return; }
  const ids = Array.from(TV_SELECTED);
  try {
    await withStepUp(() => Promise.all(ids.map((id) => api(`/api/venue-control/tvs/${id}/update`, { method: 'POST', body: { controlMethod: method } }))));
    showTvMsg(`Updated ${ids.length} TV${ids.length === 1 ? '' : 's'}.`, 'success');
    TV_SELECTED.clear();
    await loadTvsAdmin(document.getElementById('sourcesLocationSelect').value);
    renderTvBulkBar();
  } catch (e) {
    showTvMsg(e.message, 'error');
  }
}

async function bulkArchiveTvs() {
  const ids = Array.from(TV_SELECTED);
  if (!ids.length) return;
  if (!confirm(`Archive ${ids.length} TV${ids.length === 1 ? '' : 's'}? This can be undone from the archived list.`)) return;
  try {
    await withStepUp(() => Promise.all(ids.map((id) => api(`/api/venue-control/tvs/${id}/archive`, { method: 'POST' }))));
    showTvMsg(`Archived ${ids.length} TV${ids.length === 1 ? '' : 's'}.`, 'success');
    TV_SELECTED.clear();
    await loadTvsAdmin(document.getElementById('sourcesLocationSelect').value);
    renderTvBulkBar();
  } catch (e) {
    showTvMsg(e.message, 'error');
  }
}

function renderTvsList() {
  const el = document.getElementById('tvsList');
  renderTvBulkBar();
  if (!TVS_ADMIN.length) { el.innerHTML = '<p class="muted">No TVs yet.</p>'; return; }
  const rows = filteredTvs();
  if (!rows.length) { el.innerHTML = '<p class="muted">No TVs match this filter.</p>'; return; }
  el.innerHTML = rows.map((t) => {
    if (t.id === editingTvId) {
      return `
        <div class="list-row" style="flex-direction:column; align-items:stretch;">
          <input id="editTvName" value="${escapeHtml(t.name)}" placeholder="Name">
          <select id="editTvZone" style="margin-top:8px;">
            <option value="">Unassigned</option>
            ${ZONES_ADMIN.map((z) => `<option value="${z.id}" ${String(t.zone_id) === String(z.id) ? 'selected' : ''}>${escapeHtml(z.name)}</option>`).join('')}
          </select>
          <input id="editTvIp" value="${escapeHtml(t.ip || '')}" placeholder="IP address" style="margin-top:8px;">
          <input id="editTvMac" value="${escapeHtml(t.mac || '')}" placeholder="MAC address" style="margin-top:8px;">
          <select id="editTvControlMethod" style="margin-top:8px;">
            ${CONTROL_METHODS.map((m) => `<option value="${m}" ${t.control_method === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
          <label for="editTvDefaultSlot" style="margin-top:8px;">Default source slot (optional)</label>
          <input id="editTvDefaultSlot" type="number" value="${t.default_source_slot != null ? t.default_source_slot : ''}" placeholder="e.g. 10">
          <label class="toggle-row" style="gap:8px; margin-top:8px;"><span class="label">Wake-on-LAN enabled</span>
            <span class="switch"><input type="checkbox" id="editTvWol" ${t.wol_enabled ? 'checked' : ''}><span class="slider"></span></span>
          </label>
          <label class="toggle-row" style="gap:8px;"><span class="label">Channel capable (can select a source, Phase 4)</span>
            <span class="switch"><input type="checkbox" id="editTvChannelCapable" ${t.channel_capable ? 'checked' : ''}><span class="slider"></span></span>
          </label>
          <p class="muted" style="margin:-4px 0 0;">Channel selection sends key codes exactly like the remote and can't be verified automatically (docs/venue-control.md §7.2) -- try "Change source" on the agent's TVs tab once, confirm visually, then turn this on.</p>
          <label class="toggle-row" style="gap:8px;"><span class="label">Force re-pair (clear saved token)</span>
            <span class="switch"><input type="checkbox" id="editTvResetToken"><span class="slider"></span></span>
          </label>
          <div class="stack-actions">
            <button class="ghost small" onclick="cancelEditTv()">Cancel</button>
            <button class="primary small" style="margin-top:0;" onclick="saveEditTv('${t.id}')">Save</button>
          </div>
        </div>`;
    }
    return `
      <div class="list-row">
        <input type="checkbox" class="vc-tv-row-check" ${TV_SELECTED.has(String(t.id)) ? 'checked' : ''} onchange="toggleTvSelect('${t.id}', this.checked)">
        <div class="name">${escapeHtml(t.name)} <span class="badge ${t.enabled ? 'on' : 'off'}">${t.enabled ? 'active' : 'archived'}</span> ${tvStateBadge(t)}
          <div class="sub">${escapeHtml(zoneName(t.zone_id))} · ${escapeHtml(t.control_method)}${t.ip ? ' · ' + escapeHtml(t.ip) : ''}${t.wol_enabled ? ' · WoL' : ''}${t.channel_capable ? ' · channel-capable' : ''}${t.default_source_slot != null ? ` · default slot ${t.default_source_slot}` : ''}</div>
        </div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="startEditTv('${t.id}')">Edit</button>
          ${t.enabled
            ? `<button class="small ghost" onclick="archiveTv('${t.id}')">Archive</button>`
            : `<button class="small secondary" style="margin-top:0;" onclick="restoreTv('${t.id}')">Restore</button>`}
        </div>
      </div>`;
  }).join('');
}

function startEditTv(id) { editingTvId = id; renderTvsList(); }
function cancelEditTv() { editingTvId = null; renderTvsList(); }

async function saveEditTv(id) {
  const name = document.getElementById('editTvName').value.trim();
  const zoneId = document.getElementById('editTvZone').value;
  const ip = document.getElementById('editTvIp').value.trim();
  const mac = document.getElementById('editTvMac').value.trim();
  const controlMethod = document.getElementById('editTvControlMethod').value;
  const defaultSourceSlotRaw = document.getElementById('editTvDefaultSlot').value;
  const wolEnabled = document.getElementById('editTvWol').checked;
  const channelCapable = document.getElementById('editTvChannelCapable').checked;
  const resetToken = document.getElementById('editTvResetToken').checked;
  if (!name) { showTvMsg('Name is required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/tvs/${id}/update`, {
      method: 'POST',
      body: {
        name, zoneId: zoneId || null, ip: ip || null, mac: mac || null, controlMethod,
        defaultSourceSlot: defaultSourceSlotRaw === '' ? null : Number(defaultSourceSlotRaw),
        wolEnabled, channelCapable, resetToken,
      },
    }));
    editingTvId = null;
    showTvMsg('TV updated.', 'success');
    await loadTvsAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showTvMsg(e.message, 'error');
  }
}

async function archiveTv(id) {
  try {
    await withStepUp(() => api(`/api/venue-control/tvs/${id}/archive`, { method: 'POST' }));
    showTvMsg('TV archived.', 'success');
    await loadTvsAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showTvMsg(e.message, 'error');
  }
}

async function restoreTv(id) {
  try {
    await withStepUp(() => api(`/api/venue-control/tvs/${id}/restore`, { method: 'POST' }));
    showTvMsg('TV restored.', 'success');
    await loadTvsAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showTvMsg(e.message, 'error');
  }
}

async function addTv() {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  const name = document.getElementById('newTvName').value.trim();
  const zoneId = document.getElementById('newTvZone').value;
  const ip = document.getElementById('newTvIp').value.trim();
  const mac = document.getElementById('newTvMac').value.trim();
  const controlMethod = document.getElementById('newTvControlMethod').value;
  const wolEnabled = document.getElementById('newTvWol').checked;
  if (!locationId) { showTvMsg('Turn Venue Control on for a location first.', 'error'); return; }
  if (!name) { showTvMsg('Name is required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/sites/${locationId}/tvs`, {
      method: 'POST',
      body: { name, zoneId: zoneId || null, ip: ip || null, mac: mac || null, controlMethod, wolEnabled },
    }));
    document.getElementById('newTvName').value = '';
    document.getElementById('newTvIp').value = '';
    document.getElementById('newTvMac').value = '';
    document.getElementById('newTvWol').checked = false;
    showTvMsg('TV added.', 'success');
    await loadTvsAdmin(locationId);
  } catch (e) {
    showTvMsg(e.message, 'error');
  }
}

function showSchedMsg(text, kind) {
  document.getElementById('schedMsg').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

// ---- Plain-language day/time schedule builder (A8) -- the day chips + time
// field are the primary UI; #newSchedCron (in the "Advanced" details) stays
// the actual field addSchedule() reads and the backend validates, so this
// only ever WRITES a valid 5-field cron string into it, never changes what
// gets sent.
function toggleSchedDay(btn) {
  btn.classList.toggle('active');
  updateSchedCronFromChips();
}

function updateSchedCronFromChips() {
  const days = Array.from(document.querySelectorAll('#newSchedDayChips .vc-day-chip.active')).map((b) => b.dataset.day);
  const dayField = days.length ? days.slice().sort().join(',') : '*';
  const time = document.getElementById('newSchedTime').value || '10:45';
  const [hh, mm] = time.split(':').map((n) => parseInt(n, 10) || 0);
  const cron = `${mm} ${hh} * * ${dayField}`;
  document.getElementById('newSchedCron').value = cron;
  document.getElementById('newSchedCronPreviewCode').textContent = cron;
}

// Best-effort reflect a hand-typed cron back into chips/time so flipping
// back to the simple view isn't jarring -- deliberately lossy for anything
// that isn't a plain "minute hour * * days" weekly schedule (a day-of-month,
// a step value, etc.); those are left exactly as typed, advanced-only.
function onSchedRawCronEdit() {
  const raw = document.getElementById('newSchedCron').value.trim();
  document.getElementById('newSchedCronPreviewCode').textContent = raw || '—';
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return;
  const [mm, hh, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') return;
  if (!/^\d{1,2}$/.test(mm) || !/^\d{1,2}$/.test(hh)) return;
  document.getElementById('newSchedTime').value = `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`;
  const activeDays = dow === '*' ? [] : dow.split(',');
  document.querySelectorAll('#newSchedDayChips .vc-day-chip').forEach((b) => {
    b.classList.toggle('active', activeDays.includes(b.dataset.day));
  });
}

function resetSchedForm() {
  document.getElementById('newSchedTime').value = '10:45';
  document.querySelectorAll('#newSchedDayChips .vc-day-chip').forEach((b) => b.classList.remove('active'));
  updateSchedCronFromChips();
}

function onSchedActionChange() {
  const action = document.getElementById('newSchedAction').value;
  document.getElementById('schedPayloadTvsPower').style.display = action === 'tvs_power' ? '' : 'none';
  document.getElementById('schedPayloadSourceTune').style.display = action === 'source_tune' ? '' : 'none';
  document.getElementById('schedPayloadSourceLaunch').style.display = action === 'source_launch' ? '' : 'none';
  document.getElementById('schedPayloadApplyLayout').style.display = action === 'apply_layout' ? '' : 'none';
}

async function loadSchedulesAdmin(locationId) {
  try {
    SCHEDULES_ADMIN = await api(`/api/venue-control/sites/${locationId}/schedules`);
    renderSchedulesList();
  } catch (e) {
    document.getElementById('schedulesList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function layoutName(layoutId) {
  const l = (LAYOUTS_ADMIN || []).find((ll) => String(ll.id) === String(layoutId));
  return l ? l.name : `layout #${layoutId}`;
}

function describeSchedulePayload(s) {
  if (s.action_type === 'tvs_power') return `${s.payload.state} · ${s.payload.zone_id ? zoneName(s.payload.zone_id) : 'all zones'}`;
  if (s.action_type === 'source_tune') return `slot ${s.payload.slot} &rarr; ${s.payload.major}${s.payload.minor != null ? '.' + s.payload.minor : ''}`;
  if (s.action_type === 'source_launch') return `slot ${s.payload.slot} &rarr; app ${escapeHtml(String(s.payload.app_id))}`;
  if (s.action_type === 'apply_layout') return s.payload.layout_id != null ? `apply "${escapeHtml(layoutName(s.payload.layout_id))}"` : 'no layout set';
  return s.action_type;
}

function renderSchedulesList() {
  const el = document.getElementById('schedulesList');
  if (!SCHEDULES_ADMIN.length) { el.innerHTML = '<p class="muted">No schedules yet.</p>'; return; }
  el.innerHTML = SCHEDULES_ADMIN.map((s) => `
      <div class="list-row">
        <div class="name">${escapeHtml(s.name)} <span class="badge ${s.enabled ? 'on' : 'off'}">${s.enabled ? 'enabled' : 'disabled'}</span>
          <div class="sub">${escapeHtml(s.cron_expr)} · ${escapeHtml(s.action_type)} · ${describeSchedulePayload(s)}</div>
          ${s.last_run_at ? `<div class="sub">last ran ${new Date(s.last_run_at).toLocaleString()}: ${escapeHtml(s.last_result || '')}</div>` : ''}
        </div>
        <div class="stack-actions" style="margin-top:0;">
          ${s.enabled
            ? `<button class="small ghost" onclick="toggleSchedule('${s.id}', false)">Disable</button>`
            : `<button class="small secondary" style="margin-top:0;" onclick="toggleSchedule('${s.id}', true)">Enable</button>`}
          <button class="small ghost" onclick="deleteSchedule('${s.id}')">Delete</button>
        </div>
      </div>`).join('');
}

async function toggleSchedule(id, enabled) {
  try {
    await withStepUp(() => api(`/api/venue-control/schedules/${id}/update`, { method: 'POST', body: { enabled } }));
    showSchedMsg(enabled ? 'Schedule enabled.' : 'Schedule disabled.', 'success');
    await loadSchedulesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showSchedMsg(e.message, 'error');
  }
}

async function deleteSchedule(id) {
  try {
    await withStepUp(() => api(`/api/venue-control/schedules/${id}/delete`, { method: 'POST' }));
    showSchedMsg('Schedule deleted.', 'success');
    await loadSchedulesAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showSchedMsg(e.message, 'error');
  }
}

async function addSchedule() {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  const name = document.getElementById('newSchedName').value.trim();
  const cronExpr = document.getElementById('newSchedCron').value.trim();
  const actionType = document.getElementById('newSchedAction').value;
  if (!locationId) { showSchedMsg('Turn Venue Control on for a location first.', 'error'); return; }
  if (!name || !cronExpr) { showSchedMsg('Name and cron expression are required.', 'error'); return; }
  let payload = {};
  if (actionType === 'tvs_power') {
    const zoneId = document.getElementById('newSchedTvZone').value;
    payload = { state: document.getElementById('newSchedTvState').value, zone_id: zoneId ? Number(zoneId) : null };
  } else if (actionType === 'source_tune') {
    const slot = Number(document.getElementById('newSchedSlot').value);
    const major = Number(document.getElementById('newSchedMajor').value);
    const minorRaw = document.getElementById('newSchedMinor').value;
    if (!slot || !major) { showSchedMsg('Slot and channel are required for source_tune.', 'error'); return; }
    payload = { slot, major, minor: minorRaw ? Number(minorRaw) : null };
  } else if (actionType === 'source_launch') {
    const slot = Number(document.getElementById('newSchedLaunchSlot').value);
    const appId = document.getElementById('newSchedAppId').value.trim();
    if (!slot || !appId) { showSchedMsg('Slot and app ID are required for source_launch.', 'error'); return; }
    payload = { slot, app_id: appId };
  } else if (actionType === 'apply_layout') {
    const layoutId = document.getElementById('newSchedLayout').value;
    if (!layoutId) { showSchedMsg('Add a layout first.', 'error'); return; }
    payload = { layout_id: Number(layoutId) };
  }
  try {
    await withStepUp(() => api(`/api/venue-control/sites/${locationId}/schedules`, {
      method: 'POST',
      body: { name, cronExpr, actionType, payload },
    }));
    document.getElementById('newSchedName').value = '';
    resetSchedForm();
    showSchedMsg('Schedule added.', 'success');
    await loadSchedulesAdmin(locationId);
  } catch (e) {
    showSchedMsg(e.message, 'error');
  }
}

// ---- Layouts admin (owner-only, Phase 5, docs/venue-control.md §12:
// "Whole-room presets with capture-current-state..."). This card manages
// layout shells only (name/description/order) and shows how many items
// each one currently has -- there's no "capture" button here on purpose.
// The cloud never has live device state (only the on-site agent polls
// DirecTV/Samsung directly), so capturing what a layout should actually
// contain happens on the agent's own admin page, at the bar, looking at
// the room. See server/index.js's Layouts section for the fuller version
// of this same reasoning.
let LAYOUTS_ADMIN = [];
let editingLayoutId = null;

function showLayoutMsg(text, kind) {
  document.getElementById('layoutMsg').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

async function loadLayoutsAdmin(locationId) {
  try {
    LAYOUTS_ADMIN = await api(`/api/venue-control/sites/${locationId}/layouts`);
    renderLayoutsList();
    populateLayoutSelect();
  } catch (e) {
    document.getElementById('layoutsList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function populateLayoutSelect() {
  const select = document.getElementById('newSchedLayout');
  if (!select) return;
  const prevValue = select.value;
  select.innerHTML = LAYOUTS_ADMIN.length
    ? LAYOUTS_ADMIN.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')
    : '<option value="">Add a layout first</option>';
  if (LAYOUTS_ADMIN.some((l) => String(l.id) === prevValue)) select.value = prevValue;
}

function describeLayoutItem(it) {
  if (it.target_type === 'source') return `source #${it.target_id}: ${it.action.op === 'tune' ? `tune ${it.action.major}${it.action.minor != null ? '.' + it.action.minor : ''}` : it.action.op}`;
  return `TV #${it.target_id}: ${it.action.op === 'power' ? `power ${it.action.state}` : it.action.op === 'select_slot' ? `source slot ${it.action.slot}` : it.action.op}`;
}

function renderLayoutsList() {
  const el = document.getElementById('layoutsList');
  if (!LAYOUTS_ADMIN.length) { el.innerHTML = '<p class="muted">No layouts yet.</p>'; return; }
  el.innerHTML = LAYOUTS_ADMIN.map((l) => {
    if (l.id === editingLayoutId) {
      return `
        <div class="list-row" style="flex-direction:column; align-items:stretch;">
          <input id="editLayoutName" value="${escapeHtml(l.name)}" placeholder="Name">
          <input id="editLayoutDesc" value="${escapeHtml(l.description || '')}" placeholder="Description (optional)" style="margin-top:8px;">
          <div class="stack-actions">
            <button class="ghost small" onclick="cancelEditLayout()">Cancel</button>
            <button class="primary small" style="margin-top:0;" onclick="saveEditLayout('${l.id}')">Save</button>
          </div>
        </div>`;
    }
    return `
      <div class="list-row">
        <div class="name">${escapeHtml(l.name)}
          <div class="sub">${l.description ? escapeHtml(l.description) + ' · ' : ''}${l.items.length} item${l.items.length === 1 ? '' : 's'}</div>
          ${l.items.length ? `<div class="sub">${l.items.map(describeLayoutItem).map(escapeHtml).join(' · ')}</div>` : '<div class="sub">Not captured yet -- see the agent\'s Admin page at the bar.</div>'}
        </div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="startEditLayout('${l.id}')">Edit</button>
          <button class="small ghost" onclick="deleteLayout('${l.id}')">Delete</button>
        </div>
      </div>`;
  }).join('');
}

function startEditLayout(id) { editingLayoutId = id; renderLayoutsList(); }
function cancelEditLayout() { editingLayoutId = null; renderLayoutsList(); }

async function saveEditLayout(id) {
  const name = document.getElementById('editLayoutName').value.trim();
  const description = document.getElementById('editLayoutDesc').value.trim();
  if (!name) { showLayoutMsg('Name is required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/layouts/${id}/update`, { method: 'POST', body: { name, description: description || null } }));
    editingLayoutId = null;
    showLayoutMsg('Layout updated.', 'success');
    await loadLayoutsAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showLayoutMsg(e.message, 'error');
  }
}

async function deleteLayout(id) {
  if (!confirm('Delete this layout? Any schedule set to apply it will stop working.')) return;
  try {
    await withStepUp(() => api(`/api/venue-control/layouts/${id}/delete`, { method: 'POST' }));
    showLayoutMsg('Layout deleted.', 'success');
    await loadLayoutsAdmin(document.getElementById('sourcesLocationSelect').value);
  } catch (e) {
    showLayoutMsg(e.message, 'error');
  }
}

async function addLayout() {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  const name = document.getElementById('newLayoutName').value.trim();
  const description = document.getElementById('newLayoutDesc').value.trim();
  if (!locationId) { showLayoutMsg('Turn Venue Control on for a location first.', 'error'); return; }
  if (!name) { showLayoutMsg('Name is required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/venue-control/sites/${locationId}/layouts`, { method: 'POST', body: { name, description: description || null } }));
    document.getElementById('newLayoutName').value = '';
    document.getElementById('newLayoutDesc').value = '';
    showLayoutMsg('Layout added -- capture its items from the agent\'s Admin page at the bar.', 'success');
    await loadLayoutsAdmin(locationId);
  } catch (e) {
    showLayoutMsg(e.message, 'error');
  }
}

// ---- Backups & restore admin (owner-only, Phase 5, docs/venue-control.md
// §6). Restore is the one genuinely destructive action on this whole page
// that isn't reversible via a simple "restore"/"undo" toggle the way
// archive is -- it gets a real confirm(), not the agent-side Layouts tab's
// 15s-undo-bar treatment (that pattern is for a staff member's quick tap,
// not a full-site data replace).
let BACKUPS_ADMIN = [];

function showBackupMsg(text, kind) {
  document.getElementById('backupMsg').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

async function loadBackupsAdmin(locationId) {
  try {
    BACKUPS_ADMIN = await api(`/api/venue-control/sites/${locationId}/backups`);
    renderBackupsList();
  } catch (e) {
    document.getElementById('backupsList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function itemCountsText(counts) {
  if (!counts) return '';
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
}

function renderBackupsList() {
  const el = document.getElementById('backupsList');
  if (!BACKUPS_ADMIN.length) { el.innerHTML = '<p class="muted">No backups yet.</p>'; return; }
  el.innerHTML = BACKUPS_ADMIN.map((b) => `
    <div class="list-row">
      <div class="name">${new Date(b.created_at).toLocaleString()} <span class="badge ${b.kind === 'manual' ? 'on' : 'off'}">${escapeHtml(b.kind)}</span>
        <div class="sub">${b.label ? escapeHtml(b.label) + ' · ' : ''}${escapeHtml(itemCountsText(b.item_counts))}${b.created_by ? ' · by ' + escapeHtml(b.created_by) : ''}</div>
      </div>
      <div class="stack-actions" style="margin-top:0;">
        <button class="small ghost" onclick="downloadBackup('${b.id}')">Download</button>
        <button class="small ghost" onclick="restoreBackupAdmin('${b.id}')">Restore</button>
      </div>
    </div>`).join('');
}

async function takeBackupAdmin() {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  if (!locationId) { showBackupMsg('Turn Venue Control on for a location first.', 'error'); return; }
  try {
    const { backup } = await withStepUp(() => api(`/api/venue-control/sites/${locationId}/backups`, { method: 'POST' }));
    showBackupMsg(`Backup #${backup.id} taken (${itemCountsText(backup.item_counts)}).`, 'success');
    await loadBackupsAdmin(locationId);
  } catch (e) {
    showBackupMsg(e.message, 'error');
  }
}

async function downloadBackup(id) {
  try {
    const backup = await api(`/api/venue-control/backups/${id}`);
    const blob = new Blob([JSON.stringify(backup.payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `venue-control-backup-${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    showBackupMsg(e.message, 'error');
  }
}

async function restoreBackupAdmin(id) {
  if (!confirm(`Restore backup #${id}? This replaces every zone, source, TV, favorite, layout, and schedule at this location with what's in that backup. A safety snapshot of the current state is taken automatically first, so this itself can be undone by restoring that snapshot.`)) return;
  const locationId = document.getElementById('sourcesLocationSelect').value;
  try {
    const result = await withStepUp(() => api(`/api/venue-control/sites/${locationId}/restore`, { method: 'POST', body: { backupId: id } }));
    showBackupMsg(`Restored (${itemCountsText(result.restored)}). Safety snapshot #${result.pre_restore_backup_id} was taken first.`, 'success');
    onSourcesLocationChange(); // everything on the page just changed under it
  } catch (e) {
    showBackupMsg(e.message, 'error');
  }
}

// ---- Device Health (A9, docs/venue-control-gui-reconciliation.md) --
// read-only: the on-site agent samples its own existing TV/receiver
// pollers once a minute and reports up through POST /api/venue/agent/
// health (agent/lib/health.js) -> server/monitoring.js's reportAvHealth(),
// landing in the same monitored_systems/system_status/system_alerts
// tables every other monitored category (network/hvac/refrigeration/etc)
// already uses. This panel just reads that back scoped to this location's
// 'av' category -- there's no separate AV monitoring store, per the A9
// spec's "data source is the platform's existing monitoring tables, not a
// new store." Problems first, each stating what it means for the room
// right now (there's no remote power-cycle path to the agent's LAN, so
// the "action" is always "go check it," not a button here).
let HEALTH_SYSTEMS = [];

async function loadHealthAdmin(locationId) {
  const el = document.getElementById('healthList');
  try {
    HEALTH_SYSTEMS = await api(`/api/monitoring/systems?locationId=${locationId}&category=av`);
    renderHealthList();
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// external_ref on a monitored_systems row is that row's vc_tvs.id / vc_sources.id
// (server/monitoring.js) -- joining back to SOURCES_ADMIN/TVS_ADMIN here gets a
// specific, per-device consequence (zone name, how many TVs default to a dead
// source) instead of one fixed sentence per kind, matching A9's "no answer for
// 11 minutes, 4 Back Room TVs are on it" without inventing data we don't have
// (there's no tracked "since" timestamp for when a device went bad, only when
// it was last polled, so this doesn't claim a duration A9 shows but we can't).
function healthConsequence(system) {
  if (system.kind === 'vc_tv') {
    const tv = TVS_ADMIN.find((t) => String(t.id) === String(system.external_ref));
    const zone = tv ? zoneName(tv.zone_id) : null;
    return `Won’t respond to power or channel commands until it’s back online — check its power and network connection at the TV${zone && zone !== 'Unassigned' ? ` (${escapeHtml(zone)})` : ''}.`;
  }
  const source = SOURCES_ADMIN.find((s) => String(s.id) === String(system.external_ref));
  const downstream = source ? TVS_ADMIN.filter((t) => t.enabled && t.default_source_slot === source.slot).length : 0;
  return `Its channel can’t be changed remotely until it’s back online — check power and network at the headend.${downstream ? ` ${downstream} TV${downstream === 1 ? '' : 's'} default${downstream === 1 ? 's' : ''} to this source.` : ''}`;
}

function healthBadgeClass(status) {
  if (status === 'online') return 'on';
  if (status === 'warning') return 'stale';
  return 'danger'; // offline / unknown
}

function renderHealthRow(s, isProblem) {
  const kindLabel = s.kind === 'vc_tv' ? 'TV' : 'Source';
  const statusText = s.last_status || 'unknown';
  const since = s.last_checked_at ? new Date(s.last_checked_at).toLocaleString() : '—';
  return `
    <div class="list-row">
      <div class="name">${escapeHtml(s.name)} <span class="badge off">${kindLabel}</span>
        <span class="badge ${healthBadgeClass(statusText)}">${escapeHtml(statusText)}</span>
      </div>
      <p class="muted" style="margin:4px 0 0;">${isProblem ? healthConsequence(s) + ' ' : ''}Last checked ${since}.</p>
    </div>`;
}

// Summary strip (A9): counts computed straight off HEALTH_SYSTEMS, no new
// endpoint. "Auto-fixed" from A9 isn't included -- there's no IP-moved/
// auto-repair event tracked anywhere in this data model, and fabricating a
// number for it would be worse than leaving it out.
function renderHealthStats() {
  const el = document.getElementById('healthStats');
  if (!el) return;
  if (!HEALTH_SYSTEMS.length) { el.innerHTML = ''; return; }
  const total = HEALTH_SYSTEMS.length;
  const healthy = HEALTH_SYSTEMS.filter((s) => !s.last_status || s.last_status === 'online').length;
  const warning = HEALTH_SYSTEMS.filter((s) => s.last_status === 'warning').length;
  const danger = HEALTH_SYSTEMS.filter((s) => s.last_status && s.last_status !== 'online' && s.last_status !== 'warning').length;
  const lastSweep = HEALTH_SYSTEMS.reduce((max, s) => {
    const t = s.last_checked_at ? new Date(s.last_checked_at).getTime() : 0;
    return t > max ? t : max;
  }, 0);
  const stats = [
    { num: total, lbl: 'devices managed', cls: '' },
    { num: healthy, lbl: 'healthy', cls: 'good' },
    { num: danger, lbl: 'not responding', cls: danger ? 'danger' : '' },
    { num: warning, lbl: 'need attention', cls: warning ? 'warn' : '' },
    { num: lastSweep ? new Date(lastSweep).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—', lbl: 'last contact sweep', cls: '' },
  ];
  el.innerHTML = stats.map((s) => `<div class="vc-health-stat ${s.cls}"><div class="num">${escapeHtml(String(s.num))}</div><div class="lbl">${escapeHtml(s.lbl)}</div></div>`).join('');
}

// Per-category bars (A9's "Everything else"): grouped by the real kind
// distinctions the data already carries (SOURCES_ADMIN.kind for DirecTV vs.
// Roku, all vc_tv rows lumped as "TVs" since this app doesn't track TV brand
// as its own field) -- a group with no devices at this location just doesn't
// render, rather than showing a fabricated 0-of-0 bar.
function renderHealthBreakdown() {
  const el = document.getElementById('healthBreakdown');
  if (!el) return;
  if (!HEALTH_SYSTEMS.length) { el.innerHTML = ''; return; }
  const sourceById = new Map(SOURCES_ADMIN.map((s) => [String(s.id), s]));
  const groups = [
    { name: 'DirecTV receivers', rows: HEALTH_SYSTEMS.filter((h) => h.kind === 'vc_source' && (sourceById.get(String(h.external_ref)) || {}).kind === 'directv') },
    { name: 'Rokus', rows: HEALTH_SYSTEMS.filter((h) => h.kind === 'vc_source' && (sourceById.get(String(h.external_ref)) || {}).kind === 'roku') },
    { name: 'TVs', rows: HEALTH_SYSTEMS.filter((h) => h.kind === 'vc_tv') },
  ].filter((g) => g.rows.length);
  el.innerHTML = groups.map((g) => {
    const ok = g.rows.filter((r) => !r.last_status || r.last_status === 'online').length;
    const down = g.rows.length - ok;
    const pct = Math.round((ok / g.rows.length) * 100);
    return `
      <div class="vc-hb-row">
        <div class="hb-name">${escapeHtml(g.name)}</div>
        <div class="vc-hb-track"><div class="vc-hb-fill${down ? ' has-down' : ''}" style="width:${pct}%"></div></div>
        <div class="vc-hb-count">${ok} of ${g.rows.length} ok${down ? ` · <span class="down">${down} down</span>` : ''}</div>
      </div>`;
  }).join('');
}

function renderHealthList() {
  const el = document.getElementById('healthList');
  renderHealthStats();
  renderHealthBreakdown();
  if (!HEALTH_SYSTEMS.length) {
    el.innerHTML = '<p class="muted">Nothing reported yet — the on-site agent starts reporting TV/receiver health about 20 seconds after it starts, then once a minute.</p>';
    return;
  }
  const problems = HEALTH_SYSTEMS.filter((s) => s.last_status && s.last_status !== 'online');
  const healthy = HEALTH_SYSTEMS.filter((s) => !s.last_status || s.last_status === 'online');

  el.innerHTML = `
    ${problems.length
      ? `<h3 style="font-size:13px;color:var(--danger);margin:0 0 6px;">Problems (${problems.length})</h3>${problems.map((s) => renderHealthRow(s, true)).join('')}`
      : '<p class="msg success">No problems reported.</p>'}
    ${healthy.length
      ? `<h3 style="font-size:13px;color:var(--muted);margin:16px 0 6px;">Healthy (${healthy.length})</h3>${healthy.map((s) => renderHealthRow(s, false)).join('')}`
      : ''}
  `;
}

// ---- Activity log (owner-only, Phase 5, docs/venue-control.md §11: "All
// destructive admin actions write to vc_activity with actor and origin.")
// Read-only -- there's nothing to manage here, just recent history.

// A10's own mockup writes the target by name ("DirecTV 10 -> NFL Net 212",
// "Sunday NFL"), not by id -- this resolves target_type/target_id against
// whichever admin array is already loaded for the tab. Falls back to the
// raw "#id" for anything archived/deleted out from under the log, or a
// target_type this lookup doesn't know about, rather than showing nothing.
function resolveActivityTarget(type, id) {
  if (!type) return '—';
  if (id == null) return escapeHtml(type);
  const lists = { source: SOURCES_ADMIN, tv: TVS_ADMIN, zone: ZONES_ADMIN, layout: LAYOUTS_ADMIN, favorite: FAVORITES_ADMIN, schedule: SCHEDULES_ADMIN };
  const list = lists[type];
  const row = list ? list.find((r) => String(r.id) === String(id)) : null;
  const label = row ? (row.name || row.label) : null;
  return label ? `${escapeHtml(type)}: ${escapeHtml(label)}` : `${escapeHtml(type)} #${escapeHtml(String(id))}`;
}

async function loadActivityAdmin(locationId) {
  const el = document.getElementById('activityList');
  try {
    const entries = await api(`/api/venue-control/sites/${locationId}/activity?limit=100`);
    if (!entries.length) { el.innerHTML = '<p class="muted">Nothing logged yet.</p>'; return; }
    el.innerHTML = `
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Origin</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
        <tbody>
          ${entries.map((a) => `
            <tr>
              <td>${new Date(a.ts).toLocaleString()}</td>
              <td>${escapeHtml(a.actor || '—')}</td>
              <td>${escapeHtml(a.origin)}</td>
              <td>${escapeHtml(a.action)}</td>
              <td>${resolveActivityTarget(a.target_type, a.target_id)}</td>
              <td>${a.result === 'ok' ? '<span class="badge on">ok</span>' : `<span class="badge off">${escapeHtml(a.result)}</span>`}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// ---- Discovery & Adopt (A1/A2/A4 of the design pack, Option B of the
// placement question in claude/venue-control-gui-reconciliation.md §4).
// The scan itself runs on the on-site box against its own LAN, triggered
// here by enqueuing a vc_agent_commands row rather than calling the agent
// directly -- there's no inbound path to do that (agent/lib/sync.js only
// ever calls out, every 30s). So this deliberately does NOT try to
// reproduce A1's live phase-by-phase ticker (Announce/Sweep/Interrogate/
// device-by-device streaming) -- that assumes a connection this transport
// doesn't have. Instead it polls command status honestly: queued (the box
// hasn't checked in yet) -> scanning -> done/error, with a running elapsed
// clock so a real wait doesn't look like a hang.
//
// Deliberately out of scope this round, same "disclose the cut, don't fake
// it" posture as Device Health's missing remedy buttons: A3's per-device
// SAFE/VISIBLE/DISRUPTIVE test panel (two of its three disruptive tests --
// power_cycle, set_channel -- have no real driver behind them yet either,
// per lib/discovery/index.js's own runOneTest), and A4's dedicated
// bulk-adopt screen with slot/QAM auto-fill sequencing. Adopting one device
// at a time via the inline form below covers the actual "find it, name it,
// it's in inventory" need Scotto asked for.
let DISCOVERY_RUN = null;
let DISCOVERY_DEVICES = [];
let DISCOVERY_COMMAND_ID = null;
let DISCOVERY_POLL_TIMER = null;
let DISCOVERY_POLL_STARTED_AT = null;
let DISCOVERY_ADOPT_OPEN_ID = null;

async function loadDiscoveryAdmin(locationId) {
  const el = document.getElementById('discoveryResults');
  try {
    const data = await api(`/api/venue-control/sites/${locationId}/discovery/runs/latest`);
    DISCOVERY_RUN = data.run;
    DISCOVERY_DEVICES = data.devices || [];
    renderDiscoveryResults();
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function startDiscoveryScan() {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  if (!locationId) return;
  const rangesRaw = (document.getElementById('discoveryRanges').value || '').trim();
  const ranges = rangesRaw ? rangesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const statusEl = document.getElementById('discoveryStatus');
  const btn = document.getElementById('discoveryScanBtn');
  btn.disabled = true;
  statusEl.innerHTML = '<p class="msg info">Queuing the scan…</p>';
  try {
    const res = await api(`/api/venue-control/sites/${locationId}/discovery/scan`, { method: 'POST', body: { ranges } });
    DISCOVERY_COMMAND_ID = res.commandId;
    DISCOVERY_POLL_STARTED_AT = Date.now();
    pollDiscoveryCommand(locationId);
  } catch (e) {
    statusEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
    btn.disabled = false;
  }
}

async function pollDiscoveryCommand(locationId) {
  if (DISCOVERY_POLL_TIMER) { clearTimeout(DISCOVERY_POLL_TIMER); DISCOVERY_POLL_TIMER = null; }
  const statusEl = document.getElementById('discoveryStatus');
  const btn = document.getElementById('discoveryScanBtn');
  const elapsed = Math.round((Date.now() - DISCOVERY_POLL_STARTED_AT) / 1000);
  try {
    const res = await api(`/api/venue-control/sites/${locationId}/discovery/commands/${DISCOVERY_COMMAND_ID}`);
    const cmd = res.command;
    if (cmd.status === 'pending') {
      statusEl.innerHTML = `<p class="msg info">Queued — waiting for the on-site box to check in (usually within 30 seconds)… ${elapsed}s</p>`;
    } else if (cmd.status === 'running') {
      statusEl.innerHTML = `<p class="msg info">Scanning the network now — this can take a minute or two on a full subnet… ${elapsed}s</p>`;
    } else if (cmd.status === 'done') {
      const r = cmd.result || {};
      statusEl.innerHTML = `<p class="msg success">Done — ${r.deviceCount != null ? r.deviceCount : '?'} device${r.deviceCount === 1 ? '' : 's'} found (${elapsed}s).</p>`;
      btn.disabled = false;
      await loadDiscoveryAdmin(locationId);
      return;
    } else if (cmd.status === 'error') {
      statusEl.innerHTML = `<p class="msg error">${escapeHtml(cmd.error || 'The scan failed.')}</p>`;
      btn.disabled = false;
      return;
    }
  } catch (e) {
    statusEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
    btn.disabled = false;
    return;
  }
  DISCOVERY_POLL_TIMER = setTimeout(() => pollDiscoveryCommand(locationId), 3000);
}

const DISCOVERY_KIND_LABEL = {
  directv_receiver: 'DirecTV receivers', samsung_tv: 'Samsung TVs',
  samsung_tv_legacy: 'Samsung TVs (legacy)', roku: 'Rokus', unknown: 'Other',
};
const DISCOVERY_ADOPT_AS = {
  directv_receiver: 'source', roku: 'source', samsung_tv: 'tv', samsung_tv_legacy: 'tv',
};

function discoveryDeviceLabel(d) {
  const identity = d.identity || {};
  return identity.model || identity.friendlyName || d.oui_vendor || (d.mac ? `by MAC ${d.mac}` : 'unidentified device');
}

function discoveryControlBadges(d) {
  const methods = Array.isArray(d.control_methods) ? d.control_methods : [];
  if (!methods.length) return '<span class="badge off">no known control method</span>';
  return methods.map((m) => {
    const cls = m.status === 'available' ? (m.needs_pairing ? 'stale' : 'on') : 'off';
    const label = m.needs_pairing ? `${m.method} (needs pairing)` : m.method;
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  }).join(' ');
}

function renderDiscoveryResults() {
  const el = document.getElementById('discoveryResults');
  const summaryEl = document.getElementById('discoverySummary');
  if (!DISCOVERY_RUN) {
    summaryEl.innerHTML = '';
    el.innerHTML = '<p class="muted">No scan has been run yet for this location. Enter the network range above (or leave it blank to use the site\'s configured range) and scan.</p>';
    return;
  }
  const scannedAt = new Date(DISCOVERY_RUN.started_at).toLocaleString();
  const secs = DISCOVERY_RUN.finished_at
    ? Math.max(0, Math.round((new Date(DISCOVERY_RUN.finished_at) - new Date(DISCOVERY_RUN.started_at)) / 1000))
    : null;
  summaryEl.innerHTML = `<p class="muted" style="margin:0 0 12px;">${(DISCOVERY_RUN.ranges || []).join(', ') || 'default range'} · scanned ${scannedAt}${secs != null ? ` · ${secs}s` : ''} · ${DISCOVERY_DEVICES.length} device${DISCOVERY_DEVICES.length === 1 ? '' : 's'} found</p>`;

  if (!DISCOVERY_DEVICES.length) {
    el.innerHTML = '<p class="muted">No devices answered on that range.</p>';
    return;
  }

  const groups = {};
  DISCOVERY_DEVICES.forEach((d) => {
    const key = d.classified_as || 'unknown';
    (groups[key] = groups[key] || []).push(d);
  });
  const order = ['directv_receiver', 'roku', 'samsung_tv', 'samsung_tv_legacy', 'unknown'];

  el.innerHTML = order.filter((k) => groups[k] && groups[k].length).map((k) => `
    <h3 style="font-size:13px;color:var(--muted);margin:16px 0 6px;">${escapeHtml(DISCOVERY_KIND_LABEL[k] || k)} — ${groups[k].length}</h3>
    ${groups[k].map((d) => renderDiscoveryRow(d)).join('')}
  `).join('');
}

function renderDiscoveryRow(d) {
  const adoptAs = DISCOVERY_ADOPT_AS[d.classified_as];
  const alreadyAdopted = !!d.adopted_type;
  const formOpen = DISCOVERY_ADOPT_OPEN_ID === d.id;
  // .list-row is a one-line flex row by default (name | badges | actions side
  // by side) -- fine with three short children, but the adopt form below is
  // a tall block that needs to stack underneath instead of squeezing into
  // that same row. Same "switch to column layout while expanded" technique
  // renderZonesList() already uses for its own inline edit form.
  return `
    <div class="list-row"${formOpen ? ' style="flex-direction:column; align-items:stretch;"' : ''}>
      <div class="name">${escapeHtml(d.ip)} <span class="badge off">${escapeHtml(discoveryDeviceLabel(d))}</span>
        ${alreadyAdopted ? `<span class="badge on">adopted as ${escapeHtml(d.adopted_type)}</span>` : ''}
      </div>
      <p class="muted" style="margin:4px 0;">${discoveryControlBadges(d)}</p>
      ${!alreadyAdopted && adoptAs
        ? `<div class="stack-actions" style="margin-top:0;">
             <button class="small ${formOpen ? 'ghost' : 'secondary'}" style="margin-top:0;" onclick="toggleDiscoveryAdoptForm(${d.id})">${formOpen ? 'Cancel' : 'Adopt'}</button>
           </div>`
        : (!alreadyAdopted ? '<p class="muted" style="margin:2px 0 0;font-size:12px;">Not controllable — no matching driver for this device.</p>' : '')}
      ${formOpen ? renderDiscoveryAdoptForm(d, adoptAs) : ''}
    </div>`;
}

function toggleDiscoveryAdoptForm(deviceId) {
  DISCOVERY_ADOPT_OPEN_ID = DISCOVERY_ADOPT_OPEN_ID === deviceId ? null : deviceId;
  renderDiscoveryResults();
}

function renderDiscoveryAdoptForm(d, adoptAs) {
  if (adoptAs === 'tv') {
    const method = (d.control_methods || []).find((m) => m.status === 'available');
    const zoneOptions = ZONES_ADMIN.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join('');
    return `
      <div class="card" style="margin:8px 0 4px;background:rgba(255,255,255,0.03);">
        <label>Name</label>
        <input id="discAdoptName_${d.id}" value="${escapeHtml((d.identity || {}).friendlyName || '')}" placeholder="e.g. Main Bar 3">
        <label>Tag shown on the chip</label>
        <input id="discAdoptTag_${d.id}" placeholder="e.g. MB3">
        <label>Zone</label>
        <select id="discAdoptZone_${d.id}"><option value="">Unassigned</option>${zoneOptions}</select>
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px;">
          <input type="checkbox" id="discAdoptWol_${d.id}" style="width:auto;" ${d.mac ? 'checked' : 'disabled'}> Wake-on-LAN enabled
        </label>
        <p class="muted" style="margin:8px 0 0;font-size:12px;">Control method: ${escapeHtml(method ? method.method : 'unknown')} (from the scan).</p>
        <div class="stack-actions">
          <button class="small" onclick="submitDiscoveryAdopt(${d.id}, 'tv')">Adopt this TV</button>
        </div>
      </div>`;
  }
  return `
    <div class="card" style="margin:8px 0 4px;background:rgba(255,255,255,0.03);">
      <label>Label</label>
      <input id="discAdoptLabel_${d.id}" value="${escapeHtml(discoveryDeviceLabel(d))}" placeholder="e.g. DirecTV 14">
      <label>Slot</label>
      <input id="discAdoptSlot_${d.id}" type="number" placeholder="e.g. 14">
      <label>QAM channel</label>
      <input id="discAdoptQam_${d.id}" placeholder="e.g. 14.1">
      <div class="stack-actions">
        <button class="small" onclick="submitDiscoveryAdopt(${d.id}, 'source')">Adopt this source</button>
      </div>
    </div>`;
}

async function submitDiscoveryAdopt(deviceId, as) {
  const locationId = document.getElementById('sourcesLocationSelect').value;
  const d = DISCOVERY_DEVICES.find((x) => x.id === deviceId);
  let fields;
  if (as === 'tv') {
    const method = (d.control_methods || []).find((m) => m.status === 'available');
    fields = {
      name: document.getElementById(`discAdoptName_${deviceId}`).value.trim() || undefined,
      tag: document.getElementById(`discAdoptTag_${deviceId}`).value.trim() || undefined,
      zoneId: document.getElementById(`discAdoptZone_${deviceId}`).value || undefined,
      wolEnabled: document.getElementById(`discAdoptWol_${deviceId}`).checked,
      controlMethod: method ? method.method : undefined,
      ip: d.ip, mac: d.mac,
    };
  } else {
    fields = {
      label: document.getElementById(`discAdoptLabel_${deviceId}`).value.trim() || undefined,
      slot: Number(document.getElementById(`discAdoptSlot_${deviceId}`).value) || undefined,
      qamChannel: document.getElementById(`discAdoptQam_${deviceId}`).value.trim() || undefined,
      kind: d.classified_as === 'roku' ? 'roku' : 'directv',
      ip: d.ip, mac: d.mac,
    };
  }
  try {
    await api(`/api/venue-control/sites/${locationId}/discovery/adopt`, { method: 'POST', body: { discoveryDeviceId: deviceId, as, ...fields } });
    DISCOVERY_ADOPT_OPEN_ID = null;
    await loadDiscoveryAdmin(locationId);
    // Adopting writes straight to vc_tvs/vc_sources, so the tabs that list
    // them need a refresh too -- same "adoption shows up immediately"
    // promise A4's own mockup makes.
    loadSourcesAdmin(locationId);
    const zonesP = loadZonesAdmin(locationId);
    const tvsP = loadTvsAdmin(locationId);
    Promise.all([zonesP, tvsP]).then(() => { renderZonesList(); renderTvZoneChips(); renderTvsList(); });
  } catch (e) {
    document.getElementById('discoveryStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
