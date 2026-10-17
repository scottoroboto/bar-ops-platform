// Certification expiry: the countdown notices and the manager rule.
//
// Scotto, 2026-10-17: "Start giving the employee and their manager a
// notification 30 days out then 20, 10, 5, 4, 3, 2, 1. They lose
// assistant manager or manager status once it expires."
//
// runDue() is called every minute from server/index.js. Once a day, from
// 9am bar time, it walks every certification with an expiration date and
// sends the notice for the step the cert is now inside of. A step is
// sent once per cert (cert_expiry_notices UNIQUE), so restarts and
// repeat calls are harmless, and a cert entered with 12 days left just
// starts at the 10-day step's notice ("expires in 12 days") and
// continues from there.
//
// On the expiry day (step 0) a person whose role is manager drops to
// staff; the role they had is kept on people.role_before_cert_lapse and
// put back by maybeRestoreRole() when a current certificate of the same
// name is added (or by the owner setting their role by hand).
const { withServiceClient } = require('./db');
const notify = require('./notify');

const STEPS = [30, 20, 10, 5, 4, 3, 2, 1];
const SEND_FROM_HOUR = 9;
const TZ = 'America/Chicago';

function partsIn(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  const p = {};
  dtf.formatToParts(date).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function isoDay(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);
}

function fmtUs(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
}

// Which step a cert with `daysLeft` is inside of: the smallest step that
// is still >= daysLeft, or 0 once it has expired. null = more than 30
// days out, nothing to say yet.
function stepFor(daysLeft) {
  if (daysLeft <= 0) return 0;
  if (daysLeft > STEPS[0]) return null;
  let step = null;
  for (const s of STEPS) if (s >= daysLeft) step = s;
  return step;
}

function appBaseUrl() {
  return (process.env.APP_BASE_URL || 'https://app.ticketsportsbar.com').replace(/\/$/, '');
}

// Who hears about a person's cert besides them: the managers at their
// bar(s). A manager's own cert (or a person with no manager) goes to the
// owner(s) instead, so somebody always does.
async function managersFor(client, person) {
  const { rows } = await client.query(
    `SELECT DISTINCT p.id, p.name, p.phone, p.email
       FROM people p
      WHERE p.status = 'active' AND p.role = 'manager' AND p.id <> $1
        AND (p.location_id = ANY($2::uuid[])
             OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.person_id = p.id AND el.location_id = ANY($2::uuid[])))`,
    [person.id, person.location_ids]);
  if (rows.length && person.role !== 'manager') return rows;
  const { rows: owners } = await client.query(`SELECT id, name, phone, email FROM people WHERE status = 'active' AND role = 'owner' AND id <> $1`, [person.id]);
  return rows.concat(owners);
}

async function sendTo(client, certId, who, text, subject) {
  const sent = [];
  if (who.phone) {
    const r = await notify.sendSms(client, 'employee_certifications', certId, who.phone, text).catch((e) => ({ ok: false, error: e.message }));
    sent.push({ id: who.id, via: 'sms', ok: !!r.ok });
  }
  if (who.email) {
    const r = await notify.sendEmail(client, 'employee_certifications', certId, who.email, subject, text).catch((e) => ({ ok: false, error: e.message }));
    sent.push({ id: who.id, via: 'email', ok: !!r.ok });
  }
  return sent;
}

function messages({ person, cert, daysLeft, step, demoted }) {
  const expires = fmtUs(cert.expires_on);
  const link = `${appBaseUrl()}/employees.html`;
  const mgrNote = person.role === 'manager' || demoted ? ' Manager status is removed the day it expires.' : '';
  if (step === 0) {
    const lost = demoted ? ' Their manager access in Bar Ops is off until a current certificate is on file.' : '';
    return {
      subject: `${person.name}'s ${cert.name} has expired`,
      toPerson: `Your ${cert.name} expired ${expires}.${demoted ? ' Your manager access in Bar Ops is off until a current certificate is on file.' : ''} Get it renewed and give the new card or certificate to your manager.`,
      toManager: `${person.name}'s ${cert.name} expired ${expires}.${lost} Add the renewed certificate on their card: ${link}`,
    };
  }
  const when = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  return {
    subject: `${person.name}'s ${cert.name} expires ${when}`,
    toPerson: `Heads up: your ${cert.name} expires ${when} (${expires}).${mgrNote} Please renew it and give the new card or certificate to your manager.`,
    toManager: `${person.name}'s ${cert.name} expires ${when} (${expires}).${mgrNote} Once renewed, add it on their card: ${link}`,
  };
}

// Drop a manager to staff when a cert lapses. Owners are never touched.
async function demoteForLapse(client, person, cert) {
  if (person.role !== 'manager') return false;
  await client.query(
    `UPDATE people SET role = 'staff', role_before_cert_lapse = role, role_lapsed_cert_id = $2, role_lapsed_at = now(), updated_at = now()
      WHERE id = $1 AND role = 'manager'`, [person.id, cert.id]);
  console.log(`[certs] ${person.name}: ${cert.name} expired — manager role removed`);
  return true;
}

