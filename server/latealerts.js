// Late clock-in alerts for scheduling managers (patch_081, Scotto
// 2026-10-20). A manager turns it on for themselves, picks how late
// (5-30 minutes, in 5s) and text / email / both. Every minute runDue()
// looks at today's published shifts: once a shift's start plus a
// manager's minutes has passed and the employee hasn't clocked in, that
// manager gets one alert for that shift.
//
// "Clocked in" = a SpotOn punch at the shift's bar (kb_punches, pulled by
// the bar's box every 5 minutes, matched on the name) or a Bar Ops time
// clock entry (time_entries), starting up to 3 hours before the shift.
// SpotOn is only trusted when the box has pulled since the deadline; a
// bar whose pulls are stale gets no alerts rather than false ones.
// Alerts stop 2 hours after the shift started (a late app restart never
// sends a pile of old ones).
const { withServiceClient } = require('./db');
const notify = require('./notify');

const TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
const EARLY_CLOCK_IN_MS = 3 * 3600000;
const GIVE_UP_AFTER_MS = 2 * 3600000;

function tzOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; dtf.formatToParts(date).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()) / 60000;
}
// Bar wall clock (YYYY-MM-DD, HH:MM[:SS]) -> UTC Date.
function barTimeToUtc(ymd, hms) {
  const naive = new Date(`${ymd}T${String(hms).slice(0, 8).padEnd(8, ':00')}Z`);
  const guess = new Date(naive.getTime() - tzOffsetMinutes(naive) * 60000);
  return new Date(naive.getTime() - tzOffsetMinutes(guess) * 60000);
}
function barYmd(date) { return new Date(date).toLocaleDateString('en-CA', { timeZone: TZ }); }
function toYmd(v) { return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10); }
function addDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nameKey(s) { return String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' '); }
function hm(hms) { const [h, m] = String(hms).split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
function phoneText(raw) { const d = String(raw || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null; }

// ---------------------------------------------------------------- settings
async function settingsFor(personId) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT enabled, minutes, channel FROM late_alert_settings WHERE person_id = $1', [personId]);
    const r = rows[0] || {};
    return { enabled: r.enabled === true, minutes: r.minutes || 10, channel: r.channel || 'sms' };
  });
}

async function setSettings(personId, body) {
  const b = body || {};
  return withServiceClient(async (svc) => {
    const cur = await settingsFor(personId);
    const enabled = b.enabled === undefined ? cur.enabled : !!b.enabled;
    const minutes = b.minutes === undefined ? cur.minutes : Number(b.minutes);
    if (!(minutes >= 5 && minutes <= 30 && minutes % 5 === 0)) return { ok: false, error: 'Pick 5 to 30 minutes.' };
    const channel = b.channel === undefined ? cur.channel : b.channel;
    if (!['sms', 'email', 'both'].includes(channel)) return { ok: false, error: 'Pick text, email or both.' };
    if (enabled && channel !== 'email') {
      const { rows } = await svc.query('SELECT p.phone, mns.sms_consent_at, mns.sms_consent_phone FROM people p LEFT JOIN monitoring_notify_settings mns ON mns.person_id = p.id WHERE p.id = $1', [personId]);
      const n = rows[0] || {};
      if (!n.phone) return { ok: false, error: 'Add your mobile number under My Account first, or pick email.' };
      if (!n.sms_consent_at || n.sms_consent_phone !== n.phone) return { ok: false, error: 'Tick the text alerts consent box under Systems Monitoring → My alert settings first, or pick email.' };
    }
    if (enabled && channel !== 'sms') {
      const { rows } = await svc.query('SELECT email FROM people WHERE id = $1', [personId]);
      if (!rows[0] || !rows[0].email) return { ok: false, error: 'There is no email on your account; pick text.' };
    }
    await svc.query(
      `INSERT INTO late_alert_settings (person_id, enabled, minutes, channel, updated_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (person_id) DO UPDATE SET enabled = $2, minutes = $3, channel = $4, updated_at = now()`,
      [personId, enabled, minutes, channel]);
    return { ok: true, settings: { enabled, minutes, channel } };
  });
}

// ---------------------------------------------------------------- the check
// Pure: which (shift, recipient) pairs are due, given what's on the clock.
function dueAlerts({ now, shifts, recipients, clockedIn, freshSince }) {
  const out = [];
  for (const sh of shifts) {
    const start = sh.startUtc;
    if (now - start >= GIVE_UP_AFTER_MS || now < start) continue;
    if (clockedIn(sh)) continue;
    for (const r of recipients) {
      if (String(r.person_id) === String(sh.person_id)) continue; // not about yourself
      if (!(r.role === 'owner' || (r.schedule_ids || []).map(String).includes(String(sh.schedule_id)))) continue;
      const deadline = new Date(start.getTime() + r.minutes * 60000);
      if (now < deadline) continue;
      // SpotOn must have been read after the deadline, else the punch may just not be in yet.
      const fresh = freshSince(sh.location_id);
      if (!fresh || fresh < deadline) continue;
      out.push({ shift: sh, recipient: r, lateMin: Math.floor((now - start) / 60000) });
    }
  }
  return out;
}

