const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { withServiceClient } = require('./db');
const notify = require('./notify');

// NOTE: 'monitoring' was added to employee_apps' app_key CHECK constraint
// back in patch_010 but never added here — meaning no one could ever be
// granted Monitoring access through activateEmployee/setAppAccess (the
// Employees admin UI had no toggle for it either). Owner/manager never
// noticed because both roles bypass the employee_apps gate entirely for
// viewing the Monitoring dashboard (see requireMonitoringAccess callers
// in server/index.js) — but it also meant server/monitoring.js's
// recipientsFor() found nobody to notify, ever, since that query required
// an enabled row here. Fixed alongside the alert-routing work (2026-09-01).
const APP_KEYS = ['time_clock', 'service_calls', 'scheduling', 'monitoring'];

function slugUsername(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}
function randomPassword() {
  return crypto.randomBytes(6).toString('base64url'); // short, human-typeable temp password
}
function randomPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

// ---------------------------------------------------------------------
// Creates a pending_review record — this is what a Jotform submission
// (or, for now, the manual "add pending employee" form) produces. Only
// non-sensitive fields ever land here; nothing encrypted in Jotform is
// copied over, only a reference to the submission.
// ---------------------------------------------------------------------
// position here is the applicant's own pick from /apply.html's "Position
// Applied for" dropdown — same treatment as requestedLocationId: it's just
// a starting point. The manager still reviews (and can change) it during
// manager-review below, same as they always could.
async function createPendingEmployee({ name, email, phone, position, requestedLocationId, jotformSubmissionId }) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO people (name, email, phone, position, location_id, role, status, jotform_submission_id)
       VALUES ($1,$2,$3,$4,$5,'staff','pending_review',$6) RETURNING *`,
      [name, email || null, phone || null, position || null, requestedLocationId || null, jotformSubmissionId || null]
    );
    return rows[0];
  });
}

// Self-service — a person updating their own name/email/phone, any time,
// active or still pending. Deliberately narrow: only these three columns,
// and only ever scoped to the caller's own id (enforced by the route
// handler passing req.person.id, never a client-supplied id). Anything
// sensitive (tax/banking/SSN) never lives here — that stays in Jotform;
// the app just points people at the hire-pack form to update it.
async function updateOwnProfile({ personId, name, email, phone }) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `UPDATE people SET name = $1, email = $2, phone = $3, updated_at = now()
       WHERE id = $4 RETURNING id, name, email, phone, role, location_id, status`,
      [name, email || null, phone || null, personId]
    );
    return rows[0] || null;
  });
}

async function listPending() {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, name, email, phone, location_id, position, pay_rate, created_at
       FROM people WHERE status = 'pending_review' ORDER BY created_at ASC`
    );
    return rows;
  });
}

// A manager (not the owner) sets the fields only they should — role stays
// pending_review; this does NOT activate the employee.
async function managerReview({ personId, position, locationId, payRate, reviewedBy }) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `UPDATE people SET position = $1, location_id = $2, pay_rate = $3, updated_at = now()
       WHERE id = $4 AND status = 'pending_review' RETURNING *`,
      [position || null, locationId || null, payRate || null, personId]
    );
    if (!rows[0]) return { ok: false, error: 'Not found, or already activated.' };
    return { ok: true, person: rows[0] };
  });
}

