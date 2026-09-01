let ME = null;
let IS_MANAGER = false;
let LOCATIONS = [];
let EQUIPMENT = [];
let DESTINATIONS = [];       // active send-to destinations, for the New Call checkboxes
let ADMIN_DESTINATIONS = []; // full destinations (incl. archived) + members, for the Manage tab
let MANAGE_PEOPLE = [];      // active employees, for the destination member picker

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
  document.getElementById('panelManage').style.display = which === 'manage' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  if (which === 'open') loadOpen();
  if (which === 'new') renderNewForm();
  if (which === 'reports') renderReports();
  if (which === 'manage') renderManage();
}

function renderTabs() {
  const tabs = [{ key: 'open', label: 'Calls' }, { key: 'new', label: 'New Call' }];
  if (IS_MANAGER) tabs.push({ key: 'reports', label: 'Reports' }, { key: 'manage', label: 'Manage' });
  document.getElementById('tabs').innerHTML = tabs.map(t =>
    `<button data-tab="${t.key}" onclick="setTab('${t.key}')">${t.label}</button>`).join('');
  setTab('open');
}

function closeAllModals() { closeCloseModal(); closeDetailModal(); closeMembersModal(); }

// ---------------- Calls list ----------------
async function loadOpen() {
  const el = document.getElementById('panelOpen');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const calls = await api('/api/servicecalls');
    if (!calls.length) { el.innerHTML = '<div class="card"><p class="muted">No service calls yet.</p></div>'; return; }
    // Server already sorts open-first (oldest first) then closed (most
    // recently closed first) — splitting here just groups that same order
    // under the two section headers rather than re-sorting anything.
    const pending = calls.filter(c => c.status === 'open');
    const closed = calls.filter(c => c.status === 'closed');
    let html = '';
    if (pending.length) html += sectionDividerHtml('Pending Calls') + pending.map(callCardHtml).join('');
    if (closed.length) html += sectionDividerHtml('Closed Calls') + closed.map(callCardHtml).join('');
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function sectionDividerHtml(label) {
  return `<div class="sc-divider"><span></span><b>${escapeHtml(label)}</b><span></span></div>`;
}

function callCardHtml(c) {
  const equipment = c.equipment_name || c.equipment_other || 'Unspecified equipment';
  const open = c.status === 'open';
  const sentTo = (c.destination_names && c.destination_names.length) ? c.destination_names.join(', ') : '—';
  const noteHint = c.notes_count ? `${c.notes_count} note${c.notes_count === 1 ? '' : 's'}` : 'Add a note';
  return `<div class="card ${open ? '' : 'sc-closed'}" onclick="openCallDetail('${c.id}')" style="cursor:pointer;">
    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
      <div>
        <div class="name">${escapeHtml(equipment)} <span class="badge ${open ? 'stale' : 'off'}">${open ? 'open · ' + fmtDuration(c.minutes_open) : 'closed'}</span></div>
        <div class="sub">${escapeHtml(c.location_name)} · reported by ${escapeHtml(c.created_by_name)} · ${fmtDateTime(c.created_at)} · to ${escapeHtml(sentTo)}</div>
      </div>
      ${open ? `<button class="small primary" style="margin-top:0;" onclick="event.stopPropagation(); openCloseModal('${c.id}', ${JSON.stringify(equipment).replace(/"/g, '&quot;')})">Close</button>` : ''}
    </div>
    <p style="margin:10px 0 0;">${escapeHtml(c.description)}</p>
    ${!open ? `<p class="muted" style="margin-top:8px;">Closed by ${escapeHtml(c.closed_by_name || '—')} ${fmtDateTime(c.closed_at)} — ${escapeHtml(c.remedy || '')}</p>` : ''}
    <p class="muted" style="margin-top:8px;">${escapeHtml(noteHint)} →</p>
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

// ---------------- Call detail + notes ("click any call, all logged") ----------------
function notesListHtml(notes) {
  if (!notes || !notes.length) return '<p class="muted">No notes yet.</p>';
  return notes.map(n => `<div class="sc-note">
    <div class="sc-note-meta">${escapeHtml(n.author_name || '—')} · ${fmtDateTime(n.created_at)}</div>
    <div>${escapeHtml(n.note)}</div>
  </div>`).join('');
}

