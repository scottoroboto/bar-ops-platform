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

// ---------------------------------------------------------------------
// Send-to destinations — attached to each call as destination_names, e.g.
// ["Maintenance", "Kitchen Manager"]. Replaces the old single
// assigned_to_role value; a call can now go to more than one destination
// at once (that's what replaces "both"). service_call_destinations/
// service_call_recipients carry no RLS (same open-reference-data posture
// as equipment_types/locations/positions — see patch_012), so this just
// queries on whatever client it's given, same as the equipment_name join
// in CALL_SELECT above.
// ---------------------------------------------------------------------
async function destinationNamesForCalls(client, callIds) {
  const ids = [...new Set(callIds.filter(Boolean))];
  if (!ids.length) return {};
  const { rows } = await client.query(
    `SELECT r.call_id, d.name FROM service_call_recipients r
     JOIN service_call_destinations d ON d.id = r.destination_id
     WHERE r.call_id = ANY($1)
     ORDER BY d.name`,
    [ids]
  );
  const map = {};
  for (const row of rows) (map[row.call_id] ||= []).push(row.name);
  return map;
}

// ---------------------------------------------------------------------
// Call notes — append-only ("all logged"): every note is timestamped and
// attributed, nothing is ever edited or removed. Author names go through
// resolveNames() for the same reason created_by_name/closed_by_name do —
// the note's author might not be someone the viewer's own RLS-scoped
// connection can see a `people` row for (e.g. a maintenance note left on
// a staff member's call).
// ---------------------------------------------------------------------
async function listNotesForCall(client, callId) {
  const { rows } = await client.query(
    `SELECT * FROM service_call_notes WHERE call_id = $1 ORDER BY created_at ASC`,
    [callId]
  );
  const names = await resolveNames(rows.map((r) => r.author_id));
  return rows.map((r) => ({ ...r, author_name: names[r.author_id] || null }));
}

async function noteCountsForCalls(client, callIds) {
  const ids = [...new Set(callIds.filter(Boolean))];
  if (!ids.length) return {};
  const { rows } = await client.query(
    `SELECT call_id, COUNT(*)::int AS n FROM service_call_notes WHERE call_id = ANY($1) GROUP BY call_id`,
    [ids]
  );
  return Object.fromEntries(rows.map((r) => [r.call_id, r.n]));
}

async function addNote(client, { callId, personId, note }) {
  const trimmed = (note || '').trim();
  if (!trimmed) return { ok: false, error: 'Write a note before saving.' };
  const { rows: existingRows } = await client.query('SELECT id FROM service_calls WHERE id = $1', [callId]);
  if (!existingRows[0]) return { ok: false, error: 'Not found.' };
  await client.query(
    `INSERT INTO service_call_notes (call_id, author_id, note) VALUES ($1,$2,$3)`,
    [callId, personId, trimmed]
  );
  return { ok: true, notes: await listNotesForCall(client, callId) };
}

async function getCall(client, id) {
  const { rows } = await client.query(`${CALL_SELECT} WHERE sc.id = $1`, [id]);
  if (!rows[0]) return null;
  const [named] = await withNames(rows);
  const destMap = await destinationNamesForCalls(client, [id]);
  const notes = await listNotesForCall(client, id);
  return { ...withMinutesOpen(named), destination_names: destMap[id] || [], notes };
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
  const ids = named.map((r) => r.id);
  const [destMap, noteCounts] = await Promise.all([
    destinationNamesForCalls(client, ids),
    noteCountsForCalls(client, ids),
  ]);
  const withDest = named.map((r) => ({ ...r, destination_names: destMap[r.id] || [], notes_count: noteCounts[r.id] || 0 }));

  // Open calls first (oldest first — a running reminder to close them),
  // then closed calls, most recently closed first.
  withDest.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    if (a.status === 'open') return new Date(a.created_at) - new Date(b.created_at);
    return new Date(b.closed_at) - new Date(a.closed_at);
  });

  return withDest.map(withMinutesOpen);
}

function withMinutesOpen(row) {
  const end = row.closed_at ? new Date(row.closed_at) : new Date();
  const minutesOpen = Math.max(0, Math.round((end - new Date(row.created_at)) / 60000));
  return { ...row, minutes_open: minutesOpen };
}