// Called from employees.addCertification after the INSERT. If this person
// lost their role to a lapsed cert and the new one covers it (same name,
// not expired), put the role back and tell them and the owner.
async function maybeRestoreRole(client, personId, newCert) {
  const { rows } = await client.query(
    `SELECT p.id, p.name, p.phone, p.email, p.role, p.role_before_cert_lapse, p.role_lapsed_cert_id, c.name AS lapsed_name
       FROM people p LEFT JOIN employee_certifications c ON c.id = p.role_lapsed_cert_id
      WHERE p.id = $1 AND p.role_before_cert_lapse IS NOT NULL`, [personId]);
  const p = rows[0];
  if (!p) return false;
  const today = partsIn(new Date(), TZ).ymd;
  const exp = isoDay(newCert.expires_on);
  if (!exp || daysBetween(today, exp) <= 0) return false;
  const sameName = !p.lapsed_name || p.lapsed_name.trim().toLowerCase() === String(newCert.name).trim().toLowerCase();
  if (!sameName) return false;
  await client.query(
    `UPDATE people SET role = role_before_cert_lapse, role_before_cert_lapse = NULL, role_lapsed_cert_id = NULL, role_lapsed_at = NULL, updated_at = now() WHERE id = $1`,
    [personId]);
  console.log(`[certs] ${p.name}: ${newCert.name} renewed — ${p.role_before_cert_lapse} role restored`);
  const text = `${p.name}'s ${newCert.name} is current again (expires ${fmtUs(exp)}). Their ${p.role_before_cert_lapse} access in Bar Ops is back on.`;
  const mine = `Your ${newCert.name} is on file (expires ${fmtUs(exp)}). Your ${p.role_before_cert_lapse} access in Bar Ops is back on.`;
  await sendTo(client, newCert.id, p, mine, `${newCert.name} renewed`).catch(() => {});
  const { rows: owners } = await client.query(`SELECT id, name, phone, email FROM people WHERE status = 'active' AND role = 'owner' AND id <> $1`, [personId]);
  for (const o of owners) await sendTo(client, newCert.id, o, text, `${p.name}: ${newCert.name} renewed`).catch(() => {});
  return true;
}

// The daily pass. Returns how many notices went out.
async function runDue(now = new Date()) {
  const local = partsIn(now, TZ);
  if (local.hour < SEND_FROM_HOUR) return 0;
  const today = local.ymd;
  return withServiceClient(async (client) => {
    // Every dated cert of an active person, skipping (a) certs that were
    // already expired when they were entered (a history line, not a live
    // credential) and (b) certs the person has already renewed under the
    // same name with a later date — the old row is just not deleted yet.
    const { rows: certs } = await client.query(
      `SELECT c.id, c.name, c.expires_on::text AS expires_on, c.created_at::date::text AS entered_on,
              p.id AS person_id, p.name AS person_name, p.phone, p.email, p.role, p.location_id,
              ARRAY(SELECT el.location_id FROM employee_locations el WHERE el.person_id = p.id) AS extra_locations
         FROM employee_certifications c JOIN people p ON p.id = c.person_id
        WHERE c.expires_on IS NOT NULL AND p.status = 'active' AND p.role <> 'owner'
          AND c.expires_on >= c.created_at::date
          AND NOT EXISTS (SELECT 1 FROM employee_certifications c2
                           WHERE c2.person_id = c.person_id AND c2.id <> c.id
                             AND lower(trim(c2.name)) = lower(trim(c.name)) AND c2.expires_on > c.expires_on)`);
    let sent = 0;
    for (const c of certs) {
      const daysLeft = daysBetween(today, c.expires_on);
      const step = stepFor(daysLeft);
      if (step === null) continue;
      // Already sent this step (or a later one — a cert entered with 2
      // days left shouldn't get the 30/20/10 notices after the fact).
      const { rows: done } = await client.query('SELECT days_out FROM cert_expiry_notices WHERE certification_id = $1', [c.id]);
      if (done.some((d) => d.days_out <= step)) continue;
      const person = { id: c.person_id, name: c.person_name, phone: c.phone, email: c.email, role: c.role,
        location_ids: [c.location_id, ...(c.extra_locations || [])].filter(Boolean) };
      const cert = { id: c.id, name: c.name, expires_on: c.expires_on };
      const demoted = step === 0 ? await demoteForLapse(client, person, cert) : false;
      const msg = messages({ person, cert, daysLeft, step, demoted });
      const recipients = [];
      recipients.push(...await sendTo(client, c.id, person, msg.toPerson, msg.subject));
      for (const m of await managersFor(client, person)) recipients.push(...await sendTo(client, c.id, m, msg.toManager, msg.subject));
      await client.query(
        `INSERT INTO cert_expiry_notices (certification_id, person_id, days_out, days_left, recipients) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (certification_id, days_out) DO NOTHING`,
        [c.id, c.person_id, step, daysLeft, JSON.stringify({ sent: recipients, demoted })]);
      sent++;
    }
    return sent;
  });
}

module.exports = { runDue, maybeRestoreRole, STEPS, _test: { stepFor, daysBetween, messages, partsIn } };
