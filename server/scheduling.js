// Scheduling — ported from the reviewed old "TSB Scheduling" Google Apps
// Script system (script.google.com, v8.3, reviewed 2026-09-02) onto the
// shared people/locations core, gated by employee_apps.scheduling.
//
// Kept identical to the old system, per Scotto's explicit sign-off:
//   - shift model (Schedule × Position × Employee qualification matrix)
//   - availability (self-service day-of-week windows, soft-blocks shifts)
//   - draft-then-publish workflow (nothing goes live until Publish)
//   - time-off request/approval shape
// Deliberately NOT ported / NOT built:
//   - shift-swap requests (never existed in the old system either)
//   - any Time Clock conflict checking (old system had no time clock to
//     check against; Scotto confirmed this build doesn't need that link)
//   - Google Calendar sync (v1 scope decision — may revisit later)
//
// Ticket 3 stays IN SCOPE here — unlike Systems Monitoring/Service Calls,
// which exclude it because it's being sold. Don't add a T3 filter to any
// location/schedule picker in this app.
//
// Every table this module touches (schedules, employee_schedules,
// employee_positions, manager_schedules, shifts, shift_drafts,
// time_off_requests, availability) is RLS FORCE with zero policies — same
// posture as pay_rate_requests/owner_notes — so every function here owns
// its own withServiceClient() call, and authorization is enforced in the
// Express route handlers (server/index.js), same as everywhere else that
// posture is used.

const { withServiceClient } = require('./db');
const notify = require('./notify');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------------
// Bar-local timezone helpers — same technique as server/timeclock.js's
// zonedTimeToUtc/toUtcInstant (kept as its own copy here rather than a
// shared import, matching how public/common.js and server/timeclock.js
// already each carry their own copy of this same conversion logic; keep
// BUSINESS_TZ in sync with those if it ever changes).
// ---------------------------------------------------------------------
const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';

function tzOffsetMinutes(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) { if (p.type !== 'literal') parts[p.type] = p.value; }
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

function zonedTimeToUtc(dateStr, timeStr) {
  const guessUtcMs = Date.UTC(...dateStr.split('-').map(Number).map((n, i) => i === 1 ? n - 1 : n), ...timeStr.split(':').map(Number));
  const offsetMin = tzOffsetMinutes(BUSINESS_TZ, new Date(guessUtcMs));
  return new Date(guessUtcMs - offsetMin * 60000);
}

// A shift's real start/end instant, in the bar's own timezone — crossing
// midnight (end <= start) rolls the end onto the next calendar day, same
// as the old system's shiftRange_.
function shiftRange(dateStr, startTime, endTime) {
  const start = zonedTimeToUtc(dateStr, startTime);
  let end = zonedTimeToUtc(dateStr, endTime);
  if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function rangesOverlap(r1, r2) {
  return r1.start < r2.end && r2.start < r1.end;
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function dayNameForDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function weekDateRange(weekStartISO) {
  return Array.from({ length: 7 }, (_, i) => addDaysToDateStr(weekStartISO, i));
}

function formatTime12hr(hhmm) {
  const [hStr, m] = String(hhmm).split(':');
  let h = Number(hStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

async function requireSchedulingAccess(personId) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT enabled FROM employee_apps WHERE person_id = $1 AND app_key = 'scheduling'`,
      [personId]
    );
    return !!(rows[0] && rows[0].enabled);
  });
}

// =========================================================
// SCHEDULES (admin) — a named roster/crew under one location. NOT a time
// concept. Owner and any manager assigned to it (via manager_schedules)
// can manage it; only the owner can create/rename/archive one, mirroring
// how Locations work (owner-only) rather than Positions (manager+owner).
// =========================================================
async function listSchedules() {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT s.*, l.name AS location_name FROM schedules s
       JOIN locations l ON l.id = s.location_id
       ORDER BY s.active DESC, l.name, s.name`
    );
    return rows;
  });
}

