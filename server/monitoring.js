// Systems Monitoring — equipment registry, status history, and alerts.
// Structured like server/servicecalls.js: gated behind employee_apps
// ('monitoring' instead of 'service_calls'), location-scoped RLS reads,
// writes and cross-person lookups on the service (RLS-bypass) connection
// with authorization enforced in the Express route handlers.
//
// Phase one only populates UniFi devices (kind starting 'unifi_'), polled
// via Ubiquiti's Site Manager cloud API — see pollUnifiSystems() below.
// Sensor kinds (refrigeration/HVAC/etc.) get their own poll functions
// later; the registry/status/alert tables and the notify fan-out are
// already generic across every kind.
//
// Ticket 3 used to be excluded here (it was being sold) — that block has
// been removed (see db/patch_029_critical_systems_widget.sql) now that
// it's being activated again; all three locations are in scope.
const { withServiceClient } = require('./db');
const notify = require('./notify');

const UNIFI_API_BASE = 'https://api.ui.com/v1';

function unifiConfigured() {
  return !!process.env.UNIFI_API_KEY;
}

// NOTE ON ACCURACY: the Site Manager API's exact response shape couldn't
// be pulled from Ubiquiti's developer portal (it's a JS-rendered
// reference, not fetchable as static docs). Base URL, the X-API-KEY
// header, and the /hosts + /hosts/{id}/devices paths below match
// Ubiquiti's documented conventions, but the *field names* on a device
// object (state/status, id, name) are a best guess pending a real test
// against a live key. findDeviceStatus() below is written defensively
// (checks a couple of likely field names, falls back to 'unknown' rather
// than throwing) specifically so a shape mismatch degrades to "unknown"
// on the dashboard instead of crashing the poller — fix the field lookup
// there once Scotto's key is in and we can see a real response.
async function unifiRequest(path) {
  const res = await fetch(`${UNIFI_API_BASE}${path}`, {
    headers: { 'X-API-KEY': process.env.UNIFI_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`UniFi API ${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  return res.json();
}

function findDeviceStatus(device) {
  if (!device) return 'unknown';
  const raw = device.state ?? device.status ?? device.connectionState;
  const s = String(raw || '').toLowerCase();
  if (s.includes('online') || s === 'connected' || s === 'up') return 'online';
  if (s.includes('offline') || s === 'disconnected' || s === 'down') return 'offline';
  return 'unknown';
}

// ---------------------------------------------------------------------
// Access gate — same shape as servicecalls.requireServiceCallsAccess.
// ---------------------------------------------------------------------
async function requireMonitoringAccess(client, personId) {
  const { rows } = await client.query(
    `SELECT enabled FROM employee_apps WHERE person_id = $1 AND app_key = 'monitoring'`,
    [personId]
  );
  return !!(rows[0] && rows[0].enabled);
}

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------
async function listSystems(client, { locationId, category } = {}) {
  const clauses = ['ms.active = true'];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`ms.location_id = $${params.length}`); }
  if (category) { params.push(category); clauses.push(`ms.category = $${params.length}`); }
  const { rows } = await client.query(
    `SELECT ms.*, l.name AS location_name,
            (SELECT status FROM system_status ss WHERE ss.system_id = ms.id ORDER BY checked_at DESC LIMIT 1) AS last_status,
            (SELECT checked_at FROM system_status ss WHERE ss.system_id = ms.id ORDER BY checked_at DESC LIMIT 1) AS last_checked_at,
            (SELECT id FROM system_alerts sa WHERE sa.system_id = ms.id AND sa.closed_at IS NULL LIMIT 1) AS open_alert_id,
            (ms.silenced_until IS NOT NULL AND ms.silenced_until > now()) AS silenced,
            (SELECT name FROM people WHERE id = ms.silenced_by) AS silenced_by_name
     FROM monitored_systems ms JOIN locations l ON l.id = ms.location_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY l.name, ms.sort_order, ms.category, ms.name`,
    params
  );
  return rows;
}

// ---------------------------------------------------------------------
// Critical Systems dashboard widget — WAN/LAN/WAP per location, reusing
// this same registry rather than new tables: a location's WAN is its
// registered 'unifi_gateway' system(s), LAN its 'unifi_switch'(es), WAP
// its 'unifi_ap'(s), all under category='network'. One dot per kind per
// location: 'offline' if anything in that group is down, 'online' only
// if every system in the group is up, 'unknown' if nothing's registered
// there yet (the honest starting state — no UniFi equipment is
// registered anywhere as of this writing) or nothing's polled it yet.
// ---------------------------------------------------------------------
const NETWORK_KIND_TO_KEY = { unifi_gateway: 'wan', unifi_switch: 'lan', unifi_ap: 'wap' };

function aggregateNetworkStatus(statuses) {
  if (statuses.length === 0) return 'unknown';
  if (statuses.some((s) => s === 'offline')) return 'offline';
  if (statuses.every((s) => s === 'online')) return 'online';
  return 'unknown';
}

async function getCriticalSystemsStatus(client, locationIds) {
  if (!locationIds || locationIds.length === 0) return [];
  const { rows: locRows } = await client.query(
    'SELECT id, name FROM locations WHERE id = ANY($1::uuid[]) ORDER BY name',
    [locationIds]
  );
  const byLocation = {};
  locRows.forEach((l) => { byLocation[l.id] = { wan: [], lan: [], wap: [] }; });

  const { rows } = await client.query(
    `SELECT ms.location_id, ms.kind,
            (SELECT status FROM system_status ss WHERE ss.system_id = ms.id ORDER BY checked_at DESC LIMIT 1) AS last_status
     FROM monitored_systems ms
     WHERE ms.active = true AND ms.category = 'network' AND ms.location_id = ANY($1::uuid[])
       AND ms.kind IN ('unifi_gateway','unifi_switch','unifi_ap')`,
    [locationIds]
  );
  for (const row of rows) {
    const bucket = byLocation[row.location_id];
    const key = NETWORK_KIND_TO_KEY[row.kind];
    if (bucket && key) bucket[key].push(row.last_status || 'unknown');
  }

  return locRows.map((l) => ({
    locationId: l.id,
    locationName: l.name,
    wan: aggregateNetworkStatus(byLocation[l.id].wan),
    lan: aggregateNetworkStatus(byLocation[l.id].lan),
    wap: aggregateNetworkStatus(byLocation[l.id].wap),
  }));
}

// Manual reorder within a location — "move up/below one" per Scotto.
// Swaps sort_order with whichever active sibling in the same location sits
// immediately above/below in the current order; a no-op at either end of
// the list (nothing to swap with) rather than an error.
async function moveSystem(systemId, direction) {
  if (direction !== 'up' && direction !== 'down') return { ok: false, error: 'Invalid direction.' };
  return withServiceClient(async (svc) => {
    const { rows: sysRows } = await svc.query('SELECT * FROM monitored_systems WHERE id = $1', [systemId]);
    const system = sysRows[0];
    if (!system) return { ok: false, error: 'Not found.' };
    const { rows: siblings } = await svc.query(
      `SELECT id, sort_order FROM monitored_systems WHERE location_id = $1 AND active = true ORDER BY sort_order, category, name`,
      [system.location_id]
    );
    const idx = siblings.findIndex((s) => s.id === systemId);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx === -1 || swapIdx < 0 || swapIdx >= siblings.length) return { ok: true }; // already at the edge — nothing to do
    const other = siblings[swapIdx];
    await svc.query('UPDATE monitored_systems SET sort_order = $1 WHERE id = $2', [other.sort_order, systemId]);
    await svc.query('UPDATE monitored_systems SET sort_order = $1 WHERE id = $2', [siblings[idx].sort_order, other.id]);
    return { ok: true };
  });
}

async function addSystem({ locationId, category, kind, name, externalRef, config, make, model, serialNumber, addedBy }) {
  if (!locationId || !category || !kind || !name) {
    return { ok: false, error: 'Location, category, kind, and name are all required.' };
  }
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query(
      `INSERT INTO monitored_systems (location_id, category, kind, name, external_ref, config, make, model, serial_number, added_by, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM monitored_systems WHERE location_id = $1))
       RETURNING *`,
      [locationId, category, kind, name, externalRef || null, JSON.stringify(config || {}), make || null, model || null, serialNumber || null, addedBy]
    );
    return { ok: true, system: rows[0] };
  });
}

// Equipment details can change after registration (a nameplate gets read,
// a unit gets swapped, it moves location) — mirrors employees.js's
// ownerUpdateEmployee shape: full replace of the editable fields, manager/
// owner only (enforced in the route handler), any time, not just at
// add-time. external_ref is deliberately excluded — that's the poll-
// matching key (the UniFi device id), not something to hand-edit here.
async function updateSystem({ id, locationId, category, kind, name, make, model, serialNumber }) {
  if (!locationId || !category || !kind || !name) {
    return { ok: false, error: 'Location, category, kind, and name are all required.' };
  }
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query(
      `UPDATE monitored_systems
       SET location_id = $1, category = $2, kind = $3, name = $4, make = $5, model = $6, serial_number = $7
       WHERE id = $8 RETURNING *`,
      [locationId, category, kind, name, make || null, model || null, serialNumber || null, id]
    );
    if (!rows[0]) return { ok: false, error: 'Not found.' };
    return { ok: true, system: rows[0] };
  });
}

async function archiveSystem(systemId) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('UPDATE monitored_systems SET active = false WHERE id = $1 RETURNING *', [systemId]);
    if (!rows[0]) return { ok: false, error: 'Not found.' };
    return { ok: true, system: rows[0] };
  });
}

// ---------------------------------------------------------------------
// Status history (drill-down) + alerts
// ---------------------------------------------------------------------
async function listStatusHistory(client, systemId, { hours = 24, limit = 500 } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM system_status WHERE system_id = $1 AND checked_at >= now() - ($2 || ' hours')::interval
     ORDER BY checked_at DESC LIMIT $3`,
    [systemId, hours, limit]
  );
  return rows;
}

async function listAlerts(client, { locationId, openOnly } = {}) {
  const clauses = [];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`ms.location_id = $${params.length}`); }
  if (openOnly) clauses.push('sa.closed_at IS NULL');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await client.query(
    `SELECT sa.*, ms.name AS system_name, ms.category, l.name AS location_name,
            (ms.silenced_until IS NOT NULL AND ms.silenced_until > now()) AS silenced
     FROM system_alerts sa
     JOIN monitored_systems ms ON ms.id = sa.system_id
     JOIN locations l ON l.id = ms.location_id
     ${where}
     ORDER BY sa.opened_at DESC LIMIT 200`,
    params
  );
  return rows;
}

