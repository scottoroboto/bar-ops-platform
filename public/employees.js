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

let PENDING_LIST = [];
let discardConfirmId = null;

async function loadPending() {
  PENDING_LIST = await api('/api/employees/pending');
  renderPendingList();
}

function renderPendingList() {
  const el = document.getElementById('pendingList');
  if (!PENDING_LIST.length) { el.innerHTML = '<p class="muted">Nothing pending right now.</p>'; return; }
  el.innerHTML = PENDING_LIST.map(p => `
    <div class="list-row">
      <div>
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="sub">${escapeHtml(p.email || p.phone || 'no contact on file')} · ${p.position ? escapeHtml(p.position) + ' · ' : ''}${p.location_id ? escapeHtml(locationName(p.location_id)) : 'no location yet'}</div>
      </div>
      <div class="stack-actions" style="margin-top:0;">
        ${p.id === discardConfirmId ? `
          <span class="muted" style="align-self:center;">Discard this applicant?</span>
          <button class="small ghost" onclick="cancelDiscardPending()">Cancel</button>
          <button class="small danger" style="margin-top:0;" onclick="confirmDiscardPending('${p.id}')">Yes, discard</button>
        ` : `
          <button class="small ghost" onclick="startDiscardPending('${p.id}')">Discard</button>
          <button class="small ghost" onclick="openReviewModal('${p.id}', '${escapeHtml(p.name)}', '${p.position || ''}', '${p.location_id || ''}', '${p.pay_rate || ''}')">Review</button>
          ${ME.role === 'owner' ? `<button class="small primary" style="margin-top:0;" onclick="openActivateModal('${p.id}', '${escapeHtml(p.name)}')">Activate</button>` : ''}
        `}
      </div>
    </div>
  `).join('');
}

function startDiscardPending(id) { discardConfirmId = id; renderPendingList(); }
function cancelDiscardPending() { discardConfirmId = null; renderPendingList(); }