async function listSchedulesPublic() {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT s.*, l.name AS location_name FROM schedules s
       JOIN locations l ON l.id = s.location_id
       WHERE s.active = true ORDER BY l.name, s.name`
    );
    return rows;
  });
}

async function saveSchedule({ id, locationId, name }) {
  const trimmed = (name || '').trim();
  if (!trimmed || !locationId) return { ok: false, error: 'Location and name are required.' };
  return withServiceClient(async (client) => {
    if (id) {
      const { rows } = await client.query(
        `UPDATE schedules SET location_id = $1, name = $2 WHERE id = $3 RETURNING *`,
        [locationId, trimmed, id]
      );
      if (!rows[0]) return { ok: false, error: 'Not found.' };
      return { ok: true, schedule: rows[0] };
    }
    const { rows } = await client.query(
      `INSERT INTO schedules (location_id, name) VALUES ($1,$2) RETURNING *`,
      [locationId, trimmed]
    );
    return { ok: true, schedule: rows[0] };
  });
}

async function archiveSchedule(id) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query('UPDATE schedules SET active = false WHERE id = $1 RETURNING *', [id]);
    if (!rows[0]) return { ok: false, error: 'Not found.' };
    return { ok: true, schedule: rows[0] };
  });
}

async function restoreSchedule(id) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query('UPDATE schedules SET active = true WHERE id = $1 RETURNING *', [id]);
    if (!rows[0]) return { ok: false, error: 'Not found.' };
    return { ok: true, schedule: rows[0] };
  });
}

// =========================================================
// EMPLOYEE QUALIFICATION MATRICES — which schedules a person is checked
// into, which positions they're qualified for, and which schedules a
// manager can manage. Each is replaced wholesale on save, same pattern as
// Service Calls' destination-members save.
// =========================================================
async function getEmployeesForScheduling() {
  return withServiceClient(async (client) => {
    const { rows: people } = await client.query(
      `SELECT id, name, role, location_id, status FROM people WHERE status = 'active' ORDER BY name`
    );
    const [{ rows: es }, { rows: ep }, { rows: ms }] = await Promise.all([
      client.query('SELECT person_id, schedule_id FROM employee_schedules'),
      client.query('SELECT person_id, position_id FROM employee_positions'),
      client.query('SELECT person_id, schedule_id FROM manager_schedules'),
    ]);
    return people.map((p) => ({
      ...p,
      schedule_ids: es.filter((r) => r.person_id === p.id).map((r) => r.schedule_id),
      position_ids: ep.filter((r) => r.person_id === p.id).map((r) => r.position_id),
      manager_schedule_ids: ms.filter((r) => r.person_id === p.id).map((r) => r.schedule_id),
    }));
  });
}

async function setEmployeeScheduleQualifications(personId, scheduleIds) {
  return withServiceClient(async (client) => {
    await client.query('DELETE FROM employee_schedules WHERE person_id = $1', [personId]);
    const ids = [...new Set((scheduleIds || []).filter(Boolean))];
    if (ids.length) {
      const values = ids.map((_, i) => `($1, $${i + 2})`).join(',');
      await client.query(`INSERT INTO employee_schedules (person_id, schedule_id) VALUES ${values}`, [personId, ...ids]);
    }
    return { ok: true };
  });
}

async function setEmployeePositionQualifications(personId, positionIds) {
  return withServiceClient(async (client) => {
    await client.query('DELETE FROM employee_positions WHERE person_id = $1', [personId]);
    const ids = [...new Set((positionIds || []).filter(Boolean))];
    if (ids.length) {
      const values = ids.map((_, i) => `($1, $${i + 2})`).join(',');
      await client.query(`INSERT INTO employee_positions (person_id, position_id) VALUES ${values}`, [personId, ...ids]);
    }
    return { ok: true };
  });
}

async function setManagerScheduleAssignments(personId, scheduleIds) {
  return withServiceClient(async (client) => {
    await client.query('DELETE FROM manager_schedules WHERE person_id = $1', [personId]);
    const ids = [...new Set((scheduleIds || []).filter(Boolean))];
    if (ids.length) {
      const values = ids.map((_, i) => `($1, $${i + 2})`).join(',');
      await client.query(`INSERT INTO manager_schedules (person_id, schedule_id) VALUES ${values}`, [personId, ...ids]);
    }
    return { ok: true };
  });
}

// Owner manages every schedule regardless of manager_schedules (same as
// isAdmin_ in the old system); a manager only manages schedules they're
// explicitly assigned to.
async function getMyManageableScheduleIds(person) {
  return withServiceClient(async (client) => {
    if (person.role === 'owner') {
      const { rows } = await client.query('SELECT id FROM schedules WHERE active = true');
      return rows.map((r) => r.id);
    }
    const { rows } = await client.query('SELECT schedule_id FROM manager_schedules WHERE person_id = $1', [person.id]);
    return rows.map((r) => r.schedule_id);
  });
}

async function getSchedulingBootstrapData(person) {
  const manageableScheduleIds = await getMyManageableScheduleIds(person);
  const [allSchedules, employees, pendingTimeOffCount] = await Promise.all([
    listSchedulesPublic(),
    getEmployeesForScheduling(),
    getPendingTimeOffCountForManager(person),
  ]);
  return {
    isOwner: person.role === 'owner',
    manageableSchedules: allSchedules.filter((s) => manageableScheduleIds.includes(s.id)),
    schedules: allSchedules,
    employees,
    pendingTimeOffCount,
  };
}

// =========================================================
// CONFLICT CHECKING — the actual scheduling rules. Hard blocks always
// prevent a shift; soft blocks can be published anyway with a logged
// override reason. Ported directly from the old checkShiftConflicts.
// =========================================================
async function checkShiftConflicts(shift, options = {}) {
  const extraShifts = options.extraShifts || [];
  const excludeShiftIds = new Set((options.excludeShiftIds || []).map(String));
  const conflicts = [];

  return withServiceClient(async (client) => {
    const { rows: peopleRows } = await client.query('SELECT * FROM people WHERE id = $1', [shift.personId]);
    const person = peopleRows[0];
    if (!person) {
      conflicts.push({ type: 'unknown_employee', hardBlock: true, message: 'Employee not found.' });
      return conflicts;
    }

    const { rows: schedQual } = await client.query('SELECT 1 FROM employee_schedules WHERE person_id = $1 AND schedule_id = $2', [shift.personId, shift.scheduleId]);
    if (!schedQual.length) {
      conflicts.push({ type: 'qualification_schedule', hardBlock: true, message: `${person.name} is not checked in for this Schedule.` });
    }
    const { rows: posQual } = await client.query('SELECT 1 FROM employee_positions WHERE person_id = $1 AND position_id = $2', [shift.personId, shift.positionId]);
    if (!posQual.length) {
      const { rows: posRows } = await client.query('SELECT name FROM positions WHERE id = $1', [shift.positionId]);
      conflicts.push({ type: 'qualification_position', hardBlock: true, message: `${person.name} is not checked for the ${posRows[0] ? posRows[0].name : 'selected'} position.` });
    }

    // Overlaps another active shift for this person, any schedule.
    const { rows: liveShifts } = await client.query(
      `SELECT sh.*, s.name AS schedule_name FROM shifts sh
       JOIN schedules s ON s.id = sh.schedule_id
       WHERE sh.person_id = $1 AND sh.status != 'cancelled'`,
      [shift.personId]
    );
    const allOther = liveShifts
      .filter((s) => !excludeShiftIds.has(String(s.id)))
      .concat(extraShifts);
    const thisRange = shiftRange(shift.date, shift.startTime, shift.endTime);
    allOther.forEach((s) => {
      if (shift.id && String(s.id) === String(shift.id)) return;
      const otherRange = shiftRange(s.date || s.shift_date, s.start_time || s.startTime, s.end_time || s.endTime);
      if (rangesOverlap(thisRange, otherRange)) {
        const schedName = s.schedule_name || s.scheduleName || 'another schedule';
        conflicts.push({
          type: 'overlap', hardBlock: true,
          message: `Overlaps existing shift: ${schedName}, ${s.date || s.shift_date} ${formatTime12hr(s.start_time || s.startTime)}–${formatTime12hr(s.end_time || s.endTime)}`,
        });
      }
    });

    // Approved time off covering this date (soft).
    const { rows: timeOff } = await client.query(
      `SELECT * FROM time_off_requests WHERE person_id = $1 AND status = 'approved' AND $2 BETWEEN start_date AND end_date`,
      [shift.personId, shift.date]
    );
    timeOff.forEach((t) => {
      conflicts.push({
        type: 'time_off', hardBlock: false,
        message: `Conflicts with approved time off: ${t.start_date} – ${t.end_date}`,
      });
    });

    // Self-marked unavailability (soft).
    const dayName = dayNameForDate(shift.date);
    const { rows: avail } = await client.query(
      'SELECT * FROM availability WHERE person_id = $1 AND day_of_week = $2',
      [shift.personId, dayName]
    );
    avail.forEach((a) => {
      const availRange = shiftRange(shift.date, a.start_time, a.end_time);
      if (rangesOverlap(thisRange, availRange)) {
        conflicts.push({
          type: 'availability', hardBlock: false,
          message: `${person.name} marked unavailable ${dayName} ${formatTime12hr(a.start_time)}–${formatTime12hr(a.end_time)}${a.note ? ` (note: "${a.note}")` : ''}`,
        });
      }
    });

    return conflicts;
  });
}

// =========================================================
// SCHEDULER — live shifts + this manager's own draft overlay. Other
// managers' pending drafts are never shown (coordination is manual, same
// as the old system).
// =========================================================
async function getWeekShifts(scheduleIds, weekStartISO) {
  const ids = Array.isArray(scheduleIds) ? scheduleIds : [scheduleIds];
  const dates = weekDateRange(weekStartISO);
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT sh.*, p.name AS person_name, s.name AS schedule_name, pos.name AS position_name
       FROM shifts sh
       JOIN people p ON p.id = sh.person_id
       JOIN schedules s ON s.id = sh.schedule_id
       JOIN positions pos ON pos.id = sh.position_id
       WHERE sh.schedule_id = ANY($1) AND sh.status != 'cancelled' AND sh.shift_date = ANY($2)`,
      [ids, dates]
    );
    return rows;
  });
}

