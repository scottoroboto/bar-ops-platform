let ME = null;

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

// ---- Positions admin (manager + owner can add; delete is really "archive") ----
let POSITIONS_ADMIN = [];
let editingPositionId = null;

async function loadPositionsAdmin() {
  if (ME.role !== 'manager' && ME.role !== 'owner') return;
  document.getElementById('positionsCard').style.display = '';
  try {
    POSITIONS_ADMIN = await api('/api/positions/admin');
    renderPositionsList();
  } catch (e) {
    document.getElementById('positionsList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function renderPositionsList() {
  const el = document.getElementById('positionsList');
  if (!POSITIONS_ADMIN.length) { el.innerHTML = '<p class="muted">No positions yet.</p>'; return; }
  el.innerHTML = POSITIONS_ADMIN.map(p => {
    if (p.id === editingPositionId) {
      return `
        <div class="list-row" style="flex-direction:column; align-items:stretch;">
          <input id="editPositionName" value="${escapeHtml(p.name)}">
          <label class="toggle-row" style="gap:8px;"><span class="label">Management position</span>
            <span class="switch"><input type="checkbox" id="editPositionManagement" ${p.is_management ? 'checked' : ''}><span class="slider"></span></span>
          </label>
          <div class="stack-actions">
            <button class="ghost small" onclick="cancelEditPosition()">Cancel</button>
            <button class="primary small" style="margin-top:0;" onclick="saveEditPosition('${p.id}')">Save</button>
          </div>
        </div>`;
    }
    return `
      <div class="list-row">
        <div class="name">${escapeHtml(p.name)} ${p.is_management ? '<span class="badge off">management</span>' : ''} <span class="badge ${p.active ? 'on' : 'off'}">${p.active ? 'active' : 'archived'}</span></div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="startEditPosition('${p.id}')">Edit</button>
          ${p.active
            ? `<button class="small ghost" onclick="archivePosition('${p.id}')">Archive</button>`
            : `<button class="small secondary" style="margin-top:0;" onclick="restorePosition('${p.id}')">Restore</button>`}
        </div>
      </div>`;
  }).join('');
}

function startEditPosition(id) { editingPositionId = id; renderPositionsList(); }
function cancelEditPosition() { editingPositionId = null; renderPositionsList(); }

async function refreshPositions() {
  await loadPositionsAdmin();
}

async function saveEditPosition(id) {
  const name = document.getElementById('editPositionName').value.trim();
  const isManagement = document.getElementById('editPositionManagement').checked;
  if (!name) { showMsg('Position name is required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/positions/${id}/update`, { method: 'POST', body: { name, isManagement } }));
    editingPositionId = null;
    showMsg('Position updated.', 'success');
    await refreshPositions();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function archivePosition(id) {
  try {
    await withStepUp(() => api(`/api/positions/${id}/archive`, { method: 'POST' }));
    showMsg('Position archived.', 'success');
    await refreshPositions();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function restorePosition(id) {
  try {
    await withStepUp(() => api(`/api/positions/${id}/restore`, { method: 'POST' }));
    showMsg('Position restored.', 'success');
    await refreshPositions();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function addPosition() {
  const name = document.getElementById('newPositionName').value.trim();
  const isManagement = document.getElementById('newPositionManagement').checked;
  if (!name) { showMsg('Position name is required.', 'error'); return; }
  try {
    await withStepUp(() => api('/api/positions', { method: 'POST', body: { name, isManagement } }));
    document.getElementById('newPositionName').value = '';
    document.getElementById('newPositionManagement').checked = false;
    showMsg('Position added.', 'success');
    await refreshPositions();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---- Locations admin (owner only) ----
let LOCATIONS_ADMIN = [];
let editingLocationId = null;

async function loadLocationsAdmin() {
  if (ME.role !== 'owner') return;
  document.getElementById('locationsCard').style.display = '';
  try {
    LOCATIONS_ADMIN = await api('/api/locations/admin');
    renderLocationsList();
  } catch (e) {
    document.getElementById('locationsList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function renderLocationsList() {
  const el = document.getElementById('locationsList');
  if (!LOCATIONS_ADMIN.length) { el.innerHTML = '<p class="muted">No locations yet.</p>'; return; }
  el.innerHTML = LOCATIONS_ADMIN.map(l => {
    if (l.id === editingLocationId) {
      return `
        <div class="list-row" style="flex-direction:column; align-items:stretch;">
          <input id="editLocationName" value="${escapeHtml(l.name)}">
          <div class="stack-actions">
            <button class="ghost small" onclick="cancelEditLocation()">Cancel</button>
            <button class="primary small" style="margin-top:0;" onclick="saveEditLocation('${l.id}')">Save</button>
          </div>
        </div>`;
    }
    return `
      <div class="list-row">
        <div class="name">${escapeHtml(l.name)} <span class="badge ${l.active ? 'on' : 'off'}">${l.active ? 'active' : 'archived'}</span></div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="startEditLocation('${l.id}')">Edit</button>
          ${l.active
            ? `<button class="small ghost" onclick="archiveLocation('${l.id}')">Archive</button>`
            : `<button class="small secondary" style="margin-top:0;" onclick="restoreLocation('${l.id}')">Restore</button>`}
        </div>
      </div>`;
  }).join('');
}

function startEditLocation(id) { editingLocationId = id; renderLocationsList(); }
function cancelEditLocation() { editingLocationId = null; renderLocationsList(); }

async function refreshLocations() {
  await loadLocationsAdmin();
}

async function saveEditLocation(id) {
  const name = document.getElementById('editLocationName').value.trim();
  if (!name) { showMsg('Location name is required.', 'error'); return; }
  try {
    await withStepUp(() => api(`/api/locations/${id}/update`, { method: 'POST', body: { name } }));
    editingLocationId = null;
    showMsg('Location updated.', 'success');
    await refreshLocations();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function archiveLocation(id) {
  try {
    await withStepUp(() => api(`/api/locations/${id}/archive`, { method: 'POST' }));
    showMsg('Location archived.', 'success');
    await refreshLocations();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function restoreLocation(id) {
  try {
    await withStepUp(() => api(`/api/locations/${id}/restore`, { method: 'POST' }));
    showMsg('Location restored.', 'success');
    await refreshLocations();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function addLocation() {
  const name = document.getElementById('newLocationName').value.trim();
  if (!name) { showMsg('Location name is required.', 'error'); return; }
  try {
    await withStepUp(() => api('/api/locations', { method: 'POST', body: { name } }));
    document.getElementById('newLocationName').value = '';
    showMsg('Location added.', 'success');
    await refreshLocations();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

(async function init() {
  ME = requireRole(['manager', 'owner']);
  if (!ME) return;
  renderTopbar('Positions');
  if (ME.role !== 'owner') document.getElementById('managerNotice').style.display = '';
  await loadPositionsAdmin();
  await loadLocationsAdmin();
})();
