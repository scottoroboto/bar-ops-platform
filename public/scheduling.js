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
let WEEK_START = '';           // ISO date, Sunday of the currently-loaded week
let WEEK_SHIFTS = [];          // this week's live shifts + my draft overlay
let DRAFT_COUNT = 0;
let PUBLISH_OVERRIDES = {};    // draftId -> override reason, accumulated across a Publish retry
let ADMIN_SCHEDULES = [];      // Setup tab: every schedule incl. archived

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
  const d = isoToDate(iso);
  d.setDate(d.getDate() - d.getDay());
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

// ---------------- Tabs ----------------
function setTab(which) {
  document.getElementById('panelMine').style.display = which === 'mine' ? '' : 'none';
  document.getElementById('panelScheduler').style.display = which === 'scheduler' ? '' : 'none';
  document.getElementById('panelTimeOff').style.display = which === 'timeoff' ? '' : 'none';
  document.getElementById('panelSetup').style.display = which === 'setup' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  if (which === 'mine') renderMine();
  if (which === 'scheduler') renderScheduler();
  if (which === 'timeoff') renderTimeOffAdmin();
  if (which === 'setup') renderSetup();
}
function renderTabs() {
  const tabs = [{ key: 'mine', label: 'My Schedule' }];
  if (IS_MGR_OR_OWNER) tabs.push({ key: 'scheduler', label: 'Scheduler' }, { key: 'timeoff', label: 'Time Off' }, { key: 'setup', label: 'Setup' });
  document.getElementById('tabs').innerHTML = tabs.map(t =>
    `<button data-tab="${t.key}" onclick="setTab('${t.key}')">${t.label}</button>`).join('');
  setTab(IS_MGR_OR_OWNER ? 'scheduler' : 'mine');
}

function closeAllModals() {
  closeShiftModal(); closePublishModal(); closeTimeOffModal(); closeQualModal();
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
    <div class="card">
      <label>Schedules</label>
      <div id="schedPicker" class="sc-checkbox-grid"></div>
    </div>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <h2 style="margin:0;">Week of <span id="schedWeekLabel"></span></h2>
        <div class="stack-actions" style="margin:0; gap:6px;">
          <button class="small ghost" onclick="shiftSchedWeek(-7)">‹ Prev</button>
          <button class="small ghost" onclick="goToCurrentSchedWeek()">Today</button>
          <button class="small ghost" onclick="shiftSchedWeek(7)">Next ›</button>
          <button class="small secondary" onclick="openShiftModal({})">+ Add shift</button>
        </div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; flex-wrap:wrap; gap:8px;">
        <span class="badge ${DRAFT_COUNT ? 'stale' : 'off'}" id="draftCountBadge">${DRAFT_COUNT} draft${DRAFT_COUNT === 1 ? '' : 's'} pending</span>
        <div class="stack-actions" style="margin:0; gap:6px;">
          <button class="small ghost" onclick="discardDrafts()">Discard my drafts</button>
          <button class="small primary" style="margin-top:0;" onclick="openPublishModal()">Publish</button>
        </div>
      </div>
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

  document.getElementById('schedPicker').innerHTML = MANAGEABLE_SCHEDULES.length
    ? MANAGEABLE_SCHEDULES.map(s => `<label class="sc-checkbox"><input type="checkbox" value="${s.id}" ${SELECTED_SCHEDULE_IDS.includes(s.id) ? 'checked' : ''} onchange="toggleSchedule('${s.id}', this.checked)"> ${escapeHtml(s.name)} <span class="muted">(${escapeHtml(s.location_name)})</span></label>`).join('')
    : '<p class="muted">No schedules assigned to you yet — ask the owner to set one up under Setup.</p>';

  const copySel = document.getElementById('copyEmployee');
  copySel.innerHTML = EMPLOYEES.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');

  loadSchedGrid();
}

