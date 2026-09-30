// =====================================================================
// Cash Out — shift counts from the bar's trusted iPad (patch_046).
//
// The iPad holds a device token (the `devices` table, same as the
// Venue Control iPad trust). With it, the page lists the bar's
// bartenders; a bartender taps their name and enters their PIN, which
// gets them a 10-minute Cash Out pass (never an app session, so nothing
// is left signed in on a shared iPad). With the pass they submit one
// opening or closing count.
//
// Blind: the response never says over or short. At closing it only says
// how much to drop. A count off by more than the alert threshold
// notifies the bar's managers and the owner, and the dashboard shows it.
// =====================================================================
const crypto = require('crypto');
const { withServiceClient } = require('./db');
const auth = require('./auth');
const cashhandling = require('./cashhandling');
const notify = require('./notify');

const PASS_MINUTES = 10;
// Per boot: a restart only means re-entering a PIN mid-count.
const PASS_SECRET = crypto.randomBytes(32);

function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function money(n) { return '$' + Number(n).toFixed(2); }
function cents(n) { return Math.round(Number(n) * 100); }

function signPass(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', PASS_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function readPass(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', PASS_SECRET).update(body).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch (e) { return null; }
}

async function deviceFor(client, deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return null;
  const { rows } = await client.query(
    `SELECT d.id, d.label, d.location_id, l.name AS location_name
     FROM devices d JOIN locations l ON l.id = d.location_id WHERE d.device_token = $1`,
    [deviceToken]
  );
  return rows[0] || null;
}

// Active bartenders at the bar with a PIN set: position Bartender, or
// Bartender among their extra positions (Employees → positions).
async function bartendersAt(client, locationId) {
  const { rows } = await client.query(
    `SELECT p.id, p.name FROM people p
     WHERE p.status = 'active' AND p.pin_hash IS NOT NULL
       AND (p.location_id = $1 OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.person_id = p.id AND el.location_id = $1))
       AND (lower(trim(p.position)) = 'bartender'
            OR EXISTS (SELECT 1 FROM employee_positions ep JOIN positions pos ON pos.id = ep.position_id
                       WHERE ep.person_id = p.id AND lower(pos.name) = 'bartender'))
     ORDER BY p.name`,
    [locationId]
  );
  return rows;
}

async function shiftSources(client, locationId) {
  const { rows } = await client.query(
    `SELECT id, name, kind, target_amount, denominations, day_targets FROM cash_sources
     WHERE location_id = $1 AND active AND kind IN ('drawer', 'backup_bag') AND NOT is_atm
     ORDER BY kind DESC, sort_order, name`,
    [locationId]
  );
  return {
    drawers: rows.filter((r) => r.kind === 'drawer'),
    bag: rows.find((r) => r.kind === 'backup_bag') || null,
  };
}

async function getThreshold(client) {
  const { rows } = await client.query('SELECT alert_threshold FROM cash_shift_settings WHERE id');
  return rows[0] ? Number(rows[0].alert_threshold) : 5;
}

// What the iPad needs to draw itself. Drawer starting amounts and
// tonight's bag amount are instructions ("count it down to $400"), not
// expected balances, so they're safe to show.
async function kioskContext({ deviceToken }) {
  return withServiceClient(async (client) => {
    const device = await deviceFor(client, deviceToken);
    if (!device) throw fail('This iPad isn’t set up for Cash Out yet.', 403);
    const businessDate = await cashhandling.currentBusinessDate(client);
    const { drawers, bag } = await shiftSources(client, device.location_id);
    return {
      location: { id: device.location_id, name: device.location_name },
      device: { label: device.label },
      bartenders: await bartendersAt(client, device.location_id),
      drawers: drawers.map((d) => ({ id: d.id, name: d.name, start: Number(d.target_amount) })),
      bag: bag ? {
        id: bag.id, name: bag.name,
        denominations: (bag.denominations || []).map(Number),
        tonight: await cashhandling.bagTargetFor(client, bag, businessDate),
      } : null,
      businessDate,
    };
  });
}

