// Service Calls — ported from the reviewed prototype (open-first sort,
// notify-on-open/close, CSV reporting) onto the shared people/locations
// core, gated by employee_apps.service_calls the same way Time Clock is
// gated behind employee_apps.time_clock.
const notify = require('./notify');
const { withServiceClient } = require('./db');

async function requireServiceCallsAccess(client, personId) {
  const { rows } = await client.query(
    `SELECT enabled FROM employee_apps WHERE person_id = $1 AND app_key = 'service_calls'`,
    [personId]
  );
  return !!(rows[0] && rows[0].enabled);
}

// Deliberately does NOT join to `people` on the caller's own (RLS-enforced)
// connection: a staff member can see calls at their own location, but
// people's own RLS policies mean they generally can't see *other people's*
// rows (e.g. a manager's, or another staff member's) — which silently
// turned "reported by"/"closed by" into blanks for anyone but a manager/
// owner. Names are resolved afterwards via resolveNames(), on the service
// (RLS-bypass) connection, since a display name isn't the sensitive part
// of a person's record — full row access is, and this never returns one.
const CALL_SELECT = `
  SELECT sc.*, l.name AS location_name, et.name AS equipment_name
  FROM service_calls sc
  JOIN locations l ON l.id = sc.location_id
  LEFT JOIN equipment_types et ON et.id = sc.equipment_type_id
`;

async function resolveNames(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return {};
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT id, name FROM people WHERE id = ANY($1)', [uniqueIds]);
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  });
}

async function withNames(rows) {
  const names = await resolveNames(rows.flatMap((r) => [r.created_by, r.closed_by]));
  return rows.map((r) => ({
    ...r,
    created_by_name: names[r.created_by] || null,
    closed_by_name: r.closed_by ? (names[r.closed_by] || null) : null,
  }));
}

async function getCall(client, id) {
  const { rows } = await client.query(`${CALL_SELECT} WHERE sc.id = $1`, [id]);
  if (!rows[0]) return null;
  const [named] = await withNames(rows);
  return withMinutesOpen(named);
}

async function listCalls(client, filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.status) { params.push(filters.status); clauses.push(`sc.status = $${params.length}`); }
  if (filters.locationId) { params.push(filters.locationId); clauses.push(`sc.location_id = $${params.length}`); }
  if (filters.equipmentTypeId) { params.push(filters.equipmentTypeId); clauses.push(`sc.equipment_type_id = $${params.length}`); }
  if (filters.createdBy) { params.push(filters.createdBy); clauses.push(`sc.created_by = $${params.length}`); }
  if (filters.closedBy) { params.push(filters.closedBy); clauses.push(`sc.closed_by = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); clauses.push(`sc.created_at >= $${params.length}`); }
  if (filters.dateTo) { params.push(filters.dateTo); clauses.push(`sc.created_at <= $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await client.query(`${CALL_SELECT} ${where}`, params);
  const named = await withNames(rows);

  // Open calls first (oldest first — a running reminder to close them),
  // then closed calls, most recently closed first.
  named.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    if (a.status === 'open') return new Date(a.created_at) - new Date(b.created_at);
    return new Date(b.closed_at) - new Date(a.closed_at);
  });

  return named.map(withMinutesOpen);
}

function withMinutesOpen(row) {
  const end = row.closed_at ? new Date(row.closed_at) : new Date();
  const minutesOpen = Math.max(0, Math.round((end - new Date(row.created_at)) / 60000));
  return { ...row, minutes_open: minutesOpen };
}