// ---------------------------------------------------------------------
// Recording a poll result. An alert row opens on the first bad poll (the
// dashboard goes red right away) and closes on recovery — but who gets
// TOLD, and when, is damped (patch_032, Scotto 2026-09-21):
//
//   * nothing is sent until it has stayed bad for DOWN_BEFORE_NOTIFY_MS;
//     a blip that recovers sooner opens and closes with no notification;
//   * while it stays bad, one reminder every REALERT_INTERVAL_MS;
//   * "back up" goes out only if someone was told it was down;
//   * a silenced system (monitored_systems.silenced_until in the future)
//     gets none of the above — it's still tracked and still red, just
//     quiet. Silence applied mid-outage also stops the reminders.
//
// Runs on the service connection since the poller has no logged-in
// person.
// ---------------------------------------------------------------------
const DOWN_BEFORE_NOTIFY_MS = 3 * 60 * 1000;
const REALERT_INTERVAL_MS = 15 * 60 * 1000;

// silenced_until is a timestamptz; 'infinity' ("until turned back on")
// comes out of pg as the number Infinity, which new Date() can't hold —
// so check for it before the date math.
function isSilenced(system) {
  if (!system || system.silenced_until == null) return false;
  const v = system.silenced_until;
  if (v === Infinity || v === 'infinity' || v === 'Infinity') return true;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t > Date.now() : false;
}

