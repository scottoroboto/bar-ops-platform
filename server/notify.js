// Notification service — same pattern as the earlier Service Call prototype.
// Email/SMS work today in "simulated" mode (logged, not actually sent) until
// real SMTP/Twilio credentials are added to .env. Push is a placeholder seam
// for later, per the plan doc.
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

async function sendEmail(client, relatedTable, relatedId, to, subject, text) {
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
    return { ok: false, error: new Error(message) };
  }
}

async function sendSms(client, relatedTable, relatedId, to, body) {
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
    await logNotification(client, relatedTable, relatedId, 'sms', to, 'failed', String(err.message || err));
    return { ok: false, error: err };
  }
}

module.exports = { sendEmail, sendSms, emailConfigured, smsConfigured };
