const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { withServiceClient, withAuthedClient } = require('./db');
const notify = require('./notify');

const LIGHT_SESSION_DAYS = 14;   // everyday PIN login — operational scope only
const FULL_SESSION_MINUTES = 20; // step-up window — enough to finish one sensitive task
const CODE_TTL_MINUTES = 10;

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function randomCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// ---------------------------------------------------------------------
// STEP 1 (first login ever, or any full-credential login): username + password.
// If this account has never completed its one-time verification, a code is
// sent and a FULL session isn't issued until that code comes back correct.
// Pending-review employees can't log in at all — this is the literal
// enforcement of "nobody goes live until the owner activates them."
// ---------------------------------------------------------------------
async function loginWithPassword({ username, password }) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query('SELECT * FROM people WHERE username = $1', [username]);
    const person = rows[0];
    if (!person || person.status !== 'active' || !person.password_hash) {
      return { ok: false, error: 'Invalid username or password.' };
    }
    const valid = await bcrypt.compare(password, person.password_hash);
    if (!valid) return { ok: false, error: 'Invalid username or password.' };

    if (!person.password_verified_at) {
      // First time this credential has ever been used — require a one-time code.
      const code = randomCode();
      const codeHash = hashToken(code);
      const channel = person.phone ? 'sms' : 'email';
      await client.query(
        `INSERT INTO verification_codes (person_id, code_hash, channel, purpose, expires_at)
         VALUES ($1,$2,$3,'first_login', now() + interval '${CODE_TTL_MINUTES} minutes')`,
        [person.id, codeHash, channel]
      );
      const message = `Your verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`;
      if (channel === 'sms') await notify.sendSms(client, 'people', person.id, person.phone, message);
      else await notify.sendEmail(client, 'people', person.id, person.email, 'Your verification code', message);

      // No session is issued yet — the client holds personId (already proven,
      // since they just supplied the correct password for it) and submits it
      // back alongside the code in verifyFirstLoginCode below.
      return { ok: true, stage: 'verify_code', personId: person.id, channel };
    }

    // Already verified before — a full password login goes straight to a FULL session
    // (used for step-up, or for manager/owner day-to-day use where PIN isn't the model).
    const token = await mintSession(client, person, 'full', null);
    return { ok: true, stage: 'authenticated', token, person: publicPerson(person) };
  });
}

async function verifyFirstLoginCode({ personId, code }) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM verification_codes
       WHERE person_id = $1 AND purpose = 'first_login' AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [personId]
    );
    const row = rows[0];
    if (!row || row.expires_at < new Date()) return { ok: false, error: 'Code expired — log in again to get a new one.' };
    if (row.code_hash !== hashToken(code)) return { ok: false, error: 'Incorrect code.' };

    await client.query('UPDATE verification_codes SET consumed_at = now() WHERE id = $1', [row.id]);
    await client.query('UPDATE people SET password_verified_at = now() WHERE id = $1', [personId]);

    const { rows: personRows } = await client.query('SELECT * FROM people WHERE id = $1', [personId]);
    const person = personRows[0];
    const token = await mintSession(client, person, 'full', null);
    return { ok: true, token, person: publicPerson(person) };
  });
}

