// Time Clock — ported from the reviewed Apps Script app, onto the shared
// people/locations core and gated by employee_apps.time_clock.

const PAY_PERIOD_START = new Date(process.env.PAY_PERIOD_START || '2026-08-01T00:00:00Z');
const PAY_PERIOD_DAYS = 14;
const STALE_SHIFT_HOURS = 12;

// The bar's own timezone. Manual punch edits (editPunch, below) arrive from
// the client as plain "YYYY-MM-DD HH:mm" wall-clock strings with no
// timezone attached (see public/timeclock.js's editPunch prompt, which
// reads/writes this same timezone via APP_TIMEZONE in common.js — keep the
// two in sync). The DB session timezone here is UTC, so previously handing
// a naive string straight to Postgres made it get interpreted as UTC
// instead of Central, silently shifting every manually-edited punch by the
// zone's offset (the "clocked in at 9am, edited to 7:00am, shows 2:00am"
// bug). clockAction's own writes use SQL now(), which is always an
// unambiguous absolute instant and was never affected by this.
const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';

// Offset (in minutes, UTC minus zone) that `timeZone` is at approximately
// `date`. Found by asking Intl how `date` reads as wall-clock time in that
// zone, then comparing against the same numbers read as UTC — a standard
// dependency-free technique for one-off zone conversions.
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

