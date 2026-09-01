let ME = null;
let IS_MANAGER = false;
let LOCATIONS = [];
let STATUS_SYSTEMS = []; // last-loaded systems from loadStatus(), keyed off by toggleHistory() for the equipment-details line
let ROUTING_PEOPLE = []; // last-loaded /api/employees, for the Alert Routing "who" picker

const CATEGORY_LABEL = {
  network: 'Network', hvac: 'HVAC', refrigeration: 'Refrigeration', freezer: 'Freezer',
  ice_machine: 'Ice Machine', power: 'Power', other: 'Other',
};

// Status tab visual language (card-grid dashboard) — one small stroke-based
// icon per category (all 16x16, currentColor) and one color/label per
// status, shared by the stat strip, location cards, and system tiles below.
const STATUS_META = {
  online: { label: 'Online', dot: '#3fbf7f', badgeClass: 'on' },
  warning: { label: 'Warning', dot: '#e0a83e', badgeClass: 'stale' },
  offline: { label: 'Offline', dot: '#e5566d', badgeClass: 'danger' },
  unknown: { label: 'Unknown', dot: '#9aa3b2', badgeClass: 'off' },
};
function statusMeta(status) { return STATUS_META[status] || STATUS_META.unknown; }

const CATEGORY_ICON = {
  network: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="8" rx="2"></rect><circle cx="8" cy="13" r="1"></circle><circle cx="12" cy="13" r="1"></circle><path d="M12 9V6a2 2 0 0 1 2-2h1"></path></svg>',
  hvac: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"></path></svg>',
  refrigeration: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="1.5"></rect><path d="M6 9h12"></path></svg>',
  freezer: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M4.5 6l15 12M19.5 6l-15 12"></path></svg>',
  ice_machine: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"></rect><path d="M5 12h14M12 5v14"></path></svg>',
  power: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"></path></svg>',
  other: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"></rect><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"></circle></svg>',
};
function categoryIcon(cat) { return CATEGORY_ICON[cat] || CATEGORY_ICON.other; }

// Category types with no live data source yet (see server/monitoring.js —
// only 'kind's starting 'unifi_' are actually polled today). Shown as a
// grayed-out roadmap strip at the bottom of the Status tab rather than
// pretending they're monitored.
const UPCOMING_CATEGORIES = ['hvac', 'refrigeration', 'freezer', 'ice_machine', 'power'];

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

function locationName(id) { const l = LOCATIONS.find(l => l.id === id); return l ? l.name : '—'; }

