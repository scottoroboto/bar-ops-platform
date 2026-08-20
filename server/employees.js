const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { withServiceClient } = require('./db');
const notify = require('./notify');

const APP_KEYS = ['time_clock', 'service_calls', 'scheduling'];

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

async function listAllWithAccess() {
  return withServiceClient(async (client) => {
    const { rows: people } = await client.query(
      `SELECT id, name, role, location_id, username, email, phone, status, position, pay_rate, activated_at
       FROM people WHERE status != 'pending_review' ORDER BY name`
    );
    const { rows: access } = await client.query('SELECT * FROM employee_apps');
    const byPerson = {};
    access.forEach(a => { (byPerson[a.person_id] ||= {})[a.app_key] = a.enabled; });
    return people.map(p => ({ ...p, appAccess: byPerson[p.id] || {} }));
  });
}

module.exports = { createPendingEmployee, updateOwnProfile, listPending, managerReview, activateEmployee, setAppAccess, listAllWithAccess, APP_KEYS };
