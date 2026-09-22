// TV Staff passes (Scotto, 2026-09-22). The on-site box has no PIN any
// more: the cloud hands whoever opens TV Staff a short signed note —
// who they are, which bar, when it runs out — and the box checks the
// signature itself, so a pass keeps working through an internet outage
// until it expires. The signing key is the site's agent token hash,
// which both sides already hold (the box has the token, the cloud has
// its SHA-256), so nothing new has to be distributed.
//
// Pass length is one owner setting for every bar (owner_notes
// 'tv_pass_length'): 1/2/4/8/12 hours, or 'eod' = the next 3:30am bar
// time, the latest any night ends. The same length is the timer on a
// timed TVs grant in Employees.
const crypto = require('crypto');
const { withServiceClient } = require('./db');

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
const PASS_LENGTHS = ['1', '2', '4', '8', '12', 'eod'];
const DEFAULT_PASS_LENGTH = '4';
const EOD_HOUR = 3, EOD_MINUTE = 30;

function barParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  });
  const parts = {};
  dtf.formatToParts(date).forEach((p) => { if (p.type !== 'literal') parts[p.type] = p.value; });
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}

// The next 3:30am in bar time, walked in 5-minute steps so DST needs no
// special case (same approach as monitoring.js's nextSixAm).
function nextEndOfDay(from = new Date()) {
  const step = 5 * 60 * 1000;
  let t = new Date(Math.ceil((from.getTime() + 1) / step) * step);
  for (let i = 0; i < 24 * 12 + 12; i++) {
    const q = barParts(t);
    if (q.hour === EOD_HOUR && q.minute === EOD_MINUTE) return t;
    t = new Date(t.getTime() + step);
  }
  return new Date(from.getTime() + 24 * 3600e3);
}

async function getPassLength(client) {
  const run = async (c) => {
    const { rows } = await c.query("SELECT body FROM owner_notes WHERE note_key = 'tv_pass_length'");
    const v = rows.length ? String(rows[0].body || '').trim() : '';
    return PASS_LENGTHS.includes(v) ? v : DEFAULT_PASS_LENGTH;
  };
  return client ? run(client) : withServiceClient(run);
}

async function setPassLength(value, updatedBy) {
  const v = String(value || '').trim();
  if (!PASS_LENGTHS.includes(v)) return { ok: false, error: 'Pick 1, 2, 4, 8 or 12 hours, or end of day (3:30am).' };
  await withServiceClient((client) => client.query(
    `INSERT INTO owner_notes (note_key, body, updated_by, updated_at) VALUES ('tv_pass_length', $1, $2, now())
     ON CONFLICT (note_key) DO UPDATE SET body = $1, updated_by = $2, updated_at = now()`,
    [v, updatedBy]
  ));
  return { ok: true, passLength: v };
}

function expiryFor(length, from = new Date()) {
  if (length === 'eod') return nextEndOfDay(from);
  const hours = Number(length) || Number(DEFAULT_PASS_LENGTH);
  return new Date(from.getTime() + hours * 3600e3);
}

function describeLength(length) {
  if (length === 'eod') return 'until end of day (3:30am)';
  const h = Number(length);
  return h === 1 ? '1 hour' : `${h} hours`;
}

// pass = base64url(JSON) + '.' + hex HMAC-SHA256 over that base64url text,
// keyed with the site's agent token hash. The box (agent/server.js
// requireStaffPass) recomputes the same thing from sha256(AGENT_TOKEN).
function mintPass({ agentTokenHash, siteId, locationId, person, actor, expiresAt }) {
  const payload = Buffer.from(JSON.stringify({
    v: 1, siteId: Number(siteId), locationId, personId: person.id, name: person.name, actor,
    exp: expiresAt.getTime(),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', agentTokenHash).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

module.exports = { PASS_LENGTHS, DEFAULT_PASS_LENGTH, getPassLength, setPassLength, expiryFor, describeLength, mintPass, nextEndOfDay };