async function getShiftsForPrint(scheduleIds, weekStartISO, numWeeks) {
  // Published shifts only (no draft overlay) across `numWeeks` consecutive
  // weeks starting at weekStartISO -- backs the Scheduler tab's Print dialog.
  const ids = Array.isArray(scheduleIds) ? scheduleIds : [scheduleIds];
  const n = Math.max(1, Math.min(3, Number(numWeeks) || 1));
  const dates = Array.from({ length: n * 7 }, (_, i) => addDaysToDateStr(weekStartISO, i));
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT sh.*, p.name AS person_name, s.name AS schedule_name, pos.name AS position_name
       FROM shifts sh
       JOIN people p ON p.id = sh.person_id
       JOIN schedules s ON s.id = sh.schedule_id
       JOIN positions pos ON pos.id = sh.position_id
       WHERE sh.schedule_id = ANY($1) AND sh.status != 'cancelled' AND sh.shift_date = ANY($2)
       ORDER BY sh.shift_date, sh.start_time`,
      [ids, dates]
    );
    return rows;
  });
}

async function getMyDrafts(personId) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query('SELECT * FROM shift_drafts WHERE created_by = $1', [personId]);
    return rows;
  });
}

async function getMyDraftSummary(personId) {
  const drafts = await getMyDrafts(personId);
  return { count: drafts.length };
}

async function getWeekShiftsWithDrafts(scheduleIds, weekStartISO, personId) {
  const ids = (Array.isArray(scheduleIds) ? scheduleIds : [scheduleIds]).map(String);
  const dates = weekDateRange(weekStartISO);
  const liveShifts = await getWeekShifts(scheduleIds, weekStartISO);
  const byKey = {};
  liveShifts.forEach((s) => { byKey[s.id] = { ...s, isDraft: false, draftAction: null, draftId: null }; });

  const drafts = await getMyDrafts(personId);
  return withServiceClient(async (client) => {
    for (const d of drafts) {
      if (!ids.includes(String(d.schedule_id)) || !dates.includes(d.shift_date)) continue;
      if (d.action === 'create') {
        const [{ rows: pr }, { rows: sr }, { rows: por }] = await Promise.all([
          client.query('SELECT name FROM people WHERE id = $1', [d.person_id]),
          client.query('SELECT name FROM schedules WHERE id = $1', [d.schedule_id]),
          client.query('SELECT name FROM positions WHERE id = $1', [d.position_id]),
        ]);
        byKey['newdraft-' + d.id] = {
          id: null, person_id: d.person_id, schedule_id: d.schedule_id, position_id: d.position_id,
          shift_date: d.shift_date, start_time: d.start_time, end_time: d.end_time, status: 'scheduled',
          person_name: pr[0] && pr[0].name, schedule_name: sr[0] && sr[0].name, position_name: por[0] && por[0].name,
          isDraft: true, draftAction: 'create', draftId: d.id,
        };
      } else if (d.action === 'update' && d.target_shift_id) {
        if (byKey[d.target_shift_id]) {
          byKey[d.target_shift_id] = {
            ...byKey[d.target_shift_id],
            schedule_id: d.schedule_id, position_id: d.position_id, shift_date: d.shift_date,
            start_time: d.start_time, end_time: d.end_time,
            isDraft: true, draftAction: 'update', draftId: d.id,
          };
        }
      } else if (d.action === 'cancel' && d.target_shift_id && byKey[d.target_shift_id]) {
        byKey[d.target_shift_id].isDraft = true;
        byKey[d.target_shift_id].draftAction = 'cancel';
        byKey[d.target_shift_id].draftId = d.id;
      }
    }
    return Object.values(byKey);
  });
}

async function saveDraftShift(shift, personId) {
  return withServiceClient(async (client) => {
    if (shift.draftId) {
      const { rows: existingRows } = await client.query('SELECT * FROM shift_drafts WHERE id = $1', [shift.draftId]);
      const existing = existingRows[0];
      if (!existing || String(existing.created_by) !== String(personId)) {
        return { ok: false, error: 'You can only edit your own drafts.' };
      }
      const { rows } = await client.query(
        `UPDATE shift_drafts SET person_id = $1, schedule_id = $2, position_id = $3, shift_date = $4, start_time = $5, end_time = $6
         WHERE id = $7 RETURNING *`,
        [shift.personId, shift.scheduleId, shift.positionId, shift.date, shift.startTime, shift.endTime, shift.draftId]
      );
      return { ok: true, draft: rows[0] };
    }
    const action = shift.id ? 'update' : 'create';
    const { rows } = await client.query(
      `INSERT INTO shift_drafts (action, target_shift_id, person_id, schedule_id, position_id, shift_date, start_time, end_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [action, shift.id || null, shift.personId, shift.scheduleId, shift.positionId, shift.date, shift.startTime, shift.endTime, personId]
    );
    return { ok: true, draft: rows[0] };
  });
}

