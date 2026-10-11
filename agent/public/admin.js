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
    loadReceivers();
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

// ---- Receiver addresses ----
let RECEIVERS = [];
async function loadReceivers() {
  const box = document.getElementById('receiversBox');
  try {
    const d = await api('/api/admin/receivers');
    RECEIVERS = d.rows || [];
    const idText = (r) => {
      const i = r.identity;
      if (!i) return '<span class="muted">not checked yet</span>';
      if (i.status === 'ok') return `<span style="color:#4caf3a">ok · ${escapeHtml(i.found || i.expected || '')}</span>${i.movedFrom ? ` <span class="muted">(moved from ${escapeHtml(i.movedFrom)})</span>` : ''}`;
      if (i.status === 'mismatch') return `<span style="color:#e3242b">wrong box · found ${escapeHtml(i.found || '?')}, expected ${escapeHtml(i.expected || '?')}</span>`;
      if (i.status === 'duplicate') return `<span style="color:#e3242b">same address as Rcvr ${escapeHtml(i.sharedWith.join(', '))}</span>`;
      if (i.status === 'unreachable') return '<span style="color:#e8931c">not answering</span>';
      return '<span class="muted">no receiver ID yet</span>';
    };
    box.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:13px;">
      <tr class="muted"><th style="text-align:left">Rcvr</th><th style="text-align:left">Address</th><th style="text-align:left">MAC</th><th style="text-align:left">Box check</th><th style="text-align:left">UniFi</th></tr>
      ${RECEIVERS.map((r) => `<tr style="border-top:1px solid #333;">
        <td style="padding:6px 4px;"><b>${escapeHtml(r.qam_channel || r.slot)}</b> <span class="muted">${escapeHtml(r.label || '')}</span></td>
        <td style="padding:6px 4px;">${escapeHtml(r.ip || '—')}</td>
        <td style="padding:6px 4px; font-family:monospace;">${escapeHtml(r.mac || '—')}</td>
        <td style="padding:6px 4px;">${idText(r)}</td>
        <td style="padding:6px 4px;">${r.unifi ? (r.unifi.fixed ? `<span style="color:#4caf3a">reserved ${escapeHtml(r.unifi.fixedIp || '')}</span>` : 'dynamic') : '<span class="muted">not seen</span>'}</td>
      </tr>`).join('')}
    </table>${d.unifiConfigured ? '' : '<p class="muted">This box has no UniFi login, so it can list but not reserve.</p>'}${d.unifiError ? `<p class="msg error">UniFi: ${escapeHtml(d.unifiError)}</p>` : ''}
    ${(d.unassigned || []).length ? `<h3 style="margin:16px 0 6px;">New receivers on the network</h3>
      <p class="muted">DirecTV boxes answering on the LAN that belong to no slot. Give each its receiver number (10 for channel 10.1) and Adopt.</p>
      ${d.unassigned.map((u, i) => `<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:6px 0; border-top:1px solid #333;">
        <span style="font-family:monospace;">${escapeHtml(u.ip)}</span><span class="muted" style="font-family:monospace;">${escapeHtml(u.mac || 'MAC unknown')}</span><span class="muted">ID ${escapeHtml(u.receiverId)}</span>
        <input id="adoptSlot${i}" type="number" min="1" max="999" placeholder="Rcvr #" style="width:90px;">
        <button class="primary" onclick="adoptReceiver('${escapeHtml(u.receiverId)}', ${i})">Adopt</button>
      </div>`).join('')}` : '<p class="muted" style="margin-top:10px;">No unassigned receivers on the network (checked hourly, and on Refresh).</p>'}`;
  } catch (e) {
    box.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function recheckReceivers() {
  const msg = document.getElementById('receiversMsg');
  msg.innerHTML = '<p class="muted">Asking every box who it is and sweeping the network (about 20 seconds)…</p>';
  try { await api('/api/sources/identity/check', { method: 'POST', body: JSON.stringify({}) }); msg.innerHTML = ''; } catch (e) { msg.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; }
  loadReceivers();
}
async function adoptReceiver(receiverId, i) {
  const slot = Number(document.getElementById(`adoptSlot${i}`).value);
  const msg = document.getElementById('receiversMsg');
  if (!slot) { msg.innerHTML = '<p class="msg error">Enter the receiver number first.</p>'; return; }
  msg.innerHTML = '<p class="muted">Adopting…</p>';
  try {
    const d = await api('/api/admin/receivers/adopt', { method: 'POST', body: JSON.stringify({ receiverId, slot }) });
    msg.innerHTML = `<p class="msg success">Added ${escapeHtml((d.source && d.source.label) || `Rcvr ${slot}`)} on channel ${escapeHtml((d.source && d.source.qam_channel) || `${slot}.1`)}. Reserve its address when you are done.</p>`;
    setTimeout(loadReceivers, 1500);
  } catch (e) {
    msg.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function reserveReceivers() {
  const btn = document.getElementById('reserveBtn');
  const msg = document.getElementById('receiversMsg');
  btn.disabled = true; msg.innerHTML = '<p class="muted">Reserving…</p>';
  try {
    const d = await api('/api/admin/receivers/reserve', { method: 'POST', body: JSON.stringify({}) });
    const ok = d.results.filter((x) => x.ok); const bad = d.results.filter((x) => !x.ok);
    msg.innerHTML = `<p class="msg ${bad.length ? 'error' : 'success'}">${ok.length} reserved${bad.length ? `, ${bad.length} skipped` : ''}.</p>` +
      (bad.length ? `<ul class="muted">${bad.map((x) => `<li>Rcvr ${escapeHtml(x.slot)}: ${escapeHtml(x.error)}</li>`).join('')}</ul>` : '');
    loadReceivers();
  } catch (e) {
    msg.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
  btn.disabled = false;
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
