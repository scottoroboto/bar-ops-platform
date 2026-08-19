let ME = null;
let LOCATIONS = [];

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
  document.getElementById('reviewPosition').value = position || '';
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
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
