// Cash Handling — Phase 1: source dashboard + blind cash-out.
// Structured like public/monitoring.js (tabs + panel swap, statusMeta-style
// color/label helper, sys-grid/sys-tile reused as-is from styles.css).
//
// Access here is a tier (full_authority/drawers_bags/own_drawer/no_access)
// from /api/cashhandling/access, NOT the ordinary appAccess enabled flag —
// see server/cashhandling.js. own_drawer gets no dashboard at all, per
// spec: they land straight on the blind count-entry screen for their own
// drawer(s), nothing else.
let ME = null;
let TIER = 'no_access';
let LOCATIONS = [];
let SELECTED_LOCATION_ID = null;
let DASHBOARD_SOURCES = []; // last-loaded dashboard rows, kept only for the tile grid — never read by the count-entry screen (see openCountEntry)
let OWN_DRAWERS = []; // own_drawer tier's assigned drawer(s), for the picker when there's more than one

const KIND_ICON = {
  drawer: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M3 11h18"/><path d="M10 14.5h4"/></svg>',
  backup_bag: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
};
const FIXED_ICON = {
  'ATM': '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><rect x="8" y="6" width="8" height="6" rx="1"/><path d="M8 16h.01M12 16h.01M16 16h.01M8 19h.01M12 19h.01"/></svg>',
  'Change Machine': '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v5c0 1.66 3.13 3 7 3s7-1.34 7-3V6"/><path d="M5 11v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5"/></svg>',
  'Safe': '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4"/><path d="M12 8v1M12 15v1M8 12h1M15 12h1"/><path d="M17 3v3M7 3v3M17 18v3M7 18v3"/></svg>',
};
const GENERIC_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>';

function sourceIcon(s) { return s.kind === 'fixed_point' ? (FIXED_ICON[s.name] || GENERIC_ICON) : (KIND_ICON[s.kind] || GENERIC_ICON); }