async function recordStatus({ systemId, status, detail }) {
  return withServiceClient(async (svc) => {
    await svc.query(
      'INSERT INTO system_status (system_id, status, detail) VALUES ($1,$2,$3)',
      [systemId, status, detail ? JSON.stringify(detail) : null]
    );

    const { rows: openRows } = await svc.query(
      'SELECT * FROM system_alerts WHERE system_id = $1 AND closed_at IS NULL',
      [systemId]
    );
    const openAlert = openRows[0];
    const isBad = status === 'offline' || status === 'warning';
    const now = Date.now();

    if (isBad && !openAlert) {
      const system = await systemWithLocation(svc, systemId);
      const message = `${system.name} at ${system.location_name} is ${status}.`;
      await svc.query(
        'INSERT INTO system_alerts (system_id, status, message) VALUES ($1,$2,$3)',
        [systemId, status, message]
      );
      // Deliberately no notification here — see DOWN_BEFORE_NOTIFY_MS.
    } else if (isBad && openAlert) {
      const system = await systemWithLocation(svc, systemId);
      if (isSilenced(system)) return;
      const openedFor = now - new Date(openAlert.opened_at).getTime();
      if (!openAlert.notified_at) {
        if (openedFor >= DOWN_BEFORE_NOTIFY_MS) {
          await svc.query('UPDATE system_alerts SET notified_at = now(), last_notified_at = now() WHERE id = $1', [openAlert.id]);
          await notifyAlert(svc, system, openAlert, 'opened').catch((err) => console.error('[monitoring] notifyAlert(opened) error', err));
        }
      } else if (now - new Date(openAlert.last_notified_at || openAlert.notified_at).getTime() >= REALERT_INTERVAL_MS) {
        await svc.query('UPDATE system_alerts SET last_notified_at = now(), reminder_count = reminder_count + 1 WHERE id = $1', [openAlert.id]);
        await notifyAlert(svc, system, { ...openAlert, reminder_count: (openAlert.reminder_count || 0) + 1 }, 'reminder').catch((err) => console.error('[monitoring] notifyAlert(reminder) error', err));
      }
    } else if (!isBad && openAlert) {
      await svc.query('UPDATE system_alerts SET closed_at = now() WHERE id = $1', [openAlert.id]);
      if (!openAlert.notified_at) return; // nobody was told it was down, so nothing to close out
      const system = await systemWithLocation(svc, systemId);
      if (isSilenced(system)) return;
      await notifyAlert(svc, system, openAlert, 'closed').catch((err) => console.error('[monitoring] notifyAlert(closed) error', err));
    }
  });
}

