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
async function listSystems(client, { locationId } = {}) {
  const clauses = ['ms.active = true'];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`ms.location_id = $${params.length}`); }
  const { rows } = await client.query(
    `SELECT ms.*, l.name AS location_name,
            (SELECT status FROM system_status ss WHERE ss.system_id = ms.id ORDER BY checked_at DESC LIMIT 1) AS last_status,
            (SELECT checked_at FROM system_status ss WHERE ss.system_id = ms.id ORDER BY checked_at DESC LIMIT 1) AS last_checked_at,
            (SELECT id FROM system_alerts sa WHERE sa.system_id = ms.id AND sa.closed_at IS NULL LIMIT 1) AS open_alert_id
     FROM monitored_systems ms JOIN locations l ON l.id = ms.location_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY l.name, ms.category, ms.name`,
    params
  );
  return rows;
}

async function addSystem({ locationId, category, kind, name, externalRef, config, addedBy }) {
  if (!locationId || !category || !kind || !name) {
    return { ok: false, error: 'Location, category, kind, and name are all required.' };
  }
  return withServiceClient(async (svc) => {
    // Defense-in-depth backstop for the client-side Ticket 3 filter in
    // public/monitoring.js — Ticket 3 is being sold and is deliberately
    // out of scope for monitoring (see db/patch_010_monitoring.sql), so
    // reject a system registration for it even if a request bypasses the
    // UI (a direct API call, a stale cached page, etc).
    const { rows: locRows } = await svc.query('SELECT name FROM locations WHERE id = $1', [locationId]);
    if (locRows[0] && locRows[0].name === 'Ticket 3') {
      return { ok: false, error: 'Ticket 3 is out of scope for Systems Monitoring.' };
    }
    const { rows } = await svc.query(
      `INSERT INTO monitored_systems (location_id, category, kind, name, external_ref, config, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [locationId, category, kind, name, externalRef || null, JSON.stringify(config || {}), addedBy]
    );
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
    `SELECT sa.*, ms.name AS system_name, ms.category, l.name AS location_name
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
// Recording a poll result — opens an alert on a good->bad transition,
// closes it on recovery, and fans out a notification either way. Runs
// on the service connection since the poller has no logged-in person.
// ---------------------------------------------------------------------
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

    if (isBad && !openAlert) {
      const system = await systemWithLocation(svc, systemId);
      const message = `${system.name} at ${system.location_name} is ${status}.`;
      const { rows } = await svc.query(
        'INSERT INTO system_alerts (system_id, status, message) VALUES ($1,$2,$3) RETURNING *',
        [systemId, status, message]
      );
      await notifyAlert(svc, system, rows[0], 'opened').catch((err) => console.error('[monitoring] notifyAlert(opened) error', err));
    } else if (!isBad && openAlert) {
      await svc.query('UPDATE system_alerts SET closed_at = now() WHERE id = $1', [openAlert.id]);
      const system = await systemWithLocation(svc, systemId);
      await notifyAlert(svc, system, openAlert, 'closed').catch((err) => console.error('[monitoring] notifyAlert(closed) error', err));
    }
  });
}

async function systemWithLocation(svc, systemId) {
  const { rows } = await svc.query(
    `SELECT ms.*, l.name AS location_name FROM monitored_systems ms JOIN locations l ON l.id = ms.location_id WHERE ms.id = $1`,
    [systemId]
  );
  return rows[0];
}

// Notified: the owner (every location) plus anyone else with monitoring
// access at that specific location — deliberately the same set of people
// who could see this alert in the dashboard under RLS (monitored_systems_select).
async function recipientsFor(svc, system) {
  const { rows } = await svc.query(
    `SELECT p.*, mns.notify_channel FROM people p
     JOIN employee_apps ea ON ea.person_id = p.id AND ea.app_key = 'monitoring' AND ea.enabled = true
     LEFT JOIN monitoring_notify_settings mns ON mns.person_id = p.id
     WHERE p.status = 'active' AND (p.role = 'owner' OR p.location_id = $1)`,
    [system.location_id]
  );
  return rows;
}

async function notifyAlert(svc, system, alert, kind) {
  const recipients = await recipientsFor(svc, system);
  const subject = kind === 'opened'
    ? `⚠ ${system.name} is ${alert.status} — ${system.location_name}`
    : `✓ ${system.name} recovered — ${system.location_name}`;
  const text = kind === 'opened'
    ? `${alert.message}\n\nOpened: ${alert.opened_at}\n\nOpen the app to view.`
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

module.exports = {
  requireMonitoringAccess, listSystems, addSystem, archiveSystem,
  listStatusHistory, listAlerts, recordStatus,
  getNotifySettings, setNotifyChannel,
  pollUnifiSystems, unifiConfigured,
};
