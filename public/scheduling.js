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
let NOTIFICATIONS_ENABLED = true; // master email/text switch — Employees > Notifications (server/notify.js)
// Scheduler rows: by default only people checked into the selected
// schedules (Access page > Scheduling > "schedules they can work"), plus
// anyone who already has a shift there that week. The switch shows
// everyone at those bars instead (Oct 2026, per Scotto).
let SHOW_ALL_STAFF = (() => { try { return localStorage.getItem('bp_schedShowAll') === '1'; } catch (e) { return false; } })();
// Half-hour time picker in bar-day order, 5:00 AM through 4:30 AM.
const TIME_CHOICES = (() => { const out = []; for (let i = 0; i < 48; i++) { const m = (5 * 60 + i * 30) % (24 * 60); out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); } return out; })();
const DEFAULT_START = '09:00', DEFAULT_END = '19:00';
let SHIFT_PRESETS = [];         // this manager's own start/end presets (chips in the Add shift modal)
let WEEK_FC = [];               // this week's sales forecast per (bar, side) for the selected schedules (server/slate.js)

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
  closeShiftModal(); closePublishModal(); closeTimeOffModal(); closeQualModal(); closePrintModal(); closeSchedPicker(); closePreview(); closeDayPanel();
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
          <button class="small secondary" onclick="previewMyWeek()" title="See this week as a page, then share, download or print it">Share / Print</button>
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
      <div><div class="name"><span class="loc-tag">${escapeHtml(shortLoc(s.location_name))}</span> ${escapeHtml(s.schedule_name)} — ${escapeHtml(s.position_name)}</div>
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
        <div style="flex:1;">${day.length ? day.map(s => `<span class="loc-tag">${escapeHtml(shortLoc(s.location_name))}</span> ${escapeHtml(s.schedule_name)} — ${escapeHtml(s.position_name)}, ${formatTime12(s.start_time)}–${formatTime12(s.end_time)}`).join('<br>') : '<span class="muted">Off</span>'}</div>
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
      <div class="picker-popover" id="schedPickerPopover" style="display:none;" onclick="event.stopPropagation()"></div>
    </div>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <h2 style="margin:0;">Week of <span id="schedWeekLabel"></span></h2>
        <div class="stack-actions" style="margin:0; gap:6px;">
          <button class="small ghost" onclick="shiftSchedWeek(-7)">‹ Prev</button>
          <button class="small ghost" onclick="goToCurrentSchedWeek()">Today</button>
          <button class="small ghost" onclick="shiftSchedWeek(7)">Next ›</button>
          <button class="small ghost" onclick="openPrintModal()">Print</button>
        </div>
      </div>
      <div id="draftBanner" class="draft-banner no-drafts" style="margin-top:10px;"></div>
      <div id="schedGrid" style="margin-top:14px; overflow-x:auto;"><p class="muted">Loading…</p></div>
    </div>
    `;

  renderSchedPicker();
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
// Stays open while schedules are ticked (the popover swallows its own
// clicks above); a click anywhere else closes it.
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
    // The forecast is extra: the grid shows without it.
    try { WEEK_FC = await api(`/api/scheduling/forecast?scheduleIds=${SELECTED_SCHEDULE_IDS.join(',')}&weekStart=${WEEK_START}`); } catch (e) { WEEK_FC = []; }
    const summary = await api('/api/scheduling/my-drafts/summary');
    DRAFT_COUNT = summary.count;
    renderDraftBanner();

    const { roster, others, locationCount } = schedRoster();
    const dates = weekDatesFrom(WEEK_START);
    const rowHtml = (emp) => `<tr><td>${escapeHtml(emp.name)}${emp.position ? `<div class="muted" style="font-size:11px;">${escapeHtml(emp.position)}</div>` : ''}</td>${dates.map(date => schedCellHtml(emp, date)).join('')}<td style="vertical-align:top; white-space:nowrap;"><button class="small ghost" style="margin:0;" title="Copy this week's shifts for ${escapeHtml(emp.name)} onto next week, as drafts" onclick="copyEmployeeWeek('${emp.id}', this)">Copy → next wk</button></td></tr>`;
    const switchHtml = SHOW_ALL_STAFF
      ? `Showing everyone at ${locationCount === 1 ? 'this bar' : 'these bars'} (${roster.length + others.length}). <a href="#" onclick="event.preventDefault(); setShowAllStaff(false)">Show only who can work these schedules</a>`
      : `Showing the ${roster.length} who can work ${SELECTED_SCHEDULE_IDS.length === 1 ? 'this schedule' : 'these schedules'}. <a href="#" onclick="event.preventDefault(); setShowAllStaff(true)">Show everyone at ${locationCount === 1 ? 'this bar' : 'these bars'}</a>`;
    if (!roster.length && !(SHOW_ALL_STAFF && others.length)) {
      el.innerHTML = `<p class="muted">Nobody is checked into ${SELECTED_SCHEDULE_IDS.length === 1 ? 'this schedule' : 'these schedules'} yet. Add people under Employees › their Access page › Scheduling, or <a href="#" onclick="event.preventDefault(); setShowAllStaff(true)">show everyone at ${locationCount === 1 ? 'this bar' : 'these bars'}</a>.</p>`;
      return;
    }
    const anyFc = WEEK_FC.some(g => Object.keys(g.days || {}).length);
    el.innerHTML = `<p class="muted" style="margin:0 0 8px; font-size:12px;">${switchHtml}</p>
    ${anyFc ? '<p class="fc-note">Forecasts are estimates and get more accurate as sales history builds.</p>' : ''}
    <table><thead><tr><th>Employee</th>${dates.map(d => `<th>${dayLabel(d)}${fcHeadHtml(d)}</th>`).join('')}<th></th></tr></thead><tbody>
      ${roster.map(rowHtml).join('')}
      ${SHOW_ALL_STAFF && others.length ? `<tr><td colspan="9" class="muted" style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; padding-top:10px;">Not checked into ${SELECTED_SCHEDULE_IDS.length === 1 ? 'this schedule' : 'these schedules'}</td></tr>${others.map(rowHtml).join('')}` : ''}
    </tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// Who gets a row. roster: checked into a selected schedule, or already