// ---------------------------------------------------------------------
// Silencing (manager/owner; enforced in the route). duration is one of
// '1h' | '8h' | '1d' | 'forever' | 'off'. A group silence stamps every
// active system in that location + category — that IS the "system"
// (all TVs at Ticket 1, all network gear at Ticket 2). Anything that
// was already open keeps its alert row; it just stops talking.
// ---------------------------------------------------------------------
const SILENCE_DURATIONS = { '1h': '1 hour', '8h': '8 hours', '1d': '1 day', forever: null };

function silenceUntilSql(duration) {
  if (duration === 'off') return 'NULL';
  if (duration === 'forever') return "'infinity'::timestamptz";
  const interval = SILENCE_DURATIONS[duration];
  if (!interval) return null;
  return `now() + interval '${interval}'`;
}

async function setSilence({ systemId, duration, by }) {
  const untilSql = silenceUntilSql(duration);
  if (!untilSql) return { ok: false, error: 'Pick 1 hour, 8 hours, 1 day, until turned back on, or off.' };
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query(
      `UPDATE monitored_systems SET silenced_until = ${untilSql}, silenced_at = CASE WHEN ${untilSql} IS NULL THEN NULL ELSE now() END, silenced_by = CASE WHEN ${untilSql} IS NULL THEN NULL ELSE $2::uuid END
       WHERE id = $1 RETURNING *`,
      [systemId, by]
    );
    if (!rows[0]) return { ok: false, error: 'Not found.' };
    return { ok: true, system: rows[0] };
  });
}