function toggleSchedule(id, checked) {
  if (checked && !SELECTED_SCHEDULE_IDS.includes(id)) SELECTED_SCHEDULE_IDS.push(id);
  if (!checked) SELECTED_SCHEDULE_IDS = SELECTED_SCHEDULE_IDS.filter(x => x !== id);
  loadSchedGrid();
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
    const badge = document.getElementById('draftCountBadge');
    badge.textContent = `${DRAFT_COUNT} draft${DRAFT_COUNT === 1 ? '' : 's'} pending`;
    badge.className = `badge ${DRAFT_COUNT ? 'stale' : 'off'}`;

    const roster = EMPLOYEES.filter(e => e.schedule_ids.some(id => SELECTED_SCHEDULE_IDS.includes(id)));
    const dates = weekDatesFrom(WEEK_START);
    if (!roster.length) { el.innerHTML = '<p class="muted">Nobody is checked into the selected schedule(s) yet — add them under Setup.</p>'; return; }
    el.innerHTML = `<table><thead><tr><th>Employee</th>${dates.map(d => `<th>${dayLabel(d)}</th>`).join('')}</tr></thead><tbody>
      ${roster.map(emp => `<tr><td>${escapeHtml(emp.name)}</td>${dates.map(date => schedCellHtml(emp, date)).join('')}</tr>`).join('')}
    </tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function schedCellHtml(emp, date) {
  const shifts = WEEK_SHIFTS.filter(s => s.person_id === emp.id && s.shift_date === date);
  const defaultScheduleId = emp.schedule_ids.find(id => SELECTED_SCHEDULE_IDS.includes(id)) || SELECTED_SCHEDULE_IDS[0];
  const chips = shifts.map(s => {
    const cls = s.draftAction === 'cancel' ? 'danger' : (s.isDraft ? 'stale' : 'on');
    const label = s.draftAction === 'cancel' ? `<s>${formatTime12(s.start_time)}–${formatTime12(s.end_time)}</s>` : `${formatTime12(s.start_time)}–${formatTime12(s.end_time)}`;
    const payload = JSON.stringify({
      personId: s.person_id, scheduleId: s.schedule_id, positionId: s.position_id, date: s.shift_date,
      startTime: s.start_time, endTime: s.end_time, draftId: s.draftId, shiftId: s.id,
    }).replace(/"/g, '&quot;');
    return `<div class="badge ${cls}" style="display:block; margin-bottom:3px; cursor:pointer;" onclick='openShiftModal(${payload})'>${escapeHtml(s.position_name)} ${label}</div>`;
  }).join('');
  const addPayload = JSON.stringify({ personId: emp.id, scheduleId: defaultScheduleId, date }).replace(/"/g, '&quot;');
  return `<td style="min-width:120px; vertical-align:top;">${chips}<a href="#" onclick='event.preventDefault(); openShiftModal(${addPayload})' style="font-size:12px;">+ add</a></td>`;
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
      <h2>Employees</h2>
      <p class="muted">Which schedules and positions each person is checked into. ${IS_OWNER ? 'Click Edit to change.' : 'Only the owner can change this.'}</p>
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
    el.innerHTML = EMPLOYEES.map(e => `<div class="list-row">
      <div><div class="name">${escapeHtml(e.name)} <span class="muted">(${escapeHtml(e.role)})</span></div>
      <div class="sub">${e.schedule_ids.length} schedule${e.schedule_ids.length === 1 ? '' : 's'} · ${e.position_ids.length} position${e.position_ids.length === 1 ? '' : 's'}${e.role === 'manager' ? ` · manages ${e.manager_schedule_ids.length}` : ''}</div></div>
      <button class="small ghost" onclick="openQualModal('${e.id}')">${IS_OWNER ? 'Edit' : 'View'}</button>
    </div>`).join('');
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
  document.getElementById('qualSchedules').innerHTML = ALL_SCHEDULES.map(s =>
    `<label class="sc-checkbox"><input type="checkbox" ${disabled} value="${s.id}" ${emp.schedule_ids.includes(s.id) ? 'checked' : ''}> ${escapeHtml(s.name)}</label>`).join('');
  document.getElementById('qualPositions').innerHTML = POSITIONS.map(p =>
    `<label class="sc-checkbox"><input type="checkbox" ${disabled} value="${p.id}" ${emp.position_ids.includes(p.id) ? 'checked' : ''}> ${escapeHtml(p.name)}</label>`).join('');
  document.getElementById('qualManagerWrap').style.display = emp.role === 'manager' ? '' : 'none';
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
  const scheduleIds = Array.from(document.querySelectorAll('#qualSchedules input:checked')).map(i => i.value);
  const positionIds = Array.from(document.querySelectorAll('#qualPositions input:checked')).map(i => i.value);
  const managerScheduleIds = Array.from(document.querySelectorAll('#qualManagerSchedules input:checked')).map(i => i.value);
  const resultEl = document.getElementById('qualResult');
  try {
    await withStepUp(() => api(`/api/scheduling/employees/${personId}/schedules`, { method: 'POST', body: { scheduleIds } }));
    await withStepUp(() => api(`/api/scheduling/employees/${personId}/positions`, { method: 'POST', body: { positionIds } }));
    if (document.getElementById('qualManagerWrap').style.display !== 'none') {
      await withStepUp(() => api(`/api/scheduling/employees/${personId}/managed-schedules`, { method: 'POST', body: { scheduleIds: managerScheduleIds } }));
    }
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
    }
    renderTabs();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
