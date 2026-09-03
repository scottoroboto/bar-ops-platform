// Staff Layouts tab (docs/venue-control.md §10/§12 Phase 5: "Layouts tab --
// saved room presets, one tap to apply, with a 15-second undo bar rather
// than a confirmation dialog. Confirmation before the fact trains people to
// tap through it; undo after the fact actually gets used."). Same local-API
// shape as sources.js/tvs.js -- never talks to devices directly, only to
// this agent's own /api/layouts.
let STAFF_PIN = '';
let LAYOUTS = [];
let SOURCES = [];
let TVS = [];

function submitPin() {
  STAFF_PIN = document.getElementById('pinInput').value;
  api('/api/layouts').then((layouts) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = '';
    LAYOUTS = layouts;
    renderLayouts();
    loadNames(); // non-blocking -- only needed to label items by name in the apply progress list
  }).catch(() => {
    document.getElementById('pinMsg').innerHTML = '<div class="msg error">Incorrect PIN.</div>';
  });
}

// Layout items only carry target_type/target_id -- these two existing
// endpoints (already loaded by the Sources/TVs tabs) are what resolve those
// ids into the names the progress list shows. Best-effort: if this fails,
// resolveItemName() falls back to "source #4" / "TV #4" rather than blocking
// apply on it.
async function loadNames() {
  try { SOURCES = await api('/api/sources'); } catch (e) { SOURCES = []; }
  try { TVS = await api('/api/tvs'); } catch (e) { TVS = []; }
}

function resolveItemName(item) {
  if (item.target_type === 'source') {
    const s = SOURCES.find((ss) => Number(ss.id) === Number(item.target_id));
    return s ? s.label : `source #${item.target_id}`;
  }
  const t = TVS.find((tt) => Number(tt.id) === Number(item.target_id));
  return t ? t.name : `TV #${item.target_id}`;
}

