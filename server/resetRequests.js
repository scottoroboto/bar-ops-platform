// Self-service password/PIN reset — owner-mediated fallback (see
// db/patch_009_credential_reset_requests.sql for the "why" in full).
// There's no code-delivery step here at all: an employee files a request
// while logged out, the owner sees it in Employees admin and either
// denies it or approves it, and approving mints a brand-new temp
// password/PIN that the owner hands the person directly — the exact
// same trusted-channel pattern already used by activateEmployee and
// bootstrap-owner.js. Nothing here depends on email/SMS actually
// reaching anyone.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { withServiceClient } = require('./db');
const notify = require('./notify');

const REQUEST_TYPES = ['password', 'pin', 'both'];

function randomPassword() {
  return crypto.randomBytes(6).toString('base64url'); // short, human-typeable temp password
}
function randomPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

// Public, unauthenticated — this is the whole point (a person who's locked
// out can't log in to prove who they are). Deliberately returns the same
// generic message whether or not the username exists, so this endpoint
// can't be used to probe which usernames are real. Only touches an
// existing pending request (never creates a second one) if the person
// already has one outstanding.
async function requestReset({ username, requestType, note }) {
  const type = REQUEST_TYPES.includes(requestType) ? requestType : 'both';
  const trimmedNote = (note || '').trim().slice(0, 500) || null;
  const generic = { ok: true, message: "If that username has an account, we've sent your request to the owner." };

  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, name, email FROM people WHERE username = $1 AND status = 'active'`,
      [(username || '').trim()]
    );
    const person = rows[0];
    if (!person) return generic;

    const { rows: existing } = await client.query(
      `SELECT id FROM credential_reset_requests WHERE person_id = $1 AND status = 'pending'`,
      [person.id]
    );
    if (existing.length) return generic; // already filed — don't spam a second row

    const { rows: reqRows } = await client.query(
      `INSERT INTO credential_reset_requests (person_id, request_type, note) VALUES ($1,$2,$3) RETURNING id`,
      [person.id, type, trimmedNote]
    );

    const { rows: ownerRows } = await client.query(`SELECT email FROM people WHERE role = 'owner' AND email IS NOT NULL`);
    const label = type === 'both' ? 'password and PIN' : type;
    const text = `${person.name} says they forgot their ${label}${trimmedNote ? ` ("${trimmedNote}")` : ''}.\n\nReview it in Employees → Reset requests.`;
    for (const o of ownerRows) {
      await notify.sendEmail(client, 'credential_reset_requests', reqRows[0].id, o.email, `Reset request from ${person.name}`, text);
    }
    return generic;
  });
}

// Owner-only. locationFilter is intentionally unsupported here (unlike
// pay-rate requests) — handing out login credentials is owner-only,
// full stop, same as activateEmployee.
async function listResetRequests({ status = 'pending' } = {}) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT r.id, r.person_id, r.request_type, r.note, r.status, r.requested_at, r.decided_at, r.decision_note,
              p.name AS person_name, p.username, p.role, p.location_id
       FROM credential_reset_requests r
       JOIN people p ON p.id = r.person_id
       WHERE r.status = $1
       ORDER BY r.requested_at ASC`,
      [status]
    );
    return rows;
  });
}

// Owner-only. Approving mints whatever credential(s) were asked for and
// sets password_verified_at = now() in the same breath — the owner
// handing this over in person/by phone *is* the identity check, the same
// substitution bootstrap-owner.js already makes for local dev. Without
// this, a fresh password_hash would trip the "first login ever" one-time
// code gate in loginWithPassword, and since email/SMS aren't configured
// in production that code would never actually arrive — stranding the
// person right back where they started.
//
// Also invalidates every existing session for this person: if the reset
// was requested because a phone was lost or a shared device went missing,
// the whole point is that whatever was signed in before shouldn't still
// be trusted after new credentials are issued.
async function decideReset({ requestId, approve, decidedBy, note }) {
  return withServiceClient(async (client) => {
    const { rows: reqRows } = await client.query(
      `SELECT * FROM credential_reset_requests WHERE id = $1 AND status = 'pending'`,
      [requestId]
    );
    const request = reqRows[0];
    if (!request) return { ok: false, error: 'Not found, or already decided.' };

    if (!approve) {
      await client.query(
        `UPDATE credential_reset_requests SET status = 'denied', decided_by = $1, decided_at = now(), decision_note = $2 WHERE id = $3`,
        [decidedBy, note || null, requestId]
      );
      return { ok: true };
    }

    const { rows: personRows } = await client.query('SELECT * FROM people WHERE id = $1', [request.person_id]);
    const person = personRows[0];
    if (!person) return { ok: false, error: 'Employee no longer exists.' };

    let tempPassword = null;
    let pin = null;
    if (request.request_type === 'password' || request.request_type === 'both') {
      tempPassword = randomPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      await client.query(
        'UPDATE people SET password_hash = $1, password_verified_at = now(), updated_at = now() WHERE id = $2',
        [passwordHash, person.id]
      );
    }
    if (request.request_type === 'pin' || request.request_type === 'both') {
      pin = randomPin();
      const pinHash = await bcrypt.hash(pin, 10);
      await client.query('UPDATE people SET pin_hash = $1, updated_at = now() WHERE id = $2', [pinHash, person.id]);
    }

    await client.query('DELETE FROM auth_sessions WHERE person_id = $1', [person.id]);

    await client.query(
      `UPDATE credential_reset_requests SET status = 'approved', decided_by = $1, decided_at = now(), decision_note = $2 WHERE id = $3`,
      [decidedBy, note || null, requestId]
    );

    return { ok: true, person: { id: person.id, name: person.name, username: person.username }, tempPassword, pin };
  });
}

module.exports = { requestReset, listResetRequests, decideReset, REQUEST_TYPES };
