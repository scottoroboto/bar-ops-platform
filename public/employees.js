let ME = null;
let LOCATIONS = [];
let POSITIONS = [];

// Inline stroke icons — 24x24 viewBox, currentColor, no dependency on any
// icon font/sprite sheet (there isn't one in this app). Reused for both the
// roster row toggles and the employee data card's contact rows.
const ICONS = {
  clock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  calendar: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
  wrench: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 1 1-5.4 5.4L4 17l3 3 5.7-5.7a4 4 0 0 0 5.4-5.4L15 12l-3-3 2.7-2.7Z"/></svg>',
  monitor: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M6 10l3 3 2-4 2 2 3-3"/></svg>',
  people: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/><circle cx="17.5" cy="9" r="2.3"/><path d="M15.8 14.8c2 .4 3.5 2 3.7 5.2"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>',
  phone: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 3a2 2 0 0 1-.5 2.1L8 10.1a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c1 .3 2 .5 3 .7a2 2 0 0 1 1.7 2Z"/></svg>',
  pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
};

// The roster row's app-access toggles, in the order the redesign settled
// on. 'employees' is appended separately, only for role = 'manager' — see
// empToggleDefs().
const TOGGLE_DEFS = [
  { key: 'time_clock', label: 'Clock', icon: ICONS.clock },
  { key: 'scheduling', label: 'Sched', icon: ICONS.calendar },
  { key: 'service_calls', label: 'Calls', icon: ICONS.wrench },
  { key: 'monitoring', label: 'Monitor', icon: ICONS.monitor },
];
const EMPLOYEES_TOGGLE_DEF = { key: 'employees', label: 'Emp', icon: ICONS.people };

function empToggleDefs(person) {
  return person.role === 'manager' ? TOGGLE_DEFS.concat([EMPLOYEES_TOGGLE_DEF]) : TOGGLE_DEFS;
}

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

function locationName(id) {
  const l = LOCATIONS.find(l => l.id === id);
  return l ? l.name : '—';
}

// "Ticket 1" -> "T1", etc. — falls back to the first two letters for any
// location that isn't named with a trailing number.
function shortLoc(name) {
  const m = String(name || '').match(/(\d+)\s*$/);
  return m ? ('T' + m[1]) : String(name || '').slice(0, 2).toUpperCase();
}