// ---------------------------------------------------------------------
// STEP 2: everyday lightweight login — username + short PIN. Deliberately
// scoped to operational endpoints only (see requireSession below); a light
// session can never reach anything sensitive without stepping up first.
// Also used, unchanged, from a shared bar iPad — the device itself was
// trusted once by a manager/owner (see devices table); after that, whoever's
// on shift just identifies themselves here.
// ---------------------------------------------------------------------
async function loginWithPin({ username, pin, deviceToken }) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query('SELECT * FROM people WHERE username = $1', [username]);
    const person = rows[0];
    if (!person || person.status !== 'active' || !person.pin_hash) {
      return { ok: false, error: 'Invalid username or PIN.' };
    }
    // The PIN is deliberately the *lightweight* everyday credential — it
    // must never become a way to skip the one-time 2FA gate. Until this
    // person has completed a full username+password+code login at least
    // once, PIN sign-in is refused outright.
    if (!person.password_verified_at) {
      return { ok: false, error: 'NEEDS_FIRST_LOGIN', message: 'First-time setup required — sign in with your username and password first.' };
    }
    const valid = await bcrypt.compare(pin, person.pin_hash);
    if (!valid) return { ok: false, error: 'Invalid username or PIN.' };

    let deviceId = null;
    if (deviceToken) {
      const { rows: deviceRows } = await client.query('SELECT id FROM devices WHERE device_token = $1', [deviceToken]);
      deviceId = deviceRows[0] ? deviceRows[0].id : null;
    }

    const token = await mintSession(client, person, 'light', deviceId);
    return { ok: true, token, person: publicPerson(person) };
  });
}

// ---------------------------------------------------------------------
// Step-up: from an existing light session, re-enter the full password to
// get a short-lived FULL session for one sensitive action (e.g. an owner
// opening the employee-activation screen).
// ---------------------------------------------------------------------
async function stepUp({ personId, password }) {
  return withServiceClient(async (client) => {
    const { rows } = await client.query('SELECT * FROM people WHERE id = $1', [personId]);
    const person = rows[0];
    if (!person || !person.password_hash) return { ok: false, error: 'No password set for this account.' };
    const valid = await bcrypt.compare(password, person.password_hash);
    if (!valid) return { ok: false, error: 'Incorrect password.' };
    const token = await mintSession(client, person, 'full', null);
    return { ok: true, token, person: publicPerson(person) };
  });
}

async function setPin({ personId, pin }) {
  const pinHash = await bcrypt.hash(pin, 10);
  return withServiceClient(async (client) => {
    await client.query('UPDATE people SET pin_hash = $1 WHERE id = $2', [pinHash, personId]);
    return { ok: true };
  });
}

async function mintSession(client, person, tier, deviceId) {
  const token = randomToken();
  const days = tier === 'light' ? LIGHT_SESSION_DAYS : 0;
  const minutes = tier === 'full' ? FULL_SESSION_MINUTES : 0;
  await client.query(
    `INSERT INTO auth_sessions (person_id, session_tier, token_hash, device_id, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval + ($6 || ' minutes')::interval)`,
    [person.id, tier, hashToken(token), deviceId, days, minutes]
  );
  return token;
}

function publicPerson(person) {
  return { id: person.id, name: person.name, role: person.role, username: person.username, locationId: person.location_id };
}

// ---------------------------------------------------------------------
// Middleware: resolves the bearer token to a person + session tier, and
// (this is the important part) sets the two RLS session variables for
// every DB call this request makes, via withAuthedClient.
// ---------------------------------------------------------------------
function requireSession(minTier) {
  const rank = { light: 1, full: 2 };
  return async (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not signed in.' });

    const tokenHash = hashToken(token);
    const result = await withServiceClient(async (client) => {
      const { rows } = await client.query(
        `SELECT s.*, p.id AS p_id, p.name, p.role, p.location_id, p.status
         FROM auth_sessions s JOIN people p ON p.id = s.person_id
         WHERE s.token_hash = $1`,
        [tokenHash]
      );
      return rows[0];
    });

    if (!result || result.expires_at < new Date()) return res.status(401).json({ error: 'SESSION_EXPIRED' });
    if (result.status !== 'active') return res.status(403).json({ error: 'Account is not active.' });
    if (rank[result.session_tier] < rank[minTier]) {
      return res.status(403).json({ error: 'STEP_UP_REQUIRED', message: 'This needs you to re-enter your password first.' });
    }

    req.person = { id: result.p_id, name: result.name, role: result.role, location_id: result.location_id };
    req.withAuthedClient = (fn) => withAuthedClient(req.person, fn);
    next();
  };
}

module.exports = {
  loginWithPassword, verifyFirstLoginCode, loginWithPin, stepUp, setPin, requireSession, publicPerson,
};
