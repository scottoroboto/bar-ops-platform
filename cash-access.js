// Manage Access — Cash Handling Phase 3. Owner-only, both by server-side
// gate (every /api/cashhandling/access/* route 403s anyone else) and by
// this page immediately bouncing a non-owner back out. Three sections:
// Position Defaults (what a Position gets by default — the fallback
// everyone without a personal override uses), People (every active
// person's effective access, with per-person override/revert controls),
// and a Change Log (append-only history of every override set/reverted).
let ME = null;
let TIER_LABELS = { full_authority: 'Full authority', drawers_bags: 'Drawers & Bags', own_drawer: 'Own drawer', no_access: 'No access' };
let ALL_PEOPLE = [];
let editingPersonId = null;

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

function tierBadge(tier) {
  return `<span class="badge ${tier === 'no_access' ? 'off' : 'on'}">${TIER_LABELS[tier] || tier}</span>`;
}

// ---------------------------------------------------------------------
// Position Defaults
// ---------------------------------------------------------------------
async function loadDefaults() {
  const el = document.getElementById('defaultsList');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const result = await api('/api/cashhandling/access/defaults');
    el.innerHTML = defaultsHtml(result.defaults || []);
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function defaultsHtml(defaults) {
  if (!defaults.length) return '<p class="muted">No positions yet — add one from Employees admin first.</p>';
  return defaults.map(d => `
    <div class="list-row">
      <div class="name">${escapeHtml(d.position_name)}</div>
      <select id="default-${d.position_id}" style="width:auto; margin:0;">
        ${Object.entries(TIER_LABELS).map(([k, v]) => `<option value="${k}" ${d.tier === k || (!d.tier && k === 'no_access') ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <button class="small secondary" style="margin-top:0; margin-left:8px;" onclick="saveDefault('${d.position_id}')">Save</button>
    </div>`).join('');
}

async function saveDefault(positionId) {
  const tier = document.getElementById(`default-${positionId}`).value;
  try {
    await withStepUp(() => api('/api/cashhandling/access/defaults', { method: 'POST', body: { positionId, tier } }));
    showMsg('Position default updated.', 'success');
    loadDefaults();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// People — effective access + per-person override
// ---------------------------------------------------------------------
async function loadPeople() {
  const el = document.getElementById('peopleList');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const result = await api('/api/cashhandling/access/overrides');
    ALL_PEOPLE = result.people || [];
    el.innerHTML = peopleHtml(ALL_PEOPLE);
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function peopleHtml(people) {
  if (!people.length) return '<p class="muted">No one yet.</p>';
  return people.map(p => {
    if (p.id === editingPersonId) return editPersonRowHtml(p);
    const overrideNote = p.override_tier
      ? `<span class="badge stale">override${p.override_note ? ': ' + escapeHtml(p.override_note) : ''}</span>`
      : '';
    return `
      <div class="list-row">
        <div>
          <div class="name">${escapeHtml(p.name)}${p.role === 'owner' ? ' <span class="badge on">owner</span>' : ''}</div>
          <div class="sub">${escapeHtml(p.position || '—')} · ${escapeHtml(p.location_name || 'no location')}${!p.app_enabled ? ' · Cash Handling off' : ''}</div>
        </div>
        <div style="text-align:right;">
          ${tierBadge(p.effective_tier)} ${overrideNote}
          ${p.role === 'owner' ? '' : `<div class="stack-actions" style="margin-top:6px;">
            <button class="small ghost" onclick="startEditPerson('${p.id}')">Change access</button>
            ${p.override_tier ? `<button class="small ghost" onclick="revertPerson('${p.id}')">Revert to default</button>` : ''}
          </div>`}
        </div>
      </div>`;
  }).join('');
}

function editPersonRowHtml(p) {
  return `
    <div class="list-row" style="flex-direction:column; align-items:stretch;">
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="sub">${escapeHtml(p.position || '—')} · position default: ${TIER_LABELS[p.position_tier] || 'No access'}</div>
      <label>Access level</label>
      <select id="editPersonTier">
        ${Object.entries(TIER_LABELS).map(([k, v]) => `<option value="${k}" ${p.effective_tier === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <label>Note (optional)</label>
      <input id="editPersonNote" placeholder="Why this override — e.g. filling in until we hire a GM">
      <div class="stack-actions">
        <button class="ghost small" onclick="cancelEditPerson()">Cancel</button>
        <button class="primary small" style="margin-top:0;" onclick="saveEditPerson('${p.id}')">Save override</button>
      </div>
    </div>`;
}

function startEditPerson(id) { editingPersonId = id; renderPeople(); }
function cancelEditPerson() { editingPersonId = null; renderPeople(); }
function renderPeople() { document.getElementById('peopleList').innerHTML = peopleHtml(ALL_PEOPLE); }

async function saveEditPerson(personId) {
  const tier = document.getElementById('editPersonTier').value;
  const note = document.getElementById('editPersonNote').value.trim();
  try {
    await withStepUp(() => api('/api/cashhandling/access/overrides', { method: 'POST', body: { personId, tier, note: note || undefined } }));
    editingPersonId = null;
    showMsg('Access updated.', 'success');
    loadPeople();
    loadLog();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function revertPerson(personId) {
  try {
    await withStepUp(() => api(`/api/cashhandling/access/overrides/${personId}/revert`, { method: 'POST' }));
    showMsg('Reverted to the position default.', 'success');
    loadPeople();
    loadLog();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------
async function loadLog() {
  const el = document.getElementById('logList');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const result = await api('/api/cashhandling/access/log');
    el.innerHTML = logHtml(result.log || []);
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function logHtml(entries) {
  if (!entries.length) return '<p class="muted">No changes yet.</p>';
  return entries.map(e => `
    <div class="list-row">
      <div>
        <div class="name">${escapeHtml(e.person_name)}</div>
        <div class="sub">${fmtDateTime(e.changed_at)} · by ${escapeHtml(e.changed_by_name)}${e.note ? ' · “' + escapeHtml(e.note) + '”' : ''}</div>
      </div>
      <div>${TIER_LABELS[e.old_tier] || e.old_tier || '—'} → ${TIER_LABELS[e.new_tier] || e.new_tier}</div>
    </div>`).join('');
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
(async function init() {
  ME = requireAuth();
  if (!ME) return;
  renderTopbar('Manage Access');
  if (ME.role !== 'owner') {
    document.getElementById('panelMain').innerHTML =
      '<div class="card"><p>Only the owner can manage Cash Handling access.</p><p><a href="/cashhandling.html">Back to Cash Handling</a></p></div>';
    return;
  }
  document.getElementById('panelMain').innerHTML = `
    <h1 class="page-title">Manage Access</h1>
    <p class="muted" style="margin-top:-6px;">Only the owner can grant or change Cash Handling access — this never delegates to managers.</p>
    <div class="card"><h2>Position defaults</h2><div id="defaultsList"></div></div>
    <div class="card"><h2>People</h2><div id="peopleList"></div></div>
    <div class="card"><h2>Change log</h2><div id="logList"></div></div>
  `;
  loadDefaults();
  loadPeople();
  loadLog();
})();
