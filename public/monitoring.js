let ME = null;
let IS_MANAGER = false;
let LOCATIONS = [];

const CATEGORY_LABEL = {
  network: 'Network', hvac: 'HVAC', refrigeration: 'Refrigeration', freezer: 'Freezer',
  ice_machine: 'Ice Machine', power: 'Power', other: 'Other',
};

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
  document.getElementById('panelNotify').style.display = which === 'notify' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  if (which === 'status') loadStatus();
  if (which === 'alerts') loadAlerts();
  if (which === 'add') renderAdd();
  if (which === 'notify') renderNotify();
}

function renderTabs() {
  const tabs = [{ key: 'status', label: 'Status' }, { key: 'alerts', label: 'Alerts' }];
  if (IS_MANAGER) tabs.push({ key: 'add', label: 'Add / Manage' });
  tabs.push({ key: 'notify', label: 'Notify Me' });
  document.getElementById('tabs').innerHTML = tabs.map(t =>
    `<button data-tab="${t.key}" onclick="setTab('${t.key}')">${t.label}</button>`).join('');
  setTab('status');
}

// ---------------- Status board ----------------
async function loadStatus() {
  const el = document.getElementById('panelStatus');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const systems = await api('/api/monitoring/systems');
    if (!systems.length) {
      el.innerHTML = `<div class="card"><p class="muted">Nothing registered yet.${IS_MANAGER ? ' Add a system from the "Add / Manage" tab once you have a device to point it at.' : ' Check back once your manager has registered something.'}</p></div>`;
      return;
    }
    const byLocation = {};
    for (const s of systems) (byLocation[s.location_name] = byLocation[s.location_name] || []).push(s);

    el.innerHTML = Object.keys(byLocation).sort().map(loc => `
      <div class="card">
        <h2>${escapeHtml(loc)}</h2>
        ${byLocation[loc].map(systemRowHtml).join('')}
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function systemRowHtml(s) {
  const status = s.last_status || 'unknown';
  return `<div class="list-row" style="flex-direction:column; align-items:stretch;">
    <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="toggleHistory('${s.id}')">
      <div>
        <div class="name">${escapeHtml(s.name)} <span class="badge ${statusBadgeClass(status)}">${escapeHtml(status)}</span></div>
        <div class="sub">${CATEGORY_LABEL[s.category] || s.category} · ${escapeHtml(s.kind)} · checked ${relTime(s.last_checked_at)}</div>
      </div>
      <span class="muted">history ▾</span>
    </div>
    <div id="hist-${s.id}" style="display:none; margin-top:10px;"></div>
  </div>`;
}

async function toggleHistory(systemId) {
  const el = document.getElementById(`hist-${systemId}`);
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : '';
  if (isOpen || el.dataset.loaded) return;
  el.innerHTML = '<p class="muted">Loading history…</p>';
  try {
    const rows = await api(`/api/monitoring/systems/${systemId}/history?hours=24`);
    el.dataset.loaded = '1';
    if (!rows.length) { el.innerHTML = '<p class="muted">No status checks in the last 24h yet.</p>'; return; }
    el.innerHTML = `<table><thead><tr><th>Checked</th><th>Status</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${fmtDateTime(r.checked_at)}</td><td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td></tr>`).join('')}
    </tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
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
    el.innerHTML = systems.length ? systems.map(s => `<div class="list-row">
        <div>
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="sub">${escapeHtml(s.location_name)} · ${CATEGORY_LABEL[s.category] || s.category} · ${escapeHtml(s.kind)}${s.external_ref ? ' · ' + escapeHtml(s.external_ref) : ' · no external ID yet'}</div>
        </div>
        <button class="small ghost" onclick="archiveSystem('${s.id}')">Remove</button>
      </div>`).join('') : '<p class="muted">Nothing registered yet — add one above.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function submitAddSystem() {
  const locationId = document.getElementById('asLocation').value;
  const category = document.getElementById('asCategory').value;
  const kind = document.getElementById('asKind').value.trim();
  const name = document.getElementById('asName').value.trim();
  const externalRef = document.getElementById('asExternalRef').value.trim();
  if (!kind || !name) { showMsg('Kind and name are both required.', 'error'); return; }
  try {
    const result = await withStepUp(() => api('/api/monitoring/systems', {
      method: 'POST', body: { locationId, category, kind, name, externalRef: externalRef || null, config: {} },
    }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Added.', 'success');
    document.getElementById('asKind').value = '';
    document.getElementById('asName').value = '';
    document.getElementById('asExternalRef').value = '';
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

// ---------------- Notify Me (self-service) ----------------
function renderNotify() {
  const el = document.getElementById('panelNotify');
  el.innerHTML = `<div class="card">
    <h2>How should we reach you?</h2>
    <p class="muted">Applies to Systems Monitoring alerts only — Time Clock reminders are separate.</p>
    <label for="notifyChannel">Channel</label>
    <select id="notifyChannel">
      <option value="email">Email</option>
      <option value="sms">Text (SMS)</option>
      <option value="both">Both</option>
    </select>
    <p class="muted" id="smsNote" style="display:none;">Heads up — SMS isn't fully wired up yet on our end, so text alerts won't actually arrive until that's turned on. Email will still work.</p>
    <button class="primary" onclick="submitNotifyChannel()">Save</button>
  </div>`;
  document.getElementById('notifyChannel').addEventListener('change', updateSmsNote);
  loadNotifySettings();
}

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
    LOCATIONS = await api('/api/locations');
    renderTabs();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