async function openCallDetail(id) {
  document.getElementById('detailModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
  const body = document.getElementById('detailBody');
  body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const c = await api('/api/servicecalls/' + id);
    body.innerHTML = detailBodyHtml(c);
  } catch (e) {
    body.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
function closeDetailModal() {
  document.getElementById('detailModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}

function detailBodyHtml(c) {
  const equipment = c.equipment_name || c.equipment_other || 'Unspecified equipment';
  const open = c.status === 'open';
  const sentTo = (c.destination_names && c.destination_names.length) ? c.destination_names.join(', ') : '—';
  return `
    <div class="name">${escapeHtml(equipment)} <span class="badge ${open ? 'stale' : 'off'}">${open ? 'open · ' + fmtDuration(c.minutes_open) : 'closed'}</span></div>
    <p class="sub" style="margin:4px 0 12px;">${escapeHtml(c.location_name)} · reported by ${escapeHtml(c.created_by_name)} · ${fmtDateTime(c.created_at)} · to ${escapeHtml(sentTo)}</p>
    <p>${escapeHtml(c.description)}</p>
    ${!open ? `<p class="muted" style="margin-top:8px;">Closed by ${escapeHtml(c.closed_by_name || '—')} ${fmtDateTime(c.closed_at)} — ${escapeHtml(c.remedy || '')}</p>` : ''}
    <hr style="border:none; border-top:1px solid var(--card-border); margin:16px 0;">
    <h2 style="font-size:14px; margin:0 0 8px;">Notes</h2>
    <div id="detailNotesList">${notesListHtml(c.notes)}</div>
    <input type="hidden" id="detailCallId" value="${c.id}">
    <label for="detailNewNote">Add a note</label>
    <textarea id="detailNewNote" rows="2" placeholder="e.g. Called the vendor, part is on order"></textarea>
    <button class="secondary" onclick="submitNote()">Add note</button>
    <div id="detailNoteResult"></div>
    ${open ? `<button class="primary" onclick="closeDetailModal(); openCloseModal('${c.id}', ${JSON.stringify(equipment).replace(/"/g, '&quot;')})">Close this call</button>` : ''}
  `;
}

async function submitNote() {
  const id = document.getElementById('detailCallId').value;
  const note = document.getElementById('detailNewNote').value.trim();
  const resultEl = document.getElementById('detailNoteResult');
  if (!note) { resultEl.innerHTML = '<p class="msg error">Write a note first.</p>'; return; }
  try {
    const result = await api(`/api/servicecalls/${id}/notes`, { method: 'POST', body: { note } });
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    document.getElementById('detailNewNote').value = '';
    resultEl.innerHTML = '';
    document.getElementById('detailNotesList').innerHTML = notesListHtml(result.notes);
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
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
    <textarea id="ncDescription" rows="3" placeholder="Be specific — this is what the people below will see"></textarea>
    <label>Send this to</label>
    <div id="ncDestinations" class="sc-checkbox-grid"></div>
    <button class="primary" onclick="submitNewCall()">Submit</button>
  </div>`;
  fillLocationSelect(document.getElementById('ncLocation'), ME.location_id);
  fillEquipmentSelect(document.getElementById('ncEquipment'));
  const destEl = document.getElementById('ncDestinations');
  destEl.innerHTML = DESTINATIONS.length
    ? DESTINATIONS.map(d => `<label class="sc-checkbox"><input type="checkbox" value="${d.id}"> ${escapeHtml(d.name)}</label>`).join('')
    : '<p class="muted">No destinations set up yet — ask a manager to add one under Manage.</p>';
}

async function submitNewCall() {
  const locationId = document.getElementById('ncLocation').value;
  const equipmentSel = document.getElementById('ncEquipment').value;
  const equipmentTypeId = equipmentSel === '__other' ? null : equipmentSel;
  const equipmentOther = equipmentSel === '__other' ? document.getElementById('ncOther').value.trim() : null;
  const description = document.getElementById('ncDescription').value.trim();
  const destinationIds = Array.from(document.querySelectorAll('#ncDestinations input:checked')).map(i => i.value);
  if (!description) { showMsg('Describe the issue first.', 'error'); return; }
  if (!destinationIds.length) { showMsg('Pick at least one destination to send this to.', 'error'); return; }
  try {
    const result = await api('/api/servicecalls', { method: 'POST', body: { locationId, equipmentTypeId, equipmentOther, description, destinationIds } });
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
        <th>Location</th><th>Equipment</th><th>Reported by</th><th>Opened</th><th>Status</th><th>Sent to</th><th>Closed by</th><th>Time</th><th>Remedy</th>
      </tr></thead><tbody>
        ${rows.map(r => `<tr>
          <td>${escapeHtml(r.location_name)}</td>
          <td>${escapeHtml(r.equipment_name || r.equipment_other || '—')}</td>
          <td>${escapeHtml(r.created_by_name)}</td>
          <td>${fmtDateTime(r.created_at)}</td>
          <td><span class="badge ${r.status === 'open' ? 'stale' : 'off'}">${r.status}</span></td>
          <td>${escapeHtml((r.destination_names || []).join(', ') || '—')}</td>
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

// ---------------- Manage (manager/owner): equipment types + destinations ----------------
async function renderManage() {
  const el = document.getElementById('panelManage');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    MANAGE_PEOPLE = (await api('/api/employees')).filter(p => p.status === 'active');
  } catch (e) {
    MANAGE_PEOPLE = [];
  }
  el.innerHTML = `
    <div class="card">
      <h2>Equipment types</h2>
      <p class="muted">Shown in the Equipment dropdown when reporting a new call. Archiving hides one from that dropdown — it doesn't touch past calls that already used it.</p>
      <div id="equipList"><p class="muted">Loading…</p></div>
      <label for="newEquipName">Add an equipment type</label>
      <input id="newEquipName" placeholder="e.g. Neon Sign">
      <button class="secondary" onclick="submitAddEquipment()">Add</button>
      <div id="equipResult"></div>
    </div>
    <div class="card">
      <h2>Send-to destinations</h2>
      <p class="muted">Who gets notified when a call comes in. Add a destination, then set who's on it — being on a destination notifies someone whether or not they have Service Calls access themselves.</p>
      <div id="destList"><p class="muted">Loading…</p></div>
      <label for="newDestName">Add a destination</label>
      <input id="newDestName" placeholder="e.g. Kitchen Manager">
      <button class="secondary" onclick="submitAddDestination()">Add</button>
      <div id="destResult"></div>
    </div>
  `;
  loadManageEquipment();
  loadManageDestinations();
}

async function loadManageEquipment() {
  const el = document.getElementById('equipList');
  try {
    const rows = await api('/api/servicecalls/equipment-types/admin');
    // Move arrows only make sense within the active group — archived ones
    // are excluded from the move-target list server-side, so track first/
    // last position among active rows only.
    const active = rows.filter(e => e.active);
    el.innerHTML = rows.length ? rows.map(e => {
      const activeIdx = active.indexOf(e);
      return `<div class="list-row">
      <div><div class="name">${escapeHtml(e.name)}</div>${!e.active ? '<div class="sub">Archived</div>' : ''}</div>
      <div style="display:flex; gap:8px; align-items:center;">
        ${e.active ? `
        <button class="small ghost" ${activeIdx === 0 ? 'disabled' : ''} onclick="moveEquipment('${e.id}','up')" title="Move up">▲</button>
        <button class="small ghost" ${activeIdx === active.length - 1 ? 'disabled' : ''} onclick="moveEquipment('${e.id}','down')" title="Move down">▼</button>
        <button class="small ghost" onclick="archiveEquipment('${e.id}')">Archive</button>` : `
        <button class="small secondary" onclick="restoreEquipment('${e.id}')">Restore</button>`}
      </div>
    </div>`;
    }).join('') : '<p class="muted">No equipment types yet.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function moveEquipment(id, direction) {
  try {
    const result = await api(`/api/servicecalls/equipment-types/${id}/move`, { method: 'POST', body: { direction } });
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    loadManageEquipment();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function submitAddEquipment() {
  const nameEl = document.getElementById('newEquipName');
  const name = nameEl.value.trim();
  const resultEl = document.getElementById('equipResult');
  if (!name) return;
  try {
    const result = await api('/api/servicecalls/equipment-types', { method: 'POST', body: { name } });
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    nameEl.value = '';
    resultEl.innerHTML = '';
    loadManageEquipment();
    EQUIPMENT = await api('/api/servicecalls/equipment-types');
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function archiveEquipment(id) {
  await api(`/api/servicecalls/equipment-types/${id}/archive`, { method: 'POST' });
  loadManageEquipment();
  EQUIPMENT = await api('/api/servicecalls/equipment-types');
}
async function restoreEquipment(id) {
  await api(`/api/servicecalls/equipment-types/${id}/restore`, { method: 'POST' });
  loadManageEquipment();
  EQUIPMENT = await api('/api/servicecalls/equipment-types');
}

async function loadManageDestinations() {
  const el = document.getElementById('destList');
  try {
    const rows = await api('/api/servicecalls/destinations/admin');
    ADMIN_DESTINATIONS = rows;
    el.innerHTML = rows.length ? rows.map(d => `<div class="list-row" style="align-items:flex-start;">
      <div>
        <div class="name">${escapeHtml(d.name)} ${!d.active ? '<span class="badge off">Archived</span>' : ''}</div>
        <div class="sub">${d.members.length ? escapeHtml(d.members.map(m => m.name).join(', ')) : 'Nobody yet'}</div>
      </div>
      <div class="stack-actions" style="margin-top:0;">
        <button class="small ghost" onclick="openMembersModal('${d.id}')">Members</button>
        ${d.active
          ? `<button class="small ghost" onclick="archiveDestination('${d.id}')">Archive</button>`
          : `<button class="small secondary" onclick="restoreDestination('${d.id}')">Restore</button>`}
      </div>
    </div>`).join('') : '<p class="muted">No destinations yet.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function submitAddDestination() {
  const nameEl = document.getElementById('newDestName');
  const name = nameEl.value.trim();
  const resultEl = document.getElementById('destResult');
  if (!name) return;
  try {
    const result = await api('/api/servicecalls/destinations', { method: 'POST', body: { name } });
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    nameEl.value = '';
    resultEl.innerHTML = '';
    loadManageDestinations();
    DESTINATIONS = await api('/api/servicecalls/destinations');
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function archiveDestination(id) {
  await api(`/api/servicecalls/destinations/${id}/archive`, { method: 'POST' });
  loadManageDestinations();
  DESTINATIONS = await api('/api/servicecalls/destinations');
}
async function restoreDestination(id) {
  await api(`/api/servicecalls/destinations/${id}/restore`, { method: 'POST' });
  loadManageDestinations();
  DESTINATIONS = await api('/api/servicecalls/destinations');
}

function openMembersModal(destId) {
  const dest = ADMIN_DESTINATIONS.find(d => d.id === destId);
  if (!dest) return;
  document.getElementById('membersDestId').value = destId;
  document.getElementById('membersTitle').textContent = 'Members — ' + dest.name;
  const currentIds = new Set(dest.members.map(m => m.id));
  const list = document.getElementById('membersList');
  list.innerHTML = MANAGE_PEOPLE.length
    ? MANAGE_PEOPLE.map(p => `<label class="sc-checkbox"><input type="checkbox" value="${p.id}" ${currentIds.has(p.id) ? 'checked' : ''}> ${escapeHtml(p.name)}${p.role ? ' — ' + escapeHtml(p.role) : ''}</label>`).join('')
    : '<p class="muted">No active employees to add yet.</p>';
  document.getElementById('membersResult').innerHTML = '';
  document.getElementById('membersModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closeMembersModal() {
  document.getElementById('membersModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
async function submitMembers() {
  const destId = document.getElementById('membersDestId').value;
  const personIds = Array.from(document.querySelectorAll('#membersList input:checked')).map(i => i.value);
  const resultEl = document.getElementById('membersResult');
  try {
    const result = await api(`/api/servicecalls/destinations/${destId}/members`, { method: 'POST', body: { personIds } });
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    closeMembersModal();
    loadManageDestinations();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
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
    DESTINATIONS = await api('/api/servicecalls/destinations');
    renderTabs();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