async function signIn({ deviceToken, personId, pin, ip }) {
  await auth.throttleIp(ip);
  return withServiceClient(async (client) => {
    const device = await deviceFor(client, deviceToken);
    if (!device) throw fail('This iPad isn’t set up for Cash Out yet.', 403);
    const allowed = await bartendersAt(client, device.location_id);
    if (!allowed.some((b) => b.id === personId)) throw fail('Pick your name from the list.', 400);
    const { rows } = await client.query(auth.PERSON_WITH_LOCATIONS + ' WHERE p.id = $1', [personId]);
    const person = rows[0];
    const check = await auth.checkPin(client, person, pin, ip, 'Wrong PIN.');
    if (!check.ok) throw fail(check.message || check.error, 401);
    const pass = signPass({ p: person.id, d: device.id, exp: Date.now() + PASS_MINUTES * 60 * 1000 });
    return { pass, name: person.name };
  });
}

function parseAmount(v, label) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0) throw fail(`Enter the amount for ${label}.`);
  return Math.round(n * 100) / 100;
}

// counts: [{ sourceId, amount }]. Opening: every drawer. Closing: every
// drawer (one of them the closing station, counted last) and the change
// bag if the bar has one.
async function submitShift({ deviceToken, pass, kind, counts, closingSourceId }) {
  const result = await withServiceClient(async (client) => {
    const device = await deviceFor(client, deviceToken);
    if (!device) throw fail('This iPad isn’t set up for Cash Out yet.', 403);
    const who = readPass(pass);
    if (!who || who.d !== device.id) throw fail('Your sign-in timed out. Enter your PIN again.', 401);
    if (kind !== 'opening' && kind !== 'closing') throw fail('Pick opening or closing.');
    const { rows: [person] } = await client.query('SELECT id, name FROM people WHERE id = $1 AND status = $2', [who.p, 'active']);
    if (!person) throw fail('Your sign-in timed out. Enter your PIN again.', 401);

    const { drawers, bag } = await shiftSources(client, device.location_id);
    const byId = new Map();
    for (const c of Array.isArray(counts) ? counts : []) {
      if (!c || typeof c.sourceId !== 'string' || byId.has(c.sourceId)) throw fail('Something’s off with the counts. Start again.');
      byId.set(c.sourceId, c.amount);
    }
    for (const d of drawers) if (!byId.has(d.id)) throw fail(`Enter the amount for ${d.name}.`);
    if (kind === 'closing' && bag && !byId.has(bag.id)) throw fail(`Enter the amount for the ${bag.name}.`);
    const known = new Set([...drawers.map((d) => d.id), ...(kind === 'closing' && bag ? [bag.id] : [])]);
    for (const id of byId.keys()) if (!known.has(id)) throw fail('Something’s off with the counts. Start again.');
    const closing = kind === 'closing' ? drawers.find((d) => d.id === closingSourceId) : null;
    if (kind === 'closing' && !closing) throw fail('Pick the closing station.');

    const businessDate = await cashhandling.currentBusinessDate(client);
    const threshold = await getThreshold(client);
    const { rows: [session] } = await client.query(
      `INSERT INTO cash_shift_sessions (location_id, kind, person_id, device_id, business_date, closing_source_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [device.location_id, kind, person.id, device.id, businessDate, closing ? closing.id : null]
    );

    // Expected per count. Opening: the drawer's ledger balance. Closing:
    // $400 for a pre-close station, tonight's amount for the bag, and the
    // closing station is taken as counted (only the POS report can say
    // whether the night was over or short; that goes in with the drop).
    const lines = [];
    const plan = [];
    if (kind === 'opening') {
      for (const d of drawers) plan.push({ source: d, role: 'opening', expected: await cashhandling.computeExpectedAmount(client, d.id) });
    } else {
      for (const d of drawers) if (d.id !== closing.id) plan.push({ source: d, role: 'pre_close', expected: Number(d.target_amount) > 0 ? Number(d.target_amount) : null });
      if (bag) {
        const tonight = await cashhandling.bagTargetFor(client, bag, businessDate);
        plan.push({ source: bag, role: 'bag', expected: tonight > 0 ? tonight : null });
      }
      plan.push({ source: closing, role: 'closing_station', expected: null });
    }
    let flagged = 0;
    for (const item of plan) {
      const counted = parseAmount(byId.get(item.source.id), item.source.name);
      const expected = item.expected === null ? counted : item.expected;
      await client.query(
        `INSERT INTO cash_counts (source_id, counted_by, context, counted_amount, expected_amount, shift_session_id, shift_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [item.source.id, person.id, kind, counted, expected, session.id, item.role]
      );
      const off = (cents(counted) - cents(expected)) / 100;
      if (Math.abs(off) > threshold) {
        flagged += 1;
        lines.push(`${item.source.name}: counted ${money(counted)}, should be ${money(expected)} (${off < 0 ? money(-off) + ' short' : money(off) + ' over'})`);
      }
      item.counted = counted;
    }

    // Closing drop: everything over the closing station's $400.
    let drop = 0;
    let closingCounted = null;
    if (closing) {
      closingCounted = plan[plan.length - 1].counted;
      const start = Number(closing.target_amount);
      if (start > 0 && closingCounted > start) drop = Math.round((closingCounted - start) * 100) / 100;
      if (drop > 0) {
        const { rows: [dropSafe] } = await client.query(
          `SELECT id FROM cash_sources WHERE location_id = $1 AND active AND name = 'Drop Safe' LIMIT 1`,
          [device.location_id]
        );
        let txnId = null;
        if (dropSafe) {
          const txn = await cashhandling.createTransaction(client, {
            locationId: device.location_id, type: 'cash_drop', fromSourceId: closing.id, toSourceId: dropSafe.id,
            amount: drop, reason: 'Closing drop with the POS cash-out report', performedBy: person.id, afterCounts: true,
          });
          txnId = txn.id;
        }
        await client.query('UPDATE cash_shift_sessions SET drop_amount = $2, drop_transaction_id = $3 WHERE id = $1', [session.id, drop, txnId]);
      }
    }
    if (flagged) await client.query('UPDATE cash_shift_sessions SET flagged_count = $2 WHERE id = $1', [session.id, flagged]);

    return {
      reply: {
        kind, name: person.name,
        closingName: closing ? closing.name : null,
        closingStart: closing ? Number(closing.target_amount) : null,
        drop,
      },
      alert: flagged ? { locationId: device.location_id, locationName: device.location_name, sessionId: session.id, person: person.name, kind, lines } : null,
    };
  });
  if (result.alert) notifyFlagged(result.alert).catch((e) => console.error('[cashout] alert failed:', e.message));
  return result.reply;
}