// ---------------------------------------------------------------------
// THE GATE. Owner-only. This is the only path that turns a pending
// employee into someone who can log into anything at all. Also sets the
// initial per-app access grid, mints their login credentials, and sends
// them their first-login info.
// ---------------------------------------------------------------------
async function activateEmployee({ personId, appAccess, activatedBy }) {
  return withServiceClient(async (client) => {
    const { rows: existingRows } = await client.query('SELECT * FROM people WHERE id = $1', [personId]);
    const person = existingRows[0];
    if (!person) return { ok: false, error: 'Employee not found.' };
    if (person.status === 'active') return { ok: false, error: 'Already active.' };

    let username = person.username;
    let tempPassword = null;
    let pin = null;
    if (!username) {
      const base = slugUsername(person.name);
      username = base;
      let n = 1;
      while (true) {
        const { rows: clash } = await client.query('SELECT 1 FROM people WHERE username = $1', [username]);
        if (clash.length === 0) break;
        n += 1;
        username = `${base}${n}`;
      }
      tempPassword = randomPassword();
      pin = randomPin();
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const pinHash = await bcrypt.hash(pin, 10);
      await client.query(
        'UPDATE people SET username = $1, password_hash = $2, pin_hash = $3 WHERE id = $4',
        [username, passwordHash, pinHash, personId]
      );
    }

    await client.query(
      `UPDATE people SET status = 'active', activated_by = $1, activated_at = now(), updated_at = now() WHERE id = $2`,
      [activatedBy, personId]
    );

    for (const key of APP_KEYS) {
      const enabled = !!(appAccess && appAccess[key]);
      await client.query(
        `INSERT INTO employee_apps (person_id, app_key, enabled, updated_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (person_id, app_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [personId, key, enabled, activatedBy]
      );
    }

    if (tempPassword && person.email) {
      const enabledApps = APP_KEYS.filter(k => appAccess && appAccess[k]);
      const text = `Welcome! Your account is set up.\n\nUsername: ${username}\nTemporary password: ${tempPassword} (you'll verify with a one-time code the first time you use it)\nYour PIN for everyday clock-in/service-call use: ${pin}\n\nYou now have access to: ${enabledApps.join(', ') || '(nothing yet — ask your manager)'}`;
      await notify.sendEmail(client, 'people', personId, person.email, 'Your account is ready', text);
    }

    const { rows: finalRows } = await client.query('SELECT * FROM people WHERE id = $1', [personId]);
    return { ok: true, person: finalRows[0], username, tempPassword, pin };
  });
}

// Owner can revisit toggles at any point during employment — not just at onboarding.
async function setAppAccess({ personId, appKey, enabled, updatedBy }) {
  if (!APP_KEYS.includes(appKey)) return { ok: false, error: 'Unknown app.' };
  return withServiceClient(async (client) => {
    await client.query(
      `INSERT INTO employee_apps (person_id, app_key, enabled, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (person_id, app_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [personId, appKey, enabled, updatedBy]
    );
    return { ok: true };
  });
}

// locationFilter is set for a manager (their own location only, enforced by
// the route handler passing req.person.location_id, never a client-supplied
// value); left undefined for the owner, who sees every location.
async function listAllWithAccess(locationFilter) {
  return withServiceClient(async (client) => {
    const params = [];
    let where = "status != 'pending_review'";
    if (locationFilter) {
      params.push(locationFilter);
      where += ` AND location_id = $${params.length}`;
    }
    const { rows: people } = await client.query(
      `SELECT id, name, role, location_id, username, email, phone, status, position, pay_rate, activated_at
       FROM people WHERE ${where} ORDER BY name`,
      params
    );
    const { rows: access } = await client.query('SELECT * FROM employee_apps');
    const byPerson = {};
    access.forEach(a => { (byPerson[a.person_id] ||= {})[a.app_key] = a.enabled; });
    return people.map(p => ({ ...p, appAccess: byPerson[p.id] || {} }));
  });
}

// Discard/reject a still-pending applicant. Deliberately scoped to
// status = 'pending_review' only — this can never touch someone who's
// already been activated, so there's no way to accidentally delete a real
// employee's record through this path. Hard-deleted rather than soft
// (status='inactive') because a rejected applicant was never actually an
// employee; 'inactive' is reserved for people who really did work here.
async function discardPending({ personId }) {
  return withServiceClient(async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM people WHERE id = $1 AND status = 'pending_review'`,
      [personId]
    );
    if (!rowCount) return { ok: false, error: 'Not found, or already activated.' };
    return { ok: true };
  });
}

// Emails a prospective hire a link to /apply.html. Not tied to any existing
// people row (they haven't applied yet), so notifications_log gets a
// synthetic relatedId just to satisfy its NOT NULL constraint — this is an
// invite, not an update to a real record.
async function sendOnboardingInvite({ toEmail, toName, sentBy }) {
  if (!toEmail) return { ok: false, error: 'Email is required.' };
  return withServiceClient(async (client) => {
    const link = `${(process.env.APP_BASE_URL || 'https://bar-ops-platform-52n1.onrender.com').replace(/\/$/, '')}/apply.html`;
    const greeting = toName ? `Hi ${toName},` : 'Hi,';
    const text = `${greeting}\n\nYou've been invited to apply to join the team at Ticket Sports Bar. It only takes about a minute:\n\n${link}\n\nSee you soon!`;
    const result = await notify.sendEmail(client, 'onboarding_invite', crypto.randomUUID(), toEmail, 'Join the team at Ticket Sports Bar', text);
    return result;
  });
}

// Owner-only full edit — unlike managerReview (which only works while
// status = 'pending_review'), this works on any employee at any time, since
// only the owner can call it.
async function ownerUpdateEmployee({ personId, position, locationId, payRate }) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `UPDATE people SET position = $1, location_id = $2, pay_rate = $3, updated_at = now()
       WHERE id = $4 RETURNING id, name, role, location_id, position, pay_rate, status`,
      [position || null, locationId || null, payRate ?? null, personId]
    );
    if (!rows[0]) return { ok: false, error: 'Not found.' };
    return { ok: true, person: rows[0] };
  });
}