async function discardSingleDraft(draftId, personId) {
  return withServiceClient(async (client) => {
    const { rows: existingRows } = await client.query('SELECT * FROM shift_drafts WHERE id = $1', [draftId]);
    const existing = existingRows[0];
    if (!existing) return { ok: true };
    if (String(existing.created_by) !== String(personId)) return { ok: false, error: 'You can only discard your own drafts.' };
    await client.query('DELETE FROM shift_drafts WHERE id = $1', [draftId]);
    return { ok: true };
  });
}

async function draftCancelShift(payload, personId) {
  if (payload.draftId) {
    const { rows } = await withServiceClient((client) => client.query('SELECT * FROM shift_drafts WHERE id = $1', [payload.draftId]));
    const draft = rows[0];
    const result = await discardSingleDraft(payload.draftId, personId);
    if (!result.ok) return result;
    if (draft && draft.action === 'create') return { ok: true };
  }
  if (payload.shiftId) {
    return withServiceClient(async (client) => {
      const { rows: shiftRows } = await client.query('SELECT * FROM shifts WHERE id = $1', [payload.shiftId]);
      const shift = shiftRows[0];
      if (!shift) return { ok: true };
      await client.query(
        `INSERT INTO shift_drafts (action, target_shift_id, person_id, schedule_id, position_id, shift_date, start_time, end_time, created_by)
         VALUES ('cancel',$1,$2,$3,$4,$5,$6,$7,$8)`,
        [shift.id, shift.person_id, shift.schedule_id, shift.position_id, shift.shift_date, shift.start_time, shift.end_time, personId]
      );
      return { ok: true };
    });
  }
  return { ok: true };
}