// has a shift on one this week. others: everyone else at those bars.
function schedRoster() {
  const sel = SELECTED_SCHEDULE_IDS.map(String);
  const locs = Array.from(new Set(ALL_SCHEDULES.filter(s => sel.includes(String(s.id))).map(s => String(s.location_id))));
  const withShift = new Set(WEEK_SHIFTS.map(s => String(s.person_id)));
  const byName = (a, b) => a.name.localeCompare(b.name);
  const roster = EMPLOYEES.filter(e => (e.schedule_ids || []).some(id => sel.includes(String(id))) || withShift.has(String(e.id))).sort(byName);
  const rosterIds = new Set(roster.map(e => String(e.id)));
  const others = EMPLOYEES.filter(e => !rosterIds.has(String(e.id)) && (e.location_ids || [e.location_id]).some(id => locs.includes(String(id)))).sort(byName);
  return { roster, others, locationCount: locs.length };
}
function setShowAllStaff(on) {
  SHOW_ALL_STAFF = !!on;
  try { localStorage.setItem('bp_schedShowAll', on ? '1' : '0'); } catch (e) { /* fine */ }
  loadSchedGrid();
}
async function copyEmployeeWeek(personId, btn) {
  const emp = EMPLOYEES.find(e => e.id === personId);
  if (btn) { btn.disabled = true; btn.textContent = 'Copying…'; }
  try {
    const result = await withStepUp(() => api('/api/scheduling/copy-week-forward', { method: 'POST', body: { personId, weekStart: WEEK_START } }));
    const skipped = (result.skipped || []).length;
    showMsg(`${emp ? emp.name : 'Employee'}: ${result.drafted} shift${result.drafted === 1 ? '' : 's'} copied to next week as drafts${skipped ? `, ${skipped} skipped (${result.skipped.join('; ')})` : ''}.`, result.drafted ? 'success' : 'info');
    loadSchedGrid();
  } catch (e) {
    showMsg(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Copy → next wk'; }
  }
}

// ---- Sales forecast under each date + the day's Games/Events popup ----
// One line per bar and side among the selected schedules ("~$3,600
// kitchen"; with more than one bar, "T2 ~$3,600 kitchen"). Today and
// later only. Tapping a line, or Games/Events, opens the day's popup.
function fcHeadHtml(date) {
  if (!WEEK_FC.length || date < todayISO()) return '';
  const multi = new Set(WEEK_FC.map(g => g.locationId)).size > 1;
  const lines = WEEK_FC.map((g, i) => (g.days && g.days[date] != null
    ? `<a href="#" class="fc-amt" onclick="event.preventDefault(); openDayPanel(${i}, '${date}')">${multi ? escapeHtml(shortLoc(g.locationName)) + ' ' : ''}~$${Number(g.days[date]).toLocaleString()} ${g.side === 'food' ? 'kitchen' : 'bar'}</a>` : '')).join('');
  const label = date === todayISO() ? "Today's Games/Events ›" : 'Games/Events ›';
  return `${lines}<a href="#" class="fc-link" onclick="event.preventDefault(); openDayPanel(0, '${date}')">${label}</a>`;
}

let DAY_PANEL = null; // { group, date, data }
async function openDayPanel(groupIndex, date) {
  const g = WEEK_FC[groupIndex] || WEEK_FC[0];
  if (!g) return;
  let panel = document.getElementById('dayPanel');
  if (!panel) { panel = document.createElement('div'); panel.id = 'dayPanel'; panel.className = 'card day-panel'; document.body.appendChild(panel); }
  panel.innerHTML = '<p class="muted">Loading…</p>';
  panel.style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
  try {
    const data = await api(`/api/scheduling/day?locationId=${encodeURIComponent(g.locationId)}&side=${g.side}&date=${date}`);
    DAY_PANEL = { group: g, date, data };
    renderDayPanel();
  } catch (e) { panel.innerHTML = `<span class="dp-x" onclick="closeAllModals()">×</span><p class="msg error">${escapeHtml(e.message)}</p>`; }
}
function closeDayPanel() {
  const panel = document.getElementById('dayPanel');
  if (panel) panel.style.display = 'none';
  DAY_PANEL = null;
}
function renderDayPanel() {
  const { group: g, date, data: d } = DAY_PANEL;
  const panel = document.getElementById('dayPanel');
  const weekday = isoToDate(date).toLocaleDateString([], { weekday: 'long' });
  const title = isoToDate(date).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const sideWord = g.side === 'food' ? 'kitchen' : 'bar';
  const sub = [`${escapeHtml(shortLoc(d.locationName))} ${sideWord}`, d.forecast != null ? (d.forecastSet ? `target $${Number(d.forecast).toLocaleString()}, set by the owner` : `forecast ~$${Number(d.forecast).toLocaleString()}`) : 'no forecast for this day', d.busiest ? `busiest ${d.busiest}` : ''].filter(Boolean).join(' · ');
  // Hour bars, with a marker where one of our teams' games starts.
  let hoursHtml = '';
  if (d.hours && d.hours.length) {
    const max = Math.max(...d.hours.map(h => h.amount), 1);
    const kick = {};
    d.games.filter(x => x.tracked && x.hour != null).forEach(x => { (kick[x.hour] ||= []).push(`${x.tracked} ${x.time.replace(/:00 /, ' ').replace(/ (AM|PM)$/, '')}`); });
    hoursHtml = `<div class="dp-h">Forecast by hour</div>
      <div class="dp-hrs" style="grid-template-columns:repeat(${d.hours.length},1fr)">${d.hours.map(h => `<div class="dp-c ${h.amount === max ? 'peak' : ''}">${kick[h.hour] ? `<span class="dp-ev">▼ ${escapeHtml(kick[h.hour][0])}</span>` : ''}<span class="dp-v">${h.amount >= max * 0.45 ? '$' + h.amount : ''}</span><i style="height:${Math.max(2, Math.round(h.amount / max * 100))}px"></i></div>`).join('')}</div>
      <div class="dp-hl" style="grid-template-columns:repeat(${d.hours.length},1fr)">${d.hours.map(h => `<span>${h.label}</span>`).join('')}</div>`;
  } else if (d.forecast != null) {
    hoursHtml = '<p class="muted" style="font-size:12.5px;">The hour-by-hour view needs a few more weeks of full days. It fills in on its own.</p>';
  }
  // Games and events, in time order. Our teams, ranked matchups and NFL show; the rest fold away.
  const rows = [];
  d.holidays.forEach(h => rows.push({ sort: -1, time: 'All day', html: `<b>${escapeHtml(h)}</b>` }));
  d.events.forEach(e => rows.push({ sort: e.time ? Number(e.time.replace(':', '')) : -1, time: e.time ? formatTime12(e.time).replace(/\s*(AM|PM)$/, ' $1') : 'All day',
    html: `<b>${escapeHtml(e.name)}</b> <a href="#" class="dp-rm" title="Remove" onclick="event.preventDefault(); removeDayEvent('${e.id}')">×</a>` }));
  const gameRow = x => ({ sort: x.hour != null ? x.hour * 100 : 2400, time: x.time,
    html: `${x.tracked ? '<b>' : ''}${escapeHtml(x.matchup)}${x.tracked ? '</b> <span class="dp-tag">ours</span>' : ''} <span class="dp-net">${escapeHtml([x.league, x.network].filter(Boolean).join(' · '))}</span>` });
  const big = d.games.filter(x => x.tracked || x.ranked || x.league === 'NFL');
  const rest = d.games.filter(x => !big.includes(x));
  big.forEach(x => rows.push(gameRow(x)));
  // Business-day order: early-morning hours sort after late night.
  const order = r => (r.sort < 0 ? -1 : (r.sort < 600 ? r.sort + 2400 : r.sort));
  rows.sort((a, b) => order(a) - order(b));
  const line = r => `<div class="dp-it"><span class="dp-t">${escapeHtml(r.time)}</span><span class="dp-n">${r.html}</span></div>`;
  const restRows = rest.map(gameRow).sort((a, b) => order(a) - order(b));
  const listHtml = (rows.length ? rows.map(line).join('') : '<p class="muted" style="font-size:12.5px; margin:6px 0;">No big games or events on the calendar.</p>')
    + (restRows.length ? `<details class="dp-more"><summary>${restRows.length} more game${restRows.length === 1 ? '' : 's'}</summary>${restRows.map(line).join('')}</details>` : '');
  const timeOpts = ['', ...TIME_CHOICES].map(t => `<option value="${t}">${t ? formatTime12(t) : 'All day'}</option>`).join('');
  panel.innerHTML = `<span class="dp-x" onclick="closeAllModals()">×</span>
    <h3 class="dp-title">${escapeHtml(title)}</h3><div class="dp-sub">${sub}</div>
    ${hoursHtml}
    <div class="dp-h">Games &amp; events</div>${listHtml}
    <div class="dp-add"><select id="dpTime">${timeOpts}</select><input id="dpName" placeholder="Add an event, e.g. Band on the patio" maxlength="120"><button class="small" onclick="addDayEvent()">Add</button></div>
    ${d.forecast != null ? `<p class="dp-foot">An estimate from past ${escapeHtml(weekday)}s; it sharpens as history builds.</p>` : ''}`;
}
async function addDayEvent() {
  if (!DAY_PANEL) return;
  const name = document.getElementById('dpName').value.trim();
  if (!name) return;
  try {
    const r = await api('/api/scheduling/events', { method: 'POST', body: { locationId: DAY_PANEL.group.locationId, date: DAY_PANEL.date, startTime: document.getElementById('dpTime').value || null, name } });
    if (!r.ok) { showMsg(r.error || 'Could not add it.', 'error'); return; }
    openDayPanel(WEEK_FC.indexOf(DAY_PANEL.group), DAY_PANEL.date);
  } catch (e) { showMsg(e.message, 'error'); }
}
async function removeDayEvent(id) {
  if (!DAY_PANEL) return;
  try {
    await api(`/api/scheduling/events/${id}/delete`, { method: 'POST', body: {} });
    openDayPanel(WEEK_FC.indexOf(DAY_PANEL.group), DAY_PANEL.date);
  } catch (e) { showMsg(e.message, 'error'); }
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
    // Location tag first (T1/T2/T3), then position, then time — so
    // someone scanning the grid sees where they're working before what
    // (Scotto, 2026-09-21). Comes from the shift's schedule's location.
    return `<div class="chip ${cls}" onclick='openShiftModal(${payload})'><span class="loc-tag">${escapeHtml(shortLoc(s.location_name))}</span> <span class="p">${escapeHtml(s.position_name)}</span> ${label}</div>`;
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
  const { roster, others } = schedRoster();
  const opt = (e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`;
  document.getElementById('shPerson').innerHTML = roster.length
    ? `<optgroup label="Can work ${SELECTED_SCHEDULE_IDS.length === 1 ? 'this schedule' : 'these schedules'}">${roster.map(opt).join('')}</optgroup>${others.length ? `<optgroup label="Everyone else here">${others.map(opt).join('')}</optgroup>` : ''}`
    : EMPLOYEES.map(opt).join('');
  document.getElementById('shPerson').value = shift.personId || (roster[0] && roster[0].id) || (EMPLOYEES[0] && EMPLOYEES[0].id) || '';
  // Schedule: only the ones picked above (and that this manager writes
  // to). Adding from an employee's row locks it: the shift's own schedule
  // when editing, otherwise the first picked schedule the person is
  // checked into. One choice means no dropdown at all, just a line.
  const selected = SELECTED_SCHEDULE_IDS.map(String);
  const writable = MANAGEABLE_SCHEDULES.filter(s => selected.includes(String(s.id)));
  const choices = writable.length ? writable : MANAGEABLE_SCHEDULES;
  document.getElementById('shSchedule').innerHTML = choices.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  const emp0 = EMPLOYEES.find(e => e.id === document.getElementById('shPerson').value);
  const fits = emp0 ? choices.find(s => (emp0.schedule_ids || []).some(id => String(id) === String(s.id))) : null;
  document.getElementById('shSchedule').value = shift.scheduleId || (fits && fits.id) || (choices[0] && choices[0].id) || '';
  const fromRow = !!shift.personId;
  const lockSchedule = choices.length === 1 || (fromRow && (!!shift.scheduleId || !!fits));
  document.getElementById('shPersonWrap').style.display = fromRow ? 'none' : '';
  document.getElementById('shScheduleWrap').style.display = lockSchedule ? 'none' : '';
  const fixed = document.getElementById('shFixed');
  const schedName = (choices.find(s => String(s.id) === String(document.getElementById('shSchedule').value)) || {}).name || '';
  const fixedParts = [fromRow ? `<b>${escapeHtml(emp0 ? emp0.name : '')}</b>` : '', lockSchedule && schedName ? `<span class="muted">${fromRow ? '· ' : ''}${escapeHtml(schedName)}</span>` : ''].filter(Boolean);
  fixed.style.display = fixedParts.length ? '' : 'none';
  fixed.innerHTML = fixedParts.join(' ');
  fillPositionSelectForPerson(document.getElementById('shPerson').value, shift.positionId);
  document.getElementById('shDate').value = shift.date || WEEK_START;
  const isNew = !(shift.shiftId || shift.draftId);
  fillTimeSelect('shStart', (shift.startTime || '').slice(0, 5) || (isNew ? DEFAULT_START : ''));
  fillTimeSelect('shEnd', (shift.endTime || '').slice(0, 5) || (isNew ? DEFAULT_END : ''));
  renderShiftDays();
  document.getElementById('shDate').onchange = renderShiftDays;
  document.getElementById('shStart').onchange = renderShiftPresets;
  document.getElementById('shEnd').onchange = renderShiftPresets;
  renderShiftPresets();
  document.getElementById('shDuplicateWrap').style.display = isNew ? '' : 'none';
  document.getElementById('shCancelRow').style.display = (shift.shiftId || shift.draftId) ? '' : 'none';
  document.getElementById('shResult').innerHTML = '';
  document.getElementById('shPerson').onchange = () => fillPositionSelectForPerson(document.getElementById('shPerson').value);
  document.getElementById('shiftModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
// Shift-time presets: this manager's own. A chip fills Start and End;
// "Save as preset" keeps the current pair; × on a chip removes it.
function presetLabel(p) { return `${formatTime12(p.startTime)}–${formatTime12(p.endTime)}`; }
function renderShiftPresets() {
  const el = document.getElementById('shPresets');
  if (!el) return;
  const cur = { startTime: document.getElementById('shStart').value, endTime: document.getElementById('shEnd').value };
  const have = SHIFT_PRESETS.some(p => p.startTime === cur.startTime && p.endTime === cur.endTime);
  el.innerHTML = `${SHIFT_PRESETS.map(p => `<span class="sc-preset ${p.startTime === cur.startTime && p.endTime === cur.endTime ? 'on' : ''}"><button type="button" onclick="applyShiftPreset('${p.id}')">${presetLabel(p)}</button><button type="button" class="x" title="Remove this preset" onclick="removeShiftPreset('${p.id}')">×</button></span>`).join('')}
    ${!have && cur.startTime && cur.endTime ? `<a href="#" class="sc-preset-save" onclick="event.preventDefault(); saveShiftPreset()">Save ${presetLabel(cur)} as preset</a>` : ''}`;
}
function applyShiftPreset(id) {
  const p = SHIFT_PRESETS.find(x => x.id === id); if (!p) return;
  fillTimeSelect('shStart', p.startTime); fillTimeSelect('shEnd', p.endTime);
  renderShiftPresets();
}
async function saveShiftPreset() {
  try {
    const r = await api('/api/scheduling/presets', { method: 'POST', body: { startTime: document.getElementById('shStart').value, endTime: document.getElementById('shEnd').value } });
    if (!r.ok) { showMsg(r.error, 'error'); return; }
    SHIFT_PRESETS = r.presets; renderShiftPresets();
  } catch (e) { showMsg(e.message, 'error'); }
}
async function removeShiftPreset(id) {
  const p = SHIFT_PRESETS.find(x => x.id === id);
  if (p && !confirm(`Remove the ${presetLabel(p)} preset?`)) return;
  try { const r = await api(`/api/scheduling/presets/${id}/delete`, { method: 'POST', body: {} }); SHIFT_PRESETS = r.presets || []; renderShiftPresets(); }
  catch (e) { showMsg(e.message, 'error'); }
}
// Half-hour choices only (Scotto, Oct 2026). A stored time that isn't on
// the half hour (older shifts) is kept as an extra option so editing
// doesn't silently move it.
function fillTimeSelect(id, value) {
  const sel = document.getElementById(id);
  const choices = TIME_CHOICES.slice();
  if (value && !choices.includes(value)) choices.push(value);
  sel.innerHTML = choices.map(t => `<option value="${t}">${formatTime12(t)}</option>`).join('');
  sel.value = value || '';
}
// Sat–Fri boxes for the week the shift's date falls in. The shift's own
// day is ticked and locked; ticking others adds the same shift there.
function renderShiftDays() {
  const date = document.getElementById('shDate').value || WEEK_START;
  const days = weekDatesFrom(startOfWeekISO(date));
  document.getElementById('shDays').innerHTML = days.map(d => `<label class="sc-day ${d === date ? 'own' : ''}" title="${dayLabel(d)}"><input type="checkbox" value="${d}" ${d === date ? 'checked disabled' : ''}><span>${isoToDate(d).toLocaleDateString([], { weekday: 'short' })}</span></label>`).join('');
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
    const dupLines = Array.from(document.querySelectorAll('#shDays input:checked:not(:disabled)')).map(el => el.value).filter(d => d !== payload.date);
    let note = '';
    if (dupLines.length) {
      const dup = await withStepUp(() => api('/api/scheduling/drafts/duplicate', {
        method: 'POST',
        body: { scheduleId: payload.scheduleId, personId: payload.personId, positionId: payload.positionId, startTime: payload.startTime, endTime: payload.endTime, targetDates: dupLines },
      }));
      note = ` Plus ${dup.drafted} more day${dup.drafted === 1 ? '' : 's'}.`;
      if (dup.skipped && dup.skipped.length) note += ` Skipped: ${dup.skipped.join('; ')}.`;
    }
    closeShiftModal();
    showMsg(`Saved as a draft — publish when ready.${note}`, (note.includes('Skipped') ? 'info' : 'success'));
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

// ---- Publish (plain "are you sure?" confirm — no step-up gate, per Scotto) ----
function openPublishModal() {
  PUBLISH_OVERRIDES = {};
  const testModeNote = NOTIFICATIONS_ENABLED === false
    ? '<p class="msg info">Test mode is on (Employees &gt; Notifications) — nothing will actually be emailed or texted.</p>'
    : '';
  document.getElementById('publishBody').innerHTML = DRAFT_COUNT
    ? `<p>Publish ${DRAFT_COUNT} pending draft${DRAFT_COUNT === 1 ? '' : 's'}? This updates the live schedule and notifies every affected employee by email/text. Are you sure?</p>${testModeNote}`
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
    const model = scheduleModel(shifts.filter(s => employeeIds.includes(String(s.person_id))), numWeeks);
    closePrintModal();
    openPreview(model);
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}
// ---- Preview: one model, three outputs. The model is a list of tables
// (one per week); the HTML goes in the preview modal and the print block,
// and the PNG for Share / Download is drawn from the same model on a
// canvas, so a phone can send it as a picture (GroupMe, text, email). ----
// model: { title, file, tables: [{ title, columns: [..], rows: [{ label, cells: [[line, ...], ...] }] }] }
let PREVIEW = null;
function scheduleModel(shifts, numWeeks) {
  const empNames = [...new Set(shifts.map(s => s.person_name))].sort((a, b) => a.localeCompare(b));
  const tables = [];
  for (let w = 0; w < numWeeks; w++) {
    const dates = weekDatesFrom(addDaysISO(WEEK_START, w * 7));
    tables.push({
      title: `Week of ${dayLabel(dates[0])} – ${dayLabel(dates[6])}`,
      columns: ['Employee', ...dates.map(d => isoToDate(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))],
      rows: empNames.map(name => ({ label: name, cells: dates.map(d => shifts.filter(s => s.person_name === name && s.shift_date === d).map(s => `${shortLoc(s.location_name)} ${s.position_name} ${formatTime12(s.start_time)}–${formatTime12(s.end_time)}`)) })),
      empty: 'No shifts for these people in this week.',
    });
  }
  return { title: 'Bar Ops Scheduling', file: `schedule-${WEEK_START}`, tables };
}
function myScheduleModel(shifts, dates) {
  return {
    title: `${ME.name} — my schedule`, file: `my-schedule-${dates[0]}`,
    tables: [{
      title: `Week of ${dayLabel(dates[0])} – ${dayLabel(dates[6])}`,
      columns: ['Day', 'Shift'],
      rows: dates.map(d => { const day = shifts.filter(s => s.shift_date === d); return { label: dayLabel(d), cells: [day.length ? day.map(s => `${s.schedule_name} — ${s.position_name}, ${formatTime12(s.start_time)}–${formatTime12(s.end_time)}`) : ['Off']] }; }),
    }],
  };
}
async function previewMyWeek() {
  try {
    const shifts = await api('/api/scheduling/my-shifts?weekStart=' + WEEK_START);
    openPreview(myScheduleModel(shifts, weekDatesFrom(WEEK_START)));
  } catch (e) { showMsg(e.message, 'error'); }
}
function previewHtml(model) {
  return `<h2 style="margin:0 0 2px;">${escapeHtml(model.title)}</h2>` + model.tables.map((t, i) => `<div class="print-week-block${i > 0 ? ' print-new-page' : ''}">
      <div class="print-week-title">${escapeHtml(t.title)}</div>
      <table class="print-table"><thead><tr>${t.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>
      ${t.rows.length ? t.rows.map(r => `<tr><td class="print-emp-name">${escapeHtml(r.label)}</td>${r.cells.map(c => `<td>${c.map(l => `<span style="display:block;">${escapeHtml(l)}</span>`).join('')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${t.columns.length}">${escapeHtml(t.empty || 'Nothing here.')}</td></tr>`}
      </tbody></table></div>`).join('');
}
function openPreview(model) {
  PREVIEW = model;
  document.getElementById('previewTitle').textContent = 'Preview';
  document.getElementById('previewBody').innerHTML = previewHtml(model);
  document.getElementById('previewShareBtn').style.display = navigator.share ? '' : 'none';
  closeAllModals();
  document.getElementById('previewModal').style.display = '';
  document.getElementById('modalBackdrop').style.display = '';
}
function closePreview() {
  document.getElementById('previewModal').style.display = 'none';
  document.getElementById('modalBackdrop').style.display = 'none';
}
function previewPrint() {
  if (!PREVIEW) return;
  document.getElementById('printView').innerHTML = previewHtml(PREVIEW);
  window.print();
}
// Draws the model on a canvas at 2x for a crisp phone picture.
function previewCanvas(model) {
  const S = 2, pad = 24, lineH = 18, cellPad = 6, font = '13px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const probe = document.createElement('canvas').getContext('2d'); probe.font = font;
  const two = model.tables[0].columns.length === 2;
  const widths = two ? [200, 620] : [160, ...Array(model.tables[0].columns.length - 1).fill(168)];
  const W = widths.reduce((a, b) => a + b, 0) + pad * 2;
  // wrap a line to its column width
  const wrap = (text, w) => { const words = String(text).split(' '); const out = []; let cur = ''; for (const wd of words) { const t = cur ? `${cur} ${wd}` : wd; if (probe.measureText(t).width > w - cellPad * 2 && cur) { out.push(cur); cur = wd; } else cur = t; } if (cur) out.push(cur); return out; };
  const laid = model.tables.map(t => ({ ...t, rows: (t.rows.length ? t.rows : [{ label: t.empty || 'Nothing here.', cells: t.columns.slice(1).map(() => []) }]).map(r => { const cells = r.cells.map((c, i) => c.flatMap(l => wrap(l, widths[i + 1]))); const label = wrap(r.label, widths[0]); const n = Math.max(label.length, ...cells.map(c => c.length), 1); return { label, cells, h: n * lineH + cellPad * 2 }; }) }));
  let H = pad + 30;
  for (const t of laid) H += 26 + 30 + t.rows.reduce((a, r) => a + r.h, 0) + 18;
  const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
  const g = cv.getContext('2d'); g.scale(S, S);
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#111'; g.font = 'bold 18px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'; g.textBaseline = 'top';
  g.fillText(model.title, pad, pad - 6);
  let y = pad + 30;
  for (const t of laid) {
    g.font = 'bold 14px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'; g.fillStyle = '#111'; g.fillText(t.title, pad, y); y += 26;
    // header
    let x = pad; g.fillStyle = '#eee'; g.fillRect(pad, y, W - pad * 2, 30); g.strokeStyle = '#999'; g.lineWidth = 1;
    g.font = 'bold 13px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'; g.fillStyle = '#111';
    t.columns.forEach((c, i) => { g.strokeRect(x + 0.5, y + 0.5, widths[i], 30); g.fillText(c, x + cellPad, y + 8); x += widths[i]; });
    y += 30;
    for (const r of t.rows) {
      x = pad;
      [r.label, ...r.cells].forEach((lines, i) => {
        g.strokeRect(x + 0.5, y + 0.5, widths[i], r.h);
        g.font = i === 0 ? 'bold 13px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' : font; g.fillStyle = '#111';
        lines.forEach((l, j) => g.fillText(l, x + cellPad, y + cellPad + j * lineH + 2));
        x += widths[i];
      });
      y += r.h;
    }
    y += 18;
  }
  return cv;
}
function previewBlob() { return new Promise((resolve) => previewCanvas(PREVIEW).toBlob(resolve, 'image/png')); }
async function previewDownload() {
  if (!PREVIEW) return;
  const blob = await previewBlob(); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${PREVIEW.file}.png`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function previewShare() {
  if (!PREVIEW) return;
  try {
    const blob = await previewBlob(); const file = new File([blob], `${PREVIEW.file}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: PREVIEW.title });
    else await navigator.share({ title: PREVIEW.title, text: PREVIEW.title });
  } catch (e) { if (e && e.name !== 'AbortError') showMsg('Sharing didn\'t work here — use Download instead.', 'error'); }
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
  // Managers add schedules too (2026-09-21), at their own location only;
  // the server enforces the same. Archive/restore stay owner-only.
  const myLocations = IS_OWNER ? LOCATIONS : LOCATIONS.filter(l => myLocationIds(ME).includes(String(l.id)));
  const canAddSchedule = IS_OWNER || myLocations.length > 0;
  el.innerHTML = `
    <div class="card">
      <h2>Schedules</h2>
      <p class="muted">A schedule is a named roster/crew under one location — not a time concept (e.g. "Bar" vs "Kitchen").</p>
      <div id="setupSchedules"><p class="muted">Loading…</p></div>
      ${canAddSchedule ? `
      <div style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; margin-top:10px;">
        <div style="flex:1; min-width:140px;"><label for="newSchedName">Name</label><input id="newSchedName" placeholder="e.g. Bar"></div>
        <div style="flex:1; min-width:140px;"><label for="newSchedLocation">Location</label><select id="newSchedLocation"></select></div>
        <div><button class="secondary" style="margin-top:0;" onclick="submitAddSchedule()">Add</button></div>
      </div>
      ${IS_OWNER ? '' : '<p class="muted" style="font-size:12px;">A schedule you add is yours to build and publish right away. Archiving is owner-only.</p>'}
      <div id="schedResult"></div>` : ''}
    </div>
    <div class="card">
      <h2>Managers</h2>
      <p class="muted">Which schedules each manager can build and publish for. (Owners always manage every schedule.) ${IS_OWNER ? 'Click Edit to change.' : 'Only the owner can change this.'}</p>
      <div id="setupEmployees"><p class="muted">Loading…</p></div>
    </div>`;
  if (canAddSchedule) {
    document.getElementById('newSchedLocation').innerHTML = myLocations.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
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
      try { SHIFT_PRESETS = await api('/api/scheduling/presets'); } catch (e) { SHIFT_PRESETS = []; }
      // Non-critical — if this fails for any reason, default to true (today's
      // real behavior) rather than block the page on it.
      try {
        const note = await api('/api/owner-notes/notifications_enabled');
        NOTIFICATIONS_ENABLED = note.body !== 'off';
      } catch (e) {}
    }
    renderTabs();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