async function createCall(client, person, { locationId, equipmentTypeId, equipmentOther, description, assignedToRole }) {
  const hasAccess = await requireServiceCallsAccess(client, person.id);
  if (!hasAccess && person.role !== 'owner') {
    return { ok: false, error: 'Service Calls isn’t turned on for your account yet — ask your manager.' };
  }
  if (!locationId || !description || !assignedToRole) {
    return { ok: false, error: 'Location, description, and who to notify are all required.' };
  }

  const { rows } = await client.query(
    `INSERT INTO service_calls (location_id, equipment_type_id, equipment_other, description, created_by, assigned_to_role)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [locationId, equipmentTypeId || null, equipmentOther || null, description, person.id, assignedToRole]
  );

  const call = await getCall(client, rows[0].id);
  await notifyNewCall(client, call).catch((err) => console.error('notifyNewCall error', err));
  return { ok: true, call };
}

async function closeCall(client, { id, closedBy, remedy }) {
  if (!remedy) return { ok: false, error: 'Describe what fixed it before closing.' };
  const { rows: existingRows } = await client.query('SELECT * FROM service_calls WHERE id = $1', [id]);
  const existing = existingRows[0];
  if (!existing) return { ok: false, error: 'Not found.' };
  if (existing.status === 'closed') return { ok: false, error: 'Already closed.' };

  await client.query(
    `UPDATE service_calls SET status = 'closed', closed_by = $1, closed_at = now(), remedy = $2 WHERE id = $3`,
    [closedBy, remedy, id]
  );
  const call = await getCall(client, id);
  await notifyCallClosed(client, call).catch((err) => console.error('notifyCallClosed error', err));
  return { ok: true, call };
}

// ---------------------------------------------------------------------
// Notifications — same recipient logic as the prototype (active people
// whose role matches assigned_to_role), narrowed to people who actually
// have Service Calls access, and to managers at the call's own location
// specifically (maintenance floats across all 3 bars, so they're notified
// regardless of location).
//
// Deliberately runs on the service (RLS-bypass) connection, not the
// caller's authed one: figuring out who to notify is a system operation,
// not something scoped to what the *caller* can see. A staff member's own
// `people` visibility is just their own row (see people_select_self), so
// running this on their authed connection silently returned zero
// recipients — maintenance/managers were never notified when the person
// filing the call was staff, which is the normal case.
// ---------------------------------------------------------------------
async function recipientsFor(call) {
  const roles = call.assigned_to_role === 'both' ? ['maintenance', 'manager'] : [call.assigned_to_role];
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query(
      `SELECT p.* FROM people p
       JOIN employee_apps ea ON ea.person_id = p.id AND ea.app_key = 'service_calls' AND ea.enabled = true
       WHERE p.status = 'active' AND p.role = ANY($1)
         AND (p.role = 'maintenance' OR p.location_id = $2)`,
      [roles, call.location_id]
    );
    return rows;
  });
}

async function notifyNewCall(client, call) {
  const recipients = await recipientsFor(call);
  const equipmentLabel = call.equipment_name || call.equipment_other || 'Unspecified equipment';
  const subject = `New service call: ${equipmentLabel} @ ${call.location_name}`;
  const text = `${call.created_by_name} opened a service call at ${call.location_name}.\n\nEquipment: ${equipmentLabel}\nDescription: ${call.description}\nOpened: ${call.created_at}\n\nOpen the app to view and close this call.`;
  const smsBody = `Service call: ${equipmentLabel} @ ${call.location_name} (by ${call.created_by_name}). ${call.description}`.slice(0, 300);

  for (const person of recipients) {
    if (person.email) await notify.sendEmail(client, 'service_calls', call.id, person.email, subject, text);
    if (person.phone) await notify.sendSms(client, 'service_calls', call.id, person.phone, smsBody);
  }
}

async function notifyCallClosed(client, call) {
  // Let the original requester know their call was closed. Looked up via
  // the service connection for the same reason as recipientsFor above —
  // the closer (who might just be a same-location staff member) often
  // can't see the original reporter's `people` row under RLS.
  const person = await withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT * FROM people WHERE id = $1', [call.created_by]);
    return rows[0];
  });
  if (!person || !person.email) return;
  const equipmentLabel = call.equipment_name || call.equipment_other || 'Unspecified equipment';
  const subject = `Service call closed: ${equipmentLabel} @ ${call.location_name}`;
  const text = `${call.closed_by_name} closed the service call you opened at ${call.location_name}.\n\nEquipment: ${equipmentLabel}\nRemedy: ${call.remedy}\nClosed: ${call.closed_at}`;
  await notify.sendEmail(client, 'service_calls', call.id, person.email, subject, text);
}

function toCsv(rows) {
  const headers = ['id', 'location_name', 'equipment_name', 'equipment_other', 'description', 'created_by_name', 'created_at', 'status', 'closed_by_name', 'closed_at', 'minutes_open', 'remedy'];
  const esc = (v) => {
    const val = v instanceof Date ? v.toISOString() : (v == null ? '' : v);
    return `"${String(val).replace(/"/g, '""')}"`;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  return lines.join('\n');
}

module.exports = { listCalls, getCall, createCall, closeCall, requireServiceCallsAccess, toCsv };
