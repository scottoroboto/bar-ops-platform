// Notification service — same pattern as the earlier Service Call prototype.
// Email/SMS work today in "simulated" mode (logged, not actually sent) until
// real SMTP/Twilio credentials are added to .env. Push is a placeholder seam
// for later, per the plan doc. Independent of that, there's also a master
// on/off switch (see notificationsEnabled() below) that owners can flip from
// the Employees app to force EVERY send into that same simulated/logged path
// even with real credentials configured — for testing against real data
// (e.g. a real employee CSV import) without actually notifying anyone.
//
// Email goes out through Resend's HTTPS API rather than SMTP. Render's
// outbound network is HTTP(S)-first — an SMTP connection to smtp.resend.com:587
// via nodemailer was observed to hang indefinitely (no error, no timeout, just
// silence) instead of failing fast, which is what was freezing the "Send"
// button on real devices. The API call below reuses the same SMTP_PASS/
// SMTP_FROM env vars (SMTP_PASS is the Resend API key) so no Render env
// changes are needed, and it's wrapped in a hard 15s timeout so a real
// network problem surfaces as a quick, visible error instead of a hang.
let twilio; try { twilio = require('twilio'); } catch (e) {}

function emailConfigured() {
  return !!((process.env.RESEND_API_KEY || process.env.SMTP_PASS) && process.env.SMTP_FROM);
}
function smsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

let twilioClient = null;
function getTwilioClient() {
  if (!twilio || !smsConfigured()) return null;
  if (!twilioClient) twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return twilioClient;
}

async function logNotification(client, relatedTable, relatedId, channel, recipient, status, detail) {
  await client.query(
    `INSERT INTO notifications_log (related_table, related_id, channel, recipient, status, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [relatedTable, relatedId, channel, recipient, status, detail]
  );
}

// Master on/off switch for every outbound email/sms, platform-wide — added
// so Scotto can import a real employee list and click through Scheduling
// Publish, onboarding invites, etc. without actually texting/emailing real
// people while testing. Piggybacks on the existing owner_notes generic
// key/body table (see server/employees.js's getOwnerNote/setOwnerNote)
// instead of a new table+migration — exactly the "reusable anywhere else a
// short standing note is useful" case that table's patch comment called
// out. A missing row or any body other than the literal 'off' means
// notifications stay ON (today's real behavior, unchanged); the switch has
// to be explicitly turned off, it never silently defaults to off. Edited
// from the Employees app's Notifications tab (owner only), read here
// through the same generic /api/owner-notes/notifications_enabled route.
async function notificationsEnabled(client) {
  const { rows } = await client.query("SELECT body FROM owner_notes WHERE note_key = 'notifications_enabled'");
  return !rows.length || rows[0].body !== 'off';
}

async function sendEmail(client, relatedTable, relatedId, to, subject, text) {
  if (!(await notificationsEnabled(client))) {
    console.log(`[notify][email][DISABLED] to=${to} subject="${subject}" (master notifications toggle is off — nothing sent)`);
    await logNotification(client, relatedTable, relatedId, 'email', to, 'disabled', subject);
    return { ok: true, simulated: true };
  }
  const apiKey = process.env.RESEND_API_KEY || process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;
  if (!apiKey || !from) {
    console.log(`[notify][email][SIMULATED] to=${to} subject="${subject}"\n${text}`);
    await logNotification(client, relatedTable, relatedId, 'email', to, 'simulated', subject);
    return { ok: true, simulated: true };
  }
  console.log(`[notify][email] sending via Resend to=${to} subject="${subject}"`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let res;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, text }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && (data.message || data.error)) || `Resend API error (${res.status})`);
    console.log(`[notify][email] sent to=${to} id=${data && data.id}`);
    await logNotification(client, relatedTable, relatedId, 'email', to, 'sent', subject);
    return { ok: true };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Timed out reaching Resend (15s).' : String(err.message || err);
    console.log(`[notify][email] FAILED to=${to}: ${message}`);
    await logNotification(client, relatedTable, relatedId, 'email', to, 'failed', message);
    // A plain string, not an Error object: this return value gets JSON-
    // serialized straight back to the client in some callers (e.g. the
    // onboarding-invite route). Error objects serialize to "{}" (their
    // message isn't an own enumerable property), which the client then
    // wraps in `new Error({})` — producing the literal text "[object
    // Object]" instead of a real message. Learned this the hard way.
    return { ok: false, error: message };
  }
}

async function sendSms(client, relatedTable, relatedId, to, body) {
  if (!(await notificationsEnabled(client))) {
    console.log(`[notify][sms][DISABLED] to=${to} body="${body}" (master notifications toggle is off — nothing sent)`);
    await logNotification(client, relatedTable, relatedId, 'sms', to, 'disabled', body);
    return { ok: true, simulated: true };
  }
  const twilioClient = getTwilioClient();
  if (!twilioClient) {
    console.log(`[notify][sms][SIMULATED] to=${to} body="${body}"`);
    await logNotification(client, relatedTable, relatedId, 'sms', to, 'simulated', body);
    return { ok: true, simulated: true };
  }
  try {
    await twilioClient.messages.create({ from: process.env.TWILIO_FROM_NUMBER, to, body });
    await logNotification(client, relatedTable, relatedId, 'sms', to, 'sent', body);
    return { ok: true };
  } catch (err) {
    const message = String(err.message || err);
    await logNotification(client, relatedTable, relatedId, 'sms', to, 'failed', message);
    return { ok: false, error: message };
  }
}

module.exports = { sendEmail, sendSms, emailConfigured, smsConfigured, notificationsEnabled };