async function createCall(client, person, { locationId, equipmentTypeId, equipmentOther, description, destinationIds }) {
  const hasAccess = await requireServiceCallsAccess(client, person.id);
  if (!hasAccess && person.role !== 'owner') {
    return { ok: false, error: 'Service Calls isn’t turned on for your account yet — ask your manager.' };
  }
  const ids = [...new Set((Array.isArray(destinationIds) ? destinationIds : []).filter(Boolean))];
  if (!locationId || !description || !ids.length) {
    return { ok: false, error: 'Location, description, and who to notify are all required.' };
  }

  const { rows } = await client.query(
    `INSERT INTO service_calls (location_id, equipment_type_id, equipment_other, description, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [locationId, equipmentTypeId || null, equipmentOther || null, description, person.id]
  );
  const callId = rows[0].id;
  const values = ids.map((_, i) => `($1, $${i + 2})`).join(',');
  await client.query(`INSERT INTO service_call_recipients (call_id, destination_id) VALUES ${values}`, [callId, ...ids]);

  const call = await getCall(client, callId);
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
// Notifications — recipients are whoever is a member of one of the call's
// chosen destinations (service_call_destination_members), rather than
// "everyone whose platform role matches". Deliberately does NOT also
// require the recipient to have Service Calls access turned on for
// themselves — being added to a destination is the owner/manager
// explicitly saying "notify this person", independent of whether they use
// the app themselves (same reasoning as Systems Monitoring's alert
// routing).
//
// Runs on the service (RLS-bypass) connection, not the caller's authed
// one: figuring out who to notify is a system operation, not something
// scoped to what the *caller* can see.
// ---------------------------------------------------------------------
async function recipientsFor(call) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query(
      `SELECT DISTINCT p.* FROM people p
       JOIN service_call_destination_members m ON m.person_id = p.id
       JOIN service_call_recipients r ON r.destination_id = m.destination_id
       WHERE r.call_id = $1 AND p.status = 'active'`,
      [call.id]
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

// ---------------------------------------------------------------------
// Send-to destinations admin (manager/owner) — a destination's member set
// is replaced wholesale rather than added/removed one at a time, matching
// how the Manage tab presents it: a checkbox grid of everyone, saved all
// at once.
// ---------------------------------------------------------------------
async function listDestinationsWithMembers() {
  return withServiceClient(async (client) => {
    const { rows: destinations } = await client.query('SELECT * FROM service_call_destinations ORDER BY active DESC, name');
    const { rows: members } = await client.query(
      `SELECT m.destination_id, p.id AS person_id, p.name FROM service_call_destination_members m
       JOIN people p ON p.id = m.person_id ORDER BY p.name`
    );
    return destinations.map((d) => ({
      ...d,
      members: members.filter((m) => m.destination_id === d.id).map((m) => ({ id: m.person_id, name: m.name })),
    }));
  });
}

async function setDestinationMembers({ destinationId, personIds }) {
  return withServiceClient(async (client) => {
    await client.query('DELETE FROM service_call_destination_members WHERE destination_id = $1', [destinationId]);
    const ids = [...new Set((personIds || []).filter(Boolean))];
    if (ids.length) {
      const values = ids.map((_, i) => `($1, $${i + 2})`).join(',');
      await client.query(`INSERT INTO service_call_destination_members (destination_id, person_id) VALUES ${values}`, [destinationId, ...ids]);
    }
    const { rows } = await client.query(
      `SELECT p.id, p.name FROM service_call_destination_members m JOIN people p ON p.id = m.person_id WHERE m.destination_id = $1 ORDER BY p.name`,
      [destinationId]
    );
    return { ok: true, members: rows };
  });
}

function toCsv(rows) {
  const headers = ['id', 'location_name', 'equipment_name', 'equipment_other', 'description', 'created_by_name', 'created_at', 'status', 'sent_to', 'closed_by_name', 'closed_at', 'minutes_open', 'remedy'];
  const esc = (v) => {
    const val = v instanceof Date ? v.toISOString() : (v == null ? '' : v);
    return `"${String(val).replace(/"/g, '""')}"`;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    const row = { ...r, sent_to: (r.destination_names || []).join('; ') };
    lines.push(headers.map((h) => esc(row[h])).join(','));
  }
  return lines.join('\n');
}

module.exports = {
  listCalls, getCall, createCall, closeCall, requireServiceCallsAccess, toCsv,
  addNote, listDestinationsWithMembers, setDestinationMembers,
};