// A maintenance employee is dispatched across every location rather than
// tied to one (see db/patch_005's positions and the service-calls
// destination-picker note on the same convention) — shown as a "Maint"
// chip instead of whatever location_id happens to be on their row.
// Only ever one chip today: people.location_id is a single column, not a
// join table, so an employee who genuinely splits time across more than
// one location can't be represented yet. The markup (.emp-locs,
// #detailLocChips) already wraps for more than one chip so nothing here
// needs to change the day that becomes real data.
function locChipsHtml(p) {
  if (p.role === 'maintenance') return '<span class="chip warn">Maint</span>';
  if (!p.location_id) return '<span class="muted">—</span>';
  return `<span class="chip">${escapeHtml(shortLoc(locationName(p.location_id)))}</span>`;
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// "hourly rate ... only shows rate for assistant managers and below, do
// not show rate for maint employees" — hidden for the top Manager
// position and for anyone in the maintenance role, shown for everyone
// else (Assistant Manager and every non-management position).
function rateVisible(p) {
  if (p.role === 'maintenance') return false;
  if ((p.position || '').trim() === 'Manager') return false;
  return true;
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

// ---------------------------------------------------------------------
// Tabs — same renderTabs()/setTab() shape as timeclock.js/servicecalls.js/
// monitoring.js, extended with a small counter badge per tab. Pay Rate
// Requests and Reset Requests are owner-only tabs (mirrors the old cards
// only ever being shown to the owner); Employee List and Onboard Review
// are visible to manager and owner alike.
// ---------------------------------------------------------------------
function renderTabs() {
  const tabs = [{ key: 'list', label: 'Employee List' }, { key: 'onboard', label: 'Onboard Review' }];
  if (ME.role === 'owner') {
    tabs.push({ key: 'payrate', label: 'Pay Rate Requests' }, { key: 'reset', label: 'Reset Requests' }, { key: 'notifications', label: 'Notifications' });
  }
  document.getElementById('tabs').innerHTML = tabs.map(t =>
    `<button data-tab="${t.key}" onclick="setTab('${t.key}')">${t.label}<span class="tab-badge" id="badge-${t.key}" style="display:none;"></span></button>`
  ).join('');
  setTab('list');
}

function setTab(which) {
  document.getElementById('panelList').style.display = which === 'list' ? '' : 'none';
  document.getElementById('panelOnboard').style.display = which === 'onboard' ? '' : 'none';
  document.getElementById('panelPayRate').style.display = which === 'payrate' ? '' : 'none';
  document.getElementById('panelReset').style.display = which === 'reset' ? '' : 'none';
  document.getElementById('panelNotifications').style.display = which === 'notifications' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  if (which === 'notifications') loadNotificationsToggle();
}

function setBadge(key, n) {
  const el = document.getElementById('badge-' + key);
  if (!el) return;
  if (n > 0) { el.textContent = n; el.style.display = ''; } else { el.style.display = 'none'; }
}

function updateTabBadges() {
  setBadge('onboard', PENDING_LIST.length);
  setBadge('payrate', PAY_RATE_REQUESTS.length);
  setBadge('reset', RESET_REQUESTS.filter(r => r.status === 'pending').length);
}

let PENDING_LIST = [];
let discardConfirmId = null;

async function loadPending() {
  PENDING_LIST = await api('/api/employees/pending');
  renderPendingList();
  updateTabBadges();
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
  const btn = document.getElementById('sendInviteBtn');
  if (!email) { resultEl.innerHTML = '<p class="msg error">Enter an email address.</p>'; return; }
  // The server can take a little while to respond (e.g. right after the app
  // has been idle), and with no feedback here a slow request just looks like
  // the button did nothing. Show a visible "working on it" state immediately
  // and always clear it, however the request turns out.
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  resultEl.innerHTML = '<p class="msg info">Sending…</p>';
  try {
    const result = await withStepUp(() => api('/api/employees/invite', { method: 'POST', body: { name, email } }));
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error || 'Could not send invite.')}</p>`; return; }
    resultEl.innerHTML = `<p class="msg success">Onboarding link sent to ${escapeHtml(email)}.</p>`;
    document.getElementById('inviteName').value = '';
    document.getElementById('inviteEmail').value = '';
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// ---------------------------------------------------------------------
// Employee List tab — roster + sort + quick location filters
// ---------------------------------------------------------------------
let ALL_EMPLOYEES = [];
let LOC_FILTER = 'all';

async function loadAllEmployees() {
  if (ME.role !== 'owner' && ME.role !== 'manager') return;
  document.getElementById('allEmployeesHint').textContent = ME.role === 'owner'
    ? 'Click a row to see their data card. Toggle which apps each person can use right from the list — this can be changed any time, not just at onboarding.'
    : "Your location's roster. Click a row to see their data card, or request a pay raise.";
  ALL_EMPLOYEES = await api('/api/employees');
  renderLocFilters();
  renderAllEmployees();
}

function renderLocFilters() {
  const chips = [{ key: 'all', label: 'All' }]
    .concat(LOCATIONS.map(l => ({ key: l.id, label: shortLoc(l.name) })))
    .concat([{ key: 'maint', label: 'Maint' }]);
  document.getElementById('locFilters').innerHTML = chips.map(c =>
    `<button type="button" class="loc-filter ${LOC_FILTER === c.key ? 'active' : ''}" onclick="setLocFilter('${c.key}')">${escapeHtml(c.label)}</button>`
  ).join('');
}

function setLocFilter(key) {
  LOC_FILTER = key;
  renderLocFilters();
  renderAllEmployees();
}

function applyLocFilter(list) {
  if (LOC_FILTER === 'all') return list;
  if (LOC_FILTER === 'maint') return list.filter(p => p.role === 'maintenance');
  return list.filter(p => p.location_id === LOC_FILTER);
}

function applySort(list) {
  const mode = document.getElementById('employeeSort').value;
  const arr = list.slice();
  if (mode === 'name_desc') arr.sort((a, b) => b.name.localeCompare(a.name));
  else if (mode === 'location') arr.sort((a, b) => locationName(a.location_id).localeCompare(locationName(b.location_id)) || a.name.localeCompare(b.name));
  else if (mode === 'role') arr.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  else arr.sort((a, b) => a.name.localeCompare(b.name)); // name_asc, and the default
  return arr;
}

function renderAllEmployees() {
  const el = document.getElementById('employeeList');
  if (!ALL_EMPLOYEES.length) { el.innerHTML = '<p class="muted">No active employees yet.</p>'; return; }
  const rows = applySort(applyLocFilter(ALL_EMPLOYEES));
  if (!rows.length) { el.innerHTML = '<p class="muted">Nobody at this location.</p>'; return; }
  el.innerHTML = rows.map(empRowHtml).join('');
}

function empRowHtml(p) {
  let rightHtml = '';
  if (ME.role === 'owner') {
    rightHtml = `<div class="emp-toggles">${empToggleDefs(p).map(t => empToggleHtml(p, t)).join('')}</div>`;
  } else if (ME.role === 'manager') {
    rightHtml = `<button class="small ghost" style="margin-top:0; flex-shrink:0;" onclick="event.stopPropagation(); openRequestRaiseModal('${p.id}')">Request raise</button>`;
  }
  return `
    <div class="emp-row" onclick="openEmployeeDetail('${p.id}')">
      <div class="emp-name">${escapeHtml(p.name)}${p.status !== 'active' ? ` <span class="badge off">${escapeHtml(p.status)}</span>` : ''}</div>
      <div class="emp-roleinfo">${escapeHtml(cap(p.role))} &middot; ${escapeHtml(p.position || '—')}</div>
      <div class="emp-locs">${locChipsHtml(p)}</div>
      ${rightHtml}
    </div>`;
}

// Bigger icon-plus-label toggle, per the approved Concept C mockup — still
// one row per employee, just with the toggle itself carrying its own
// label instead of relying on a shared column header.
function empToggleHtml(person, def) {
  const on = !!(person.appAccess && person.appAccess[def.key]);
  return `<div class="emp-tgl ${on ? 'on' : 'off'}" onclick="event.stopPropagation(); toggleAccess('${person.id}','${def.key}',${!on})" title="${escapeHtml(def.label)}">
    <div class="ic">${def.icon}</div>
    <span class="lbl">${def.label}</span>
  </div>`;
}

async function toggleAccess(personId, appKey, enabled) {
  try {
    const result = await withStepUp(() => api(`/api/employees/${personId}/app-access`, { method: 'POST', body: { appKey, enabled } }));
    if (result && result.ok === false) { showMsg(result.error || 'Could not update access.', 'error'); loadAllEmployees(); return; }
    showMsg(`Updated ${appKey.replace('_', ' ')} access.`, 'success');
    await loadAllEmployees();
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

// ---------------------------------------------------------------------
// Employee data card — opened by clicking a roster row. Contact info here
// is the same email/phone/address the roster already fetches for every
// person (server/employees.js's listAllWithAccess) — this just surfaces
// it, rather than pulling anything new or more sensitive. Nothing
// genuinely secure (password/PIN hashes, SSN, banking) is ever sent to
// the client at all; that stays in Jotform (see JOTFORM_HIRE_PACK_URL) or
// hashed server-side only.
//
// Everyone who can open this (owner + manager) sees the same read-only
// card — name, role/position, location, rate (visibility-gated), hire
// date, certifications, contact. Only the owner additionally gets the
// edit section at the bottom (position/location/pay rate/address) and
// the certification-add form, since /api/employees/:id/update and the
// certifications endpoints stay owner-only server-side.
// ---------------------------------------------------------------------
function openEmployeeDetail(id) {
  const p = ALL_EMPLOYEES.find(p => p.id === id);
  if (!p) return;
  const isOwner = ME.role === 'owner';
  document.getElementById('detailPersonId').value = p.id;
  document.getElementById('detailAvatar').textContent = initials(p.name);
  document.getElementById('detailName').textContent = p.name;
  document.getElementById('detailMeta').textContent = `${cap(p.role)} · ${p.position || '—'}${p.status !== 'active' ? ' · ' + p.status : ''}`;
  document.getElementById('detailLocChips').innerHTML = locChipsHtml(p);

  const tiles = [];
  if (rateVisible(p)) tiles.push(detailTileHtml('Hourly rate', p.pay_rate ? '$' + p.pay_rate + '/hr' : '—'));
  tiles.push(detailTileHtml('Hire date', p.hire_date ? fmtDate(p.hire_date) : '—'));
  document.getElementById('detailTiles').innerHTML = tiles.join('');

  renderDetailCerts(p, isOwner);
  document.getElementById('detailCertsAdd').style.display = isOwner ? '' : 'none';
  document.getElementById('certName').value = '';
  document.getElementById('certDate').value = '';

  document.getElementById('detailContact').innerHTML = `
    <div class="detail-contact-row"><span class="ic">${ICONS.phone}</span><span>${p.phone ? escapeHtml(p.phone) : '<span class="muted">not on file</span>'}</span></div>
    <div class="detail-contact-row"><span class="ic">${ICONS.pin}</span><span>${p.address ? escapeHtml(p.address) : '<span class="muted">not on file</span>'}</span></div>
  `;

  document.getElementById('detailEditFields').style.display = isOwner ? '' : 'none';
  if (isOwner) {
    fillPositionSelect(document.getElementById('detailPosition'), p.position || '');
    fillLocationSelect(document.getElementById('detailLocation'));
    if (p.location_id) document.getElementById('detailLocation').value = p.location_id;
    document.getElementById('detailPayRate').value = p.pay_rate || '';
    document.getElementById('detailAddress').value = p.address || '';
  }
  document.getElementById('detailResult').innerHTML = '';

  // Role is deliberately a separate section/action from the fields above —
  // see saveEmployeeRole(). Owner can't demote themselves (would leave the
  // page with no way to complete owner-only actions) or edit a still-pending
  // applicant's role (they aren't a real account yet).
  const roleEditable = isOwner && p.id !== ME.id && p.status === 'active';
  document.getElementById('detailRoleFields').style.display = roleEditable ? '' : 'none';
  if (roleEditable) document.getElementById('detailRole').value = p.role;
  document.getElementById('detailRoleResult').innerHTML = '';

  document.getElementById('employeeDetailModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}

function detailTileHtml(label, value) {
  return `<div class="stat-tile"><div class="l">${escapeHtml(label)}</div><div class="n" style="font-size:19px; margin-top:2px;">${escapeHtml(value)}</div></div>`;
}

function renderDetailCerts(p, isOwner) {
  const certs = p.certifications || [];
  document.getElementById('detailCerts').innerHTML = certs.length
    ? certs.map(c => `
      <div class="cert-row">
        <span class="check">${ICONS.check}</span>
        <span class="cert-name">${escapeHtml(c.name)}</span>
        <span class="cert-date">${c.acquired_on ? fmtDate(c.acquired_on) : ''}</span>
        ${isOwner ? `<span class="cert-remove" onclick="removeCertification('${c.id}')" title="Remove">&times;</span>` : ''}
      </div>`).join('')
    : '<p class="muted">No certifications on file.</p>';
}

async function addCertification() {
  const id = document.getElementById('detailPersonId').value;
  const name = document.getElementById('certName').value.trim();
  const acquiredOn = document.getElementById('certDate').value || null;
  if (!name) return;
  try {
    const result = await withStepUp(() => api(`/api/employees/${id}/certifications`, { method: 'POST', body: { name, acquiredOn } }));
    if (!result.ok) { showMsg(result.error || 'Could not add certification.', 'error'); return; }
    await loadAllEmployees();
    openEmployeeDetail(id);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function removeCertification(certId) {
  const id = document.getElementById('detailPersonId').value;
  try {
    const result = await withStepUp(() => api(`/api/employees/${id}/certifications/${certId}`, { method: 'DELETE' }));
    if (!result.ok) { showMsg(result.error || 'Could not remove certification.', 'error'); return; }
    await loadAllEmployees();
    openEmployeeDetail(id);
  } catch (e) {
    showMsg(e.message, 'error');
  }
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
  const address = document.getElementById('detailAddress').value.trim();
  const resultEl = document.getElementById('detailResult');
  try {
    const result = await withStepUp(() => api(`/api/employees/${id}/update`, {
      method: 'POST', body: { position, locationId, payRate: payRate ? Number(payRate) : null, address },
    }));
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    closeEmployeeDetail();
    showMsg('Employee updated.', 'success');
    await loadAllEmployees();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// Role assignment — deliberately its own action/endpoint (POST
// /api/employees/:id/role), separate from saveEmployeeDetail()'s
// position/location/pay/address save, since it changes what this person can
// access platform-wide rather than just their profile fields.
async function saveEmployeeRole() {
  const id = document.getElementById('detailPersonId').value;
  const role = document.getElementById('detailRole').value;
  const resultEl = document.getElementById('detailRoleResult');
  try {
    const result = await withStepUp(() => api(`/api/employees/${id}/role`, { method: 'POST', body: { role } }));
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    resultEl.innerHTML = '';
    showMsg('Role updated.', 'success');
    await loadAllEmployees();
    openEmployeeDetail(id);
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
  const memoEl = document.getElementById('raiseMemo');
  memoEl.style.display = 'none';
  api('/api/owner-notes/pay_rate_requests').then(note => {
    if (note.body) { memoEl.textContent = note.body; memoEl.style.display = ''; }
  }).catch(() => {});
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
let PAY_RATE_REQUESTS = [];

async function loadPayRateRequests() {
  if (ME.role !== 'owner') return;
  loadPayRateMemo();
  try {
    const list = await api('/api/pay-rate-requests');
    PAY_RATE_REQUESTS = list;
    const el = document.getElementById('payRateRequestsList');
    if (!list.length) { el.innerHTML = '<p class="muted">No pending requests.</p>'; } else {
      el.innerHTML = list.map(r => `
        <div class="list-row">
          <div>
            <div class="name">${escapeHtml(r.person_name)}</div>
            <div class="sub">Requested: $${r.requested_rate}/hr &nbsp;·&nbsp; Current: $${r.current_rate ?? '—'}/hr</div>
            <div class="sub">${r.last_raise_at ? 'Last raise: ' + fmtDateTime(r.last_raise_at) : 'Hire date: ' + (r.hire_date ? fmtDateTime(r.hire_date) : '—')} &nbsp;·&nbsp; requested by ${escapeHtml(r.requested_by_name || 'a manager')}</div>
          </div>
          <div class="stack-actions" style="margin-top:0;">
            <button class="small ghost" onclick="decidePayRateRequest('${r.id}', false)">Deny</button>
            <button class="small primary" style="margin-top:0;" onclick="decidePayRateRequest('${r.id}', true)">Approve</button>
          </div>
        </div>
      `).join('');
    }
    updateTabBadges();
  } catch (e) {
    document.getElementById('payRateRequestsList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// ---- Owner's memo for managers, shown right where they request a raise ----
async function loadPayRateMemo() {
  try {
    const note = await api('/api/owner-notes/pay_rate_requests');
    document.getElementById('payRateMemoInput').value = note.body || '';
  } catch (e) {
    // Non-critical — leave the box blank rather than blocking the page on it.
  }
}
async function savePayRateMemo() {
  const body = document.getElementById('payRateMemoInput').value;
  const resultEl = document.getElementById('payRateMemoResult');
  try {
    await withStepUp(() => api('/api/owner-notes/pay_rate_requests', { method: 'POST', body: { body } }));
    resultEl.innerHTML = '<span class="msg success">Saved.</span>';
    setTimeout(() => { resultEl.innerHTML = ''; }, 2000);
  } catch (e) {
    resultEl.innerHTML = `<span class="msg error">${escapeHtml(e.message)}</span>`;
  }
}

// ---- Master notifications toggle (owner only) — see server/notify.js ----
function renderNotificationsStatus(enabled) {
  const statusEl = document.getElementById('notificationsStatus');
  statusEl.innerHTML = enabled
    ? ''
    : '<p class="msg info" style="margin-top:10px;">Test mode — no real emails or texts will go out platform-wide until this is switched back on.</p>';
}
async function loadNotificationsToggle() {
  try {
    const note = await api('/api/owner-notes/notifications_enabled');
    const enabled = note.body !== 'off';
    document.getElementById('notificationsToggle').checked = enabled;
    renderNotificationsStatus(enabled);
  } catch (e) {
    document.getElementById('notificationsResult').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function submitNotificationsToggle() {
  const checkbox = document.getElementById('notificationsToggle');
  const enabled = checkbox.checked;
  const resultEl = document.getElementById('notificationsResult');
  try {
    await withStepUp(() => api('/api/owner-notes/notifications_enabled', { method: 'POST', body: { body: enabled ? 'on' : 'off' } }));
    renderNotificationsStatus(enabled);
    resultEl.innerHTML = '<span class="msg success">Saved.</span>';
    setTimeout(() => { resultEl.innerHTML = ''; }, 2000);
  } catch (e) {
    checkbox.checked = !enabled; // revert the flip — the save didn't take
    resultEl.innerHTML = `<span class="msg error">${escapeHtml(e.message)}</span>`;
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
  try {
    const list = await api('/api/reset-requests');
    RESET_REQUESTS = list.map(r => ({ ...r, _reveal: null }));
    renderResetRequestsList();
    updateTabBadges();
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
    updateTabBadges();
    showMsg(approve ? 'New credentials generated below.' : 'Request denied.', 'success');
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function closeAllModals() { closeReviewModal(); closeActivateModal(); closeEmployeeDetail(); closeRequestRaiseModal(); }

(async function init() {
  ME = requireRole(['manager', 'owner']);
  if (!ME) return;
  renderTopbar('Employees');
  renderTabs();
  if (ME.role !== 'owner') document.getElementById('ownerOnlyNotice').style.display = '';
  try {
    LOCATIONS = await api('/api/locations');
    // Positions and Locations admin moved to their own page (Apps Home >
    // Positions) — this page only needs the active-position list to feed
    // the Review/Detail dropdowns (fillPositionSelect).
    POSITIONS = await api('/api/positions');
    await loadPending();
    await loadAllEmployees();
  } catch (e) {
    showMsg(e.message, 'error');
  }
  // Same resilience for pay rate requests — its own try/catch, owner-only.
  await loadPayRateRequests();
  // Same again for reset requests — its own try/catch, owner-only.
  await loadResetRequests();
})();