// The bar's managers and the owner, by email and text.
async function notifyFlagged(alert) {
  await withServiceClient(async (client) => {
    const { rows: people } = await client.query(
      `SELECT DISTINCT p.id, p.email, p.phone FROM people p
       WHERE p.status = 'active' AND (p.role = 'owner' OR (p.role = 'manager' AND (p.location_id = $1
         OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.person_id = p.id AND el.location_id = $1))))`,
      [alert.locationId]
    );
    const subject = `Cash Out: ${alert.kind} count off at ${alert.locationName}`;
    const text = `${alert.person} logged the ${alert.kind} count at ${alert.locationName}.\n\n${alert.lines.join('\n')}\n\nOpen Cash Handling → Shifts for the details.`;
    const sms = `${subject} (${alert.person}). ${alert.lines.join('; ')}`.slice(0, 300);
    for (const p of people) {
      if (p.email) await notify.sendEmail(client, 'cash_shift_sessions', alert.sessionId, p.email, subject, text);
      if (p.phone) await notify.sendSms(client, 'cash_shift_sessions', alert.sessionId, p.phone, sms);
    }
  });
}

// ---- Manager / owner side (Cash Handling → Shifts) --------------------
async function listShifts(client, { locationId, limit }) {
  const { rows: sessions } = await client.query(
    `SELECT s.*, p.name AS person_name, cs.name AS closing_name
     FROM cash_shift_sessions s JOIN people p ON p.id = s.person_id
     LEFT JOIN cash_sources cs ON cs.id = s.closing_source_id
     WHERE s.location_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
    [locationId, limit || 30]
  );
  if (!sessions.length) return [];
  const { rows: counts } = await client.query(
    `SELECT c.shift_session_id, c.shift_role, c.counted_amount, c.expected_amount, c.variance, cs.name AS source_name
     FROM cash_counts c JOIN cash_sources cs ON cs.id = c.source_id
     WHERE c.shift_session_id = ANY($1::uuid[]) ORDER BY cs.sort_order, cs.name`,
    [sessions.map((s) => s.id)]
  );
  for (const s of sessions) s.counts = counts.filter((c) => c.shift_session_id === s.id);
  return sessions;
}

async function getSettings(client, { locationId }) {
  const { bag } = await shiftSources(client, locationId);
  let events = [];
  if (bag) {
    const today = await cashhandling.currentBusinessDate(client);
    ({ rows: events } = await client.query(
      `SELECT id, business_date, amount, label FROM cash_bag_event_targets
       WHERE source_id = $1 AND business_date >= $2 ORDER BY business_date LIMIT 50`,
      [bag.id, today]
    ));
  }
  return {
    threshold: await getThreshold(client),
    bag: bag ? { id: bag.id, name: bag.name, dayTargets: (bag.day_targets || []).map(Number), targetAmount: Number(bag.target_amount) } : null,
    events,
  };
}

async function setThreshold(client, { amount, personId }) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw fail('Enter a dollar amount.');
  await client.query('UPDATE cash_shift_settings SET alert_threshold = $1, updated_by = $2, updated_at = now() WHERE id', [n, personId]);
  return { threshold: n };
}

async function bagAt(client, bagId) {
  const { rows } = await client.query(`SELECT * FROM cash_sources WHERE id = $1 AND kind = 'backup_bag'`, [bagId]);
  return rows[0] || null;
}

async function setBagDayTargets(client, { bag, dayTargets }) {
  if (!Array.isArray(dayTargets) || dayTargets.length !== 7) throw fail('Enter an amount for each day.');
  const values = dayTargets.map((v) => {
    const n = Number(v === '' || v === null ? 0 : v);
    if (!Number.isFinite(n) || n < 0) throw fail('Amounts have to be dollar amounts.');
    return Math.round(n * 100) / 100;
  });
  await client.query('UPDATE cash_sources SET day_targets = $2 WHERE id = $1', [bag.id, values]);
  return { dayTargets: values };
}

async function addBagEvent(client, { bag, date, amount, label, personId }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw fail('Pick the date.');
  const n = Number(amount);
  if (amount === '' || !Number.isFinite(n) || n < 0) throw fail('Enter the bag amount for that night.');
  const { rows } = await client.query(
    `INSERT INTO cash_bag_event_targets (source_id, business_date, amount, label, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_id, business_date) DO UPDATE SET amount = EXCLUDED.amount, label = EXCLUDED.label
     RETURNING id, business_date, amount, label`,
    [bag.id, date, Math.round(n * 100) / 100, (label || '').trim() || null, personId]
  );
  return rows[0];
}

async function deleteBagEvent(client, { eventId }) {
  const { rows } = await client.query(
    `DELETE FROM cash_bag_event_targets e USING cash_sources s
     WHERE e.id = $1 AND s.id = e.source_id RETURNING s.location_id`,
    [eventId]
  );
  return rows[0] || null;
}

async function bagEventLocation(client, eventId) {
  const { rows } = await client.query(
    `SELECT s.location_id FROM cash_bag_event_targets e JOIN cash_sources s ON s.id = e.source_id WHERE e.id = $1`,
    [eventId]
  );
  return rows[0] ? rows[0].location_id : null;
}

module.exports = {
  kioskContext, signIn, submitShift,
  listShifts, getSettings, setThreshold, bagAt, setBagDayTargets, addBagEvent, deleteBagEvent, bagEventLocation,
};