async function confirmDiscardPending(id) {
  try {
    await withStepUp(() => api(`/api/employees/${id}/discard`, { method: 'POST' }));
    discardConfirmId = null;
    showMsg('Applicant discarded.', 'success');
    await loadPending();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function sendOnboardingInvite() {
  const name = document.getElementById('inviteName').value.trim();
  const email = document.getElementById('inviteEmail').value.trim();
  const resultEl = document.getElementById('inviteResult');
  if (!email) { resultEl.innerHTML = '<p class="msg error">Enter an email address.</p>'; return; }
  try {
    const result = await withStepUp(() => api('/api/employees/invite', { method: 'POST', body: { name, email } }));
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error || 'Could not send invite.')}</p>`; return; }
    resultEl.innerHTML = `<p class="msg success">Onboarding link sent to ${escapeHtml(email)}.</p>`;
    document.getElementById('inviteName').value = '';
    document.getElementById('inviteEmail').value = '';
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// Owner sees every location and can click through to a full edit. Manager
// sees only their own location (server-enforced, not just hidden client-
// side) and can request a raise instead of editing pay directly.
let ALL_EMPLOYEES = [];

async function loadAllEmployees() {
  if (ME.role !== 'owner' && ME.role !== 'manager') return;
  document.getElementById('allEmployeesCard').style.display = '';
  document.getElementById('allEmployeesHint').textContent = ME.role === 'owner'
    ? 'Click a name to edit their position, location, or pay rate. Toggle which apps each person can use — this can be changed any time, not just at onboarding.'
    : "Your location's roster. Request a pay raise and the owner will review it.";
  ALL_EMPLOYEES = await api('/api/employees');
  renderAllEmployees();
}

function renderAllEmployees() {
  const el = document.getElementById('employeeList');
  if (!ALL_EMPLOYEES.length) { el.innerHTML = '<p class="muted">No active employees yet.</p>'; return; }
  el.innerHTML = ALL_EMPLOYEES.map(p => `
    <div class="list-row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between;">
        <div${ME.role === 'owner' ? ` class="clickable" onclick="openEmployeeDetail('${p.id}')" style="cursor:pointer;"` : ''}>
          <div class="name">${escapeHtml(p.name)} <span class="badge ${p.status === 'active' ? 'on' : 'off'}">${escapeHtml(p.status)}</span></div>
          <div class="sub">${escapeHtml(p.role)} · ${escapeHtml(p.position || '—')} · ${escapeHtml(locationName(p.location_id))}${p.pay_rate ? ' · $' + p.pay_rate + '/hr' : ''}</div>
        </div>
        ${ME.role === 'manager' ? `<button class="small ghost" style="margin-top:0;" onclick="openRequestRaiseModal('${p.id}')">Request raise</button>` : ''}
      </div>
      ${ME.role === 'owner' ? `
      <div style="margin-top:8px; display:flex; gap:18px; flex-wrap:wrap;">
        ${appToggleHtml(p, 'time_clock', 'Time Clock')}
        ${appToggleHtml(p, 'service_calls', 'Service Calls')}
        ${appToggleHtml(p, 'scheduling', 'Scheduling')}
        ${appToggleHtml(p, 'monitoring', 'Systems Monitoring')}
      </div>` : ''}
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
  document.getElementById('accessMonitoring').checked = false;
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
    monitoring: document.getElementById('accessMonitoring').checked,
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

// ---- Employee detail / edit modal (owner only) ----
function openEmployeeDetail(id) {
  const p = ALL_EMPLOYEES.find(p => p.id === id);
  if (!p) return;
  document.getElementById('detailPersonId').value = p.id;
  document.getElementById('detailName').textContent = p.name;
  document.getElementById('detailMeta').textContent = `${p.role} · ${p.status}${p.username ? ' · @' + p.username : ''}`;
  fillPositionSelect(document.getElementById('detailPosition'), p.position || '');
  fillLocationSelect(document.getElementById('detailLocation'));
  if (p.location_id) document.getElementById('detailLocation').value = p.location_id;
  document.getElementById('detailPayRate').value = p.pay_rate || '';
  document.getElementById('detailResult').innerHTML = '';
  document.getElementById('employeeDetailModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closeEmployeeDetail() {
  document.getElementById('employeeDetailModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
async function saveEmployeeDetail() {
  const id = document.getElementById('detailPersonId').value;
  const position = document.getElementById('detailPosition').value.trim();
  const locationId = document.getElementById('detailLocation').value;
  const payRate = document.getElementById('detailPayRate').value;
  const resultEl = document.getElementById('detailResult');
  try {
    const result = await withStepUp(() => api(`/api/employees/${id}/update`, {
      method: 'POST', body: { position, locationId, payRate: payRate ? Number(payRate) : null },
    }));
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    closeEmployeeDetail();
    showMsg('Employee updated.', 'success');
    await loadAllEmployees();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// ---- Request pay raise modal (manager) ----
function openRequestRaiseModal(id) {
  const p = ALL_EMPLOYEES.find(p => p.id === id);
  if (!p) return;
  document.getElementById('raisePersonId').value = p.id;
  document.getElementById('raiseName').textContent = p.name;
  document.getElementById('raiseCurrentRate').textContent = `Current rate: ${p.pay_rate ? '$' + p.pay_rate + '/hr' : 'not set'}`;
  document.getElementById('raiseRequestedRate').value = '';
  document.getElementById('raiseResult').innerHTML = '';
  document.getElementById('requestRaiseModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closeRequestRaiseModal() {
  document.getElementById('requestRaiseModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
async function submitRequestRaise() {
  const id = document.getElementById('raisePersonId').value;
  const requestedRate = Number(document.getElementById('raiseRequestedRate').value);
  const resultEl = document.getElementById('raiseResult');
  if (!requestedRate || requestedRate <= 0) { resultEl.innerHTML = '<p class="msg error">Enter a valid pay rate.</p>'; return; }
  try {
    const result = await withStepUp(() => api(`/api/employees/${id}/request-raise`, { method: 'POST', body: { requestedRate } }));
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    closeRequestRaiseModal();
    showMsg('Sent to the owner for approval.', 'success');
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// ---- Pay rate requests (owner decides; manager just files them above) ----
async function loadPayRateRequests() {
  if (ME.role !== 'owner') return;
  document.getElementById('payRateRequestsCard').style.display = '';
  try {
    const list = await api('/api/pay-rate-requests');
    const el = document.getElementById('payRateRequestsList');
    if (!list.length) { el.innerHTML = '<p class="muted">No pending requests.</p>'; return; }
    el.innerHTML = list.map(r => `
      <div class="list-row">
        <div>
          <div class="name">${escapeHtml(r.person_name)}</div>
          <div class="sub">$${r.current_rate ?? '—'}/hr → $${r.requested_rate}/hr · requested by ${escapeHtml(r.requested_by_name || 'a manager')}</div>
        </div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="decidePayRateRequest('${r.id}', false)">Deny</button>
          <button class="small primary" style="margin-top:0;" onclick="decidePayRateRequest('${r.id}', true)">Approve</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('payRateRequestsList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function decidePayRateRequest(id, approve) {
  try {
    await withStepUp(() => api(`/api/pay-rate-requests/${id}/decide`, { method: 'POST', body: { approve } }));
    showMsg(approve ? 'Raise approved.' : 'Request denied.', 'success');
    await loadPayRateRequests();
    await loadAllEmployees();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---- Reset requests (owner decides; employee files from the login page) ----
// requestType labels + a client-side reveal cache: once approved, the new
// temp password/PIN is shown exactly once (the server never returns it
// again), so we keep decided rows on screen with their reveal attached
// instead of re-fetching (a re-fetch would just drop them — they're no
// longer 'pending').
const RESET_TYPE_LABEL = { password: 'password', pin: 'PIN', both: 'password & PIN' };
let RESET_REQUESTS = [];

async function loadResetRequests() {
  if (ME.role !== 'owner') return;
  document.getElementById('resetRequestsCard').style.display = '';
  try {
    const list = await api('/api/reset-requests');
    RESET_REQUESTS = list.map(r => ({ ...r, _reveal: null }));
    renderResetRequestsList();
  } catch (e) {
    document.getElementById('resetRequestsList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function renderResetRequestsList() {
  const el = document.getElementById('resetRequestsList');
  if (!RESET_REQUESTS.length) { el.innerHTML = '<p class="muted">No pending requests.</p>'; return; }
  el.innerHTML = RESET_REQUESTS.map(r => `
    <div class="list-row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between;">
        <div>
          <div class="name">${escapeHtml(r.person_name)} <span class="badge off">@${escapeHtml(r.username || '—')}</span></div>
          <div class="sub">Forgot: ${escapeHtml(RESET_TYPE_LABEL[r.request_type] || r.request_type)}${r.note ? ` · "${escapeHtml(r.note)}"` : ''} · requested ${fmtDateTime(r.requested_at)}</div>
        </div>
        ${r.status === 'pending' ? `
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="decideResetRequest('${r.id}', false)">Deny</button>
          <button class="small primary" style="margin-top:0;" onclick="decideResetRequest('${r.id}', true)">Approve &amp; generate</button>
        </div>` : `<span class="badge ${r.status === 'approved' ? 'on' : 'off'}">${escapeHtml(r.status)}</span>`}
      </div>
      ${r._reveal ? `
      <div class="credential-box">
        <b>Username:</b> ${escapeHtml(r._reveal.username)}<br>
        ${r._reveal.tempPassword ? `<b>New temp password:</b> ${escapeHtml(r._reveal.tempPassword)}<br>` : ''}
        ${r._reveal.pin ? `<b>New PIN:</b> ${escapeHtml(r._reveal.pin)}<br>` : ''}
        <span class="muted">Shown once — hand this to ${escapeHtml(r._reveal.username)} directly. Their other sessions were signed out.</span>
      </div>` : ''}
    </div>
  `).join('');
}

async function decideResetRequest(id, approve) {
  try {
    const result = await withStepUp(() => api(`/api/reset-requests/${id}/decide`, { method: 'POST', body: { approve } }));
    if (!result.ok) { showMsg(result.error || 'Could not decide that request.', 'error'); return; }
    const row = RESET_REQUESTS.find(r => r.id === id);
    if (row) {
      row.status = approve ? 'approved' : 'denied';
      if (approve) row._reveal = { username: result.person.username, tempPassword: result.tempPassword, pin: result.pin };
    }
    renderResetRequestsList();
    showMsg(approve ? 'New credentials generated below.' : 'Request denied.', 'success');
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function closeAllModals() { closeReviewModal(); closeActivateModal(); closeEmployeeDetail(); closeRequestRaiseModal(); }

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
  // Same resilience for pay rate requests — its own try/catch, owner-only.
  await loadPayRateRequests();
  // Same again for reset requests — its own try/catch, owner-only, and a
  // brand new table (patch_009), so this stays resilient if that migration
  // hasn't landed yet either.
  await loadResetRequests();
})();
