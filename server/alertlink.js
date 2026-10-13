// One-tap Mute / Acknowledge from an alert text or email (Oct 2026).
// Every alert notification carries a link made for that one recipient
// (alert_links). Opening it shows the alert and the choices; the first
// time on a device it asks for the person's Bar Ops PIN, then a cookie
// keeps that device trusted for 30 days. The actions are the same ones
// the app offers: acknowledge (stops the reminders, the alert still
// clears itself) and silence the piece of equipment for a while.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { withServiceClient } = require('./db');
const monitoring = require('./monitoring');

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
const TOKEN_RE = /^[A-Za-z0-9_-]{10,40}$/;
const DEVICE_DAYS = 30;
const MUTES = [['1h', '1 hour'], ['today', 'Rest of today'], ['1d', '1 day'], ['forever', 'Until turned back on']];
const devices = new Map(); // deviceToken -> { personId, exp }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function cookies(req) { const out = {}; String(req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return out; }
function fmtWhen(v) {
  if (v == null) return '';
  if (v === Infinity || v === 'infinity' || v === 'Infinity') return 'turned back on';
  const d = new Date(v); if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-US', { timeZone: BUSINESS_TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
function baseUrl() { return (process.env.APP_BASE_URL || 'https://app.ticketsportsbar.com').replace(/\/$/, ''); }

async function load(token) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query(
      `SELECT al.token, al.person_id, al.alert_id, sa.system_id, sa.message, sa.status, sa.opened_at, sa.closed_at, sa.acknowledged_at,
              ms.name AS system_name, ms.silenced_until, ms.category, l.name AS location_name, p.name AS person_name,
              (SELECT name FROM people WHERE id = sa.acknowledged_by) AS acknowledged_by_name
       FROM alert_links al
       JOIN system_alerts sa ON sa.id = al.alert_id
       JOIN monitored_systems ms ON ms.id = sa.system_id
       JOIN locations l ON l.id = ms.location_id
       JOIN people p ON p.id = al.person_id
       WHERE al.token = $1`, [token]);
    return rows[0] || null;
  });
}

