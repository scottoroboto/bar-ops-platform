// Staff Layouts tab (docs/venue-control.md §10/§12 Phase 5: "Layouts tab --
// saved room presets, one tap to apply, with a 15-second undo bar rather
// than a confirmation dialog. Confirmation before the fact trains people to
// tap through it; undo after the fact actually gets used."). Same local-API
// shape as sources.js/tvs.js -- never talks to devices directly, only to
// this agent's own /api/layouts.
let STAFF_PIN = '';
let LAYOUTS = [];

function submitPin() {
  STAFF_PIN = document.getElementById('pinInput').value;
  api('/api/layouts').then((layouts) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = '';
    LAYOUTS = layouts;
    renderLayouts();
  }).catch(() => {
    document.getElementById('pinMsg').innerHTML = '<div class="msg error">Incorrect PIN.</div>';
  });
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

async function applyLayout(id) {
  try {
    const result = await api(`/api/layouts/${id}/apply`, { method: 'POST' });
    const failed = result.results.filter((r) => !r.ok);
    if (failed.length) {
      alert(`"${result.name}" applied with ${failed.length} of ${result.results.length} item(s) failing:\n` + failed.map((f) => f.error || f.name || f.target_id).join('\n'));
    }
    // Only offer undo if there's actually a prior-state snapshot to restore
    // to -- a layout applied to a room the agent has no live readings for
    // yet has nothing meaningful to undo back to.
    if (result.undo && result.undo.length) showUndoBar(result.name, result.undo);
  } catch (e) {
    alert(e.message);
  }
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
