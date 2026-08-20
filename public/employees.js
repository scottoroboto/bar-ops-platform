let ME = null;
let LOCATIONS = [];
let POSITIONS = [];

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

function locationName(id) {
  const l = LOCATIONS.find(l => l.id === id);
  return l ? l.name : '—';
}

function fillLocationSelect(sel) {
  sel.innerHTML = LOCATIONS.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
}

// Review can set any position, management included (a manager/owner might
// review someone straight into an Assistant Manager slot). If the record's
// current position isn't in the active list — e.g. it's since been
// archived — keep it selectable instead of silently dropping it.
function fillPositionSelect(sel, currentValue) {
  const known = POSITIONS.some(p => p.name === currentValue);
  const extra = (currentValue && !known) ? `<option value="${escapeHtml(currentValue)}">${escapeHtml(currentValue)} (archived)</option>` : '';
  sel.innerHTML = '<option value="">— none —</option>' + extra +
    POSITIONS.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}${p.is_management ? ' (management)' : ''}</option>`).join('');
  sel.value = currentValue || '';
}

async function loadPending() {
  const list = await api('/api/employees/pending');
  const el = document.getElementById('pendingList');
  if (!list.length) { el.innerHTML = '<p class="muted">Nothing pending right now.</p>'; return; }
  el.innerHTML = list.map(p => `
    <div class="list-row">
      <div>
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="sub">${escapeHtml(p.email || p.phone || 'no contact on file')} · ${p.position ? escapeHtml(p.position) + ' · ' : ''}${p.location_id ? escapeHtml(locationName(p.location_id)) : 'no location yet'}</div>
      </div>
      <div class="stack-actions" style="margin-top:0;">
        <button class="small ghost" onclick="openReviewModal('${p.id}', '${escapeHtml(p.name)}', '${p.position || ''}', '${p.location_id || ''}', '${p.pay_rate || ''}')">Review</button>
        ${ME.role === 'owner' ? `<button class="small primary" style="margin-top:0;" onclick="openActivateModal('${p.id}', '${escapeHtml(p.name)}')">Activate</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function loadAllEmployees() {
  if (ME.role !== 'owner') return;
  document.getElementById('allEmployeesCard').style.display = '';
  const list = await api('/api/employees');
  const el = document.getElementById('employeeList');
  if (!list.length) { el.innerHTML = '<p class="muted">No active employees yet.</p>'; return; }
  el.innerHTML = list.map(p => `
    <div class="list-row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between;">
        <div>
          <div class="name">${escapeHtml(p.name)} <span class="badge ${p.status === 'active' ? 'on' : 'off'}">${escapeHtml(p.status)}</span></div>
          <div class="sub">${escapeHtml(p.role)} · ${escapeHtml(p.position || '—')} · ${escapeHtml(locationName(p.location_id))}${p.pay_rate ? ' · $' + p.pay_rate + '/hr' : ''}</div>
        </div>
      </div>
      <div style="margin-top:8px; display:flex; gap:18px; flex-wrap:wrap;">
        ${appToggleHtml(p, 'time_clock', 'Time Clock')}
        ${appToggleHtml(p, 'service_calls', 'Service Calls')}
        ${appToggleHtml(p, 'scheduling', 'Scheduling')}
      </div>
    </div>
  `).join('');
}

function appToggleHtml(person, key, label) {
  const on = !!(person.appAccess && person.appAccess[key]);
  return `<label class="toggle-row" style="gap:8px;"><span class="label">${label}</span>
    <span class="switch"><input type="checkbox" ${on ? 'checked' : ''} onchange="toggleAccess('${person.id}','${key}',this.checked)"><span class="slider"></span></span>
  </label>`;
}

async function toggleAccess(personId, appKey, enabled) {
  try {
    await withStepUp(() => api(`/api/employees/${personId}/app-access`, { method: 'POST', body: { appKey, enabled } }));
    showMsg(`Updated ${appKey.replace('_', ' ')} access.`, 'success');
  } catch (e) {
    showMsg(e.message, 'error');
    loadAllEmployees();
  }
}

// ---- Review modal ----
function openReviewModal(id, name, position, locationId, payRate) {
  document.getElementById('reviewPersonId').value = id;
  document.getElementById('reviewName').value = name;
  fillPositionSelect(document.getElementById('reviewPosition'), position || '');
  fillLocationSelect(document.getElementById('reviewLocation'));
  if (locationId) document.getElementById('reviewLocation').value = locationId;
  document.getElementById('reviewPayRate').value = payRate || '';
  document.getElementById('reviewModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closeReviewModal() {
  document.getElementById('reviewModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
async function submitReview() {
  const id = document.getElementById('reviewPersonId').value;
  const position = document.getElementById('reviewPosition').value.trim();
  const locationId = document.getElementById('reviewLocation').value;
  const payRate = document.getElementById('reviewPayRate').value;
  try {
    await withStepUp(() => api(`/api/employees/${id}/manager-review`, {
      method: 'POST', body: { position, locationId, payRate: payRate ? Number(payRate) : null },
    }));
    closeReviewModal();
    showMsg('Review saved.', 'success');
    await loadPending();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---- Activate modal ----
function openActivateModal(id, name) {
  document.getElementById('activatePersonId').value = id;
  document.getElementById('activateName').textContent = name;
  document.getElementById('accessTimeClock').checked = true;
  document.getElementById('accessServiceCalls').checked = false;
  document.getElementById('accessScheduling').checked = false;
  document.getElementById('activateResult').innerHTML = '';
  document.getElementById('activateModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closeActivateModal() {
  document.getElementById('activateModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
async function submitActivate() {
  const id = document.getElementById('activatePersonId').value;
  const appAccess = {
    time_clock: document.getElementById('accessTimeClock').checked,
    service_calls: document.getElementById('accessServiceCalls').checked,
    scheduling: document.getElementById('accessScheduling').checked,
  };
  try {
    const result = await withStepUp(() => api(`/api/employees/${id}/activate`, { method: 'POST', body: { appAccess } }));
    if (!result.ok) { document.getElementById('activateResult').innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    let box = `<div class="msg success">Activated — they're live.</div>`;
    if (result.tempPassword) {
      box += `<div class="credential-box">
        <b>Username:</b> ${escapeHtml(result.username)}<br>
        <b>Temp password:</b> ${escapeHtml(result.tempPassword)}<br>
        <b>PIN:</b> ${escapeHtml(result.pin)}<br>
        <span class="muted">Already emailed to them if they have an email on file. They'll verify with a one-time code the first time they sign in.</span>
      </div>`;
    }
    document.getElementById('activateResult').innerHTML = box;
    await loadPending();
    await loadAllEmployees();
  } catch (e) {
    document.getElementById('activateResult').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function closeAllModals() { closeReviewModal(); closeActivateModal(); }

// ---- Positions admin (manager + owner can add; delete is really "archive") ----
let POSITIONS_ADMIN = [];
let editingPositionId = null;

async function loadPositionsAdmin() {
  if (ME.role !== 'manager' && ME.role !== 'owner') return;
  document.getElementById('positionsCard').style.display = '';
  try {
    POSITIONS_ADMIN = await api('/api/positions/admin');
    // Also feeds fillPositionSelect() (the Review employee dropdown) — no
    // separate fetch needed, just the active subset of what we just got.
    POSITIONS = POSITIONS_ADMIN.filter(p => p.active);
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
  POSITIONS = await api('/api/positions');
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
  LOCATIONS = await api('/api/locations');
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

// ---- Shared device trust ----
async function trustThisDevice() {
  const label = document.getElementById('deviceLabel').value.trim() || 'Shared device';
  const locationId = document.getElementById('deviceLocation').value;
  try {
    const result = await withStepUp(() => api('/api/devices', { method: 'POST', body: { label, locationId } }));
    setDeviceToken(result.deviceToken);
    document.getElementById('deviceResult').innerHTML =
      `<p class="msg success">This browser is now a trusted device for ${escapeHtml(locationName(locationId))}. Staff can sign in here with just their username + PIN.</p>`;
  } catch (e) {
    document.getElementById('deviceResult').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

(async function init() {
  ME = requireRole(['manager', 'owner']);
  if (!ME) return;
  renderTopbar('Employees');
  if (ME.role !== 'owner') document.getElementById('ownerOnlyNotice').style.display = '';
  try {
    LOCATIONS = await api('/api/locations');
    fillLocationSelect(document.getElementById('deviceLocation'));
    await loadPending();
    await loadAllEmployees();
    await loadLocationsAdmin();
  } catch (e) {
    showMsg(e.message, 'error');
  }
  // Positions is a newer, separate table — loadPositionsAdmin() has its own
  // try/catch and shows its card regardless, so if this table hasn't been
  // migrated in yet, the rest of the page above still works normally.
  await loadPositionsAdmin();
})();