function shell(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#0f1115;color:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;}
.card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:22px;width:360px;max-width:100%;box-sizing:border-box;}h1{font-size:18px;margin:0 0 4px;}p{color:#9aa3b2;font-size:14px;margin:0 0 12px;line-height:1.4;}
.al{border-left:4px solid #e0a83e;background:#0f1115;border-radius:8px;padding:10px 12px;margin:0 0 14px;font-size:14px;line-height:1.45;}.al.ok{border-left-color:#3fbf7f;}.al.quiet{border-left-color:#6f7a8c;}.al b{display:block;font-size:15px;margin-bottom:2px;}.al .m{color:#c8ceda;}.al .s{color:#9aa3b2;font-size:12px;margin-top:4px;}
input{width:100%;box-sizing:border-box;font-size:26px;letter-spacing:.3em;text-align:center;padding:10px;border-radius:10px;border:1px solid #262b36;background:#0f1115;color:#eef0f4;margin:0 0 10px;}
button{width:100%;margin-top:8px;padding:12px;border:0;border-radius:10px;font-size:15px;font-weight:600;color:#fff;background:#2a3140;cursor:pointer;}button.ack{background:#3fbf7f;color:#08231a;}button.mute{background:#4f8dfd;}button.off{background:#e5566d;}
.lbl{color:#9aa3b2;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 2px;}.err{color:#e5566d;font-size:14px;margin:8px 0 0;}a{color:#8fb6ff;}.foot{margin-top:16px;font-size:13px;color:#9aa3b2;}</style></head>
<body><div class="card">${body}</div></body></html>`;
}

function alertCard(row) {
  const silenced = monitoring.isSilenced(row);
  const cls = row.closed_at ? 'ok' : silenced ? 'quiet' : '';
  const state = row.closed_at ? `Back to normal ${fmtWhen(row.closed_at)}.`
    : silenced ? `Muted until ${fmtWhen(row.silenced_until)}.`
    : row.acknowledged_at ? `Acknowledged${row.acknowledged_by_name ? ` by ${esc(row.acknowledged_by_name)}` : ''}; reminders stopped. Clears itself when the reading comes back.`
    : `Open since ${fmtWhen(row.opened_at)}. Reminders every 30 min until someone acknowledges it.`;
  return `<div class="al ${cls}"><b>${esc(row.system_name)} · ${esc(row.location_name)}</b><div class="m">${esc(row.message || '')}</div><div class="s">${state}</div></div>`;
}

function formPage(row, { needPin, error } = {}) {
  const silenced = monitoring.isSilenced(row);
  const open = !row.closed_at;
  const buttons = [];
  if (open && !row.acknowledged_at) buttons.push(`<button class="ack" name="action" value="ack">Acknowledge — stop the reminders</button>`);
  if (silenced) buttons.push(`<div class="lbl">Muted</div><button class="off" name="action" value="unmute">Turn alerts back on for ${esc(row.system_name)}</button>`);
  else buttons.push(`<div class="lbl">Mute ${esc(row.system_name)}</div>${MUTES.map(([d, l]) => `<button class="mute" name="action" value="mute:${d}">${l}</button>`).join('')}`);
  return shell(`${row.system_name} alert`, `<h1>${esc(row.system_name)}</h1><p>Hi ${esc(String(row.person_name || '').split(' ')[0])}. ${needPin ? 'Enter your Bar Ops PIN, then pick what to do. This phone stays trusted for 30 days.' : 'Pick what to do.'}</p>
${alertCard(row)}
<form method="post" action="/a/${esc(row.token)}">${needPin ? `<input name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="PIN" autofocus>` : ''}${error ? `<div class="err">${esc(error)}</div>` : ''}
${buttons.join('')}</form>
<div class="foot">Muting stops texts and emails for this one piece of equipment; it stays on the dashboard. <a href="${esc(baseUrl())}/sensors.html">Open Bar Ops</a></div>`);
}

function donePage(row, note) {
  return shell(`${row.system_name} alert`, `<h1>Done</h1><p>${esc(note)}</p>${alertCard(row)}<form method="post" action="/a/${esc(row.token)}">${monitoring.isSilenced(row) ? `<button class="off" name="action" value="unmute">Turn alerts back on</button>` : ''}</form>
<div class="foot"><a href="${esc(baseUrl())}/sensors.html">Open Bar Ops</a></div>`);
}

function trustedPerson(req) {
  const vt = cookies(req).bo_a; const d = vt && devices.get(vt);
  return d && d.exp > Date.now() ? d.personId : null;
}

async function page(req, res) {
  const token = String(req.params.token || ''); if (!TOKEN_RE.test(token)) return res.status(404).send('Not found');
  const row = await load(token); if (!row) return res.status(404).send('This alert link is no longer valid.');
  res.type('html').send(formPage(row, { needPin: trustedPerson(req) !== row.person_id }));
}

async function verifyPin(personId, pin) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT * FROM people WHERE id = $1', [personId]);
    const person = rows[0]; if (!person || !person.pin_hash) return { ok: false, error: 'No PIN on this account. Sign in to Bar Ops and set one under My Account.' };
    if (person.pin_locked_at) return { ok: false, error: 'Your PIN is locked. Sign in to Bar Ops with your password to reset it.' };
    const valid = pin && await bcrypt.compare(pin, person.pin_hash);
    if (!valid) {
      const count = (person.pin_failed_count || 0) + 1;
      if (count >= 5) { await svc.query('UPDATE people SET pin_failed_count = 0, pin_locked_at = now() WHERE id = $1', [person.id]); return { ok: false, error: 'Fifth wrong PIN. Your PIN is now locked; sign in to Bar Ops with your password to set a new one.' }; }
      await svc.query('UPDATE people SET pin_failed_count = $2 WHERE id = $1', [person.id, count]);
      return { ok: false, error: `Wrong PIN. ${5 - count} tr${5 - count === 1 ? 'y' : 'ies'} left.` };
    }
    if (person.pin_failed_count) await svc.query('UPDATE people SET pin_failed_count = 0 WHERE id = $1', [person.id]);
    return { ok: true };
  });
}

async function act(req, res) {
  const token = String(req.params.token || ''); if (!TOKEN_RE.test(token)) return res.status(404).send('Not found');
  let row = await load(token); if (!row) return res.status(404).send('This alert link is no longer valid.');
  const body = req.body || {};
  const action = String(body.action || '');
  if (trustedPerson(req) !== row.person_id) {
    const check = await verifyPin(row.person_id, String(body.pin || '').trim());
    if (!check.ok) return res.status(401).type('html').send(formPage(row, { needPin: true, error: check.error }));
    const vt = crypto.randomBytes(18).toString('base64url');
    devices.set(vt, { personId: row.person_id, exp: Date.now() + DEVICE_DAYS * 86400e3 });
    for (const [k, x] of devices) if (x.exp < Date.now()) devices.delete(k);
    res.set('Set-Cookie', `bo_a=${vt}; Path=/a; Max-Age=${DEVICE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
  }
  let note;
  if (action === 'ack') {
    if (row.closed_at) note = `${row.system_name} already cleared on its own.`;
    else { await monitoring.acknowledgeAlert({ alertId: row.alert_id, personId: row.person_id }); note = `Acknowledged. No more reminders for this one; it still clears itself when the reading comes back.`; }
  } else if (action === 'unmute') {
    await monitoring.setSilence({ systemId: row.system_id, duration: 'off', by: row.person_id });
    note = `Alerts are back on for ${row.system_name}.`;
  } else if (action.startsWith('mute:') && MUTES.some(([d]) => d === action.slice(5))) {
    const r = await monitoring.setSilence({ systemId: row.system_id, duration: action.slice(5), by: row.person_id });
    if (!r.ok) return res.status(400).type('html').send(formPage(row, { error: r.error }));
    note = `${row.system_name} is muted until ${fmtWhen(r.system.silenced_until)}. No texts or emails for it until then; it stays on the dashboard.`;
  } else {
    return res.status(400).type('html').send(formPage(row, { error: 'Pick one of the buttons.' }));
  }
  await withServiceClient((svc) => svc.query('UPDATE alert_links SET used_at = now(), action = $2 WHERE token = $1', [token, action]));
  row = await load(token);
  res.type('html').send(donePage(row, note));
}

module.exports = { page, act, _test: { formPage, donePage } };