async function discardMyDrafts(personId) {
  return withServiceClient(async (client) => {
    const { rowCount } = await client.query('DELETE FROM shift_drafts WHERE created_by = $1', [personId]);
    return { discarded: rowCount };
  });
}

// Drafts the same shift template across a list of target dates — one
// 'create' draft per date. No conflict checking here; resolved together
// at publish time, same as the old system.
async function draftDuplicateShift(baseShift, targetDates, personId) {
  return withServiceClient(async (client) => {
    for (const dateStr of targetDates) {
      await client.query(
        `INSERT INTO shift_drafts (action, target_shift_id, person_id, schedule_id, position_id, shift_date, start_time, end_time, created_by)
         VALUES ('create', NULL, $1,$2,$3,$4,$5,$6,$7)`,
        [baseShift.personId, baseShift.scheduleId, baseShift.positionId, dateStr, baseShift.startTime, baseShift.endTime, personId]
      );
    }
    return { drafted: targetDates.length };
  });
}

// "Copy this week forward" — scoped per employee, per Scotto: copies every
// live shift THIS ONE employee has in the source week onto the following
// week (same weekday/schedule/position/times), as new drafts. Deliberately
// per-employee rather than a whole-schedule bulk copy (the old system's
// draftCopyWeekToNextWeek copied an entire Schedule at once — Scotto asked
// for the narrower, per-employee version instead).
async function copyWeekForwardForEmployee({ personId, weekStartISO, createdBy }) {
  const dates = weekDateRange(weekStartISO);
  return withServiceClient(async (client) => {
    const { rows: sourceShifts } = await client.query(
      `SELECT * FROM shifts WHERE person_id = $1 AND status != 'cancelled' AND shift_date = ANY($2)`,
      [personId, dates]
    );
    for (const s of sourceShifts) {
      const newDate = addDaysToDateStr(s.shift_date, 7);
      await client.query(
        `INSERT INTO shift_drafts (action, target_shift_id, person_id, schedule_id, position_id, shift_date, start_time, end_time, created_by)
         VALUES ('create', NULL, $1,$2,$3,$4,$5,$6,$7)`,
        [s.person_id, s.schedule_id, s.position_id, newDate, s.start_time, s.end_time, createdBy]
      );
    }
    return { drafted: sourceShifts.length };
  });
}