// A manager can't change pay directly — they submit a request, the owner
// decides. pay_rate_requests has RLS FORCE-enabled with zero policies (same
// situation as devices/locations/positions before them), so every touch of
// this table has to go through the service client.
async function requestPayRaise({ personId, requestedRate, requestedBy }) {
  return withServiceClient(async (client) => {
    const { rows: personRows } = await client.query('SELECT name, pay_rate FROM people WHERE id = $1', [personId]);
    const person = personRows[0];
    if (!person) return { ok: false, error: 'Employee not found.' };
    const { rows } = await client.query(
      `INSERT INTO pay_rate_requests (person_id, current_rate, requested_rate, requested_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [personId, person.pay_rate, requestedRate, requestedBy]
    );
    const { rows: ownerRows } = await client.query(`SELECT email FROM people WHERE role = 'owner' AND email IS NOT NULL`);
    const text = `A manager has requested a pay rate change for ${person.name}: $${person.pay_rate ?? '—'}/hr → $${requestedRate}/hr.\n\nReview it in Employees → Pay rate requests.`;
    for (const o of ownerRows) {
      await notify.sendEmail(client, 'pay_rate_requests', rows[0].id, o.email, `Pay rate request for ${person.name}`, text);
    }
    return { ok: true, request: rows[0] };
  });
}

// locationFilter scopes a manager to requests for people at their own
// location; left undefined for the owner, who sees every request.
async function listPayRateRequests({ status = 'pending', locationFilter } = {}) {
  return withServiceClient(async (client) => {
    const params = [status];
    let where = 'r.status = $1';
    if (locationFilter) {
      params.push(locationFilter);
      where += ` AND p.location_id = $${params.length}`;
    }
    const { rows } = await client.query(
      `SELECT r.id, r.person_id, r.current_rate, r.requested_rate, r.requested_by, r.requested_at, r.status, r.decided_at, r.note,
              p.name AS person_name, p.location_id, req.name AS requested_by_name
       FROM pay_rate_requests r
       JOIN people p ON p.id = r.person_id
       LEFT JOIN people req ON req.id = r.requested_by
       WHERE ${where}
       ORDER BY r.requested_at ASC`,
      params
    );
    return rows;
  });
}

// Owner-only. Approving copies requested_rate onto the person's actual
// pay_rate in the same transaction as the decision, so the two can never
// drift apart.
async function decidePayRateRequest({ requestId, approve, decidedBy, note }) {
  return withServiceClient(async (client) => {
    const { rows: reqRows } = await client.query(`SELECT * FROM pay_rate_requests WHERE id = $1 AND status = 'pending'`, [requestId]);
    const request = reqRows[0];
    if (!request) return { ok: false, error: 'Not found, or already decided.' };
    await client.query(
      `UPDATE pay_rate_requests SET status = $1, decided_by = $2, decided_at = now(), note = $3 WHERE id = $4`,
      [approve ? 'approved' : 'denied', decidedBy, note || null, requestId]
    );
    if (approve) {
      await client.query('UPDATE people SET pay_rate = $1, updated_at = now() WHERE id = $2', [request.requested_rate, request.person_id]);
    }
    const { rows: managerRows } = await client.query('SELECT name, email FROM people WHERE id = $1', [request.requested_by]);
    const { rows: personRows } = await client.query('SELECT name FROM people WHERE id = $1', [request.person_id]);
    const manager = managerRows[0];
    if (manager && manager.email) {
      const text = approve
        ? `Your pay rate request for ${personRows[0]?.name || 'the employee'} was approved: now $${request.requested_rate}/hr.`
        : `Your pay rate request for ${personRows[0]?.name || 'the employee'} was denied.${note ? ` Note: ${note}` : ''}`;
      await notify.sendEmail(client, 'pay_rate_requests', requestId, manager.email, `Pay rate request ${approve ? 'approved' : 'denied'}`, text);
    }
    return { ok: true };
  });
}

module.exports = {
  createPendingEmployee, updateOwnProfile, listPending, managerReview, activateEmployee, setAppAccess,
  listAllWithAccess, discardPending, sendOnboardingInvite, ownerUpdateEmployee,
  requestPayRaise, listPayRateRequests, decidePayRateRequest, APP_KEYS,
};