async function setGroupSilence({ locationId, category, duration, by }) {
  const untilSql = silenceUntilSql(duration);
  if (!untilSql) return { ok: false, error: 'Pick 1 hour, 8 hours, 1 day, until turned back on, or off.' };
  if (!locationId || !category) return { ok: false, error: 'Location and category are required.' };
  return withServiceClient(async (svc) => {
    const { rowCount } = await svc.query(
      `UPDATE monitored_systems SET silenced_until = ${untilSql}, silenced_at = CASE WHEN ${untilSql} IS NULL THEN NULL ELSE now() END, silenced_by = CASE WHEN ${untilSql} IS NULL THEN NULL ELSE $3::uuid END
       WHERE location_id = $1 AND category = $2 AND active = true`,
      [locationId, category, by]
    );
    return { ok: true, count: rowCount };
  });
}

async function systemWithLocation(svc, systemId) {
  const { rows } = await svc.query(
    `SELECT ms.*, l.name AS location_name FROM monitored_systems ms JOIN locations l ON l.id = ms.location_id WHERE ms.id = $1`,
    [systemId]
  );
  return rows[0];
}

// Notified: the owner (every location, unconditionally) + anyone with
// Monitoring access enabled at that specific location (dashboard viewers)
// + anyone assigned via monitoring_alert_routes for this system's
// location/category (routed recipients — e.g. "the kitchen manager gets
// refrigeration alerts at Ticket 1" — regardless of whether that person
// has Monitoring dashboard access at all; routing is about who's
// responsible for the equipment, not who can browse the dashboard).
//
// Bug fixed 2026-09-01: this used to INNER JOIN employee_apps for every
// recipient including the owner, but 'monitoring' was never in
// employees.js's APP_KEYS, so no one — not even the owner — ever had an
// enabled row there. Every alert's recipient list was silently empty.
async function recipientsFor(svc, system) {
  const { rows } = await svc.query(
    `SELECT p.*, mns.notify_channel FROM people p
     LEFT JOIN monitoring_notify_settings mns ON mns.person_id = p.id
     WHERE p.status = 'active' AND (
       p.role = 'owner'
       OR EXISTS (
         SELECT 1 FROM employee_apps ea
         WHERE ea.person_id = p.id AND ea.app_key = 'monitoring' AND ea.enabled = true
           AND (p.location_id = $1 OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.person_id = p.id AND el.location_id = $1))
       )
       OR EXISTS (
         SELECT 1 FROM monitoring_alert_routes r
         WHERE r.person_id = p.id
           AND (r.location_id IS NULL OR r.location_id = $1)
           AND (r.category IS NULL OR r.category = $2)
       )
     )`,
    [system.location_id, system.category]
  );
  return rows;
}

function minutesSince(iso) {
  return Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

// kind: 'opened' (first notice, after the 3-minute hold), 'reminder'
// (every 15 minutes while still down), 'closed' (back to normal).
async function notifyAlert(svc, system, alert, kind) {
  const recipients = await recipientsFor(svc, system);
  const downFor = `${minutesSince(alert.opened_at)} min`;
  const subject = kind === 'opened'
    ? `⚠ ${system.name} is ${alert.status} — ${system.location_name}`
    : kind === 'reminder'
    ? `⚠ Still ${alert.status}: ${system.name} — ${system.location_name} (${downFor})`
    : `✓ ${system.name} recovered — ${system.location_name}`;
  const text = kind === 'opened'
    ? `${alert.message}\n\nDown since: ${alert.opened_at}\n\nYou'll get a reminder every 15 minutes while it stays down, and a note when it recovers. To quiet it, open the app and press Silence on it.`
    : kind === 'reminder'
    ? `${alert.message}\n\nStill ${alert.status}, ${downFor} so far (since ${alert.opened_at}). Reminder ${alert.reminder_count || 1}.\n\nTo quiet it, open the app and press Silence on it.`
    : `${system.name} at ${system.location_name} is back to normal.\n\nWas ${alert.status} from ${alert.opened_at} until now.`;

  for (const person of recipients) {
    const channel = person.notify_channel || 'email'; // default until they set a preference
    if ((channel === 'email' || channel === 'both') && person.email) {
      await notify.sendEmail(svc, 'system_alerts', alert.id, person.email, subject, text);
    }
    if ((channel === 'sms' || channel === 'both') && person.phone) {
      await notify.sendSms(svc, 'system_alerts', alert.id, person.phone, `${subject}\n${alert.message || ''}`.slice(0, 300));
    }
  }
}

// ---------------------------------------------------------------------
// Notification channel preference — self-service, mirrors the
// reminder_settings pattern (no RLS on that table either; scoped by
// req.person.id in the route handler).
// ---------------------------------------------------------------------
async function getNotifySettings(personId) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT * FROM monitoring_notify_settings WHERE person_id = $1', [personId]);
    return rows[0] || { person_id: personId, notify_channel: 'email' };
  });
}

