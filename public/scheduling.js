// Scheduling — manager scheduler (draft-then-publish), time off, self-service
// availability, and the employee "my shifts" portal. Ported from the old
// Google Apps Script "TSB Scheduling" system's shape (see server/scheduling.js
// header for the full writeup) onto this platform's shared people/locations
// core.

let ME = null;
let IS_OWNER = false;
let IS_MGR_OR_OWNER = false;
let LOCATIONS = [];
let POSITIONS = [];
let ALL_SCHEDULES = [];        // every active schedule, for pickers
let MANAGEABLE_SCHEDULES = []; // schedules this manager (or every schedule, for the owner) can write to
let EMPLOYEES = [];            // full roster w/ schedule_ids/position_ids/manager_schedule_ids
let SELECTED_SCHEDULE_IDS = [];
let WEEK_START = '';           // ISO date, Saturday of the currently-loaded week (business week runs Sat-Fri)
let WEEK_SHIFTS = [];          // this week's live shifts + my draft overlay
let DRAFT_COUNT = 0;
let PUBLISH_OVERRIDES = {};    // draftId -> override reason, accumulated across a Publish retry
let ADMIN_SCHEDULES = [];      // Setup tab: every schedule incl. archived
let PENDING_TIMEOFF_COUNT = 0; // sidebar badge + pending-review nudge (bootstrap-provided)
let SCHED_PICKER_OPEN = false; // schedule-picker popover open/closed (Scheduler tab)

