let ME = null;
let IS_MANAGER = false;
let LOCATIONS = [];
let EQUIPMENT = [];

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

function locationName(id) { const l = LOCATIONS.find(l => l.id === id); return l ? l.name : '—'; }

function fillLocationSelect(sel, defaultId) {
  sel.innerHTML = LOCATIONS.map(l => `<option value="${l.id}" ${l.id === defaultId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
}
function fillEquipmentSelect(sel) {
  sel.innerHTML = EQUIPMENT.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('') + `<option value="__other">Other…</option>`;
}

function fmtDuration(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hrs = Math.floor(minutes / 60);
  if (hrs < 24) return `${hrs}h ${minutes % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function setTab(which) {
  document.getElementById('panelOpen').style.display = which === 'open' ? '' : 'none';
  document.getElementById('panelNew').style.display = which === 'new' ? '' : 'none';
  document.getElementById('panelReports').style.display = which === 'reports' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  if (which === 'open') loadOpen();
  if (which === 'new') renderNewForm();
  if (which === 'reports') renderReports();
}

function renderTabs() {
  const tabs = [{ key: 'open', label: 'Calls' }, { key: 'new', label: 'New Call' }];
  if (IS_MANAGER) tabs.push({ key: 'reports', label: 'Reports' });
  document.getElementById('tabs').innerHTML = tabs.map(t =>
    `<button data-tab="${t.key}" onclick="setTab('${t.key}')">${t.label}</button>`).join('');
  setTab('open');
}

// ---------------- Calls list ----------------
async function loadOpen() {
  const el = document.getElementById('panelOpen');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const calls = await api('/api/servicecalls');
    if (!calls.length) { el.innerHTML = '<div class="card"><p class="muted">No service calls yet.</p></div>'; return; }
    el.innerHTML = calls.map(callCardHtml).join('');
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function callCardHtml(c) {
  const equipment = c.equipment_name || c.equipment_other || 'Unspecified equipment';
  const open = c.status === 'open';
  return `<div class="card">
    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
      <div>
        <div class="name">${escapeHtml(equipment)} <span class="badge ${open ? 'stale' : 'off'}">${open ? 'open · ' + fmtDuration(c.minutes_open) : 'closed'}</span></div>
        <div class="sub">${escapeHtml(c.location_name)} · reported by ${escapeHtml(c.created_by_name)} · ${fmtDateTime(c.created_at)} · to ${escapeHtml(c.assigned_to_role)}</div>
      </div>
      ${open ? `<button class="small primary" style="margin-top:0;" onclick="openCloseModal('${c.id}', ${JSON.stringify(equipment).replace(/"/g, '&quot;')})">Close</button>` : ''}
    </div>
    <p style="margin:10px 0 0;">${escapeHtml(c.description)}</p>
    ${!open ? `<p class="muted" style="margin-top:8px;">Closed by ${escapeHtml(c.closed_by_name || '—')} ${fmtDateTime(c.closed_at)} — ${escapeHtml(c.remedy || '')}</p>` : ''}
  </div>`;
}

function openCloseModal(id, desc) {
  document.getElementById('closeCallId').value = id;
  document.getElementById('closeCallDesc').textContent = desc;
  document.getElementById('closeRemedy').value = '';
  document.getElementById('closeModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closeCloseModal() {
  document.getElementById('closeModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
async function submitClose() {
  const id = document.getElementById('closeCallId').value;
  const remedy = document.getElementById('closeRemedy').value.trim();
  if (!remedy) { alert('Describe what fixed it first.'); return; }
  try {
    const result = await api(`/api/servicecalls/${id}/close`, { method: 'POST', body: { remedy } });
    if (!result.ok) { alert(result.error); return; }
    closeCloseModal();
    showMsg('Call closed.', 'success');
    loadOpen();
  } catch (e) {
    alert(e.message);
  }
}

// ---------------- New call ----------------
function renderNewForm() {
  const el = document.getElementById('panelNew');
  el.innerHTML = `<div class="card">
    <h2>Report a new issue</h2>
    <label for="ncLocation">Location</label>
    <select id="ncLocation"></select>
    <label for="ncEquipment">Equipment</label>
    <select id="ncEquipment" onchange="document.getElementById('ncOtherWrap').style.display = this.value === '__other' ? '' : 'none';"></select>
    <div id="ncOtherWrap" style="display:none;">
      <label for="ncOther">What is it?</label>
      <input id="ncOther" placeholder="e.g. Back door lock">
    </div>
    <label for="ncDescription">What's going on?</label>
    <textarea id="ncDescription" rows="3" placeholder="Be specific — this is what maintenance/your manager will see"></textarea>
    <label>Send this to</label>
    <select id="ncAssigned">
      <option value="maintenance">Maintenance</option>
      <option value="manager">Manager</option>
      <option value="both">Both</option>
    </select>
    <button class="primary" onclick="submitNewCall()">Submit</button>
  </div>`;
  fillLocationSelect(document.getElementById('ncLocation'), ME.location_id);
  fillEquipmentSelect(document.getElementById('ncEquipment'));
}

async function submitNewCall() {
  const locationId = document.getElementById('ncLocation').value;
  const equipmentSel = document.getElementById('ncEquipment').value;
  const equipmentTypeId = equipmentSel === '__other' ? null : equipmentSel;
  const equipmentOther = equipmentSel === '__other' ? document.getElementById('ncOther').value.trim() : null;
  const description = document.getElementById('ncDescription').value.trim();
  const assignedToRole = document.getElementById('ncAssigned').value;
  if (!description) { showMsg('Describe the issue first.', 'error'); return; }
  try {
    const result = await api('/api/servicecalls', { method: 'POST', body: { locationId, equipmentTypeId, equipmentOther, description, assignedToRole } });
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Reported — thanks.', 'success');
    setTab('open');
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------- Reports (manager/owner) ----------------
function renderReports() {
  const el = document.getElementById('panelReports');
  el.innerHTML = `<div class="card">
    <h2>Reports</h2>
    <label for="rpLocation">Location</label>
    <select id="rpLocation"><option value="">All locations</option></select>
    <label for="rpEquipment">Equipment</label>
    <select id="rpEquipment"><option value="">All equipment</option></select>
    <label for="rpStatus">Status</label>
    <select id="rpStatus"><option value="">All</option><option value="open">Open</option><option value="closed">Closed</option></select>
    <div class="stack-actions">
      <button class="secondary" onclick="runReport()">Run</button>
      <button class="secondary" onclick="downloadCsv()">Download CSV</button>
    </div>
    <div id="reportSummary"></div>
    <div id="reportTable" style="margin-top:10px; overflow-x:auto;"></div>
  </div>`;
  const locSel = document.getElementById('rpLocation');
  locSel.insertAdjacentHTML('beforeend', LOCATIONS.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join(''));
  const eqSel = document.getElementById('rpEquipment');
  eqSel.insertAdjacentHTML('beforeend', EQUIPMENT.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join(''));
  runReport();
}

function reportQuery() {
  const params = new URLSearchParams();
  const loc = document.getElementById('rpLocation').value;
  const eq = document.getElementById('rpEquipment').value;
  const status = document.getElementById('rpStatus').value;
  if (loc) params.set('locationId', loc);
  if (eq) params.set('equipmentTypeId', eq);
  if (status) params.set('status', status);
  return params.toString();
}

async function runReport() {
  try {
    const rows = await api('/api/servicecalls?' + reportQuery());
    const closed = rows.filter(r => r.status === 'closed');
    const open = rows.filter(r => r.status === 'open');
    const avgMin = closed.length ? Math.round(closed.reduce((s, r) => s + r.minutes_open, 0) / closed.length) : 0;
    document.getElementById('reportSummary').innerHTML = `
      <p class="muted" style="margin-top:14px;">${rows.length} calls · ${open.length} open · ${closed.length} closed
      ${closed.length ? ' · avg time to close: ' + fmtDuration(avgMin) : ''}</p>`;
    document.getElementById('reportTable').innerHTML = rows.length ? `<table><thead><tr>
        <th>Location</th><th>Equipment</th><th>Reported by</th><th>Opened</th><th>Status</th><th>Closed by</th><th>Time</th><th>Remedy</th>
      </tr></thead><tbody>
        ${rows.map(r => `<tr>
          <td>${escapeHtml(r.location_name)}</td>
          <td>${escapeHtml(r.equipment_name || r.equipment_other || '—')}</td>
          <td>${escapeHtml(r.created_by_name)}</td>
          <td>${fmtDateTime(r.created_at)}</td>
          <td><span class="badge ${r.status === 'open' ? 'stale' : 'off'}">${r.status}</span></td>
          <td>${escapeHtml(r.closed_by_name || '—')}</td>
          <td>${fmtDuration(r.minutes_open)}</td>
          <td>${escapeHtml(r.remedy || '—')}</td>
        </tr>`).join('')}
      </tbody></table>` : '<p class="muted">No calls match those filters.</p>';
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function downloadCsv() {
  try {
    const res = await fetch('/api/servicecalls/report.csv?' + reportQuery(), {
      headers: { Authorization: 'Bearer ' + getToken() },
    });
    if (!res.ok) throw new Error('Could not generate the report.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'service_calls.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

(async function init() {
  ME = requireAuth();
  if (!ME) return;
  renderTopbar('Service Calls');
  IS_MANAGER = ME.role === 'manager' || ME.role === 'owner';
  const access = getAppAccess();
  const hasAccess = ME.role === 'owner' || access.some(a => a.app_key === 'service_calls' && a.enabled);
  if (!hasAccess && !IS_MANAGER) {
    document.getElementById('app').innerHTML = '<div class="card"><p>Service Calls isn\'t enabled for your account yet — ask your manager.</p><p><a href="/dashboard.html">Back home</a></p></div>';
    return;
  }
  try {
    LOCATIONS = await api('/api/locations');
    EQUIPMENT = await api('/api/servicecalls/equipment-types');
    renderTabs();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
