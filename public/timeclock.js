let ME = null;
let MY_ACCESS = false;
let IS_MANAGER = false;
let currentPeriodIndex = null;

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

function setTab(which) {
  document.getElementById('panelMine').style.display = which === 'mine' ? '' : 'none';
  document.getElementById('panelRoster').style.display = which === 'roster' ? '' : 'none';
  document.getElementById('panelPeriod').style.display = which === 'period' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  if (which === 'mine') loadMine();
  if (which === 'roster') loadRoster();
  if (which === 'period') loadPeriod();
}

function renderTabs(initial) {
  const tabs = [];
  if (MY_ACCESS) tabs.push({ key: 'mine', label: 'My Clock' });
  if (IS_MANAGER) tabs.push({ key: 'roster', label: 'Roster' });
  if (IS_MANAGER) tabs.push({ key: 'period', label: 'Pay Period' });
  document.getElementById('tabs').innerHTML = tabs.map(t =>
    `<button data-tab="${t.key}" onclick="setTab('${t.key}')">${t.label}</button>`).join('');
  setTab(initial && tabs.some(t => t.key === initial) ? initial : (tabs[0] ? tabs[0].key : null));
}

// ---------------- My Clock ----------------
async function loadMine() {
  const el = document.getElementById('panelMine');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const status = await api('/api/timeclock/status');
    const open = status.open;
    el.innerHTML = `
      <div class="card center">
        ${open
          ? `<p class="msg success">Clocked in since ${fmtDateTime(open.clock_in)}</p>
             <button class="primary danger" onclick="punch('out')">Clock Out</button>`
          : `<p class="muted">Not currently clocked in</p>
             <button class="primary" onclick="punch('in')">Clock In</button>`}
        <p class="muted" style="margin-top:14px;">This pay period: <b>${status.periodHours} hrs</b> across ${status.periodPunches} punch(es)</p>
      </div>
      <div class="card">
        <h2>Recent</h2>
        ${status.recent.length ? `<table><thead><tr><th>In</th><th>Out</th><th>Memo</th></tr></thead><tbody>
          ${status.recent.map(r => `<tr><td>${fmtDateTime(r.clock_in)}</td><td>${r.clock_out ? fmtDateTime(r.clock_out) : '<span class="badge on">open</span>'}</td><td>${escapeHtml(r.memo || '')}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">No punches yet.</p>'}
      </div>
    `;
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

async function punch(action) {
  try {
    const result = await api('/api/timeclock/punch', { method: 'POST', body: { action } });
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('');
    loadMine();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------- Roster ----------------
async function loadRoster() {
  const el = document.getElementById('panelRoster');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const roster = await api('/api/timeclock/roster');
    el.innerHTML = `<div class="card">
      <h1>Roster</h1>
      ${roster.length ? roster.map(r => `
        <div class="list-row">
          <div>
            <div class="name">${escapeHtml(r.name)}</div>
            <div class="sub">${r.since ? fmtDateTime(r.since) : 'never clocked in'}</div>
          </div>
          <span class="badge ${r.status === 'clocked_in' ? (r.stale ? 'stale' : 'on') : 'off'}">
            ${r.status === 'clocked_in' ? (r.stale ? 'clocked in — stale' : 'clocked in') : r.status.replace('_', ' ')}
          </span>
        </div>`).join('') : '<p class="muted">No one has Time Clock access yet.</p>'}
    </div>`;
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

// ---------------- Pay period ----------------
async function loadPeriod(idx) {
  const el = document.getElementById('panelPeriod');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const data = await api('/api/timeclock/pay-period' + (idx !== undefined ? `?periodIndex=${idx}` : ''));
    currentPeriodIndex = data.periodIndex;
    el.innerHTML = `<div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <button class="small ghost" onclick="loadPeriod(${currentPeriodIndex - 1})">&larr; Prev</button>
        <h2 style="margin:0;">${fmtDateTime(data.periodStart)} – ${fmtDateTime(data.periodEnd)} ${data.isCurrent ? '<span class="badge on">current</span>' : ''}</h2>
        <button class="small ghost" onclick="loadPeriod(${currentPeriodIndex + 1})">Next &rarr;</button>
      </div>
      ${data.employees.length ? data.employees.map(emp => `
        <h2 style="margin-top:18px;">${escapeHtml(emp.name)} — ${(emp.totalMinutes / 60).toFixed(1)} hrs</h2>
        <table><thead><tr><th>In</th><th>Out</th><th>Memo</th><th></th></tr></thead><tbody>
          ${emp.entries.map(r => `<tr>
            <td>${fmtDateTime(r.clock_in)}</td>
            <td>${r.clock_out ? fmtDateTime(r.clock_out) : '<span class="badge on">open</span>'}</td>
            <td>${escapeHtml(r.memo || '')}${r.auto_clock_out ? ' <span class="muted">(auto)</span>' : ''}</td>
            <td><button class="small ghost" onclick="editPunch('${r.id}','${r.clock_in}','${r.clock_out || ''}')">Edit</button>
                <button class="small ghost" onclick="deletePunch('${r.id}')">Delete</button></td>
          </tr>`).join('')}
        </tbody></table>
      `).join('') : '<p class="muted">No punches this period.</p>'}
    </div>`;
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

async function editPunch(id, clockIn, clockOut) {
  // Pre-filled and entered in the bar's own timezone (Central), not
  // whatever timezone the manager's own device happens to be set to —
  // see toBarTimeInput/APP_TIMEZONE in common.js. Previously this sliced
  // the raw UTC timestamp directly, so the prompt showed UTC wall-clock
  // numbers mislabeled as if they were local (e.g. a 9am Central clock-in
  // showed as "14:00" here), and whatever got typed back was then stored
  // as if it were UTC too — that's the reported "off by 5 hours" bug.
  const newIn = window.prompt('Clock-in — bar time (Central), e.g. "2026-08-19 07:00":', clockIn ? toBarTimeInput(clockIn) : '');
  if (newIn === null) return;
  const newOut = window.prompt('Clock-out — bar time (Central), blank = still open:', clockOut ? toBarTimeInput(clockOut) : '');
  if (newOut === null) return;
  const reason = window.prompt('Reason for this edit (for the audit log):', '');
  try {
    await withStepUp(() => api(`/api/timeclock/punch/${id}/edit`, {
      method: 'POST', body: { clockIn: newIn, clockOut: newOut || null, reason },
    }));
    showMsg('Punch updated.', 'success');
    loadPeriod(currentPeriodIndex);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function deletePunch(id) {
  if (!window.confirm('Delete this punch? This is logged in the audit trail.')) return;
  const reason = window.prompt('Reason for deleting:', '');
  try {
    await withStepUp(() => api(`/api/timeclock/punch/${id}/delete`, { method: 'POST', body: { reason } }));
    showMsg('Punch deleted.', 'success');
    loadPeriod(currentPeriodIndex);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

(function init() {
  ME = requireAuth();
  if (!ME) return;
  renderTopbar('Time Clock');
  const access = getAppAccess();
  MY_ACCESS = ME.role === 'owner' || access.some(a => a.app_key === 'time_clock' && a.enabled);
  IS_MANAGER = ME.role === 'manager' || ME.role === 'owner';
  if (!MY_ACCESS && !IS_MANAGER) {
    document.getElementById('app').innerHTML = '<div class="card"><p>Time Clock isn\'t enabled for your account yet — ask your manager.</p><p><a href="/dashboard.html">Back home</a></p></div>';
    return;
  }
  const params = new URLSearchParams(window.location.search);
  renderTabs(params.get('view'));
})();