async function runDue(now = new Date()) {
  return withServiceClient(async (svc) => {
    const { rows: recipients } = await svc.query(
      `SELECT las.person_id, las.minutes, las.channel, p.role, p.email, p.phone, p.name,
              ARRAY(SELECT ms.schedule_id FROM manager_schedules ms WHERE ms.person_id = p.id) AS schedule_ids
         FROM late_alert_settings las JOIN people p ON p.id = las.person_id
        WHERE las.enabled AND p.status = 'active' AND p.role IN ('owner', 'manager')`);
    if (!recipients.length) return 0;

    // Shifts that started in the last 2 hours (yesterday's date covers past-midnight starts).
    const today = barYmd(now);
    const { rows: shiftRows } = await svc.query(
      `SELECT sh.id, sh.person_id, sh.schedule_id, sh.shift_date, sh.start_time, sh.end_time,
              p.name AS person_name, p.phone AS person_phone, s.name AS schedule_name, s.location_id
         FROM shifts sh JOIN people p ON p.id = sh.person_id JOIN schedules s ON s.id = sh.schedule_id
        WHERE sh.status = 'scheduled' AND sh.shift_date IN ($1, $2)`,
      [addDays(today, -1), today]);
    const shifts = shiftRows.map((r) => ({ ...r, startUtc: barTimeToUtc(toYmd(r.shift_date), r.start_time) }))
      .filter((r) => now >= r.startUtc && now - r.startUtc < GIVE_UP_AFTER_MS);
    if (!shifts.length) return 0;

    const since = new Date(Math.min(...shifts.map((s) => s.startUtc.getTime())) - EARLY_CLOCK_IN_MS);
    const locIds = [...new Set(shifts.map((s) => String(s.location_id)))];
    const { rows: punches } = await svc.query('SELECT location_id, full_name, clock_in FROM kb_punches WHERE location_id = ANY($1::uuid[]) AND clock_in >= $2', [locIds, since]);
    const { rows: entries } = await svc.query('SELECT person_id, clock_in FROM time_entries WHERE person_id = ANY($1::uuid[]) AND clock_in >= $2', [[...new Set(shifts.map((s) => s.person_id))], since]);
    const { rows: pulls } = await svc.query('SELECT location_id, max(at) AS at FROM kb_pulls WHERE ok AND location_id = ANY($1::uuid[]) GROUP BY location_id', [locIds]);
    const fresh = new Map(pulls.map((p) => [String(p.location_id), new Date(p.at)]));

    const clockedIn = (sh) => {
      const from = sh.startUtc.getTime() - EARLY_CLOCK_IN_MS;
      if (entries.some((e) => String(e.person_id) === String(sh.person_id) && new Date(e.clock_in).getTime() >= from)) return true;
      const key = nameKey(sh.person_name);
      return punches.some((p) => String(p.location_id) === String(sh.location_id) && nameKey(p.full_name) === key && new Date(p.clock_in).getTime() >= from);
    };
    const { rows: already } = await svc.query('SELECT shift_id, recipient_id FROM late_alerts_sent WHERE shift_id = ANY($1::uuid[])', [shifts.map((x) => x.id)]);
    const done = new Set(already.map((a) => `${a.shift_id}|${a.recipient_id}`));
    const due = dueAlerts({ now, shifts, recipients, clockedIn, freshSince: (loc) => fresh.get(String(loc)) || null })
      .filter((d) => !done.has(`${d.shift.id}|${d.recipient.person_id}`));

    let sent = 0;
    for (const { shift: sh, recipient: r, lateMin } of due) {
      const { rowCount } = await svc.query('INSERT INTO late_alerts_sent (shift_id, recipient_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sh.id, r.person_id]);
      if (!rowCount) continue; // another instance got it
      const phone = phoneText(sh.person_phone);
      const line = `Late: ${sh.person_name} hasn't clocked in for ${sh.schedule_name}, ${hm(sh.start_time)}–${hm(sh.end_time)} (${lateMin} min).${phone ? ` Call ${phone}.` : ''}`;
      if ((r.channel === 'sms' || r.channel === 'both') && r.phone) await notify.sendSms(svc, 'shifts', sh.id, r.phone, line);
      if ((r.channel === 'email' || r.channel === 'both') && r.email) {
        await notify.sendEmail(svc, 'shifts', sh.id, r.email, `Late: ${sh.person_name}, ${sh.schedule_name} ${hm(sh.start_time)}`,
          `${line}\n\nNo SpotOn punch or Bar Ops clock-in yet. You get one alert per shift; change it in Scheduling → Late alerts.`);
      }
      sent += 1;
    }
    return sent;
  });
}

module.exports = { settingsFor, setSettings, runDue, _test: { dueAlerts, barTimeToUtc, nameKey } };