// The only place conflict-checking happens — validates this manager's
// ENTIRE pending draft batch (each draft against live data AND against
// every other draft in the same batch), and only applies anything if
// every single draft comes back clean. overrideReasons = { draftId: reason }
// for soft conflicts the manager already chose to override on a retry.
async function publishMyDrafts(overrideReasons, personId) {
  overrideReasons = overrideReasons || {};
  const drafts = await getMyDrafts(personId);
  if (!drafts.length) return { success: true, published: 0, notifiedEmployees: 0 };

  const cancelTargetIds = drafts.filter((d) => d.action === 'cancel').map((d) => d.target_shift_id);
  const employees = await getEmployeesForScheduling();
  const conflictsByDraft = [];

  for (const d of drafts) {
    if (d.action === 'cancel') continue;
    const candidate = {
      id: d.target_shift_id || null,
      personId: d.person_id, scheduleId: d.schedule_id, positionId: d.position_id,
      date: d.shift_date, startTime: d.start_time, endTime: d.end_time,
    };
    const otherDraftShifts = drafts
      .filter((other) => other.id !== d.id && other.action !== 'cancel')
      .map((other) => ({
        id: 'draft-' + other.id, person_id: other.person_id, schedule_id: other.schedule_id,
        position_id: other.position_id, shift_date: other.shift_date, start_time: other.start_time,
        end_time: other.end_time, status: 'scheduled',
      }));
    const conflicts = await checkShiftConflicts(candidate, { extraShifts: otherDraftShifts, excludeShiftIds: cancelTargetIds });
    const hardBlocks = conflicts.filter((c) => c.hardBlock);
    const softBlocks = conflicts.filter((c) => !c.hardBlock);
    const hasReason = !!overrideReasons[d.id];
    if (hardBlocks.length > 0 || (softBlocks.length > 0 && !hasReason)) {
      const emp = employees.find((e) => String(e.id) === String(d.person_id));
      conflictsByDraft.push({
        draftId: d.id, employeeName: emp ? emp.name : 'Unknown', date: d.shift_date,
        canOverride: hardBlocks.length === 0,
        hardMessages: hardBlocks.map((c) => c.message),
        softMessages: softBlocks.map((c) => c.message),
      });
    } else if (softBlocks.length > 0 && hasReason) {
      await withServiceClient((client) => client.query('UPDATE shift_drafts SET override_reason = $1 WHERE id = $2', [overrideReasons[d.id], d.id]));
    }
  }

  if (conflictsByDraft.length > 0) return { success: false, conflicts: conflictsByDraft };

  return withServiceClient(async (client) => {
    const { rows: freshDrafts } = await client.query('SELECT * FROM shift_drafts WHERE created_by = $1', [personId]);
    const notifyByPerson = {};
    for (const d of freshDrafts) {
      let finalShiftId;
      if (d.action === 'create') {
        const { rows } = await client.query(
          `INSERT INTO shifts (person_id, schedule_id, position_id, shift_date, start_time, end_time, status, created_by, override_reason)
           VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8) RETURNING id`,
          [d.person_id, d.schedule_id, d.position_id, d.shift_date, d.start_time, d.end_time, personId, d.override_reason || null]
        );
        finalShiftId = rows[0].id;
      } else if (d.action === 'update') {
        finalShiftId = d.target_shift_id;
        await client.query(
          `UPDATE shifts SET person_id=$1, schedule_id=$2, position_id=$3, shift_date=$4, start_time=$5, end_time=$6, status='scheduled', updated_at=now(), override_reason=$7
           WHERE id = $8`,
          [d.person_id, d.schedule_id, d.position_id, d.shift_date, d.start_time, d.end_time, d.override_reason || null, d.target_shift_id]
        );
      } else if (d.action === 'cancel') {
        finalShiftId = d.target_shift_id;
        await client.query(`UPDATE shifts SET status = 'cancelled', updated_at = now() WHERE id = $1`, [d.target_shift_id]);
      }
      (notifyByPerson[d.person_id] ||= []).push(d);
    }

    const [{ rows: schedules }, { rows: positions }] = await Promise.all([
      client.query('SELECT * FROM schedules'),
      client.query('SELECT * FROM positions'),
    ]);
    let notifiedCount = 0;
    for (const pid of Object.keys(notifyByPerson)) {
      const items = notifyByPerson[pid].slice().sort((a, b) => a.shift_date.localeCompare(b.shift_date));
      const lines = items.map((d) => {
        const sched = schedules.find((s) => s.id === d.schedule_id);
        const label = d.action === 'create' ? 'Added' : (d.action === 'cancel' ? 'Cancelled' : 'Updated');
        return `${label}: ${sched ? sched.name : ''} ${d.shift_date} ${formatTime12hr(d.start_time)}–${formatTime12hr(d.end_time)}`;
      });
      const { rows: personRows } = await client.query('SELECT * FROM people WHERE id = $1', [pid]);
      const person = personRows[0];
      if (person) {
        const subject = 'Your schedule was updated';
        const text = `Your schedule was updated:\n${lines.join('\n')}`;
        if (person.email) await notify.sendEmail(client, 'shifts', pid, person.email, subject, text);
        if (person.phone) await notify.sendSms(client, 'shifts', pid, person.phone, text.slice(0, 300));
      }
      notifiedCount++;
    }

    const publishedCount = freshDrafts.length;
    await client.query('DELETE FROM shift_drafts WHERE created_by = $1', [personId]);
    return { success: true, published: publishedCount, notifiedEmployees: notifiedCount };
  });
}

