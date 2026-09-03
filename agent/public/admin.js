// Admin-only local page (docs/venue-control.md §11: "Discovery is
// admin-only by design" -- Phase 5 extends that same posture to capture/
// backup/restore, per §8.2: "Admin-scoped routes (/api/discovery/*,
// /api/backup/*, /api/restore) require the admin PIN.") Same PIN-gate
// pattern as discovery.js.
let ADMIN_PIN = '';

function submitPin() {
  ADMIN_PIN = document.getElementById('pinInput').value;
  // GET /api/backups is harmless, cheap, and always returns 200 with an
  // array (even an empty one) for a valid PIN -- unlike discovery's
  // "latest run" check, there's no plausible 404 case to special-case here.
  api('/api/backups').then(() => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    loadLayoutsForCapture();
    loadBackups();
  }).catch(() => {
    document.getElementById('pinMsg').innerHTML = '<div class="msg error">Incorrect PIN.</div>';
  });
}
document.getElementById('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-pin': ADMIN_PIN, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- capture ----
async function loadLayoutsForCapture() {
  const sel = document.getElementById('captureLayoutSelect');
  try {
    // /api/layouts is staff-gated, but an admin PIN also satisfies the
    // staff gate (same "owner shouldn't need two PINs" rule as every other
    // staff route) -- see requireStaffPin in agent/server.js.
    const layouts = await api('/api/layouts', { headers: { 'x-staff-pin': ADMIN_PIN } });
    if (!layouts.length) {
      sel.innerHTML = '<option value="">No layouts yet -- add one from TSB Platform: Venue Control → Layouts first</option>';
      return;
    }
    sel.innerHTML = layouts.map((l) => `<option value="${l.id}">${escapeHtml(l.name)} (${l.items.length} item${l.items.length === 1 ? '' : 's'} currently)</option>`).join('');
  } catch (e) {
    sel.innerHTML = `<option value="">Failed to load layouts: ${escapeHtml(e.message)}</option>`;
  }
}

async function captureLayout() {
  const id = document.getElementById('captureLayoutSelect').value;
  const msgEl = document.getElementById('captureMsg');
  if (!id) { msgEl.innerHTML = '<div class="msg error">No layout selected.</div>'; return; }
  msgEl.innerHTML = '<p class="muted">Capturing…</p>';
  try {
    const result = await api(`/api/admin/layouts/${id}/capture`, { method: 'POST' });
    msgEl.innerHTML = `<div class="msg success">Captured ${result.item_count} item(s).</div>`;
    await loadLayoutsForCapture();
  } catch (e) {
    msgEl.innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}

// ---- backups ----
function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function itemCountsText(counts) {
  if (!counts) return '';
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
}

async function loadBackups() {
  const box = document.getElementById('backupsBox');
  try {
    const backups = await api('/api/backups');
    if (!backups.length) { box.innerHTML = '<p class="muted">No backups yet.</p>'; return; }
    box.innerHTML = `
      <table>
        <thead><tr><th>When</th><th>Kind</th><th>Label</th><th>Contents</th><th>By</th><th>Actions</th></tr></thead>
        <tbody>
          ${backups.map((b) => `
            <tr>
              <td>${escapeHtml(fmtDate(b.created_at))}</td>
              <td>${escapeHtml(b.kind)}</td>
              <td>${escapeHtml(b.label || '—')}</td>
              <td class="muted">${escapeHtml(itemCountsText(b.item_counts))}</td>
              <td class="muted">${escapeHtml(b.created_by || '—')}</td>
              <td class="actions-cell"><button class="small danger" onclick="restoreBackup(${b.id})">Restore</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    box.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function takeBackupNow() {
  const msgEl = document.getElementById('backupMsg');
  msgEl.innerHTML = '<p class="muted">Taking backup…</p>';
  try {
    const { backup } = await api('/api/backup/now', { method: 'POST' });
    msgEl.innerHTML = `<div class="msg success">Backup #${backup.id} taken (${itemCountsText(backup.item_counts)}).</div>`;
    await loadBackups();
  } catch (e) {
    msgEl.innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}

async function restoreBackup(id) {
  if (!confirm(`Restore backup #${id}? This replaces every zone, source, TV, favorite, layout, and schedule for this site with what's in that backup. A safety snapshot of the current state is taken automatically first, so this itself can be undone by restoring that snapshot.`)) return;
  const msgEl = document.getElementById('backupMsg');
  msgEl.innerHTML = '<p class="muted">Restoring…</p>';
  try {
    const result = await api('/api/restore', { method: 'POST', body: JSON.stringify({ backup_id: id }) });
    msgEl.innerHTML = `<div class="msg success">Restored (${itemCountsText(result.restored)}). Safety snapshot #${result.pre_restore_backup_id} was taken first.</div>`;
    await loadBackups();
  } catch (e) {
    msgEl.innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}