function actionLabel(action) {
  if (!action) return '';
  if (action.op === 'tune') return `tune ${action.major}${action.minor != null ? '.' + action.minor : ''}`;
  if (action.op === 'launch') return 'launch app';
  if (action.op === 'power') return `power ${action.state}`;
  if (action.op === 'select_slot') return `source → slot ${action.slot}`;
  return action.op || '';
}
document.getElementById('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-staff-pin': STAFF_PIN, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLayouts() {
  const box = document.getElementById('layoutsBox');
  if (!LAYOUTS.length) {
    box.innerHTML = '<p class="muted">No layouts yet -- capture one from this box\'s admin page (Admin &rarr; Capture current state), or add one from TSB Platform: Venue Control &rarr; Layouts.</p>';
    return;
  }
  box.innerHTML = LAYOUTS.map((l) => `
    <div class="layout-row">
      <div>
        <div class="layout-name">${escapeHtml(l.name)}</div>
        ${l.description ? `<div class="layout-desc">${escapeHtml(l.description)}</div>` : ''}
        <div class="layout-count">${l.items.length} item${l.items.length === 1 ? '' : 's'}</div>
      </div>
      <button class="primary" ${l.items.length ? '' : 'disabled'} onclick="applyLayout(${l.id})">Apply</button>
    </div>
  `).join('');
}

// ---- apply + 15s undo bar ----
let undoTimer = null;
let undoCountdownTimer = null;
let undoSnapshot = null;
let undoLabel = '';

function hideUndoBar() {
  clearTimeout(undoTimer);
  clearInterval(undoCountdownTimer);
  undoTimer = null;
  undoCountdownTimer = null;
  undoSnapshot = null;
  document.getElementById('undoBar').classList.remove('show');
}

function showUndoBar(label, snapshot) {
  hideUndoBar();
  undoSnapshot = snapshot;
  undoLabel = label;
  const UNDO_WINDOW_MS = 15000;
  const deadline = Date.now() + UNDO_WINDOW_MS;
  document.getElementById('undoText').textContent = `Applied "${label}".`;
  const tick = () => {
    const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    document.getElementById('undoCountdown').textContent = `Undo available for ${secs}s`;
    if (secs <= 0) hideUndoBar();
  };
  tick();
  undoCountdownTimer = setInterval(tick, 250);
  undoTimer = setTimeout(hideUndoBar, UNDO_WINDOW_MS);
  document.getElementById('undoBar').classList.add('show');
}

// Named live-ish progress list instead of a blocking alert() (§9: "13 done,
// 1 working, 1 failed, each device named"). The apply endpoint returns every
// item's result in one response rather than streaming them, so this can't
// show true per-item timing -- every targeted item shows "Working…" the
// moment the tap lands, then flips to Done/Failed together once the response
// comes back. Still names every item and never collapses to one pass/fail
// verdict for the whole layout.
async function applyLayout(id) {
  const layout = LAYOUTS.find((l) => Number(l.id) === Number(id));
  const items = layout ? layout.items : [];
  const pendingRows = items.map((it) => ({ name: resolveItemName(it), detail: actionLabel(it.action), status: 'working' }));
  renderApplyProgress(layout ? layout.name : 'Layout', pendingRows, id);

  try {
    const result = await api(`/api/layouts/${id}/apply`, { method: 'POST' });
    // runItems() preserves item order (grouped by step_order, index-preserving
    // concurrency), so results[i] corresponds to items[i] -- used only as a
    // fallback for the rare case a result has no label/name of its own
    // (target no longer exists).
    const rows = result.results.map((r, i) => ({
      name: r.label || r.name || (items[i] ? resolveItemName(items[i]) : `${r.target_type || 'item'} #${r.target_id}`),
      detail: items[i] ? actionLabel(items[i].action) : '',
      status: r.ok ? 'done' : 'failed',
      error: r.error,
    }));
    renderApplyProgress(result.name, rows, id);
    // Only offer undo if there's actually a prior-state snapshot to restore
    // to -- a layout applied to a room the agent has no live readings for
    // yet has nothing meaningful to undo back to.
    if (result.undo && result.undo.length) showUndoBar(result.name, result.undo);
  } catch (e) {
    renderApplyProgress(layout ? layout.name : 'Layout', pendingRows.map((r) => ({ ...r, status: 'failed', error: e.message })), id);
  }
}

function renderApplyProgress(layoutName, rows, layoutId) {
  const box = document.getElementById('applyProgress');
  const done = rows.filter((r) => r.status === 'done').length;
  const failed = rows.filter((r) => r.status === 'failed');
  const working = rows.filter((r) => r.status === 'working').length;
  const summary = working
    ? `Applying "${escapeHtml(layoutName)}"…`
    : `"${escapeHtml(layoutName)}": ${done} of ${rows.length} done${failed.length ? `, ${failed.length} failed` : ''}.`;

  box.innerHTML = `
    <div class="card">
      <h2 style="margin:0 0 8px;">${escapeHtml(layoutName)}</h2>
      <div class="progress-list">
        ${rows.map((r) => `
          <div class="progress-row">
            <span>${escapeHtml(r.name)}${r.detail ? ` <span class="muted">(${escapeHtml(r.detail)})</span>` : ''}</span>
            <span class="pstate ${r.status}">${r.status === 'working' ? 'Working…' : r.status === 'done' ? 'Done' : 'Failed' + (r.error ? `: ${escapeHtml(r.error)}` : '')}</span>
          </div>`).join('')}
      </div>
      <div class="progress-summary">${summary}</div>
      ${failed.length && working === 0 ? `
      <div class="failure-banner">
        <span class="text">${failed.length} item${failed.length === 1 ? '' : 's'} didn't apply.</span>
        <div class="actions">
          <button class="small" onclick="applyLayout(${layoutId})">Retry</button>
          <button class="small" onclick="document.getElementById('applyProgress').innerHTML=''">Dismiss</button>
        </div>
      </div>` : ''}
    </div>`;
}

async function undoApply() {
  if (!undoSnapshot) return;
  const snapshot = undoSnapshot;
  const label = undoLabel;
  hideUndoBar();
  try {
    await api('/api/layouts/replay', { method: 'POST', body: JSON.stringify({ items: snapshot, label: `undo: ${label}` }) });
  } catch (e) {
    alert(`Undo failed: ${e.message}`);
  }
}