// =========================================================
// TIME OFF — date-range request + manager-scoped approval, same shape as
// the old system. No request "types", just a range + optional message.
// =========================================================
async function getPendingTimeOffCountForManager(person) {
  const scheduleIds = await getMyManageableScheduleIds(person);
  if (!scheduleIds.length) return 0;
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM time_off_requests t
       JOIN employee_schedules es ON es.person_id = t.person_id
       WHERE t.status = 'pending' AND es.schedule_id = ANY($1)`,
      [scheduleIds]
    );
    return rows[0].n;
  });
}

async function getTimeOffRequestsICanApprove(person) {
  const scheduleIds = await getMyManageableScheduleIds(person);
  if (!scheduleIds.length) return [];
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT DISTINCT t.*, p.name AS employee_name FROM time_off_requests t
       JOIN people p ON p.id = t.person_id
       JOIN employee_schedules es ON es.person_id = t.person_id
       WHERE t.status = 'pending' AND es.schedule_id = ANY($1)
       ORDER BY t.start_date`,
      [scheduleIds]
    );
    return rows;
  });
}

async function getAllTimeOffRequestsIManage(person) {
  const scheduleIds = await getMyManageableScheduleIds(person);
  if (!scheduleIds.length) return [];
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT DISTINCT t.*, p.name AS employee_name FROM time_off_requests t
       JOIN people p ON p.id = t.person_id
       JOIN employee_schedules es ON es.person_id = t.person_id
       WHERE es.schedule_id = ANY($1)
       ORDER BY t.start_date DESC`,
      [scheduleIds]
    );
    return rows;
  });
}

async function decideTimeOffRequest(requestId, decision, person) {
  if (decision !== 'approved' && decision !== 'denied') return { ok: false, error: 'Invalid decision.' };
  return withServiceClient(async (client) => {
    const { rows: reqRows } = await client.query(`SELECT * FROM time_off_requests WHERE id = $1 AND status = 'pending'`, [requestId]);
    const request = reqRows[0];
    if (!request) return { ok: false, error: 'Not found, or already decided.' };
    await client.query(
      `UPDATE time_off_requests SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE id = $3`,
      [decision, person.id, requestId]
    );
    const { rows: personRows } = await client.query('SELECT * FROM people WHERE id = $1', [request.person_id]);
    const employee = personRows[0];
    if (employee) {
      const dateRange = request.start_date === request.end_date ? request.start_date : `${request.start_date} – ${request.end_date}`;
      const subject = `Time off request ${decision}`;
      const text = `Your time off request for ${dateRange} was ${decision} by ${person.name}.`;
      if (employee.email) await notify.sendEmail(client, 'time_off_requests', requestId, employee.email, subject, text);
      if (employee.phone) await notify.sendSms(client, 'time_off_requests', requestId, employee.phone, text);
    }
    return { ok: true };
  });
}

async function submitTimeOffRequest(person, { startDate, endDate, allDay, message }) {
  if (!startDate || !endDate) return { ok: false, error: 'Start and end dates are required.' };
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO time_off_requests (person_id, start_date, end_date, all_day, message)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [person.id, startDate, endDate, allDay !== false, message || null]
    );
    // Notify every manager/owner who manages a schedule this person is checked into.
    const { rows: managers } = await client.query(
      `SELECT DISTINCT pm.* FROM people pm
       JOIN manager_schedules ms ON ms.person_id = pm.id
       JOIN employee_schedules es ON es.schedule_id = ms.schedule_id
       WHERE es.person_id = $1 AND pm.status = 'active'
       UNION
       SELECT * FROM people WHERE role = 'owner' AND status = 'active'`,
      [person.id]
    );
    const dateRange = startDate === endDate ? startDate : `${startDate} – ${endDate}`;
    const subject = 'New time off request';
    const text = `${person.name} requested time off: ${dateRange}${message ? ` (${message})` : ''}. Review it in the app.`;
    for (const m of managers) {
      if (m.email) await notify.sendEmail(client, 'time_off_requests', rows[0].id, m.email, subject, text);
      if (m.phone) await notify.sendSms(client, 'time_off_requests', rows[0].id, m.phone, text);
    }
    return { ok: true, request: rows[0] };
  });
}

async function getMyTimeOffRequests(personId) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM time_off_requests WHERE person_id = $1 ORDER BY start_date DESC',
      [personId]
    );
    return rows;
  });
}

// =========================================================
// AVAILABILITY — pure self-service. Every function resolves the employee
// from the session (never a client-supplied id), same defensive pattern
// used throughout the rest of the platform.
// =========================================================
async function getMyAvailability(personId) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query('SELECT * FROM availability WHERE person_id = $1 ORDER BY day_of_week, start_time', [personId]);
    return rows;
  });
}

async function saveMyAvailabilityRow(row, personId) {
  return withServiceClient(async (client) => {
    if (row.id) {
      const { rows: existingRows } = await client.query('SELECT * FROM availability WHERE id = $1', [row.id]);
      const existing = existingRows[0];
      if (!existing || String(existing.person_id) !== String(personId)) {
        return { ok: false, error: 'You can only edit your own availability windows.' };
      }
      await client.query(
        'UPDATE availability SET day_of_week = $1, start_time = $2, end_time = $3, note = $4 WHERE id = $5',
        [row.dayOfWeek, row.startTime, row.endTime, row.note || null, row.id]
      );
    } else {
      await client.query(
        'INSERT INTO availability (person_id, day_of_week, start_time, end_time, note) VALUES ($1,$2,$3,$4,$5)',
        [personId, row.dayOfWeek, row.startTime, row.endTime, row.note || null]
      );
    }
    const { rows } = await client.query('SELECT * FROM availability WHERE person_id = $1 ORDER BY day_of_week, start_time', [personId]);
    return rows;
  });
}

async function deleteMyAvailabilityRow(id, personId) {
  return withServiceClient(async (client) => {
    const { rows: existingRows } = await client.query('SELECT * FROM availability WHERE id = $1', [id]);
    const existing = existingRows[0];
    if (!existing || String(existing.person_id) !== String(personId)) {
      return { ok: false, error: 'You can only remove your own availability windows.' };
    }
    await client.query('DELETE FROM availability WHERE id = $1', [id]);
    const { rows } = await client.query('SELECT * FROM availability WHERE person_id = $1 ORDER BY day_of_week, start_time', [personId]);
    return rows;
  });
}

// =========================================================
// EMPLOYEE PORTAL — "my shifts" across every Schedule the person is
// checked into, not scoped to a single one.
// =========================================================
async function getMyAllShiftsForWeek(personId, weekStartISO) {
  const dates = weekDateRange(weekStartISO);
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT sh.*, s.name AS schedule_name, pos.name AS position_name FROM shifts sh
       JOIN schedules s ON s.id = sh.schedule_id
       JOIN positions pos ON pos.id = sh.position_id
       WHERE sh.person_id = $1 AND sh.status != 'cancelled' AND sh.shift_date = ANY($2)
       ORDER BY sh.shift_date, sh.start_time`,
      [personId, dates]
    );
    return rows;
  });
}