function fillLocationSelect(sel, defaultId) {
  sel.innerHTML = LOCATIONS.map(l => `<option value="${l.id}" ${l.id === defaultId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
}

function statusBadgeClass(status) {
  if (status === 'online') return 'on';
  if (status === 'offline') return 'danger';
  if (status === 'warning') return 'stale';
  return 'off';
}

function relTime(iso) {
  if (!iso) return 'never checked';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function setTab(which) {
  document.getElementById('panelStatus').style.display = which === 'status' ? '' : 'none';
  document.getElementById('panelAlerts').style.display = which === 'alerts' ? '' : 'none';
  document.getElementById('panelAdd').style.display = which === 'add' ? '' : 'none';
  document.getElementById('panelNotifications').style.display = which === 'notifications' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  if (which === 'status') loadStatus();
  if (which === 'alerts') loadAlerts();
  if (which === 'add') renderAdd();
  if (which === 'notifications') renderNotifications();
}

function renderTabs() {
  const tabs = [{ key: 'status', label: 'Status' }, { key: 'alerts', label: 'Alerts' }];
  if (IS_MANAGER) tabs.push({ key: 'add', label: 'Add / Manage' });
  // Alert Routing and the old self-service "Notify Me" tab are one tab now
  // — Scotto was using Alert Routing for himself and didn't want a second,
  // separate button just for his own channel preference.
  tabs.push({ key: 'notifications', label: 'Alert Notifications' });
  document.getElementById('tabs').innerHTML = tabs.map(t =>
    `<button data-tab="${t.key}" onclick="setTab('${t.key}')">${t.label}</button>`).join('');
  setTab('status');
}

// ---------------- Status board (card-grid dashboard) ----------------
async function loadStatus() {
  const el = document.getElementById('panelStatus');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const [systems, alerts] = await Promise.all([
      api('/api/monitoring/systems'),
      api('/api/monitoring/alerts'),
    ]);
    if (!systems.length) {
      el.innerHTML = `<div class="card"><p class="muted">Nothing registered yet.${IS_MANAGER ? ' Add a system from the "Add / Manage" tab once you have a device to point it at.' : ' Check back once your manager has registered something.'}</p></div>`;
      return;
    }

    const openAlerts = alerts.filter(a => !a.closed_at)
      .sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at));

    const counts = { online: 0, warning: 0, offline: 0, unknown: 0 };
    for (const s of systems) counts[STATUS_META[s.last_status] ? s.last_status : 'unknown']++;

    STATUS_SYSTEMS = systems;
    const byLocation = {};
    for (const s of systems) (byLocation[s.location_name] = byLocation[s.location_name] || []).push(s);

    el.innerHTML = `
      ${openAlerts.length ? alertBannerHtml(openAlerts) : ''}
      ${statSummaryHtml(counts)}
      ${Object.keys(byLocation).sort().map(loc => locationCardHtml(loc, byLocation[loc])).join('')}
      ${roadmapCardHtml()}
    `;
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function alertBannerHtml(openAlerts) {
  const top = openAlerts[0];
  const more = openAlerts.length > 1 ? ` <span class="alert-more">(+${openAlerts.length - 1} more)</span>` : '';
  return `<div class="alert-banner">
    <span class="dot"></span>
    <span class="sp"><b>${escapeHtml(top.system_name)}</b> at ${escapeHtml(top.location_name)} — ${escapeHtml(top.message)} · ${relTime(top.opened_at)}${more}</span>
    <span class="link" onclick="setTab('alerts')">View Alerts →</span>
  </div>`;
}

function statSummaryHtml(counts) {
  return `<div class="stat-strip">${['online', 'warning', 'offline', 'unknown'].map(key => {
    const m = statusMeta(key);
    return `<div class="stat-tile"><div class="n">${counts[key]}</div><div class="l"><span class="dot" style="background:${m.dot}"></span>${m.label}</div></div>`;
  }).join('')}</div>`;
}

function locationCardHtml(name, systems) {
  const online = systems.filter(s => (s.last_status || 'unknown') === 'online').length;
  const anyOffline = systems.some(s => s.last_status === 'offline');
  const pillClass = anyOffline ? 'danger' : (online === systems.length ? 'on' : 'stale');
  return `<div class="loc-card">
    <div class="loc-header">
      <div><div class="name">${escapeHtml(name)}</div><div class="sub">${systems.length} system${systems.length === 1 ? '' : 's'}</div></div>
      <span class="badge ${pillClass}">${online} of ${systems.length} online</span>
    </div>
    <div class="sys-grid">${systems.map(systemTileHtml).join('')}</div>
  </div>`;
}

function systemTileHtml(s) {
  const status = s.last_status || 'unknown';
  const m = statusMeta(status);
  return `<div class="sys-tile" style="border-left-color:${m.dot}">
    <div class="sys-tile-head" onclick="toggleHistory('${s.id}')">
      <div class="top-row">
        <div class="sys-icon">${categoryIcon(s.category)}</div>
        <div><div class="sys-name">${escapeHtml(s.name)}</div><div class="sys-sub">${CATEGORY_LABEL[s.category] || s.category} · ${escapeHtml(s.kind)}</div></div>
      </div>
      <div class="status-row"><span class="dot" style="background:${m.dot}"></span><span class="label" style="color:${m.dot}">${m.label}</span></div>
      <div class="sys-checked">checked ${relTime(s.last_checked_at)} · history ▾</div>
    </div>
    <div id="hist-${s.id}" class="sys-hist" style="display:none;"></div>
  </div>`;
}

function roadmapCardHtml() {
  return `<div class="roadmap-card">
    <div class="title">More on the way</div>
    <div class="sub">Phase 2 adds these system types once sensor hardware is chosen — the registry's already built for them.</div>
    <div class="roadmap-row">
      ${UPCOMING_CATEGORIES.map(cat => `<div class="roadmap-item">
        <div class="roadmap-icon">${categoryIcon(cat)}</div>
        <div class="rl">${CATEGORY_LABEL[cat]}</div>
      </div>`).join('')}
    </div>
  </div>`;
}

function equipmentDetailsHtml(s) {
  if (!s) return '';
  const rows = [
    ['Location', s.location_name],
    ['Make', s.make],
    ['Model', s.model],
    ['Serial', s.serial_number],
  ].filter(([, v]) => v);
  if (!rows.length) return '';
  return `<div class="sys-equip">${rows.map(([label, v]) => `<span><b>${label}:</b> ${escapeHtml(v)}</span>`).join(' · ')}</div>`;
}

async function toggleHistory(systemId) {
  const el = document.getElementById(`hist-${systemId}`);
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : '';
  if (isOpen || el.dataset.loaded) return;
  el.innerHTML = '<p class="muted">Loading history…</p>';
  const equip = equipmentDetailsHtml(STATUS_SYSTEMS.find(s => s.id === systemId));
  try {
    const rows = await api(`/api/monitoring/systems/${systemId}/history?hours=24`);
    el.dataset.loaded = '1';
    const table = rows.length
      ? `<table><thead><tr><th>Checked</th><th>Status</th></tr></thead><tbody>
          ${rows.map(r => `<tr><td>${fmtDateTime(r.checked_at)}</td><td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td></tr>`).join('')}
        </tbody></table>`
      : '<p class="muted">No status checks in the last 24h yet.</p>';
    el.innerHTML = equip + table;
  } catch (e) {
    el.innerHTML = equip + `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// ---------------- Alerts ----------------
async function loadAlerts() {
  const el = document.getElementById('panelAlerts');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const alerts = await api('/api/monitoring/alerts');
    if (!alerts.length) { el.innerHTML = '<div class="card"><p class="muted">No alerts yet — good sign.</p></div>'; return; }
    const open = alerts.filter(a => !a.closed_at);
    const closed = alerts.filter(a => a.closed_at);
    el.innerHTML = `
      <div class="card">
        <h2>Open (${open.length})</h2>
        ${open.length ? open.map(alertRowHtml).join('') : '<p class="muted">Nothing open right now.</p>'}
      </div>
      <div class="card">
        <h2>Recent history</h2>
        ${closed.length ? closed.slice(0, 30).map(alertRowHtml).join('') : '<p class="muted">No resolved alerts yet.</p>'}
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function alertRowHtml(a) {
  const open = !a.closed_at;
  return `<div class="list-row">
    <div>
      <div class="name">${escapeHtml(a.system_name)} <span class="badge ${open ? 'danger' : 'off'}">${open ? 'open' : 'resolved'}</span></div>
      <div class="sub">${escapeHtml(a.location_name)} · ${escapeHtml(a.message)}</div>
      <div class="sub">opened ${fmtDateTime(a.opened_at)}${a.closed_at ? ' · closed ' + fmtDateTime(a.closed_at) : ''}</div>
    </div>
  </div>`;
}

// ---------------- Add / Manage (manager/owner) ----------------
function renderAdd() {
  const el = document.getElementById('panelAdd');
  el.innerHTML = `
    <div class="card">
      <h2>Register a system</h2>
      <label for="asLocation">Location</label>
      <select id="asLocation"></select>
      <label for="asCategory">Category</label>
      <select id="asCategory">${Object.keys(CATEGORY_LABEL).map(k => `<option value="${k}">${CATEGORY_LABEL[k]}</option>`).join('')}</select>
      <label for="asKind">Kind</label>
      <input id="asKind" list="kindOptions" placeholder="e.g. unifi_switch, unifi_ap, unifi_gateway">
      <datalist id="kindOptions">
        <option value="unifi_switch"><option value="unifi_ap"><option value="unifi_gateway">
      </datalist>
      <label for="asName">Name</label>
      <input id="asName" placeholder="e.g. Zone 2 Switch">
      <label for="asExternalRef">External ID <span class="muted">(optional — the UniFi device ID, for network kinds)</span></label>
      <input id="asExternalRef" placeholder="Leave blank until you have it">
      <label for="asMake">Make <span class="muted">(optional)</span></label>
      <input id="asMake" placeholder="e.g. Ubiquiti">
      <label for="asModel">Model <span class="muted">(optional)</span></label>
      <input id="asModel" placeholder="e.g. USW-Pro-48-PoE">
      <label for="asSerial">Serial <span class="muted">(optional)</span></label>
      <input id="asSerial" placeholder="Nameplate serial number">
      <button class="primary" onclick="submitAddSystem()">Add system</button>
    </div>
    <div class="card">
      <h2>Registered systems</h2>
      <div id="manageList"><p class="muted">Loading…</p></div>
    </div>`;
  fillLocationSelect(document.getElementById('asLocation'), ME.location_id);
  loadManageList();
}

async function loadManageList() {
  const el = document.getElementById('manageList');
  try {
    const systems = await api('/api/monitoring/systems');
    el.dataset.systemsJson = JSON.stringify(systems);
    if (!systems.length) { el.innerHTML = '<p class="muted">Nothing registered yet — add one above.</p>'; return; }
    // Grouped by location (server already returns them in that order) so
    // the up/down arrows move a system within its own location's list,
    // matching how they're grouped on the Status tab.
    const byLocation = {};
    for (const s of systems) (byLocation[s.location_name] = byLocation[s.location_name] || []).push(s);
    el.innerHTML = Object.keys(byLocation).map((loc) => {
      const rows = byLocation[loc];
      return `<div class="sc-divider"><span>${escapeHtml(loc)}</span></div>` +
        rows.map((s, i) => manageSystemRowHtml(s, i === 0, i === rows.length - 1)).join('');
    }).join('');
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function manageSystemRowHtml(s, isFirst, isLast) {
  return `<div class="list-row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between;">
        <div>
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="sub">${CATEGORY_LABEL[s.category] || s.category} · ${escapeHtml(s.kind)}${s.external_ref ? ' · ' + escapeHtml(s.external_ref) : ' · no external ID yet'}</div>
          ${equipmentDetailsHtml(s)}
        </div>
        <div style="display:flex; gap:8px; align-items:start;">
          <button class="small ghost" ${isFirst ? 'disabled' : ''} onclick="moveSystem('${s.id}','up')" title="Move up">▲</button>
          <button class="small ghost" ${isLast ? 'disabled' : ''} onclick="moveSystem('${s.id}','down')" title="Move down">▼</button>
          <button class="small ghost" onclick="editSystemRow('${s.id}')">Edit</button>
          <button class="small ghost" onclick="archiveSystem('${s.id}')">Remove</button>
        </div>
      </div>
      <div id="edit-${s.id}" style="display:none;"></div>
    </div>`;
}

async function moveSystem(id, direction) {
  try {
    const result = await withStepUp(() => api(`/api/monitoring/systems/${id}/move`, { method: 'POST', body: { direction } }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    loadManageList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function editSystemRow(id) {
  const el = document.getElementById(`edit-${id}`);
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : '';
  if (isOpen) return;
  const systems = JSON.parse(document.getElementById('manageList').dataset.systemsJson || '[]');
  const s = systems.find(x => x.id === id);
  if (!s) return;
  el.innerHTML = `<div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.12);">
    <label>Location</label>
    <select id="es-location-${id}"></select>
    <label>Category</label>
    <select id="es-category-${id}">${Object.keys(CATEGORY_LABEL).map(k => `<option value="${k}" ${k === s.category ? 'selected' : ''}>${CATEGORY_LABEL[k]}</option>`).join('')}</select>
    <label>Kind</label>
    <input id="es-kind-${id}" value="${escapeHtml(s.kind)}">
    <label>Name</label>
    <input id="es-name-${id}" value="${escapeHtml(s.name)}">
    <label>Make</label>
    <input id="es-make-${id}" value="${escapeHtml(s.make || '')}">
    <label>Model</label>
    <input id="es-model-${id}" value="${escapeHtml(s.model || '')}">
    <label>Serial</label>
    <input id="es-serial-${id}" value="${escapeHtml(s.serial_number || '')}">
    <div class="stack-actions">
      <button class="ghost" onclick="editSystemRow('${id}')">Cancel</button>
      <button class="primary" style="margin-top:0;" onclick="submitEditSystem('${id}')">Save</button>
    </div>
  </div>`;
  fillLocationSelect(document.getElementById(`es-location-${id}`), s.location_id);
}

async function submitEditSystem(id) {
  const locationId = document.getElementById(`es-location-${id}`).value;
  const category = document.getElementById(`es-category-${id}`).value;
  const kind = document.getElementById(`es-kind-${id}`).value.trim();
  const name = document.getElementById(`es-name-${id}`).value.trim();
  const make = document.getElementById(`es-make-${id}`).value.trim();
  const model = document.getElementById(`es-model-${id}`).value.trim();
  const serialNumber = document.getElementById(`es-serial-${id}`).value.trim();
  if (!kind || !name) { showMsg('Kind and name are both required.', 'error'); return; }
  try {
    const result = await withStepUp(() => api(`/api/monitoring/systems/${id}/update`, {
      method: 'POST', body: { locationId, category, kind, name, make: make || null, model: model || null, serialNumber: serialNumber || null },
    }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Saved.', 'success');
    loadManageList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function submitAddSystem() {
  const locationId = document.getElementById('asLocation').value;
  const category = document.getElementById('asCategory').value;
  const kind = document.getElementById('asKind').value.trim();
  const name = document.getElementById('asName').value.trim();
  const externalRef = document.getElementById('asExternalRef').value.trim();
  const make = document.getElementById('asMake').value.trim();
  const model = document.getElementById('asModel').value.trim();
  const serialNumber = document.getElementById('asSerial').value.trim();
  if (!kind || !name) { showMsg('Kind and name are both required.', 'error'); return; }
  try {
    const result = await withStepUp(() => api('/api/monitoring/systems', {
      method: 'POST', body: { locationId, category, kind, name, externalRef: externalRef || null, config: {}, make: make || null, model: model || null, serialNumber: serialNumber || null },
    }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Added.', 'success');
    document.getElementById('asKind').value = '';
    document.getElementById('asName').value = '';
    document.getElementById('asExternalRef').value = '';
    document.getElementById('asMake').value = '';
    document.getElementById('asModel').value = '';
    document.getElementById('asSerial').value = '';
    loadManageList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function archiveSystem(id) {
  if (!confirm('Remove this from monitoring? Its history is kept, it just stops appearing.')) return;
  try {
    const result = await withStepUp(() => api(`/api/monitoring/systems/${id}/archive`, { method: 'POST' }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    loadManageList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------- Alert Notifications (routing admin + everyone's own channel) ----------------
// "Notify this person about this category at this location" — independent
// of that person's own Monitoring dashboard access (server/monitoring.js's
// recipientsFor() unions this with the self-service opt-in + owner set).
// A manager only ever sees/creates routes for their own location; the
// server enforces that too (see /api/monitoring/alert-routes in
// server/index.js) — the location picker here is hidden for a manager
// rather than just disabled, so there's nothing misleading to click.
//
// The routing admin section (manager/owner only) and everyone's own "how
// should we reach you" channel preference (previously a separate "Notify
// Me" tab) live in one "Alert Notifications" tab now — same idea, one
// place to set it, whether you're routing alerts to other people or just
// setting your own.
async function renderNotifications() {
  const el = document.getElementById('panelNotifications');
  el.innerHTML = `
    ${IS_MANAGER ? `
    <div class="card">
      <h2>Route alerts to someone</h2>
      <p class="muted">Assign a person to be notified about a category of alerts — even if they don't have Monitoring dashboard access themselves. Leave category blank for "every category".</p>
      <label for="arPerson">Who</label>
      <select id="arPerson"></select>
      ${ME.role === 'owner' ? `<label for="arLocation">Location</label><select id="arLocation"><option value="">All locations</option></select>` : ''}
      <label for="arCategory">Category</label>
      <select id="arCategory"><option value="">All categories</option>${Object.keys(CATEGORY_LABEL).map(k => `<option value="${k}">${CATEGORY_LABEL[k]}</option>`).join('')}</select>
      <button class="primary" onclick="submitAddRoute()">Add routing</button>
    </div>
    <div class="card">
      <h2>Current routing</h2>
      <div id="routingList"><p class="muted">Loading…</p></div>
    </div>` : ''}
    <div class="card">
      <h2>How should we reach you?</h2>
      <p class="muted">Your own alert notifications.</p>
      <label for="notifyChannel">Channel</label>
      <select id="notifyChannel">
        <option value="email">Email</option>
        <option value="sms">Text (SMS)</option>
        <option value="both">Both</option>
      </select>
      <p class="muted" id="smsNote" style="display:none;">Heads up — SMS isn't fully wired up yet on our end, so text alerts won't actually arrive until that's turned on. Email will still work.</p>
      <button class="primary" onclick="submitNotifyChannel()">Save</button>
    </div>`;
  if (IS_MANAGER) {
    try {
      ROUTING_PEOPLE = (await api('/api/employees')).filter(p => p.status === 'active');
      const sel = document.getElementById('arPerson');
      sel.innerHTML = ROUTING_PEOPLE.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.position ? ' — ' + escapeHtml(p.position) : ''}</option>`).join('');
      if (ME.role === 'owner') {
        // Deliberately not fillLocationSelect() — that replaces the whole
        // <select> contents, which would wipe out the "All locations" option
        // already in the markup above.
        const locSel = document.getElementById('arLocation');
        locSel.innerHTML += LOCATIONS.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
      }
    } catch (e) {
      showMsg(e.message, 'error');
    }
    loadRoutingList();
  }
  document.getElementById('notifyChannel').addEventListener('change', updateSmsNote);
  loadNotifySettings();
}