// ---------------- Date helpers (calendar-date-only, local time — these
// dates carry no time-of-day meaning, so plain local Date math is fine and
// avoids UTC-conversion day-shift bugs from toISOString()). ----------------
function dateToISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDaysISO(iso, n) {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + n);
  return dateToISO(d);
}
function startOfWeekISO(iso) {
  // Business week runs Saturday through Friday (not the JS-default Sun-Sat).
  // getDay(): Sun=0 ... Sat=6. Days since the most recent Saturday = (day+1) % 7.
  const d = isoToDate(iso);
  d.setDate(d.getDate() - ((d.getDay() + 1) % 7));
  return dateToISO(d);
}
function todayISO() { return dateToISO(new Date()); }
function weekDatesFrom(startIso) { return Array.from({ length: 7 }, (_, i) => addDaysISO(startIso, i)); }
function dayLabel(iso) { return isoToDate(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); }
function formatTime12(t) {
  if (!t) return '';
  const [hStr, m] = t.slice(0, 5).split(':');
  let h = Number(hStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m}${ampm}`;
}

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}
function personName(id) { const p = EMPLOYEES.find(e => e.id === id); return p ? p.name : '—'; }
function scheduleName(id) { const s = ALL_SCHEDULES.find(s => s.id === id) || ADMIN_SCHEDULES.find(s => s.id === id); return s ? s.name : '—'; }
function positionName(id) { const p = POSITIONS.find(p => p.id === id); return p ? p.name : '—'; }

// ---------------- Sidebar nav (Concept A: left rail instead of a tab bar) ----------------
const TAB_TITLES = { mine: 'My Schedule', scheduler: 'Scheduler', timeoff: 'Time Off', setup: 'Setup' };
// Icons are hidden on desktop (Concept A's approved look uses the dot indicator only) and
// shown on narrow viewports — bottom tab bar (portrait) and collapsed rail (landscape) —
// where a text-only nav item doesn't work. See scheduling.css's mobile media queries.
const NAV_ICONS = {
  mine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  scheduler: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>',
  timeoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
  setup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

function setTab(which) {
  document.getElementById('panelMine').style.display = which === 'mine' ? '' : 'none';
  document.getElementById('panelScheduler').style.display = which === 'scheduler' ? '' : 'none';
  document.getElementById('panelTimeOff').style.display = which === 'timeoff' ? '' : 'none';
  document.getElementById('panelSetup').style.display = which === 'setup' ? '' : 'none';
  Array.from(document.querySelectorAll('#sidebarNav button.nav-item')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  document.getElementById('schedPageTitle').textContent = TAB_TITLES[which] || 'Scheduling';
  closeSchedPicker();
  if (which === 'mine') renderMine();
  if (which === 'scheduler') renderScheduler();
  if (which === 'timeoff') renderTimeOffAdmin();
  if (which === 'setup') renderSetup();
}
function renderTabs() {
  const tabs = [{ key: 'mine', label: 'My Schedule' }];
  if (IS_MGR_OR_OWNER) {
    tabs.push({ key: 'scheduler', label: 'Scheduler' });
    tabs.push({ key: 'timeoff', label: 'Time Off', badge: PENDING_TIMEOFF_COUNT });
    tabs.push({ key: 'setup', label: 'Setup' });
  }
  const navHtml = tabs.map(t =>
    `<button type="button" class="nav-item" data-tab="${t.key}" onclick="setTab('${t.key}')">
      <span class="nav-icon">${NAV_ICONS[t.key] || ''}</span>
      <span class="dot"></span><span class="nav-label">${t.label}</span>
      ${t.badge ? `<span class="nav-badge">${t.badge}</span>` : ''}
    </button>`).join('');
  const pendingBanner = (IS_MGR_OR_OWNER && PENDING_TIMEOFF_COUNT)
    ? `<div class="pending-banner"><b>${PENDING_TIMEOFF_COUNT} time-off request${PENDING_TIMEOFF_COUNT === 1 ? '' : 's'}</b> pending your review.</div>`
    : '';
  document.getElementById('sidebarNav').innerHTML = `
    <div class="brand-row"><div class="brand-mark">T</div><div><div class="brand-name">TSB Scheduling</div><div class="brand-sub">Ticket Sports Bar</div></div></div>
    ${navHtml}
    ${pendingBanner}`;
  document.getElementById('schedWho').innerHTML = ME ? `Signed in as <b>${escapeHtml(ME.name)}</b><br>${escapeHtml(ME.role)}` : '';
  setTab(IS_MGR_OR_OWNER ? 'scheduler' : 'mine');
}

function closeAllModals() {
  closeShiftModal(); closePublishModal(); closeTimeOffModal(); closeQualModal(); closePrintModal(); closeSchedPicker();
}

// =========================================================
// MY SCHEDULE — everyone (managers/owners see this too, for their own shifts).
// =========================================================
async function renderMine() {
  const el = document.getElementById('panelMine');
  el.innerHTML = `
    <div class="card">
      <h2>Upcoming shifts</h2>
      <div id="myUpcoming"><p class="muted">Loading…</p></div>
    </div>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2 style="margin:0;">Week of <span id="myWeekLabel"></span></h2>
        <div class="stack-actions" style="margin:0; gap:6px;">
          <button class="small ghost" onclick="shiftMyWeek(-7)">‹ Prev</button>
          <button class="small ghost" onclick="shiftMyWeek(7)">Next ›</button>
        </div>
      </div>
      <div id="myWeek" style="margin-top:10px;"><p class="muted">Loading…</p></div>
    </div>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2 style="margin:0;">Time off</h2>
        <button class="small secondary" style="margin-top:0;" onclick="openTimeOffModal()">Request time off</button>
      </div>
      <div id="myTimeOff" style="margin-top:10px;"><p class="muted">Loading…</p></div>
    </div>
    <div class="card">
      <h2>My availability</h2>
      <p class="muted">Windows you can't work — used to flag conflicts when a manager schedules you (they can still schedule you anyway, with a reason).</p>
      <div id="myAvailability"><p class="muted">Loading…</p></div>
      <div class="list-row" style="border:none; gap:8px; align-items:flex-end; flex-wrap:wrap;">
        <div><label for="avDay">Day</label><select id="avDay">
          <option value="Sun">Sunday</option><option value="Mon">Monday</option><option value="Tue">Tuesday</option>
          <option value="Wed">Wednesday</option><option value="Thu">Thursday</option><option value="Fri">Friday</option><option value="Sat">Saturday</option>
        </select></div>
        <div><label for="avStart">From</label><input type="time" id="avStart"></div>
        <div><label for="avEnd">To</label><input type="time" id="avEnd"></div>
        <div style="flex:1; min-width:140px;"><label for="avNote">Note (optional)</label><input id="avNote" placeholder="e.g. school"></div>
        <div><button class="secondary" style="margin-top:0;" onclick="addAvailabilityRow()">Add</button></div>
      </div>
      <div id="avResult"></div>
    </div>`;
  if (!WEEK_START) WEEK_START = startOfWeekISO(todayISO());
  loadMyUpcoming();
  loadMyWeek();
  loadMyTimeOff();
  loadMyAvailability();
}

async function loadMyUpcoming() {
  const el = document.getElementById('myUpcoming');
  try {
    const shifts = await api('/api/scheduling/my-shifts/upcoming');
    el.innerHTML = shifts.length ? shifts.map(s => `<div class="list-row">
      <div><div class="name">${escapeHtml(s.schedule_name)} — ${escapeHtml(s.position_name)}</div>
      <div class="sub">${dayLabel(s.shift_date)} · ${formatTime12(s.start_time)}–${formatTime12(s.end_time)}</div></div>
    </div>`).join('') : '<p class="muted">No upcoming shifts scheduled.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function shiftMyWeek(days) { WEEK_START = addDaysISO(WEEK_START, days); loadMyWeek(); }

async function loadMyWeek() {
  document.getElementById('myWeekLabel').textContent = dayLabel(WEEK_START) + ' – ' + dayLabel(addDaysISO(WEEK_START, 6));
  const el = document.getElementById('myWeek');
  try {
    const shifts = await api('/api/scheduling/my-shifts?weekStart=' + WEEK_START);
    const dates = weekDatesFrom(WEEK_START);
    el.innerHTML = dates.map(date => {
      const day = shifts.filter(s => s.shift_date === date);
      return `<div class="list-row" style="align-items:flex-start;">
        <div style="width:120px; flex-shrink:0;"><b>${dayLabel(date)}</b></div>
        <div style="flex:1;">${day.length ? day.map(s => `${escapeHtml(s.schedule_name)} — ${escapeHtml(s.position_name)}, ${formatTime12(s.start_time)}–${formatTime12(s.end_time)}`).join('<br>') : '<span class="muted">Off</span>'}</div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function loadMyTimeOff() {
  const el = document.getElementById('myTimeOff');
  try {
    const rows = await api('/api/scheduling/time-off/mine');
    el.innerHTML = rows.length ? rows.map(r => {
      const range = r.start_date === r.end_date ? r.start_date : `${r.start_date} – ${r.end_date}`;
      const badgeClass = r.status === 'approved' ? 'on' : (r.status === 'denied' ? 'danger' : 'stale');
      return `<div class="list-row"><div>
        <div class="name">${escapeHtml(range)} <span class="badge ${badgeClass}">${r.status}</span></div>
        ${r.message ? `<div class="sub">${escapeHtml(r.message)}</div>` : ''}
      </div></div>`;
    }).join('') : '<p class="muted">No time off requests yet.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function openTimeOffModal() {
  document.getElementById('toStart').value = '';
  document.getElementById('toEnd').value = '';
  document.getElementById('toMessage').value = '';
  document.getElementById('toResult').innerHTML = '';
  document.getElementById('timeOffModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closeTimeOffModal() {
  document.getElementById('timeOffModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
async function submitTimeOffRequest() {
  const startDate = document.getElementById('toStart').value;
  const endDate = document.getElementById('toEnd').value;
  const message = document.getElementById('toMessage').value.trim();
  const resultEl = document.getElementById('toResult');
  if (!startDate || !endDate) { resultEl.innerHTML = '<p class="msg error">Pick both dates.</p>'; return; }
  try {
    const result = await api('/api/scheduling/time-off', { method: 'POST', body: { startDate, endDate, allDay: true, message } });
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    closeTimeOffModal();
    showMsg('Time off requested.', 'success');
    loadMyTimeOff();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function loadMyAvailability() {
  const el = document.getElementById('myAvailability');
  try {
    const rows = await api('/api/scheduling/availability/mine');
    el.innerHTML = rows.length ? rows.map(a => `<div class="list-row">
      <div><div class="name">${a.day_of_week}, ${formatTime12(a.start_time)}–${formatTime12(a.end_time)}</div>${a.note ? `<div class="sub">${escapeHtml(a.note)}</div>` : ''}</div>
      <button class="small ghost" onclick="deleteAvailabilityRow('${a.id}')">Remove</button>
    </div>`).join('') : '<p class="muted">No windows marked yet.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function addAvailabilityRow() {
  const dayOfWeek = document.getElementById('avDay').value;
  const startTime = document.getElementById('avStart').value;
  const endTime = document.getElementById('avEnd').value;
  const note = document.getElementById('avNote').value.trim();
  const resultEl = document.getElementById('avResult');
  if (!startTime || !endTime) { resultEl.innerHTML = '<p class="msg error">Pick a start and end time.</p>'; return; }
  try {
    // saveMyAvailabilityRow returns the full updated list on success, or
    // {ok:false, error} on failure — no success wrapper either way.
    const result = await api('/api/scheduling/availability', { method: 'POST', body: { dayOfWeek, startTime, endTime, note } });
    if (!Array.isArray(result)) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    document.getElementById('avNote').value = '';
    resultEl.innerHTML = '';
    loadMyAvailability();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function deleteAvailabilityRow(id) {
  try {
    await api(`/api/scheduling/availability/${id}/delete`, { method: 'POST' });
    loadMyAvailability();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// =========================================================
// SCHEDULER (manager/owner) — week grid, one row per employee checked into
// a selected schedule, drafts overlaid on live shifts, publish flow.
// =========================================================
async function renderScheduler() {
  const el = document.getElementById('panelScheduler');
  if (!WEEK_START) WEEK_START = startOfWeekISO(todayISO());
  if (!SELECTED_SCHEDULE_IDS.length) SELECTED_SCHEDULE_IDS = MANAGEABLE_SCHEDULES.map(s => s.id);
  el.innerHTML = `
    <div class="card" style="position:relative;">
      <label>Schedules</label>
      <div class="picker-btn" id="schedPickerBtn" onclick="toggleSchedPicker(event)"></div>
      <div class="picker-popover" id="schedPickerPopover" style="display:none;"></div>
    </div>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <h2 style="margin:0;">Week of <span id="schedWeekLabel"></span></h2>
        <div class="stack-actions" style="margin:0; gap:6px;">
          <button class="small ghost" onclick="shiftSchedWeek(-7)">‹ Prev</button>
          <button class="small ghost" onclick="goToCurrentSchedWeek()">Today</button>
          <button class="small ghost" onclick="shiftSchedWeek(7)">Next ›</button>
          <button class="small ghost" onclick="openPrintModal()">Print</button>
          <button class="small secondary" onclick="openShiftModal({})">+ Add shift</button>
        </div>
      </div>
      <div id="draftBanner" class="draft-banner no-drafts" style="margin-top:10px;"></div>
      <div id="schedGrid" style="margin-top:14px; overflow-x:auto;"><p class="muted">Loading…</p></div>
    </div>
    <div class="card">
      <h2>Copy this week forward</h2>
      <p class="muted">Copies one employee's shifts from the week shown above onto the following week, as new drafts.</p>
      <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap;">
        <div style="flex:1; min-width:180px;"><label for="copyEmployee">Employee</label><select id="copyEmployee"></select></div>
        <div><button class="secondary" style="margin-top:0;" onclick="submitCopyWeekForward()">Copy forward</button></div>
      </div>
      <div id="copyResult"></div>
    </div>`;

  renderSchedPicker();

  const copySel = document.getElementById('copyEmployee');
  copySel.innerHTML = EMPLOYEES.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');

  loadSchedGrid();
}

// ---- Schedule picker: a "N schedules selected" button that opens a
// checklist popover, replacing the old always-visible checkbox grid. ----
function renderSchedPicker() {
  const btn = document.getElementById('schedPickerBtn');
  if (!btn) return;
  const n = SELECTED_SCHEDULE_IDS.length;
  btn.innerHTML = MANAGEABLE_SCHEDULES.length
    ? `${n} schedule${n === 1 ? '' : 's'} selected <span class="chev">▾</span>`
    : `No schedules assigned <span class="chev">▾</span>`;

  const pop = document.getElementById('schedPickerPopover');
  const allChecked = MANAGEABLE_SCHEDULES.length > 0 && SELECTED_SCHEDULE_IDS.length === MANAGEABLE_SCHEDULES.length;
  const allRow = MANAGEABLE_SCHEDULES.length
    ? `<div class="pp-row" onclick="toggleAllSchedules(${!allChecked})" style="border-bottom:1px solid var(--line); margin-bottom:4px; padding-bottom:10px;">
        <div class="pp-check ${allChecked ? 'checked' : ''}">${allChecked ? '✓' : ''}</div>
        <div class="lbl"><b>ALL</b></div>
      </div>`
    : '';
  pop.innerHTML = `<div class="pp-title">Choose schedules</div>` + allRow + (MANAGEABLE_SCHEDULES.length
    ? MANAGEABLE_SCHEDULES.map(s => {
        const checked = SELECTED_SCHEDULE_IDS.includes(s.id);
        return `<div class="pp-row" onclick="toggleSchedule('${s.id}', ${!checked})">
          <div class="pp-check ${checked ? 'checked' : ''}">${checked ? '✓' : ''}</div>
          <div class="lbl"><b>${escapeHtml(s.name)}</b><span>${escapeHtml(s.location_name)}</span></div>
        </div>`;
      }).join('')
    : '<p class="pp-empty">No schedules assigned to you yet — ask the owner to set one up under Setup.</p>');
}
function toggleSchedPicker(evt) {
  if (evt) evt.stopPropagation();
  SCHED_PICKER_OPEN = !SCHED_PICKER_OPEN;
  const pop = document.getElementById('schedPickerPopover');
  if (!pop) return;
  pop.style.display = SCHED_PICKER_OPEN ? '' : 'none';
  if (SCHED_PICKER_OPEN) {
    document.addEventListener('click', closeSchedPickerOnOutsideClick);
  }
}
function closeSchedPicker() {
  SCHED_PICKER_OPEN = false;
  const pop = document.getElementById('schedPickerPopover');
  if (pop) pop.style.display = 'none';
  document.removeEventListener('click', closeSchedPickerOnOutsideClick);
}
function closeSchedPickerOnOutsideClick(evt) {
  const pop = document.getElementById('schedPickerPopover');
  const btn = document.getElementById('schedPickerBtn');
  if (!pop || (pop.contains(evt.target)) || (btn && btn.contains(evt.target))) return;
  closeSchedPicker();
}
function toggleSchedule(id, checked) {
  if (checked && !SELECTED_SCHEDULE_IDS.includes(id)) SELECTED_SCHEDULE_IDS.push(id);
  if (!checked) SELECTED_SCHEDULE_IDS = SELECTED_SCHEDULE_IDS.filter(x => x !== id);
  renderSchedPicker();
  loadSchedGrid();
}
function toggleAllSchedules(checked) {
  SELECTED_SCHEDULE_IDS = checked ? MANAGEABLE_SCHEDULES.map(s => s.id) : [];
  renderSchedPicker();
  loadSchedGrid();
}

// ---- Draft/publish banner — replaces the old small "N drafts pending"
// badge with a proper banner + inline Discard/Publish actions. ----
function renderDraftBanner() {
  const el = document.getElementById('draftBanner');
  if (!el) return;
  if (DRAFT_COUNT) {
    el.className = 'draft-banner has-drafts';
    el.innerHTML = `
      <div><span class="n">${DRAFT_COUNT} draft${DRAFT_COUNT === 1 ? '' : 's'}</span> pending — nothing is live or notified until you publish.</div>
      <div class="actions">
        <button class="btn-discard" onclick="discardDrafts()">Discard my drafts</button>
        <button class="btn-publish" onclick="openPublishModal()">Publish</button>
      </div>`;
  } else {
    el.className = 'draft-banner no-drafts';
    el.innerHTML = `<div>No drafts pending.</div>`;
  }
}
function shiftSchedWeek(days) {
  WEEK_START = addDaysISO(WEEK_START, days);
  loadSchedGrid();
}
function goToCurrentSchedWeek() {
  WEEK_START = startOfWeekISO(todayISO());
  loadSchedGrid();
}

async function loadSchedGrid() {
  document.getElementById('schedWeekLabel').textContent = dayLabel(WEEK_START) + ' – ' + dayLabel(addDaysISO(WEEK_START, 6));
  const el = document.getElementById('schedGrid');
  if (!SELECTED_SCHEDULE_IDS.length) { el.innerHTML = '<p class="muted">Pick at least one schedule above.</p>'; return; }
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    WEEK_SHIFTS = await api(`/api/scheduling/week?scheduleIds=${SELECTED_SCHEDULE_IDS.join(',')}&weekStart=${WEEK_START}`);
    const summary = await api('/api/scheduling/my-drafts/summary');
    DRAFT_COUNT = summary.count;
    renderDraftBanner();

    // Every employee shows up as a row now, whether or not they have a shift
    // this week — per Scotto, dropped the old "checked into this schedule"
    // filter (Sep 2026). The schedule picker above now only scopes which
    // schedules' shifts are pulled in, not who appears.
    const roster = EMPLOYEES.slice().sort((a, b) => a.name.localeCompare(b.name));
    const dates = weekDatesFrom(WEEK_START);
    if (!roster.length) { el.innerHTML = '<p class="muted">No employees yet.</p>'; return; }
    el.innerHTML = `<table><thead><tr><th>Employee</th>${dates.map(d => `<th>${dayLabel(d)}</th>`).join('')}</tr></thead><tbody>
      ${roster.map(emp => `<tr><td>${escapeHtml(emp.name)}</td>${dates.map(date => schedCellHtml(emp, date)).join('')}</tr>`).join('')}
    </tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function schedCellHtml(emp, date) {
  const shifts = WEEK_SHIFTS.filter(s => s.person_id === emp.id && s.shift_date === date);
  const defaultScheduleId = SELECTED_SCHEDULE_IDS[0];
  const chips = shifts.map(s => {
    const cls = s.draftAction === 'cancel' ? 'cancel' : (s.isDraft ? 'draft' : 'live');
    const label = s.draftAction === 'cancel' ? `<s>${formatTime12(s.start_time)}–${formatTime12(s.end_time)}</s>` : `${formatTime12(s.start_time)}–${formatTime12(s.end_time)}`;
    const payload = JSON.stringify({
      personId: s.person_id, scheduleId: s.schedule_id, positionId: s.position_id, date: s.shift_date,
      startTime: s.start_time, endTime: s.end_time, draftId: s.draftId, shiftId: s.id,
    }).replace(/"/g, '&quot;');
    return `<div class="chip ${cls}" onclick='openShiftModal(${payload})'><span class="p">${escapeHtml(s.position_name)}</span> ${label}</div>`;
  }).join('');
  const addPayload = JSON.stringify({ personId: emp.id, scheduleId: defaultScheduleId, date }).replace(/"/g, '&quot;');
  return `<td style="min-width:120px; vertical-align:top;">${chips}<a href="#" class="add-link" onclick='event.preventDefault(); openShiftModal(${addPayload})'>+ add</a></td>`;
}

// ---- Shift modal (create/update/cancel a draft) ----
function openShiftModal(shift) {
  shift = shift || {};
  document.getElementById('shiftModalTitle').textContent = shift.shiftId || shift.draftId ? 'Edit shift' : 'Add shift';
  document.getElementById('shDraftId').value = shift.draftId || '';
  document.getElementById('shShiftId').value = shift.shiftId || '';
  document.getElementById('shPerson').innerHTML = EMPLOYEES.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
  document.getElementById('shSchedule').innerHTML = MANAGEABLE_SCHEDULES.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  document.getElementById('shPerson').value = shift.personId || (EMPLOYEES[0] && EMPLOYEES[0].id) || '';
  document.getElementById('shSchedule').value = shift.scheduleId || (MANAGEABLE_SCHEDULES[0] && MANAGEABLE_SCHEDULES[0].id) || '';
  fillPositionSelectForPerson(shift.personId, shift.positionId);
  document.getElementById('shDate').value = shift.date || WEEK_START;
  document.getElementById('shStart').value = (shift.startTime || '').slice(0, 5);
  document.getElementById('shEnd').value = (shift.endTime || '').slice(0, 5);
  document.getElementById('shDuplicateDates').value = '';
  document.getElementById('shDuplicateWrap').style.display = (shift.shiftId || shift.draftId) ? 'none' : '';
  document.getElementById('shCancelRow').style.display = (shift.shiftId || shift.draftId) ? '' : 'none';
  document.getElementById('shResult').innerHTML = '';
  document.getElementById('shPerson').onchange = () => fillPositionSelectForPerson(document.getElementById('shPerson').value);
  document.getElementById('shiftModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function fillPositionSelectForPerson(personId, selectedId) {
  const emp = EMPLOYEES.find(e => e.id === personId);
  const ids = emp && emp.position_ids.length ? emp.position_ids : POSITIONS.map(p => p.id);
  const sel = document.getElementById('shPosition');
  sel.innerHTML = POSITIONS.filter(p => ids.includes(p.id)).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
    || POSITIONS.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  if (selectedId) sel.value = selectedId;
}
function closeShiftModal() {
  document.getElementById('shiftModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
function currentShiftPayload() {
  return {
    draftId: document.getElementById('shDraftId').value || undefined,
    id: document.getElementById('shShiftId').value || undefined,
    personId: document.getElementById('shPerson').value,
    scheduleId: document.getElementById('shSchedule').value,
    positionId: document.getElementById('shPosition').value,
    date: document.getElementById('shDate').value,
    startTime: document.getElementById('shStart').value,
    endTime: document.getElementById('shEnd').value,
  };
}
async function submitShift() {
  const payload = currentShiftPayload();
  const resultEl = document.getElementById('shResult');
  if (!payload.date || !payload.startTime || !payload.endTime) { resultEl.innerHTML = '<p class="msg error">Date, start, and end are required.</p>'; return; }
  try {
    const result = await withStepUp(() => api('/api/scheduling/drafts', { method: 'POST', body: payload }));
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    const dupLines = document.getElementById('shDuplicateDates').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (dupLines.length) {
      await withStepUp(() => api('/api/scheduling/drafts/duplicate', {
        method: 'POST',
        body: { scheduleId: payload.scheduleId, personId: payload.personId, positionId: payload.positionId, startTime: payload.startTime, endTime: payload.endTime, targetDates: dupLines },
      }));
    }
    closeShiftModal();
    showMsg('Saved as a draft — publish when ready.', 'success');
    loadSchedGrid();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function submitCancelShift() {
  const payload = currentShiftPayload();
  try {
    const result = await withStepUp(() => api('/api/scheduling/drafts/cancel', { method: 'POST', body: { draftId: payload.draftId, shiftId: payload.id } }));
    if (!result.ok) { document.getElementById('shResult').innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    closeShiftModal();
    showMsg('Marked for cancellation — publish when ready.', 'success');
    loadSchedGrid();
  } catch (e) {
    document.getElementById('shResult').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function discardDrafts() {
  if (!DRAFT_COUNT) return;
  try {
    await withStepUp(() => api('/api/scheduling/drafts/discard', { method: 'POST' }));
    showMsg('Drafts discarded.', 'info');
    loadSchedGrid();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function submitCopyWeekForward() {
  const personId = document.getElementById('copyEmployee').value;
  const resultEl = document.getElementById('copyResult');
  try {
    const result = await withStepUp(() => api('/api/scheduling/copy-week-forward', { method: 'POST', body: { personId, weekStart: WEEK_START } }));
    resultEl.innerHTML = `<p class="msg success">Added ${result.drafted} shift${result.drafted === 1 ? '' : 's'} as drafts for the following week.</p>`;
    loadSchedGrid();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// ---- Publish (plain "are you sure?" confirm — no step-up gate, per Scotto) ----
function openPublishModal() {
  PUBLISH_OVERRIDES = {};
  document.getElementById('publishBody').innerHTML = DRAFT_COUNT
    ? `<p>Publish ${DRAFT_COUNT} pending draft${DRAFT_COUNT === 1 ? '' : 's'}? This updates the live schedule and notifies every affected employee by email/text. Are you sure?</p>`
    : '<p class="muted">Nothing to publish — no drafts pending.</p>';
  document.getElementById('publishConfirmBtn').style.display = DRAFT_COUNT ? '' : 'none';
  document.getElementById('publishModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closePublishModal() {
  document.getElementById('publishModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
async function doPublish() {
  const bodyEl = document.getElementById('publishBody');
  try {
    const result = await withStepUp(() => api('/api/scheduling/publish', { method: 'POST', body: { overrideReasons: PUBLISH_OVERRIDES } }));
    if (result.success) {
      closePublishModal();
      showMsg(`Published ${result.published} shift${result.published === 1 ? '' : 's'} — notified ${result.notifiedEmployees} employee${result.notifiedEmployees === 1 ? '' : 's'}.`, 'success');
      DRAFT_COUNT = 0;
      loadSchedGrid();
      return;
    }
    // Conflicts — render each draft's issues; soft-only conflicts can be
    // overridden with a reason and republished, hard blocks can't.
    bodyEl.innerHTML = `<p class="msg error">Some drafts need attention before this can publish:</p>` +
      result.conflicts.map(c => `<div class="list-row" style="display:block;">
        <div class="name">${escapeHtml(c.employeeName)} — ${escapeHtml(c.date)}</div>
        ${c.hardMessages.map(m => `<div class="sub" style="color:#ff8a9a;">${escapeHtml(m)}</div>`).join('')}
        ${c.softMessages.map(m => `<div class="sub" style="color:#f0c265;">${escapeHtml(m)}</div>`).join('')}
        ${c.canOverride ? `<label style="margin-top:6px;">Override reason</label><input data-draft-id="${c.draftId}" class="publishOverrideInput" placeholder="Why publish this anyway?" oninput="PUBLISH_OVERRIDES['${c.draftId}'] = this.value">` : '<p class="muted" style="margin-top:4px;">Fix or cancel this shift in the Scheduler grid, then try again.</p>'}
      </div>`).join('');
    document.getElementById('publishConfirmBtn').style.display = result.conflicts.some(c => c.canOverride) ? '' : 'none';
    document.getElementById('publishConfirmBtn').textContent = 'Publish anyway';
  } catch (e) {
    bodyEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// ---- Print / multi-week view (mirrors the old system's Print dialog:
// pick schedules + employees, pick 1-3 weeks starting at whatever week the
// Scheduler grid is currently showing, render into a print-only block, and
// hand off to the browser's print dialog — same as before, save-as-PDF works
// there too). Published shifts only, no drafts. ----
function openPrintModal() {
  const schedChecks = MANAGEABLE_SCHEDULES.map(s => `<label class="sc-checkbox"><input type="checkbox" class="printSchedCb" value="${s.id}" ${SELECTED_SCHEDULE_IDS.includes(s.id) ? 'checked' : ''} onchange="refreshPrintEmployeeList()"> ${escapeHtml(s.name)} <span class="muted">(${escapeHtml(s.location_name)})</span></label>`).join('');
  document.getElementById('printBody').innerHTML = `
    <div class="card" style="margin:0 0 12px;">
      <label>Schedules</label>
      <div id="printSchedPicker" class="sc-checkbox-grid">${schedChecks || '<p class="muted">No schedules assigned to you.</p>'}</div>
    </div>
    <div class="card" style="margin:0 0 12px;">
      <label>Employees</label>
      <div id="printEmpPicker" class="sc-checkbox-grid"></div>
    </div>
    <label for="printWeeks">How many weeks</label>
    <select id="printWeeks">
      <option value="1">1 week (just this one)</option>
      <option value="2">2 weeks</option>
      <option value="3">3 weeks</option>
    </select>
    <p class="muted" style="font-size:12px;">Starting from the week of ${dayLabel(WEEK_START)} — the week currently showing in the Scheduler grid. Use Prev/Next there first if you want to print ahead. Weeks with no published shifts yet just print blank.</p>
    <div id="printResult"></div>`;
  refreshPrintEmployeeList();
  document.getElementById('printModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closePrintModal() {
  document.getElementById('printModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
function refreshPrintEmployeeList() {
  // Every employee is listable for print now, same as the grid — no longer
  // gated by which schedule(s) are checked above.
  const roster = EMPLOYEES.slice().sort((a, b) => a.name.localeCompare(b.name));
  const empEl = document.getElementById('printEmpPicker');
  const prevChecked = new Set(Array.from(document.querySelectorAll('.printEmpCb:checked')).map(el => el.value));
  empEl.innerHTML = roster.length
    ? roster.map(e => `<label class="sc-checkbox"><input type="checkbox" class="printEmpCb" value="${e.id}" ${prevChecked.has(String(e.id)) || !prevChecked.size ? 'checked' : ''}> ${escapeHtml(e.name)}</label>`).join('')
    : '<p class="muted">No employees yet.</p>';
}
async function submitPrint() {
  const resultEl = document.getElementById('printResult');
  const scheduleIds = Array.from(document.querySelectorAll('.printSchedCb:checked')).map(el => el.value);
  const employeeIds = Array.from(document.querySelectorAll('.printEmpCb:checked')).map(el => el.value);
  if (!scheduleIds.length) { resultEl.innerHTML = '<p class="msg error">Pick at least one schedule.</p>'; return; }
  if (!employeeIds.length) { resultEl.innerHTML = '<p class="msg error">Pick at least one employee.</p>'; return; }
  const numWeeks = Number(document.getElementById('printWeeks').value);
  resultEl.innerHTML = '<p class="muted">Preparing…</p>';
  try {
    const shifts = await api(`/api/scheduling/print?scheduleIds=${scheduleIds.join(',')}&weekStart=${WEEK_START}&weeks=${numWeeks}`);
    renderPrintView(shifts.filter(s => employeeIds.includes(String(s.person_id))), numWeeks);
    closePrintModal();
    window.print();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
function renderPrintView(shifts, numWeeks) {
  const dayHeader = (d) => `<th>${isoToDate(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</th>`;
  const empNames = [...new Set(shifts.map(s => s.person_name))].sort((a, b) => a.localeCompare(b));
  let html = `<h2 style="margin-bottom:2px;">Bar Ops Scheduling</h2>`;
  for (let w = 0; w < numWeeks; w++) {
    const wStart = addDaysISO(WEEK_START, w * 7);
    const dates = weekDatesFrom(wStart);
    const header = `<th>Employee</th>${dates.map(dayHeader).join('')}`;
    const rows = (empNames.length ? empNames : ['No employees selected']).map(name => {
      if (!empNames.length) return `<tr><td colspan="8">No shifts to print.</td></tr>`;
      const cells = dates.map(d => {
        const cellShifts = shifts.filter(s => s.person_name === name && s.shift_date === d);
        const lines = cellShifts.map(s => `<span style="display:block;">${escapeHtml(s.position_name)} ${formatTime12(s.start_time)}–${formatTime12(s.end_time)}</span>`).join('');
        return `<td>${lines}</td>`;
      }).join('');
      return `<tr><td class="print-emp-name">${escapeHtml(name)}</td>${cells}</tr>`;
    }).join('');
    html += `<div class="print-week-block${w > 0 ? ' print-new-page' : ''}">
      <div class="print-week-title">Week of ${dayLabel(dates[0])} – ${dayLabel(dates[6])}</div>
      <table class="print-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }
  document.getElementById('printView').innerHTML = html;
}

// =========================================================
// TIME OFF (manager/owner) — approve/deny pending, browse full history.
// =========================================================
async function renderTimeOffAdmin() {
  const el = document.getElementById('panelTimeOff');
  el.innerHTML = `
    <div class="card"><h2>Pending requests</h2><div id="toPending"><p class="muted">Loading…</p></div></div>
    <div class="card"><h2>All requests you manage</h2><div id="toAll"><p class="muted">Loading…</p></div></div>`;
  loadTimeOffPending();
  loadTimeOffAll();
}
async function loadTimeOffPending() {
  const el = document.getElementById('toPending');
  try {
    const rows = await api('/api/scheduling/time-off/to-approve');
    el.innerHTML = rows.length ? rows.map(r => {
      const range = r.start_date === r.end_date ? r.start_date : `${r.start_date} – ${r.end_date}`;
      return `<div class="list-row" style="align-items:flex-start;">
        <div><div class="name">${escapeHtml(r.employee_name)} — ${escapeHtml(range)}</div>${r.message ? `<div class="sub">${escapeHtml(r.message)}</div>` : ''}</div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small secondary" onclick="decideTimeOff('${r.id}', true)">Approve</button>
          <button class="small ghost" onclick="decideTimeOff('${r.id}', false)">Deny</button>
        </div>
      </div>`;
    }).join('') : '<p class="muted">Nothing pending.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function loadTimeOffAll() {
  const el = document.getElementById('toAll');
  try {
    const rows = await api('/api/scheduling/time-off/all');
    el.innerHTML = rows.length ? rows.map(r => {
      const range = r.start_date === r.end_date ? r.start_date : `${r.start_date} – ${r.end_date}`;
      const badgeClass = r.status === 'approved' ? 'on' : (r.status === 'denied' ? 'danger' : 'stale');
      return `<div class="list-row"><div>
        <div class="name">${escapeHtml(r.employee_name)} — ${escapeHtml(range)} <span class="badge ${badgeClass}">${r.status}</span></div>
        ${r.message ? `<div class="sub">${escapeHtml(r.message)}</div>` : ''}
      </div></div>`;
    }).join('') : '<p class="muted">No requests yet.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function decideTimeOff(id, approve) {
  try {
    const result = await withStepUp(() => api(`/api/scheduling/time-off/${id}/decide`, { method: 'POST', body: { approve } }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    loadTimeOffPending();
    loadTimeOffAll();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// =========================================================
// SETUP (manager/owner view; schedule + qualification-matrix writes are
// owner-only — see server/index.js for why: wholesale-replace writes would
// let a manager silently wipe assignments outside their own scope).
// =========================================================
async function renderSetup() {
  const el = document.getElementById('panelSetup');
  el.innerHTML = `
    <div class="card">
      <h2>Schedules</h2>
      <p class="muted">A schedule is a named roster/crew under one location — not a time concept (e.g. "Bar" vs "Kitchen").</p>
      <div id="setupSchedules"><p class="muted">Loading…</p></div>
      ${IS_OWNER ? `
      <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; margin-top:10px;">
        <div style="flex:1; min-width:140px;"><label for="newSchedName">Name</label><input id="newSchedName" placeholder="e.g. Bar"></div>
        <div style="flex:1; min-width:140px;"><label for="newSchedLocation">Location</label><select id="newSchedLocation"></select></div>
        <div><button class="secondary" style="margin-top:0;" onclick="submitAddSchedule()">Add</button></div>
      </div>
      <div id="schedResult"></div>` : ''}
    </div>
    <div class="card">
      <h2>Managers</h2>
      <p class="muted">Which schedules each manager can build and publish for. (Owners always manage every schedule.) ${IS_OWNER ? 'Click Edit to change.' : 'Only the owner can change this.'}</p>
      <div id="setupEmployees"><p class="muted">Loading…</p></div>
    </div>`;
  if (IS_OWNER) {
    document.getElementById('newSchedLocation').innerHTML = LOCATIONS.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
  }
  loadSetupSchedules();
  renderSetupEmployees();
}

async function loadSetupSchedules() {
  const el = document.getElementById('setupSchedules');
  try {
    ADMIN_SCHEDULES = await api('/api/scheduling/schedules/admin');
    el.innerHTML = ADMIN_SCHEDULES.length ? ADMIN_SCHEDULES.map(s => `<div class="list-row">
      <div><div class="name">${escapeHtml(s.name)} ${!s.active ? '<span class="badge off">Archived</span>' : ''}</div><div class="sub">${escapeHtml(s.location_name)}</div></div>
      ${IS_OWNER ? (s.active
        ? `<button class="small ghost" onclick="archiveSchedule('${s.id}')">Archive</button>`
        : `<button class="small secondary" onclick="restoreSchedule('${s.id}')">Restore</button>`) : ''}
    </div>`).join('') : '<p class="muted">No schedules yet.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function submitAddSchedule() {
  const name = document.getElementById('newSchedName').value.trim();
  const locationId = document.getElementById('newSchedLocation').value;
  const resultEl = document.getElementById('schedResult');
  if (!name || !locationId) { resultEl.innerHTML = '<p class="msg error">Name and location are required.</p>'; return; }
  try {
    const result = await withStepUp(() => api('/api/scheduling/schedules', { method: 'POST', body: { name, locationId } }));
    if (!result.ok) { resultEl.innerHTML = `<p class="msg error">${escapeHtml(result.error)}</p>`; return; }
    document.getElementById('newSchedName').value = '';
    resultEl.innerHTML = '';
    await refreshScheduleCaches();
    loadSetupSchedules();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
async function archiveSchedule(id) {
  await withStepUp(() => api(`/api/scheduling/schedules/${id}/archive`, { method: 'POST' }));
  await refreshScheduleCaches();
  loadSetupSchedules();
}
async function restoreSchedule(id) {
  await withStepUp(() => api(`/api/scheduling/schedules/${id}/restore`, { method: 'POST' }));
  await refreshScheduleCaches();
  loadSetupSchedules();
}
async function refreshScheduleCaches() {
  const boot = await api('/api/scheduling/bootstrap');
  ALL_SCHEDULES = boot.schedules;
  MANAGEABLE_SCHEDULES = boot.manageableSchedules;
}

async function renderSetupEmployees() {
  const el = document.getElementById('setupEmployees');
  try {
    EMPLOYEES = await api('/api/scheduling/employees');
    const managers = EMPLOYEES.filter(e => e.role === 'manager');
    el.innerHTML = managers.length ? managers.map(e => `<div class="list-row">
      <div><div class="name">${escapeHtml(e.name)}</div>
      <div class="sub">manages ${e.manager_schedule_ids.length} schedule${e.manager_schedule_ids.length === 1 ? '' : 's'}</div></div>
      <button class="small ghost" onclick="openQualModal('${e.id}')">${IS_OWNER ? 'Edit' : 'View'}</button>
    </div>`).join('') : '<p class="muted">No managers yet — owners already manage every schedule.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function openQualModal(personId) {
  const emp = EMPLOYEES.find(e => e.id === personId);
  if (!emp) return;
  document.getElementById('qualPersonId').value = personId;
  document.getElementById('qualModalTitle').textContent = emp.name;
  const disabled = IS_OWNER ? '' : 'disabled';
  document.getElementById('qualManagerSchedules').innerHTML = ALL_SCHEDULES.map(s =>
    `<label class="sc-checkbox"><input type="checkbox" ${disabled} value="${s.id}" ${emp.manager_schedule_ids.includes(s.id) ? 'checked' : ''}> ${escapeHtml(s.name)}</label>`).join('');
  document.getElementById('qualSaveBtn').style.display = IS_OWNER ? '' : 'none';
  document.getElementById('qualResult').innerHTML = '';
  document.getElementById('qualModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closeQualModal() {
  document.getElementById('qualModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
async function submitQual() {
  const personId = document.getElementById('qualPersonId').value;
  const managerScheduleIds = Array.from(document.querySelectorAll('#qualManagerSchedules input:checked')).map(i => i.value);
  const resultEl = document.getElementById('qualResult');
  try {
    await withStepUp(() => api(`/api/scheduling/employees/${personId}/managed-schedules`, { method: 'POST', body: { scheduleIds: managerScheduleIds } }));
    closeQualModal();
    showMsg('Saved.', 'success');
    renderSetupEmployees();
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// =========================================================
// Init
// =========================================================
(async function init() {
  ME = requireAuth();
  if (!ME) return;
  renderTopbar('Scheduling');
  IS_OWNER = ME.role === 'owner';
  IS_MGR_OR_OWNER = ME.role === 'manager' || ME.role === 'owner';
  const access = getAppAccess();
  const hasAccess = IS_MGR_OR_OWNER || access.some(a => a.app_key === 'scheduling' && a.enabled);
  if (!hasAccess) {
    document.getElementById('app').innerHTML = '<div class="card"><p>Scheduling isn\'t enabled for your account yet — ask your manager.</p><p><a href="/dashboard.html">Back home</a></p></div>';
    return;
  }
  try {
    POSITIONS = await api('/api/positions');
    LOCATIONS = await api('/api/locations');
    if (IS_MGR_OR_OWNER) {
      const boot = await api('/api/scheduling/bootstrap');
      ALL_SCHEDULES = boot.schedules;
      MANAGEABLE_SCHEDULES = boot.manageableSchedules;
      EMPLOYEES = boot.employees;
      PENDING_TIMEOFF_COUNT = boot.pendingTimeOffCount || 0;
    }
    renderTabs();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