async function getEmployeeUpcomingShifts(personId) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT sh.*, s.name AS schedule_name, pos.name AS position_name FROM shifts sh
       JOIN schedules s ON s.id = sh.schedule_id
       JOIN positions pos ON pos.id = sh.position_id
       WHERE sh.person_id = $1 AND sh.status != 'cancelled' AND sh.shift_date >= CURRENT_DATE
       ORDER BY sh.shift_date, sh.start_time LIMIT 20`,
      [personId]
    );
    return rows;
  });
}

module.exports = {
  requireSchedulingAccess,
  listSchedules, listSchedulesPublic, saveSchedule, archiveSchedule, restoreSchedule,
  getEmployeesForScheduling, setEmployeeScheduleQualifications, setEmployeePositionQualifications, setManagerScheduleAssignments,
  getMyManageableScheduleIds, getSchedulingBootstrapData,
  checkShiftConflicts, getWeekShifts, getWeekShiftsWithDrafts, getShiftsForPrint,
  getMyDrafts, getMyDraftSummary, saveDraftShift, draftCancelShift, discardMyDrafts,
  draftDuplicateShift, copyWeekForwardForEmployee, publishMyDrafts,
  getPendingTimeOffCountForManager, getTimeOffRequestsICanApprove, getAllTimeOffRequestsIManage,
  decideTimeOffRequest, submitTimeOffRequest, getMyTimeOffRequests,
  getMyAvailability, saveMyAvailabilityRow, deleteMyAvailabilityRow,
  getMyAllShiftsForWeek, getEmployeeUpcomingShifts,
  weekDateRange, formatTime12hr,
};