async function loadRoutingList() {
  const el = document.getElementById('routingList');
  try {
    const routes = await api('/api/monitoring/alert-routes');
    el.innerHTML = routes.length ? routes.map(r => `<div class="list-row">
        <div>
          <div class="name">${escapeHtml(r.person_name)}</div>
          <div class="sub">${r.location_name ? escapeHtml(r.location_name) : 'All locations'} · ${r.category ? (CATEGORY_LABEL[r.category] || r.category) : 'All categories'}</div>
        </div>
        <button class="small ghost" onclick="removeRoute('${r.id}')">Remove</button>
      </div>`).join('') : '<p class="muted">No routing set up — everyone with Monitoring access gets every alert for their location, plus you.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function submitAddRoute() {
  const personId = document.getElementById('arPerson').value;
  if (!personId) { showMsg('Choose who to notify.', 'error'); return; }
  const locationEl = document.getElementById('arLocation');
  const locationId = locationEl ? locationEl.value : undefined; // omitted entirely for a manager — server forces their own location
  const category = document.getElementById('arCategory').value;
  try {
    const result = await withStepUp(() => api('/api/monitoring/alert-routes', {
      method: 'POST', body: { personId, locationId: locationId || null, category: category || null },
    }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Added.', 'success');
    loadRoutingList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function removeRoute(id) {
  try {
    const result = await withStepUp(() => api(`/api/monitoring/alert-routes/${id}/remove`, { method: 'POST' }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    loadRoutingList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------- Notification channel helpers (used by renderNotifications) ----------------
function updateSmsNote() {
  const v = document.getElementById('notifyChannel').value;
  document.getElementById('smsNote').style.display = (v === 'sms' || v === 'both') ? '' : 'none';
}

async function loadNotifySettings() {
  try {
    const settings = await api('/api/monitoring/notify-settings');
    document.getElementById('notifyChannel').value = settings.notify_channel || 'email';
    updateSmsNote();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function submitNotifyChannel() {
  const channel = document.getElementById('notifyChannel').value;
  try {
    const result = await api('/api/monitoring/notify-settings', { method: 'POST', body: { channel } });
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Saved.', 'success');
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

(async function init() {
  ME = requireAuth();
  if (!ME) return;
  renderTopbar('Systems Monitoring');
  IS_MANAGER = ME.role === 'manager' || ME.role === 'owner';
  const access = getAppAccess();
  const hasAccess = IS_MANAGER || access.some(a => a.app_key === 'monitoring' && a.enabled);
  if (!hasAccess) {
    document.getElementById('app').innerHTML = '<div class="card"><p>Systems Monitoring isn\'t enabled for your account yet — ask your manager.</p><p><a href="/dashboard.html">Back home</a></p></div>';
    return;
  }
  try {
    // Ticket 3 is being sold and is deliberately out of scope for
    // monitoring (see db/patch_010_monitoring.sql) — filtered here so it
    // never shows up in the Status/Alerts location filters or the
    // Add/Manage "Location" picker, even though it's still an active
    // location for the rest of Bar Ops (time clock, service calls, etc.).
    LOCATIONS = (await api('/api/locations')).filter(l => l.name !== 'Ticket 3');
    renderTabs();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