// Converts a naive "YYYY-MM-DD HH:mm[:ss]" wall-clock string that is meant
// to represent a moment in `timeZone` into the correct absolute UTC Date.
function zonedTimeToUtc(naiveStr, timeZone) {
  const m = String(naiveStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const guessUtcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  const offsetMin = tzOffsetMinutes(timeZone, new Date(guessUtcMs));
  return new Date(guessUtcMs - offsetMin * 60000);
}

// Accepts either an absolute timestamp (already carries a "Z" or +hh:mm
// offset) or a naive bar-time wall-clock string, and always returns a
// correct UTC Date (or null for empty input, or invalid input we can't
// parse at all).
function toUtcInstant(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  return zonedTimeToUtc(str, BUSINESS_TZ);
}

function periodWindowFor(date) {
  const msPerPeriod = PAY_PERIOD_DAYS * 86400000;
  const elapsed = date.getTime() - PAY_PERIOD_START.getTime();
  const periodsIn = Math.floor(elapsed / msPerPeriod);
  const start = new Date(PAY_PERIOD_START.getTime() + periodsIn * msPerPeriod);
  const end = new Date(start.getTime() + msPerPeriod);
  return { start, end, index: periodsIn };
}

async function requireTimeClockAccess(client, personId) {
  const { rows } = await client.query(
    `SELECT enabled FROM employee_apps WHERE person_id = $1 AND app_key = 'time_clock'`,
    [personId]
  );
  return !!(rows[0] && rows[0].enabled);
}

async function clockAction(client, person, action, memo, deviceId) {
  // The owner is exempt (they're the one granting access to everyone else);
  // every other role — including managers — only gets in if the owner has
  // switched time_clock on for them, per the "some employees get it, some
  // don't" requirement.
  const hasAccess = await requireTimeClockAccess(client, person.id);
  if (!hasAccess && person.role !== 'owner') return { ok: false, error: 'Time Clock isn’t turned on for your account yet — ask your manager.' };

  const { rows: openRows } = await client.query(
    `SELECT * FROM time_entries WHERE person_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,
    [person.id]
  );
  const open = openRows[0];

  if (action === 'in') {
    if (open) return { ok: false, error: 'Already clocked in.' };
    const { rows } = await client.query(
      `INSERT INTO time_entries (person_id, location_id, clock_in, memo, device_id)
       VALUES ($1,$2, now(), $3, $4) RETURNING *`,
      [person.id, person.location_id, memo || null, deviceId || null]
    );
    return { ok: true, entry: rows[0] };
  }

  if (action === 'out') {
    if (!open) return { ok: false, error: 'Not currently clocked in.' };
    const { rows } = await client.query(
      `UPDATE time_entries SET clock_out = now(), memo = COALESCE($2, memo) WHERE id = $1 RETURNING *`,
      [open.id, memo || null]
    );
    return { ok: true, entry: rows[0] };
  }

  return { ok: false, error: 'Invalid action.' };
}

async function getStatus(client, personId) {
  const { rows } = await client.query(
    `SELECT * FROM time_entries WHERE person_id = $1 ORDER BY clock_in DESC LIMIT 20`,
    [personId]
  );
  const open = rows.find(r => !r.clock_out) || null;
  const win = periodWindowFor(new Date());
  const { rows: periodRows } = await client.query(
    `SELECT * FROM time_entries WHERE person_id = $1 AND clock_in >= $2 AND clock_in < $3`,
    [personId, win.start, win.end]
  );
  let totalMs = 0;
  periodRows.forEach(r => {
    const end = r.clock_out || new Date();
    totalMs += new Date(end).getTime() - new Date(r.clock_in).getTime();
  });
  return {
    open,
    recent: rows,
    periodHours: Math.round((totalMs / 3600000) * 10) / 10,
    periodPunches: periodRows.length,
  };
}

// Admin/manager view: everyone at (their) location(s), current status, stale flag.
async function getRosterStatus(client) {
  const { rows: people } = await client.query(
    `SELECT p.id, p.name, p.location_id FROM people p
     JOIN employee_apps ea ON ea.person_id = p.id AND ea.app_key = 'time_clock' AND ea.enabled = true
     WHERE p.status = 'active'`
  );
  const results = [];
  for (const person of people) {
    const { rows } = await client.query(
      `SELECT * FROM time_entries WHERE person_id = $1 ORDER BY clock_in DESC LIMIT 1`,
      [person.id]
    );
    const last = rows[0];
    const clockedIn = !!last && !last.clock_out;
    const hoursSince = last ? (Date.now() - new Date(last.clock_in).getTime()) / 3600000 : null;
    results.push({
      id: person.id,
      name: person.name,
      status: !last ? 'never_clocked_in' : (clockedIn ? 'clocked_in' : 'clocked_out'),
      since: last ? (clockedIn ? last.clock_in : last.clock_out) : null,
      stale: clockedIn && hoursSince > STALE_SHIFT_HOURS,
    });
  }
  return results;
}

async function getPayPeriod(client, periodIndex) {
  const now = new Date();
  const current = periodWindowFor(now);
  const idx = periodIndex === undefined || periodIndex === null ? current.index : Number(periodIndex);
  const start = new Date(PAY_PERIOD_START.getTime() + idx * PAY_PERIOD_DAYS * 86400000);
  const end = new Date(start.getTime() + PAY_PERIOD_DAYS * 86400000);

  const { rows: entries } = await client.query(
    `SELECT te.*, p.name FROM time_entries te JOIN people p ON p.id = te.person_id
     WHERE te.clock_in >= $1 AND te.clock_in < $2 ORDER BY p.name, te.clock_in`,
    [start, end]
  );

  const byPerson = {};
  entries.forEach(e => {
    (byPerson[e.name] ||= []).push(e);
  });

  const employees = Object.keys(byPerson).sort().map(name => {
    const rows = byPerson[name];
    let totalMinutes = 0;
    rows.forEach(r => {
      const endTs = r.clock_out ? new Date(r.clock_out) : new Date();
      totalMinutes += Math.max(0, Math.round((endTs - new Date(r.clock_in)) / 60000));
    });
    return { name, entries: rows, totalMinutes };
  });

  return { periodIndex: idx, periodStart: start, periodEnd: end, isCurrent: idx === current.index, employees };
}

async function editPunch(client, { id, clockIn, clockOut, memo, reason, editedBy }) {
  const { rows: oldRows } = await client.query('SELECT * FROM time_entries WHERE id = $1', [id]);
  const old = oldRows[0];
  if (!old) return { ok: false, error: 'Punch not found.' };

  const newClockIn = toUtcInstant(clockIn);
  if (!newClockIn) return { ok: false, error: 'Could not understand that clock-in time — use "YYYY-MM-DD HH:mm".' };
  if (clockOut && !toUtcInstant(clockOut)) return { ok: false, error: 'Could not understand that clock-out time — use "YYYY-MM-DD HH:mm".' };
  const newClockOut = toUtcInstant(clockOut);

  const { rows } = await client.query(
    `UPDATE time_entries SET clock_in = $1, clock_out = $2, memo = $3 WHERE id = $4 RETURNING *`,
    [newClockIn, newClockOut, memo || null, id]
  );
  await client.query(
    `INSERT INTO punch_edits (time_entry_id, edited_by, old_values, new_values, reason) VALUES ($1,$2,$3,$4,$5)`,
    [id, editedBy, JSON.stringify(old), JSON.stringify(rows[0]), reason || null]
  );
  return { ok: true, entry: rows[0] };
}

async function deletePunch(client, { id, reason, editedBy }) {
  const { rows: oldRows } = await client.query('SELECT * FROM time_entries WHERE id = $1', [id]);
  const old = oldRows[0];
  if (!old) return { ok: false, error: 'Punch not found.' };
  await client.query(
    `INSERT INTO punch_edits (time_entry_id, edited_by, old_values, new_values, reason) VALUES ($1,$2,$3,NULL,$4)`,
    [id, editedBy, JSON.stringify(old), reason || null]
  );
  await client.query('DELETE FROM time_entries WHERE id = $1', [id]);
  return { ok: true };
}

// Safety net — anyone still clocked in from a prior calendar day gets closed
// out at day-boundary so hours never silently bleed across a pay period.
// Call this on a schedule (see server/index.js) the same way the Apps
// Script version used a nightly trigger.
async function autoClockOutStale(client) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const { rows } = await client.query(
    `SELECT * FROM time_entries WHERE clock_out IS NULL AND clock_in < $1`,
    [todayStart]
  );
  for (const row of rows) {
    const cutoff = new Date(todayStart.getTime() - 1);
    await client.query(
      `UPDATE time_entries SET clock_out = $1, memo = COALESCE(memo, '') || ' (auto clock-out)', auto_clock_out = true WHERE id = $2`,
      [cutoff, row.id]
    );
  }
  return rows.length;
}

module.exports = { clockAction, getStatus, getRosterStatus, getPayPeriod, editPunch, deletePunch, autoClockOutStale, requireTimeClockAccess };
