// Notification service — same pattern as the earlier Service Call prototype.
// Email/SMS work today in "simulated" mode (logged, not actually sent) until
// real SMTP/Twilio credentials are added to .env. Push is a placeholder seam
// for later, per the plan doc.

let nodemailer; try { nodemailer = require('nodemailer'); } catch (e) {}
let twilio; try { twilio = require('twilio'); } catch (e) {}

function emailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
}
function smsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

let mailTransport = null;
function getMailTransport() {
  if (!nodemailer || !emailConfigured()) return null;
  if (!mailTransport) {
    mailTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return mailTransport;
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
  const transport = getMailTransport();
  if (!transport) {
    console.log(`[notify][email][SIMULATED] to=${to} subject="${subject}"\n${text}`);
    await logNotification(client, relatedTable, relatedId, 'email', to, 'simulated', subject);
    return { ok: true, simulated: true };
  }
  try {
    await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
    await logNotification(client, relatedTable, relatedId, 'email', to, 'sent', subject);
    return { ok: true };
  } catch (err) {
    await logNotification(client, relatedTable, relatedId, 'email', to, 'failed', String(err.message || err));
    return { ok: false, error: err };
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