function fmtMoney(n) {
  const v = Number(n || 0);
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

// Status color/label for a dashboard tile — mirrors monitoring.js's
// statusMeta() shape (dot color + label), driven off the source's last
// logged count rather than a live poll.
function sourceStatus(s) {
  if (!s.last_counted_at) return { dot: '#9aa3b2', label: 'Not counted yet' };
  const v = Number(s.last_variance);
  if (v === 0) return { dot: '#3fbf7f', label: 'OK' };
  if (v < 0) return { dot: '#e5566d', label: `${fmtMoney(Math.abs(v))} short` };
  return { dot: '#e0a83e', label: `${fmtMoney(v)} over` };
}

function locationName(id) { const l = LOCATIONS.find(l => l.id === id); return l ? l.name : '—'; }

// api() (common.js) always JSON.stringifies its body and forces
// application/json — fine for everything else in this app, but wrong for
// a multipart receipt upload. This is the one place in the app that
// sends a file, so a tiny sibling helper lives here rather than changing
// api() for every other page. Mirrors api()'s auth header, timeout, and
// SESSION_EXPIRED/error handling; just skips the JSON body handling and
// lets the browser set its own multipart boundary (no Content-Type set
// explicitly — fetch does this correctly on its own for a FormData body,
// and setting one manually strips the boundary).
async function apiUpload(path, formData) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers, body: formData, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('That took too long to respond. The server may be waking up — please try again.');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (res.status === 401 && data && data.error === 'SESSION_EXPIRED') {
    goLogin('Your session ended — please sign in again.');
    throw Object.assign(new Error('Session expired'), { code: 'SESSION_EXPIRED' });
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Request failed (${res.status})`);
    err.code = data && data.error;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------
// Manager / owner dashboard (drawers_bags, full_authority)
// ---------------------------------------------------------------------
function renderManagerShell() {
  const isOwner = ME.role === 'owner';
  document.getElementById('panelMain').innerHTML = `
    <h1 class="page-title">Cash Handling</h1>
    <div class="ch-loc-row">
      ${isOwner
        ? `<select id="locSelect" onchange="onLocationChange()"></select>`
        : `<span class="badge on">${escapeHtml(locationName(SELECTED_LOCATION_ID))}</span>`}
      ${isOwner ? `<a href="/cash-access.html" class="muted">Manage access ›</a>` : ''}
    </div>
    <div class="tabs" id="tabs">
      <button data-tab="dashboard" onclick="setTab('dashboard')">Dashboard</button>
      <button data-tab="history" onclick="setTab('history')">History</button>
      ${TIER === 'full_authority' ? `<button data-tab="transactions" onclick="setTab('transactions')">Transactions</button>` : ''}
      <button data-tab="weekly" onclick="setTab('weekly')">Weekly Audit</button>
      <button data-tab="manual" onclick="setTab('manual')">Random Audit</button>
      ${isOwner ? `<button data-tab="sources" onclick="setTab('sources')">Manage sources</button>` : ''}
    </div>
    <div id="panelDashboard"></div>
    <div id="panelHistory" style="display:none;"></div>
    ${TIER === 'full_authority' ? `<div id="panelTransactions" style="display:none;"></div>` : ''}
    <div id="panelWeekly" style="display:none;"></div>
    <div id="panelManual" style="display:none;"></div>
    ${isOwner ? `<div id="panelSources" style="display:none;"></div>` : ''}
  `;
  if (isOwner) {
    const sel = document.getElementById('locSelect');
    sel.innerHTML = LOCATIONS.map(l => `<option value="${l.id}" ${l.id === SELECTED_LOCATION_ID ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
  }
  setTab('dashboard');
}

// Split out from setTab() so quickTransaction() (below) can switch to the
// Transactions tab's panel without also triggering loadTransactions() —
// it's about to replace that panel's content with the new-transaction
// form itself, and running both would race to write panelTransactions'
// innerHTML (whichever finishes last wins, so the form could flash and
// then get clobbered by the plain history list a moment later).
function showTabPanel(which) {
  document.getElementById('panelDashboard').style.display = which === 'dashboard' ? '' : 'none';
  document.getElementById('panelHistory').style.display = which === 'history' ? '' : 'none';
  const txnPanel = document.getElementById('panelTransactions');
  if (txnPanel) txnPanel.style.display = which === 'transactions' ? '' : 'none';
  document.getElementById('panelWeekly').style.display = which === 'weekly' ? '' : 'none';
  document.getElementById('panelManual').style.display = which === 'manual' ? '' : 'none';
  const sourcesPanel = document.getElementById('panelSources');
  if (sourcesPanel) sourcesPanel.style.display = which === 'sources' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
}

function setTab(which) {
  showTabPanel(which);
  if (which === 'dashboard') loadDashboard();
  if (which === 'history') loadHistory();
  if (which === 'transactions') loadTransactions();
  if (which === 'weekly') loadAuditLanding('weekly');
  if (which === 'manual') loadAuditLanding('manual');
  if (which === 'sources') loadManageSources();
}

// Dashboard-tab quick actions (full_authority only, see dashboardHtml) —
// jump straight to the Transactions tab with the New Transaction form
// already open and pre-set to the right type, instead of making someone
// find the Transactions tab, click "+ New transaction", then pick the
// type from a dropdown themselves.
async function quickTransaction(type) {
  showTabPanel('transactions');
  await openNewTransactionForm();
  document.getElementById('txnType').value = type;
  onTransactionTypeChange();
}

function onLocationChange() {
  SELECTED_LOCATION_ID = document.getElementById('locSelect').value;
  loadDashboard();
  loadHistory();
  if (TIER === 'full_authority') loadTransactions();
  if (ME.role === 'owner') loadManageSources();
}

async function loadDashboard() {
  const el = document.getElementById('panelDashboard');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const result = await api('/api/cashhandling/dashboard' + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    DASHBOARD_SOURCES = result.sources || [];
    el.innerHTML = dashboardHtml(DASHBOARD_SOURCES, result.tier);
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function dashboardHtml(sources, tier) {
  const drawers = sources.filter(s => s.kind === 'drawer');
  const bagById = {};
  sources.filter(s => s.kind === 'backup_bag').forEach(b => { bagById[b.id] = b; });
  const orphanBags = sources.filter(s => s.kind === 'backup_bag' && !drawers.some(d => d.linked_source_id === s.id));
  const fixedPoints = sources.filter(s => s.kind === 'fixed_point');

  const registerTotal = drawers.reduce((sum, d) => sum + Number(d.last_counted_amount ?? d.target_amount ?? 0), 0)
    + sources.filter(s => s.kind === 'backup_bag').reduce((sum, b) => sum + Number(b.last_counted_amount ?? b.target_amount ?? 0), 0);
  const fixedTotal = fixedPoints.reduce((sum, f) => sum + Number(f.last_counted_amount ?? f.target_amount ?? 0), 0);
  const varianceCount = sources.filter(s => s.last_counted_at && Number(s.last_variance) !== 0).length;

  // Quick actions — full_authority only, matching the server-side gate on
  // POST /api/cashhandling/transactions (tierAtLeast(tier, 'full_authority')).
  // Jumps into the Transactions tab's New Transaction form pre-set to the
  // right type; see quickTransaction() above setTab().
  let html = '';
  if (tier === 'full_authority') {
    html += `
    <div class="ch-quick-actions">
      <button class="ch-quick-btn primary" onclick="quickTransaction('deposit')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-6 9 6"/><path d="M5 10v9M9 10v9M15 10v9M19 10v9"/><path d="M3 19h18"/></svg>
        Bank Deposit
      </button>
      <button class="ch-quick-btn secondary" onclick="quickTransaction('bank_change')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>
        Bank Change
      </button>
    </div>`;
  }

  html += `
    <div class="stat-strip">
      <div class="stat-tile"><div class="n">${fmtMoney(registerTotal + fixedTotal)}</div><div class="l">Total cash on hand · ${sources.length} sources</div></div>
      <div class="stat-tile"><div class="n ${varianceCount ? 'danger' : ''}">${varianceCount}</div><div class="l"><span class="dot" style="background:${varianceCount ? '#e5566d' : '#3fbf7f'}"></span>Variance flagged</div></div>
    </div>`;

  if (drawers.length || orphanBags.length) {
    html += `
      <div class="ch-group">
        <div class="ch-group-head">
          <div class="ch-group-title">Registers · Drawers &amp; Backup Bags</div>
          <div class="ch-group-total">current total <b>${fmtMoney(registerTotal)}</b></div>
        </div>
        <div class="sys-grid">
          ${drawers.map(d => drawerTileHtml(d, bagById[d.linked_source_id])).join('')}
          ${orphanBags.map(b => sourceTileHtml(b)).join('')}
        </div>
      </div>`;
  }

  if (fixedPoints.length) {
    html += `
      <div class="ch-group">
        <div class="ch-group-head">
          <div class="ch-group-title">Fixed Cash Points</div>
          <div class="ch-group-total">current total <b>${fmtMoney(fixedTotal)}</b></div>
        </div>
        <div class="sys-grid">${fixedPoints.map(sourceTileHtml).join('')}</div>
      </div>`;
  }

  if (!drawers.length && !orphanBags.length && !fixedPoints.length) {
    html += `<div class="card"><p class="muted">No cash sources at this location yet.</p></div>`;
  }

  return html;
}

function sourceTileHtml(s) {
  const m = sourceStatus(s);
  return `<div class="sys-tile" style="border-left-color:${m.dot}">
    <div class="sys-tile-head" onclick="openCountEntryFromDashboard('${s.id}')">
      <div class="top-row">
        <div class="sys-icon">${sourceIcon(s)}</div>
        <div><div class="sys-name">${escapeHtml(s.name)}</div><div class="sys-sub">${escapeHtml(s.location_name || '')}</div></div>
      </div>
      <div class="status-row"><span class="dot" style="background:${m.dot}"></span><span class="label" style="color:${m.dot}">${m.label}</span></div>
    </div>
  </div>`;
}

function drawerTileHtml(d, bag) {
  const m = sourceStatus(d);
  const bagMeta = bag ? sourceStatus(bag) : null;
  return `<div class="sys-tile" style="border-left-color:${m.dot}">
    <div class="sys-tile-head" onclick="openCountEntryFromDashboard('${d.id}')">
      <div class="top-row">
        <div class="sys-icon">${sourceIcon(d)}</div>
        <div><div class="sys-name">${escapeHtml(d.name)}</div><div class="sys-sub">${escapeHtml(d.location_name || '')}${d.assigned_person_name ? ' · ' + escapeHtml(d.assigned_person_name) : ''}</div></div>
      </div>
      <div class="status-row"><span class="dot" style="background:${m.dot}"></span><span class="label" style="color:${m.dot}">${m.label}</span></div>
      ${bag ? `<div class="bag-chip"><span class="dot" style="background:${bagMeta.dot}"></span>${escapeHtml(bag.name)} · ${bagMeta.label}</div>` : ''}
    </div>
  </div>`;
}

function openCountEntryFromDashboard(sourceId) {
  const source = DASHBOARD_SOURCES.find(s => s.id === sourceId);
  if (!source) return;
  renderCountEntry(source, { returnTo: 'dashboard' });
}

function openOwnDrawerCountEntry(sourceId) {
  const source = OWN_DRAWERS.find(s => s.id === sourceId);
  if (!source) return;
  renderCountEntry(source, { returnTo: 'own' });
}

async function loadHistory() {
  const el = document.getElementById('panelHistory');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const result = await api('/api/cashhandling/counts' + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    el.innerHTML = historyHtml(result.counts || []);
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function historyHtml(counts) {
  if (!counts.length) return `<div class="card"><p class="muted">No counts logged yet.</p></div>`;
  return `<div class="card">${counts.map(c => `
    <div class="list-row">
      <div>
        <div class="name">${escapeHtml(c.source_name)}</div>
        <div class="sub">${fmtDateTime(c.counted_at)} · ${escapeHtml(c.counted_by_name)}${c.on_behalf_of_name ? ' on behalf of ' + escapeHtml(c.on_behalf_of_name) : ''}${c.note ? ' · “' + escapeHtml(c.note) + '”' : ''}</div>
      </div>
      <div style="text-align:right;">
        <div class="ch-amt">${fmtMoney(c.counted_amount)}</div>
        <span class="badge ${Number(c.variance) === 0 ? 'on' : 'danger'}">${Number(c.variance) === 0 ? 'Matched' : (Number(c.variance) < 0 ? fmtMoney(Math.abs(c.variance)) + ' short' : fmtMoney(c.variance) + ' over')}</span>
      </div>
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------
// Transactions (Phase 2) — full_authority only. Deposits, bank change,
// transfers, cash drops, and adjustments, each moving money between the
// sources shown on the Dashboard tab (or to/from the bank), with an
// optional receipt photo for the two bank-facing types. Unlike a blind
// count, there's nothing to hide here — a transaction's amount is what
// the person entering it decides to move, not something checked against
// a hidden target, so the amount is visible the whole time.
// ---------------------------------------------------------------------
const TRANSACTION_TYPE_LABELS = {
  deposit: 'Deposit',
  bank_change: 'Bank change',
  transfer: 'Transfer',
  cash_drop: 'Cash drop',
  adjustment: 'Adjustment',
};

async function ensureSourcesLoaded() {
  if (DASHBOARD_SOURCES.length) return;
  try {
    const result = await api('/api/cashhandling/dashboard' + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    DASHBOARD_SOURCES = result.sources || [];
  } catch (e) { /* the form will just show an empty picker; its own submit will surface a real error */ }
}

async function loadTransactions() {
  const el = document.getElementById('panelTransactions');
  if (!el) return;
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const result = await api('/api/cashhandling/transactions' + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    el.innerHTML = transactionsHtml(result.transactions || []);
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function transactionSideLabel(t, side) {
  const sourceName = side === 'from' ? t.from_source_name : t.to_source_name;
  const external = side === 'from' ? t.from_external : t.to_external;
  if (sourceName) return sourceName;
  if (external === 'bank') return 'Bank';
  return '—';
}

function transactionsHtml(list) {
  let html = `<div style="display:flex; justify-content:flex-end; margin-bottom:12px;"><button class="primary" onclick="openNewTransactionForm()">+ New transaction</button></div>`;
  if (!list.length) {
    html += `<div class="card"><p class="muted">No transactions logged yet.</p></div>`;
    return html;
  }
  html += `<div class="card">${list.map(t => `
    <div class="list-row">
      <div>
        <div class="name">${escapeHtml(TRANSACTION_TYPE_LABELS[t.type] || t.type)}${t.reason ? ' · ' + escapeHtml(t.reason) : ''}</div>
        <div class="sub">${fmtDateTime(t.performed_at)} · ${escapeHtml(t.performed_by_name)} · ${escapeHtml(transactionSideLabel(t, 'from'))} → ${escapeHtml(transactionSideLabel(t, 'to'))}</div>
      </div>
      <div style="text-align:right;">
        <div class="ch-amt">${fmtMoney(t.amount)}</div>
        ${t.receipt_path ? `<a href="#" onclick="viewReceipt('${t.id}'); return false;" class="muted" style="font-size:12px;">View receipt</a>` : ''}
      </div>
    </div>`).join('')}</div>`;
  return html;
}

async function viewReceipt(transactionId) {
  try {
    const result = await api(`/api/cashhandling/transactions/${transactionId}/receipt`);
    window.open(result.url, '_blank', 'noopener');
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function sourceOptionsHtml(excludeId) {
  return DASHBOARD_SOURCES
    .filter(s => s.id !== excludeId)
    .map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
    .join('');
}

async function openNewTransactionForm() {
  await ensureSourcesLoaded();
  const el = document.getElementById('panelTransactions');
  el.innerHTML = `
    <div class="card">
      <h2>New transaction</h2>
      <label>Type</label>
      <select id="txnType" onchange="onTransactionTypeChange()">
        ${Object.entries(TRANSACTION_TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>

      <div id="txnFromGroup">
        <label id="txnFromLabel">From source</label>
        <select id="txnFromSource">${sourceOptionsHtml()}</select>
      </div>
      <div id="txnToGroup">
        <label id="txnToLabel">To source</label>
        <select id="txnToSource">${sourceOptionsHtml()}</select>
      </div>
      <div id="txnAdjDirGroup" style="display:none;">
        <label>What happened</label>
        <select id="txnAdjDirection">
          <option value="add">Found extra — add it to the source</option>
          <option value="remove">Came up short — remove it from the source</option>
        </select>
      </div>

      <label>Amount</label>
      <div class="big-amt-wrap" style="margin:6px 0 14px;">
        <span class="prefix">$</span>
        <input type="number" inputmode="decimal" step="0.01" min="0.01" id="txnAmount" placeholder="0.00" style="font-size:20px; padding:12px 14px 12px 34px;">
      </div>

      <div id="txnReasonGroup" style="display:none;">
        <label>Reason</label>
        <textarea id="txnReason" rows="2" placeholder="Why this adjustment is being made"></textarea>
      </div>

      <div id="txnReceiptGroup">
        <label>Receipt / deposit slip photo (optional)</label>
        <input type="file" id="txnReceipt" accept="image/*,application/pdf" capture="environment">
      </div>

      <div style="display:flex; gap:10px; margin-top:16px;">
        <button class="secondary" onclick="loadTransactions()">Cancel</button>
        <button class="primary" onclick="submitTransaction()">Log transaction</button>
      </div>
    </div>
  `;
  onTransactionTypeChange();
}

function onTransactionTypeChange() {
  const type = document.getElementById('txnType').value;
  const show = (id, on) => { document.getElementById(id).style.display = on ? '' : 'none'; };
  // Adjustment reuses the From picker as its single source picker (shown
  // for every type except bank_change, which has no "from" side at all).
  show('txnFromGroup', type !== 'bank_change');
  show('txnToGroup', type === 'bank_change' || type === 'transfer' || type === 'cash_drop');
  show('txnAdjDirGroup', type === 'adjustment');
  show('txnReasonGroup', type === 'adjustment');
  show('txnReceiptGroup', type === 'deposit' || type === 'bank_change');
  document.getElementById('txnFromLabel').textContent =
    type === 'deposit' ? 'From source' : (type === 'adjustment' ? 'Source' : 'From');
  document.getElementById('txnToLabel').textContent = type === 'bank_change' ? 'To source' : 'To';
}

async function submitTransaction() {
  const type = document.getElementById('txnType').value;
  const amountEl = document.getElementById('txnAmount');
  const amount = Number(amountEl.value);
  if (!Number.isFinite(amount) || amount <= 0) { showMsg('Enter a valid amount.', 'error'); return; }

  const form = new FormData();
  form.append('type', type);
  form.append('amount', String(amount));
  if (SELECTED_LOCATION_ID) form.append('locationId', SELECTED_LOCATION_ID);

  if (type === 'deposit') {
    form.append('fromSourceId', document.getElementById('txnFromSource').value);
    form.append('toExternal', 'bank');
  } else if (type === 'bank_change') {
    form.append('fromExternal', 'bank');
    form.append('toSourceId', document.getElementById('txnToSource').value);
  } else if (type === 'transfer' || type === 'cash_drop') {
    const from = document.getElementById('txnFromSource').value;
    const to = document.getElementById('txnToSource').value;
    if (from === to) { showMsg("A source can't transfer into itself.", 'error'); return; }
    form.append('fromSourceId', from);
    form.append('toSourceId', to);
  } else if (type === 'adjustment') {
    const direction = document.getElementById('txnAdjDirection').value;
    const sourceId = document.getElementById('txnFromSource').value; // the From picker doubles as Adjustment's single source picker
    if (direction === 'add') form.append('toSourceId', sourceId);
    else form.append('fromSourceId', sourceId);
    const reason = document.getElementById('txnReason').value.trim();
    if (!reason) { showMsg('An adjustment needs a reason.', 'error'); return; }
    form.append('reason', reason);
  }

  const receiptInput = document.getElementById('txnReceipt');
  if (receiptInput && receiptInput.files && receiptInput.files[0]) form.append('receipt', receiptInput.files[0]);

  try {
    await apiUpload('/api/cashhandling/transactions', form);
    showMsg('Transaction logged.', 'success');
    loadTransactions();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Manage Cash Sources (Phase 3) — owner only. Add a Fixed Point or a
// Drawer (its Backup Bag is created alongside it automatically), retire
// one, and toggle whether each source is in the Weekly Audit / Random
// Audit pools (both start off for a brand-new source — see
// server/cashhandling.js's createSource — since it has no track record
// yet; the owner opts it in here once it's actually in use).
// ---------------------------------------------------------------------
let MANAGE_SOURCES = [];

async function loadManageSources() {
  const el = document.getElementById('panelSources');
  if (!el) return;
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const result = await api('/api/cashhandling/dashboard' + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    MANAGE_SOURCES = result.sources || [];
    el.innerHTML = manageSourcesHtml(MANAGE_SOURCES);
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function auditTogglesHtml(s) {
  return `
    <label class="toggle-row" style="gap:8px; margin-top:6px;">
      <span class="label" style="font-size:12px;">Weekly Audit</span>
      <span class="switch"><input type="checkbox" ${s.include_weekly_audit ? 'checked' : ''} onchange="toggleSourceAuditFlag('${s.id}', 'includeWeeklyAudit', this.checked)"><span class="slider"></span></span>
    </label>
    <label class="toggle-row" style="gap:8px;">
      <span class="label" style="font-size:12px;">Random Audit pool</span>
      <span class="switch"><input type="checkbox" ${s.include_random_audit ? 'checked' : ''} onchange="toggleSourceAuditFlag('${s.id}', 'includeRandomAudit', this.checked)"><span class="slider"></span></span>
    </label>`;
}

function manageSourceRowHtml(s, sub) {
  return `
    <div class="list-row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="sub">${escapeHtml(sub || '')}${s.target_amount ? ' · target ' + fmtMoney(s.target_amount) : ''}</div>
        </div>
        <button class="small ghost" onclick="retireManagedSource('${s.id}')">Retire</button>
      </div>
      ${auditTogglesHtml(s)}
    </div>`;
}

function manageSourcesHtml(sources) {
  const drawers = sources.filter(s => s.kind === 'drawer');
  const bagById = {};
  sources.filter(s => s.kind === 'backup_bag').forEach(b => { bagById[b.id] = b; });
  const fixedPoints = sources.filter(s => s.kind === 'fixed_point');

  let html = `<div class="card"><h2>Fixed Cash Points</h2>${
    fixedPoints.length ? fixedPoints.map(s => manageSourceRowHtml(s)).join('') : '<p class="muted">None yet.</p>'
  }</div>`;

  html += `<div class="card"><h2>Drawers &amp; Backup Bags</h2>${
    drawers.length ? drawers.map(d => {
      const bag = bagById[d.linked_source_id];
      return manageSourceRowHtml(d) + (bag ? manageSourceRowHtml(bag, 'Paired with ' + d.name) : '');
    }).join('') : '<p class="muted">None yet.</p>'
  }</div>`;

  html += `
    <div class="card">
      <h2>Add a cash source</h2>
      <label>Type</label>
      <select id="newSourceKind" onchange="onNewSourceKindChange()">
        <option value="fixed_point">Fixed Point (ATM, safe, change machine, …)</option>
        <option value="drawer">Drawer &amp; Backup Bag</option>
      </select>
      <label>Name</label>
      <input id="newSourceName" placeholder="e.g. Cash Drawer 5">
      <div id="newSourceBagGroup" style="display:none;">
        <label>Backup bag name (optional)</label>
        <input id="newSourceBagName" placeholder="e.g. Backup Bag 5">
      </div>
      <label>Starting target amount (optional)</label>
      <div class="big-amt-wrap" style="margin:6px 0 14px;">
        <span class="prefix">$</span>
        <input type="number" inputmode="decimal" step="0.01" min="0" id="newSourceTarget" placeholder="0.00" style="font-size:18px; padding:11px 14px 11px 32px;">
      </div>
      <button class="primary" onclick="submitNewSource()">Add source</button>
    </div>`;

  html += `
    <div class="card" style="text-align:center;">
      <button class="secondary" id="retiredSourcesToggle" onclick="toggleRetiredSources()">View retired sources</button>
    </div>
    <div id="panelRetiredSources"></div>`;

  return html;
}

// ---- Retired sources — retireSource() is a soft delete (active = false),
// so nothing is ever actually gone. This panel, collapsed by default at
// the bottom of the page, lists what's retired at the selected location
// and lets the owner bring one back.
let RETIRED_SOURCES_OPEN = false;

async function toggleRetiredSources() {
  const panel = document.getElementById('panelRetiredSources');
  const btn = document.getElementById('retiredSourcesToggle');
  if (RETIRED_SOURCES_OPEN) {
    panel.innerHTML = '';
    RETIRED_SOURCES_OPEN = false;
    btn.textContent = 'View retired sources';
    return;
  }
  RETIRED_SOURCES_OPEN = true;
  btn.textContent = 'Hide retired sources';
  panel.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const result = await api('/api/cashhandling/sources/retired' + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    panel.innerHTML = retiredSourcesHtml(result.sources || []);
  } catch (e) {
    panel.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function retiredSourcesHtml(sources) {
  if (!sources.length) {
    return '<div class="card"><h2>Retired sources</h2><p class="muted">Nothing retired at this location.</p></div>';
  }
  return `
    <div class="card" style="padding:0;">
      <h2 style="padding:16px 16px 0;">Retired sources</h2>
      ${sources.map(s => `
        <div class="list-row">
          <div>
            <div class="name">${escapeHtml(s.name)}</div>
            <div class="sub">${s.kind === 'fixed_point' ? 'Fixed Cash Point' : (s.kind === 'drawer' ? 'Drawer' : 'Backup Bag')}${s.last_counted_at ? ' · last counted ' + fmtDate(s.last_counted_at) : ' · never counted'}</div>
          </div>
          <button class="small secondary" onclick="reactivateManagedSource('${s.id}')">Reactivate</button>
        </div>`).join('')}
    </div>`;
}

async function reactivateManagedSource(sourceId) {
  try {
    await withStepUp(() => api(`/api/cashhandling/sources/${sourceId}/reactivate`, { method: 'POST' }));
    showMsg('Source reactivated.', 'success');
    RETIRED_SOURCES_OPEN = false; // loadManageSources() below rebuilds the panel closed
    loadManageSources();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function onNewSourceKindChange() {
  const kind = document.getElementById('newSourceKind').value;
  document.getElementById('newSourceBagGroup').style.display = kind === 'drawer' ? '' : 'none';
}

async function toggleSourceAuditFlag(sourceId, field, checked) {
  try {
    await withStepUp(() => api(`/api/cashhandling/sources/${sourceId}/update`, { method: 'POST', body: { [field]: checked } }));
    showMsg('Updated.', 'success');
  } catch (e) {
    showMsg(e.message, 'error');
    loadManageSources(); // revert the toggle's visual state to what the server actually has
  }
}

async function retireManagedSource(sourceId) {
  try {
    await withStepUp(() => api(`/api/cashhandling/sources/${sourceId}/retire`, { method: 'POST' }));
    showMsg('Source retired.', 'success');
    loadManageSources();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function submitNewSource() {
  const kind = document.getElementById('newSourceKind').value;
  const name = document.getElementById('newSourceName').value.trim();
  if (!name) { showMsg('Enter a name.', 'error'); return; }
  const bagName = document.getElementById('newSourceBagName') ? document.getElementById('newSourceBagName').value.trim() : '';
  const targetAmount = Number(document.getElementById('newSourceTarget').value) || 0;
  try {
    await withStepUp(() => api('/api/cashhandling/sources', {
      method: 'POST',
      body: { locationId: SELECTED_LOCATION_ID, kind, name, bagName: bagName || undefined, targetAmount },
    }));
    showMsg('Source added.', 'success');
    loadManageSources();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Weekly Audit + Manual Random Audit (Phase 4) — a checklist that
// blind-counts a set of sources one at a time (Weekly: everything
// flagged for the weekly rotation; Random: everything in the random-
// audit pool, run on demand rather than waiting for the system's
// once-a-week pick) and reveals every item's match/variance together,
// only once, at final submit. Frontend mirrors server/cashhandling.js's
// own kind-parameterized design — one set of functions shared by both
// tabs instead of two near-duplicate copies.
// ---------------------------------------------------------------------
const AUDIT_META = {
  weekly: { base: '/api/cashhandling/audits/weekly', panel: 'panelWeekly', title: 'Weekly Audit', blurb: 'Every source in the weekly rotation, counted blind in one pass.' },
  manual: { base: '/api/cashhandling/audits/manual', panel: 'panelManual', title: 'Random Audit', blurb: 'An on-demand spot-check of everything in the random-audit pool.' },
};
const AUDIT_STATE = { weekly: null, manual: null }; // last-loaded checklist, or null between loads

async function loadAuditLanding(kind) {
  const meta = AUDIT_META[kind];
  const el = document.getElementById(meta.panel);
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const result = await api(`${meta.base}/history/list` + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    el.innerHTML = auditLandingHtml(kind, result.audits || []);
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function auditLandingHtml(kind, history) {
  const meta = AUDIT_META[kind];
  let html = `
    <div class="card">
      <h2>${meta.title}</h2>
      <p class="muted">${meta.blurb}</p>
      <button class="primary" onclick="startAuditFlow('${kind}')">Start ${meta.title.toLowerCase()}</button>
    </div>`;
  html += `<div class="card"><h2>Past ${meta.title.toLowerCase()}s</h2>${
    history.length ? history.map(a => auditHistoryRowHtml(a)).join('') : '<p class="muted">None submitted yet.</p>'
  }</div>`;
  return html;
}

function auditHistoryRowHtml(a) {
  const varianceCount = (a.items || []).filter(i => Number(i.variance) !== 0).length;
  return `
    <div class="list-row">
      <div>
        <div class="name">${fmtDateTime(a.submitted_at)}</div>
        <div class="sub">${escapeHtml(a.run_by_name)} · ${(a.items || []).length} counted</div>
      </div>
      <span class="badge ${varianceCount ? 'danger' : 'on'}">${varianceCount ? varianceCount + ' variance' : 'All matched'}</span>
    </div>`;
}

async function startAuditFlow(kind) {
  const meta = AUDIT_META[kind];
  const el = document.getElementById(meta.panel);
  el.innerHTML = '<div class="card"><p class="muted">Starting…</p></div>';
  try {
    const checklist = await api(`${meta.base}/start`, { method: 'POST', body: { locationId: SELECTED_LOCATION_ID } });
    AUDIT_STATE[kind] = checklist;
    el.innerHTML = auditChecklistHtml(kind, checklist);
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function auditChecklistHtml(kind, checklist) {
  const meta = AUDIT_META[kind];
  const remaining = checklist.items.filter(i => !i.counted).length;
  let html = `
    <div class="card">
      <h2>${meta.title} in progress</h2>
      <p class="blind-note">Each item below is blind — nothing is checked against the ledger until you submit the whole audit at the end.</p>
    </div>
    <div class="card" style="padding:0;">
      ${checklist.items.map(item => `
        <div class="list-row">
          <div>
            <div class="name">${escapeHtml(item.source.name)}</div>
            <div class="sub">${item.source.kind === 'fixed_point' ? 'Fixed Cash Point' : (item.source.kind === 'drawer' ? 'Drawer' : 'Backup Bag')}</div>
          </div>
          ${item.counted
            ? `<span class="badge on">Counted</span>`
            : `<button class="small secondary" style="margin-top:0;" onclick="openAuditItemEntry('${kind}', '${item.source.id}', '${escapeHtml(item.source.name).replace(/'/g, "\\'")}')">Count it</button>`}
        </div>`).join('')}
    </div>
    <div id="auditItemForm-${kind}"></div>
    <div class="card">
      ${remaining ? `<p class="muted">${remaining} item${remaining === 1 ? '' : 's'} left to count.</p>` : ''}
      <div style="display:flex; gap:10px;">
        <button class="secondary" onclick="loadAuditLanding('${kind}')">Cancel / back to list</button>
        <button class="primary" onclick="finishAudit('${kind}')">Submit ${meta.title.toLowerCase()}</button>
      </div>
    </div>`;
  return html;
}

function openAuditItemEntry(kind, sourceId, sourceName) {
  const formEl = document.getElementById(`auditItemForm-${kind}`);
  formEl.innerHTML = `
    <div class="card">
      <h2>Count ${escapeHtml(sourceName)}</h2>
      <p class="blind-note">Blind — count it now, then enter how many of each. No target is shown.</p>
      ${denomCalcHtml(`auditItemAmount-${kind}`)}
      <label>Note (optional)</label>
      <textarea id="auditItemNote-${kind}" rows="2"></textarea>
      <div style="display:flex; gap:10px;">
        <button class="secondary" onclick="document.getElementById('auditItemForm-${kind}').innerHTML=''">Cancel</button>
        <button class="primary" onclick="submitAuditItemAmount('${kind}', '${sourceId}')">Log this count</button>
      </div>
    </div>`;
  focusDenomCalc(`auditItemAmount-${kind}`);
}

async function submitAuditItemAmount(kind, sourceId) {
  const meta = AUDIT_META[kind];
  const amountEl = document.getElementById(`auditItemAmount-${kind}`);
  const amount = Number(amountEl.value);
  if (!Number.isFinite(amount) || amount < 0 || !denomCalcTouched(`auditItemAmount-${kind}`)) { showMsg('Enter the count.', 'error'); return; }
  const note = document.getElementById(`auditItemNote-${kind}`).value.trim();
  const auditId = AUDIT_STATE[kind].audit.id;
  try {
    await api(`${meta.base}/${auditId}/items`, { method: 'POST', body: { sourceId, countedAmount: amount, note: note || undefined } });
    const checklist = await api(`${meta.base}/${auditId}`);
    AUDIT_STATE[kind] = checklist;
    document.getElementById(meta.panel).innerHTML = auditChecklistHtml(kind, checklist);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function finishAudit(kind) {
  const meta = AUDIT_META[kind];
  const auditId = AUDIT_STATE[kind].audit.id;
  try {
    const result = await api(`${meta.base}/${auditId}/submit`, { method: 'POST' });
    document.getElementById(meta.panel).innerHTML = auditRevealHtml(kind, result);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function auditRevealHtml(kind, result) {
  const meta = AUDIT_META[kind];
  const items = result.items || [];
  return `
    <div class="card">
      <h2>${meta.title} submitted</h2>
      <p class="muted">Every item below is now revealed.</p>
    </div>
    <div class="card" style="padding:0;">
      ${items.map(i => {
        const v = Number(i.variance);
        return `<div class="list-row">
          <div><div class="name">${escapeHtml(i.source_name)}</div><div class="sub">${fmtMoney(i.counted_amount)} counted · ${fmtMoney(i.expected_amount)} expected</div></div>
          <span class="badge ${v === 0 ? 'on' : 'danger'}">${v === 0 ? 'Matched' : (v < 0 ? fmtMoney(Math.abs(v)) + ' short' : fmtMoney(v) + ' over')}</span>
        </div>`;
      }).join('')}
    </div>
    <button class="primary" onclick="loadAuditLanding('${kind}')">Done</button>`;
}

// ---------------------------------------------------------------------
// System-Assigned Random Audit banner — shown regardless of tier (the
// eligibility rules that produced the assignment already guarantee only
// a drawers_bags+ person ever has one, but the check itself is just "do
// I have an open assignment," never gated on tier here). Rendered above
// whichever flow (own_drawer or manager shell) is on screen.
// ---------------------------------------------------------------------
let RANDOM_ASSIGNMENT = null;

async function loadRandomAuditBanner() {
  const el = document.getElementById('bannerAssignment');
  if (!el) return;
  try {
    const result = await api('/api/cashhandling/random-audit/mine');
    RANDOM_ASSIGNMENT = result.assignment;
    el.innerHTML = RANDOM_ASSIGNMENT ? randomAuditBannerHtml(RANDOM_ASSIGNMENT) : '';
  } catch (e) { /* quiet — this is a bonus banner, not the primary flow */ }
}

function randomAuditBannerHtml(a) {
  return `
    <div class="card" style="border-left:4px solid var(--accent, #3b7ddb);">
      <h2>Your random audit this week</h2>
      <p class="muted">You've been picked to independently count <b style="color:var(--text);">${escapeHtml(a.source_name)}</b> at ${escapeHtml(a.location_name)}, due ${fmtDate(a.due_at)}.</p>
      <button class="primary" onclick="openRandomAuditEntry()">Count it now</button>
    </div>`;
}

function openRandomAuditEntry() {
  document.getElementById('panelMain').insertAdjacentHTML('afterbegin', `
    <div class="card" id="randomAuditEntryCard">
      <h2>Count ${escapeHtml(RANDOM_ASSIGNMENT.source_name)}</h2>
      <p class="blind-note">Blind — count it now, then enter how many of each. No target is shown.</p>
      ${denomCalcHtml('randomAuditAmount')}
      <label>Note (optional)</label>
      <textarea id="randomAuditNote" rows="2"></textarea>
      <div style="display:flex; gap:10px;">
        <button class="secondary" onclick="document.getElementById('randomAuditEntryCard').remove()">Cancel</button>
        <button class="primary" onclick="submitRandomAuditAmount()">Log this count</button>
      </div>
    </div>`);
  focusDenomCalc('randomAuditAmount');
}

async function submitRandomAuditAmount() {
  const amountEl = document.getElementById('randomAuditAmount');
  const amount = Number(amountEl.value);
  if (!Number.isFinite(amount) || amount < 0 || !denomCalcTouched('randomAuditAmount')) { showMsg('Enter the count.', 'error'); return; }
  const note = document.getElementById('randomAuditNote').value.trim();
  try {
    const result = await api(`/api/cashhandling/random-audit/${RANDOM_ASSIGNMENT.id}/count`, {
      method: 'POST', body: { countedAmount: amount, note: note || undefined },
    });
    const card = document.getElementById('randomAuditEntryCard');
    if (card) card.remove();
    RANDOM_ASSIGNMENT = null;
    document.getElementById('bannerAssignment').innerHTML = '';
    renderReveal(result.count, TIER === 'own_drawer' ? 'own' : 'dashboard');
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// own_drawer flow — blind cash-out is their entire world in this app.
// ---------------------------------------------------------------------
async function renderOwnDrawerFlow() {
  const el = document.getElementById('panelMain');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const result = await api('/api/cashhandling/my-drawers');
    OWN_DRAWERS = result.drawers || [];
    if (!OWN_DRAWERS.length) {
      el.innerHTML = `<h1 class="page-title">Cash Handling</h1><div class="card"><p>You don't have a drawer assigned yet — ask your manager.</p></div>`;
      return;
    }
    if (OWN_DRAWERS.length === 1) {
      renderCountEntry(OWN_DRAWERS[0], { returnTo: 'own' });
      return;
    }
    el.innerHTML = `
      <h1 class="page-title">Cash Handling</h1>
      <p class="muted">Pick which drawer to cash out.</p>
      <div class="card" style="padding:0;">
        ${OWN_DRAWERS.map(d => `<div class="picker-row" onclick="openOwnDrawerCountEntry('${d.id}')">
          <div><div class="name">${escapeHtml(d.name)}</div><div class="sub">${escapeHtml(d.location_name || '')}</div></div>
        </div>`).join('')}
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------
// Denomination calculator — shared by every blind-count screen (cash-out,
// audit items, the random-audit banner). Nobody adds up bills in their
// head: they enter how many of each denomination they've got, and this
// does the math. `idPrefix` becomes a hidden input holding the computed
// total — every submit function below reads it exactly the way it used
// to read the old single dollar-amount field, so nothing downstream
// (validation, the POST body, blind-reveal logic) had to change.
// ---------------------------------------------------------------------
const DENOMINATIONS = [100, 50, 20, 10, 5, 2, 1, 0.25];

function denomCalcHtml(idPrefix) {
  return `
    <div class="denom-calc" id="${idPrefix}-denomcalc">
      ${DENOMINATIONS.map(d => `
        <div class="denom-row">
          <span class="denom-label">${d >= 1 ? '$' + d : '25¢'}</span>
          <input type="number" inputmode="numeric" min="0" step="1" class="denom-qty" data-value="${d}" placeholder="0" oninput="updateDenomTotal('${idPrefix}')">
          <span class="denom-line">$0.00</span>
        </div>`).join('')}
      <div class="denom-row denom-other-row">
        <span class="denom-label">Other</span>
        <div class="denom-other-input">
          <span class="prefix-sm">$</span>
          <input type="number" inputmode="decimal" min="0" step="0.01" class="denom-other" placeholder="0.00" oninput="updateDenomTotal('${idPrefix}')">
        </div>
      </div>
      <div class="denom-total-row">
        <span class="denom-total-label">Total counted</span>
        <span class="denom-total-value" id="${idPrefix}-totaldisplay">$0.00</span>
      </div>
    </div>
    <input type="hidden" id="${idPrefix}" value="0">`;
}

function updateDenomTotal(idPrefix) {
  const wrap = document.getElementById(`${idPrefix}-denomcalc`);
  if (!wrap) return;
  let total = 0;
  wrap.querySelectorAll('.denom-row:not(.denom-other-row)').forEach((row) => {
    const qtyEl = row.querySelector('.denom-qty');
    const value = Number(qtyEl.dataset.value);
    const qty = Math.max(0, Math.floor(Number(qtyEl.value) || 0));
    const line = qty * value;
    total += line;
    row.querySelector('.denom-line').textContent = fmtMoney(line);
  });
  const otherEl = wrap.querySelector('.denom-other');
  total += Math.max(0, Number(otherEl.value) || 0);
  document.getElementById(idPrefix).value = total.toFixed(2);
  const totalDisplay = document.getElementById(`${idPrefix}-totaldisplay`);
  if (totalDisplay) totalDisplay.textContent = fmtMoney(total);
}

// True once the person has typed into at least one denomination or the
// Other field — lets submit handlers tell "genuinely counted to zero"
// apart from "hit submit without entering anything."
function denomCalcTouched(idPrefix) {
  const wrap = document.getElementById(`${idPrefix}-denomcalc`);
  if (!wrap) return true;
  return Array.from(wrap.querySelectorAll('.denom-qty, .denom-other')).some((el) => el.value !== '');
}

function focusDenomCalc(idPrefix) {
  const firstQty = document.querySelector(`#${idPrefix}-denomcalc .denom-qty`);
  if (firstQty) firstQty.focus();
}

// ---------------------------------------------------------------------
// Blind count entry — shared by every tier. Deliberately never shown an
// expected amount or a prior variance; nothing above this function passes
// one in, and the reveal only happens after submitCount()'s POST returns.
// ---------------------------------------------------------------------
function renderCountEntry(source, opts) {
  showMsg('');
  const onBehalf = source.assigned_person_id && source.assigned_person_id !== ME.id ? source.assigned_person_name : null;
  document.getElementById('panelMain').innerHTML = `
    <a href="#" onclick="backFromCountEntry('${opts.returnTo}'); return false;" class="muted">‹ Back</a>
    <div class="detail-head" style="margin-top:10px;">
      <div class="detail-icon">${sourceIcon(source)}</div>
      <div><div class="detail-title">${escapeHtml(source.name)}</div><div class="detail-loc">${escapeHtml(source.location_name || '')}</div></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <h2>Cash out ${escapeHtml(source.name)}</h2>
      ${onBehalf ? `<p class="muted">On behalf of <b style="color:var(--text);">${escapeHtml(onBehalf)}</b>.</p>` : ''}
      <p class="blind-note">Count it now, then enter how many of each below. This is blind — no target amount is shown, so what you type is never just a copy of a number on screen. It's checked against the ledger only after you submit.</p>
      ${denomCalcHtml('countAmount')}
      <label>Note (optional)</label>
      <textarea id="countNote" rows="2" placeholder="Anything worth flagging about this count"></textarea>
      <button class="primary" onclick="submitCount('${source.id}', ${onBehalf ? `'${source.assigned_person_id}'` : 'null'}, '${opts.returnTo}')">Log this count</button>
    </div>
  `;
  focusDenomCalc('countAmount');
}

function backFromCountEntry(returnTo) {
  if (returnTo === 'own') { renderOwnDrawerFlow(); return; }
  renderManagerShell();
}

async function submitCount(sourceId, onBehalfOf, returnTo) {
  const amountEl = document.getElementById('countAmount');
  const amount = Number(amountEl.value);
  if (!Number.isFinite(amount) || amount < 0 || !denomCalcTouched('countAmount')) {
    showMsg('Enter the count.', 'error');
    return;
  }
  const note = document.getElementById('countNote').value.trim();
  try {
    const result = await api(`/api/cashhandling/sources/${sourceId}/count`, {
      method: 'POST',
      body: { countedAmount: amount, note: note || undefined, onBehalfOf: onBehalfOf || undefined },
    });
    renderReveal(result.count, returnTo);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function renderReveal(count, returnTo) {
  const v = Number(count.variance);
  const varClass = v === 0 ? 'match' : (v < 0 ? 'short' : 'over');
  const varLabel = v === 0 ? 'Matched — no variance' : (v < 0 ? `${fmtMoney(Math.abs(v))} short` : `${fmtMoney(v)} over`);
  document.getElementById('panelMain').innerHTML = `
    <h1 class="page-title">Logged</h1>
    <div class="reveal-tiles">
      <div class="card"><div class="l">Expected</div><div class="n">${fmtMoney(count.expected_amount)}</div></div>
      <div class="card"><div class="l">Counted</div><div class="n">${fmtMoney(count.counted_amount)}</div></div>
    </div>
    <div class="reveal-variance ${varClass}">${varLabel}</div>
    <button class="primary" onclick="${returnTo === 'own' ? 'renderOwnDrawerFlow()' : 'renderManagerShell()'}">Done</button>
  `;
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
(async function init() {
  ME = requireAuth();
  if (!ME) return;
  renderTopbar('Cash Handling');
  try {
    const accessResult = await api('/api/cashhandling/access');
    TIER = accessResult.tier;
    if (TIER === 'no_access') {
      document.getElementById('panelMain').innerHTML =
        '<div class="card"><p>Cash Handling isn\'t enabled for your account yet — ask your manager.</p><p><a href="/dashboard.html">Back home</a></p></div>';
      return;
    }
    LOCATIONS = await api('/api/locations');
    SELECTED_LOCATION_ID = ME.location_id || (LOCATIONS[0] && LOCATIONS[0].id) || null;
    if (TIER === 'own_drawer') {
      renderOwnDrawerFlow();
    } else {
      renderManagerShell();
    }
    loadRandomAuditBanner();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