async function setNotifyChannel(personId, channel) {
  if (!['email', 'sms', 'both'].includes(channel)) return { ok: false, error: 'Invalid channel.' };
  return withServiceClient(async (svc) => {
    await svc.query(
      `INSERT INTO monitoring_notify_settings (person_id, notify_channel, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (person_id) DO UPDATE SET notify_channel = $2, updated_at = now()`,
      [personId, channel]
    );
    return { ok: true };
  });
}

// ---------------------------------------------------------------------
// Alert routing admin — who gets notified for a location/category,
// independent of Monitoring dashboard access. locationFilter scopes a
// manager to routes touching their own location (their own assignments
// plus any all-location ones, so they can see what applies to them);
// left undefined for the owner, who sees and can create every route.
// ---------------------------------------------------------------------
async function listAlertRoutes({ locationFilter } = {}) {
  return withServiceClient(async (svc) => {
    const params = [];
    let where = '';
    if (locationFilter) {
      params.push(Array.isArray(locationFilter) ? locationFilter : [locationFilter]);
      where = `WHERE r.location_id = ANY($1::uuid[]) OR r.location_id IS NULL`;
    }
    const { rows } = await svc.query(
      `SELECT r.*, p.name AS person_name, l.name AS location_name
       FROM monitoring_alert_routes r
       JOIN people p ON p.id = r.person_id
       LEFT JOIN locations l ON l.id = r.location_id
       ${where}
       ORDER BY p.name`,
      params
    );
    return rows;
  });
}

async function addAlertRoute({ personId, locationId, category, addedBy }) {
  if (!personId) return { ok: false, error: 'Choose who to notify.' };
  return withServiceClient(async (svc) => {
    const { rows: personRows } = await svc.query(`SELECT id FROM people WHERE id = $1 AND status = 'active'`, [personId]);
    if (!personRows[0]) return { ok: false, error: 'Choose an active employee.' };
    const { rows } = await svc.query(
      `INSERT INTO monitoring_alert_routes (person_id, location_id, category, added_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [personId, locationId || null, category || null, addedBy]
    );
    return { ok: true, route: rows[0] };
  });
}

async function removeAlertRoute(routeId) {
  return withServiceClient(async (svc) => {
    const { rowCount } = await svc.query('DELETE FROM monitoring_alert_routes WHERE id = $1', [routeId]);
    if (!rowCount) return { ok: false, error: 'Not found.' };
    return { ok: true };
  });
}

// ---------------------------------------------------------------------
// UniFi Site Manager poll — no-ops entirely if UNIFI_API_KEY isn't set
// (same "not configured" shape as notify.js), so this is safe to deploy
// and schedule before any key exists. Matches poll results back to
// monitored_systems rows by external_ref (the UniFi device id).
// ---------------------------------------------------------------------
async function pollUnifiSystems() {
  if (!unifiConfigured()) return;

  const systems = await withServiceClient((svc) =>
    svc.query(`SELECT * FROM monitored_systems WHERE active = true AND kind LIKE 'unifi_%' AND external_ref IS NOT NULL`)
      .then((r) => r.rows)
  );
  if (!systems.length) return; // nothing registered yet — deploy-safe empty state

  let devicesById = new Map();
  try {
    const hosts = await unifiRequest('/hosts');
    const hostList = hosts.data || hosts.hosts || hosts || [];
    for (const host of hostList) {
      const hostId = host.id || host.hostId;
      if (!hostId) continue;
      try {
        const deviceResp = await unifiRequest(`/hosts/${hostId}/devices`);
        const deviceList = deviceResp.data || deviceResp.devices || deviceResp || [];
        for (const d of deviceList) devicesById.set(d.id || d.mac || d.deviceId, d);
      } catch (err) {
        console.error(`[monitoring] UniFi devices fetch failed for host ${hostId}`, err.message);
      }
    }
  } catch (err) {
    console.error('[monitoring] UniFi hosts fetch failed', err.message);
    return; // whole poll cycle skipped, not marked offline — an API outage isn't the same as the device being down
  }

  for (const system of systems) {
    const device = devicesById.get(system.external_ref);
    const status = findDeviceStatus(device);
    await recordStatus({ systemId: system.id, status, detail: device || null }).catch((err) =>
      console.error(`[monitoring] recordStatus failed for ${system.name}`, err)
    );
  }
}

// ---------------------------------------------------------------------
// AV Device Health (A9, docs/venue-control-gui-reconciliation.md) — the
// on-site Venue Control agent already polls every TV/receiver it has a
// control path for (agent/lib/poller.js, agent/lib/tv-poller.js, each on
// its own 15-20s cadence) purely to serve the staff UI. This reuses that
// existing poll data rather than standing up a second poller: the agent
// batches its current poller state once a minute (agent/lib/health.js)
// and pushes it here via POST /api/venue/agent/health, which slots each
// TV/source into monitored_systems (auto-registering it under category
// 'av' the first time it's seen) and hands the result to the same
// recordStatus() every other monitored category already uses — so an AV
// alert opens/closes and notifies exactly like a network switch or a
// walk-in cooler would, no separate code path.
//
// One monitored_systems row per (location, kind, external_ref): kind is
// 'vc_tv' or 'vc_source', external_ref is that row's vc_tvs.id / the
// source's slot number (both stable identifiers the agent already has on
// every poll — matches pollUnifiSystems' external_ref-matching convention
// above). Auto-registered on first sight rather than requiring someone to
// pre-add every TV by hand in the Monitoring admin, since Venue Control's
// own TVs/Sources admin (public/venue-control.html) is already the real
// inventory of what should exist; the agent reporting it is what makes it
// "seen" here.
async function reportAvHealth({ locationId, items }) {
  if (!locationId) return { ok: false, error: 'Missing location.' };
  if (!Array.isArray(items) || !items.length) return { ok: true, count: 0 };

  let count = 0;
  for (const item of items) {
    const { targetType, targetId, name, status, detail } = item || {};
    if ((targetType !== 'tv' && targetType !== 'source') || targetId == null || !status) continue;
    if (!['online', 'offline', 'warning', 'unknown'].includes(status)) continue;

    const kind = targetType === 'tv' ? 'vc_tv' : 'vc_source';
    const externalRef = String(targetId);

    const systemId = await withServiceClient(async (svc) => {
      const { rows: existing } = await svc.query(
        `SELECT id, name FROM monitored_systems
         WHERE location_id = $1 AND category = 'av' AND kind = $2 AND external_ref = $3`,
        [locationId, kind, externalRef]
      );
      if (existing[0]) {
        if (name && name !== existing[0].name) {
          await svc.query('UPDATE monitored_systems SET name = $1 WHERE id = $2', [name, existing[0].id]);
        }
        return existing[0].id;
      }
      const { rows: inserted } = await svc.query(
        `INSERT INTO monitored_systems (location_id, category, kind, name, external_ref, sort_order)
         VALUES ($1, 'av', $2, $3, $4,
           (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM monitored_systems WHERE location_id = $1))
         RETURNING id`,
        [locationId, kind, name || `${targetType} ${externalRef}`, externalRef]
      );
      return inserted[0].id;
    });

    await recordStatus({ systemId, status, detail });
    count++;
  }
  return { ok: true, count };
}

module.exports = {
  setSilence, setGroupSilence, isSilenced, DOWN_BEFORE_NOTIFY_MS, REALERT_INTERVAL_MS,
  requireMonitoringAccess, listSystems, addSystem, updateSystem, archiveSystem, moveSystem,
  listStatusHistory, listAlerts, recordStatus,
  getNotifySettings, setNotifyChannel,
  listAlertRoutes, addAlertRoute, removeAlertRoute,
  pollUnifiSystems, unifiConfigured,
  reportAvHealth,
  getCriticalSystemsStatus,
};
