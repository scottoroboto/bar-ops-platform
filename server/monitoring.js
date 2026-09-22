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
const servicecalls = require('./servicecalls');

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || 'America/Chicago';

// Wall-clock parts in the bar's own timezone (never the server's UTC).
function barParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = {};
  dtf.formatToParts(date).forEach((p) => { if (p.type !== 'literal') parts[p.type] = p.value; });
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), hhmm: `${parts.hour}:${parts.minute}` };
}

// Are TVs expected on at this bar right now? av_hours_start/end are
// 'HH:MM[:SS]'; end before start means the window crosses midnight
// (the default 10:00 -> 02:00). Equal = always.
function withinAvHours(location, date = new Date()) {
  const start = String(location.av_hours_start || '10:00').slice(0, 5);
  const end = String(location.av_hours_end || '02:00').slice(0, 5);
  if (start === end) return true;
  const now = barParts(date).hhmm;
  return start < end ? (now >= start && now < end) : (now >= start || now < end);
}

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
  const res = await fetch(path.startsWith('http') ? path : `${UNIFI_API_BASE}${path}`, {
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
// WAN speed par (Scotto, 2026-09-22): each internet line is registered
// as kind 'unifi_wan' with an expected speed ("par", e.g. 1000 Mbps for
// fiber, 300 for cable) and a warn percentage (default 70). Every poll
// compares the latest measured download against par: at or above the
// percentage is green, below it is orange, no reading / line down is
// red. Pure, so it's testable without the API.
// ---------------------------------------------------------------------
const DEFAULT_WARN_PCT = 70;

function wanConfig(system) {
  const c = (system && system.config) || {};
  return {
    hostId: c.hostId || c.host_id || null,
    wan: String(c.wan || 'wan').toLowerCase(), // 'wan' = whichever line UniFi reports as active
    parMbps: Number(c.par_mbps) > 0 ? Number(c.par_mbps) : null,
    warnPct: Number(c.warn_pct) > 0 ? Number(c.warn_pct) : DEFAULT_WARN_PCT,
  };
}

function speedStatus({ downloadMbps, parMbps, warnPct = DEFAULT_WARN_PCT, up = true }) {
  if (up === false) return { status: 'offline', pct: null };
  if (downloadMbps == null || !Number.isFinite(Number(downloadMbps))) return { status: 'unknown', pct: null };
  // UniFi reports 0/0 when the console has never run a speed test — that's
  // "no reading", not a dead-slow line (seen on the T1 UDM, 2026-09-22).
  if (Number(downloadMbps) === 0) return { status: 'unknown', pct: null };
  if (!parMbps) return { status: 'online', pct: null }; // no par set yet: up is up
  const pct = Math.round((Number(downloadMbps) / parMbps) * 100);
  return { status: pct >= warnPct ? 'online' : 'warning', pct };
}

// Pulls one number out of the several shapes Ubiquiti has used for a
// WAN throughput field: a plain kbps number, {kbps}, {value}, {speed}.
function kbpsOf(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    for (const k of ['kbps', 'value', 'speed', 'avg', 'bps']) {
      if (typeof v[k] === 'number') return k === 'bps' ? v[k] / 1000 : v[k];
    }
  }
  return null;
}

// Latest WAN sample for a host from an ISP-metrics response
// (GET https://api.ui.com/ea/isp-metrics/5m): data[] -> { hostId,
// periods[] -> { metricTime, data: { wan: {...} } } }. Defensive about
// where hostId sits and which WAN key is present, and returns null (not
// a throw) when nothing matches.
function latestWanSample(metricsResp, hostId, wanKey) {
  const items = (metricsResp && (metricsResp.data || metricsResp)) || [];
  const mine = (Array.isArray(items) ? items : []).filter((it) => {
    const h = it.hostId || it.host_id || (it.host && it.host.id) || it.siteId;
    return !hostId || !h || String(h) === String(hostId);
  });
  let best = null;
  for (const it of mine) {
    for (const period of it.periods || []) {
      const d = period.data || {};
      const wan = d[wanKey] || d.wan || (d.wans && (d.wans[wanKey] || d.wans[0])) || null;
      if (!wan) continue;
      const t = new Date(period.metricTime || period.time || 0).getTime();
      if (!best || t > best.t) best = { t, wan, metricTime: period.metricTime || null };
    }
  }
  if (!best) return null;
  const w = best.wan;
  const downloadKbps = kbpsOf(w.download_kbps ?? w.downloadKbps ?? w.download);
  const uploadKbps = kbpsOf(w.upload_kbps ?? w.uploadKbps ?? w.upload);
  const uptime = typeof w.uptime === 'number' ? w.uptime : null;
  const downtime = typeof w.downtime === 'number' ? w.downtime : null;
  return {
    metricTime: best.metricTime,
    downloadMbps: downloadKbps == null ? null : Math.round(downloadKbps / 100) / 10,
    uploadMbps: uploadKbps == null ? null : Math.round(uploadKbps / 100) / 10,
    latencyMs: typeof w.avgLatency === 'number' ? w.avgLatency : null,
    packetLoss: typeof w.packetLoss === 'number' ? w.packetLoss : null,
    // down = no uptime in the period while there was downtime, or an explicit flag
    up: w.up === false || w.status === 'down' ? false : !(uptime === 0 && downtime > 0),
    ispName: w.ispName || null,
  };
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
            (SELECT detail FROM system_status ss WHERE ss.system_id = ms.id ORDER BY checked_at DESC LIMIT 1) AS last_detail,
            (SELECT id FROM system_alerts sa WHERE sa.system_id = ms.id AND sa.closed_at IS NULL LIMIT 1) AS open_alert_id,
            (SELECT service_call_id FROM system_alerts sa WHERE sa.system_id = ms.id AND sa.closed_at IS NULL LIMIT 1) AS open_service_call_id,
            (SELECT expected_on FROM system_alerts sa WHERE sa.system_id = ms.id AND sa.closed_at IS NULL LIMIT 1) AS open_alert_expected_on,
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
async function updateSystem({ id, locationId, category, kind, name, make, model, serialNumber, config }) {
  if (!locationId || !category || !kind || !name) {
    return { ok: false, error: 'Location, category, kind, and name are all required.' };
  }
  return withServiceClient(async (svc) => {
    // config (par_mbps, warn_pct, hostId, wan) is merged over what's there,
    // so an edit that doesn't mention it leaves it alone.
    const { rows } = await svc.query(
      `UPDATE monitored_systems
       SET location_id = $1, category = $2, kind = $3, name = $4, make = $5, model = $6, serial_number = $7,
           config = COALESCE(config, '{}'::jsonb) || COALESCE($9::jsonb, '{}'::jsonb)
       WHERE id = $8 RETURNING *`,
      [locationId, category, kind, name, make || null, model || null, serialNumber || null, id, config && typeof config === 'object' ? JSON.stringify(config) : null]
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
// Recording a poll result (redesigned 2026-09-22, patch_034). An alert
// row opens on the first bad poll (the dashboard goes red right away)
// and closes on recovery. Who is TOLD:
//
//   * nothing until it has stayed bad for DOWN_BEFORE_NOTIFY_MS; a blip
//     that recovers sooner opens and closes with no notification;
//   * TVs & AV ('av'): never emailed from here. The on-site box shows
//     the TV on the bar's iPad (getAttention) and the bartender decides:
//     Turn On, Clear (silence), or Service call (agentServiceCall, which
//     is the one path that emails for a TV). Outside the bar's TV hours
//     a dark TV is normal, so the alert opens with expected_on=false and
//     is never flagged or summarised.
//   * every other category: one email per bar per category listing
//     everything that just became eligible (a pile-up is one email),
//     to people whose setting for that category is "right away"; one
//     "recovered" when it comes back. No reminders — the 6am summary
//     carries what's still down.
//   * a silenced system gets none of the above.
//
// Runs on the service connection since the poller has no logged-in
// person.
// ---------------------------------------------------------------------
const DOWN_BEFORE_NOTIFY_MS = 3 * 60 * 1000;
// Per bar-day, all categories; the 6am summary is outside it. 30 because
// Resend's free plan allows 100 emails a day total and sign-in codes,
// credentials and service-call notices share that pool. Raise it with
// the ALERT_EMAIL_DAILY_BUDGET env var (Render -> Environment) once the
// email plan allows more.
const DAILY_ALERT_EMAIL_BUDGET = Number(process.env.ALERT_EMAIL_DAILY_BUDGET) > 0 ? Number(process.env.ALERT_EMAIL_DAILY_BUDGET) : 30;

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
      const expectedOn = system.category === 'av' ? withinAvHours(system) : true;
      await svc.query(
        'INSERT INTO system_alerts (system_id, status, message, expected_on) VALUES ($1,$2,$3,$4)',
        [systemId, status, message, expectedOn]
      );
      // Deliberately no notification here — see DOWN_BEFORE_NOTIFY_MS.
    } else if (isBad && openAlert) {
      if (openAlert.notified_at || !openAlert.expected_on) return;
      if (now - new Date(openAlert.opened_at).getTime() < DOWN_BEFORE_NOTIFY_MS) return;
      const system = await systemWithLocation(svc, systemId);
      if (isSilenced(system) || system.category === 'av') return; // av: the bar's iPad handles it
      await notifyGroupOpened(svc, system).catch((err) => console.error('[monitoring] notify(opened) error', err));
    } else if (!isBad && openAlert) {
      await svc.query('UPDATE system_alerts SET closed_at = now() WHERE id = $1', [openAlert.id]);
      if (!openAlert.notified_at) return; // nobody was told it was down, so nothing to close out
      const system = await systemWithLocation(svc, systemId);
      if (isSilenced(system)) return;
      await notifyAlert(svc, system, openAlert, 'closed').catch((err) => console.error('[monitoring] notify(closed) error', err));
    }
  });
}

// Everything at this bar, in this category, that is open, past the hold,
// unsilenced and not yet announced — announced together, once.
async function notifyGroupOpened(svc, system) {
  const { rows: alerts } = await svc.query(
    `SELECT sa.*, ms.name AS system_name FROM system_alerts sa
     JOIN monitored_systems ms ON ms.id = sa.system_id
     WHERE ms.location_id = $1 AND ms.category = $2 AND ms.active = true
       AND sa.closed_at IS NULL AND sa.notified_at IS NULL AND sa.expected_on = true
       AND sa.opened_at <= now() - ($3 || ' milliseconds')::interval
       AND (ms.silenced_until IS NULL OR ms.silenced_until <= now())
     ORDER BY sa.opened_at`,
    [system.location_id, system.category, DOWN_BEFORE_NOTIFY_MS]
  );
  if (!alerts.length) return;
  await svc.query('UPDATE system_alerts SET notified_at = now(), last_notified_at = now() WHERE id = ANY($1::uuid[])', [alerts.map((a) => a.id)]);
  await notifyAlert(svc, system, alerts.length === 1 ? alerts[0] : alerts, 'opened');
}

// ---------------------------------------------------------------------
// Silencing (manager/owner from the app; the bar's iPad via Clear).
// duration: '1h' | '8h' | '1d' | 'today' | '3d' | '7d' | 'forever' | 'off'.
// 'today' = until 6am tomorrow, bar time (the summary hour). A group
// silence stamps every active system in that location + category.
// ---------------------------------------------------------------------
function silenceUntil(duration) {
  const now = Date.now();
  switch (duration) {
    case 'off': return null;
    case '1h': return new Date(now + 3600e3);
    case '8h': return new Date(now + 8 * 3600e3);
    case '1d': return new Date(now + 24 * 3600e3);
    case '3d': return new Date(now + 3 * 24 * 3600e3);
    case '7d': return new Date(now + 7 * 24 * 3600e3);
    case 'today': return nextSixAm();
    case 'forever': return 'infinity';
    default: return undefined;
  }
}

// The next 06:00 in the bar's timezone, as a real instant: step forward
// in 15-minute ticks until the bar clock reads 06:00.
function nextSixAm(from = new Date()) {
  const step = 15 * 60 * 1000;
  let t = new Date(Math.ceil((from.getTime() + 1) / step) * step);
  for (let i = 0; i < 24 * 4 + 4; i++) {
    const q = barParts(t);
    if (q.hour === 6 && q.minute === 0) return t;
    t = new Date(t.getTime() + step);
  }
  return new Date(from.getTime() + 24 * 3600e3);
}

async function setSilence({ systemId, duration, by }) {
  const until = silenceUntil(duration);
  if (until === undefined) return { ok: false, error: 'Pick 1 hour, 8 hours, 1 day, the rest of today, 3 days, 7 days, until turned back on, or off.' };
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query(
      `UPDATE monitored_systems SET silenced_until = $2, silenced_at = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE now() END, silenced_by = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE $3::uuid END
       WHERE id = $1 RETURNING *`,
      [systemId, until, by || null]
    );
    if (!rows[0]) return { ok: false, error: 'Not found.' };
    return { ok: true, system: rows[0] };
  });
}

async function setGroupSilence({ locationId, category, duration, by }) {
  const until = silenceUntil(duration);
  if (until === undefined) return { ok: false, error: 'Pick 1 hour, 8 hours, 1 day, the rest of today, 3 days, 7 days, until turned back on, or off.' };
  if (!locationId || !category) return { ok: false, error: 'Location and category are required.' };
  return withServiceClient(async (svc) => {
    const { rowCount } = await svc.query(
      `UPDATE monitored_systems SET silenced_until = $3, silenced_at = CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE now() END, silenced_by = CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE $4::uuid END
       WHERE location_id = $1 AND category = $2 AND active = true`,
      [locationId, category, until, by || null]
    );
    return { ok: true, count: rowCount };
  });
}

// ---------------------------------------------------------------------
// The bar's iPad (TV Staff page on the on-site box) — patch_034.
// getAttention: TVs at this bar that have been unreachable for 3+ minutes
// during TV hours, not silenced: what the box shows the bartender.
// agentClear: the Clear button (a silence, by duration).
// agentServiceCall: the Service call button — opens a Service Call for
// the TV and sends the TV alert to everyone set to get TV alerts.
// All three are called by the box with its site token (route handlers
// in server/index.js check the system belongs to that site's location).
// ---------------------------------------------------------------------
async function getAttention(svc, locationId) {
  const { rows } = await svc.query(
    `SELECT sa.id AS alert_id, sa.opened_at, sa.service_call_id, ms.id AS system_id, ms.external_ref, ms.name, ms.kind
     FROM system_alerts sa JOIN monitored_systems ms ON ms.id = sa.system_id
     WHERE ms.location_id = $1 AND ms.category = 'av' AND ms.kind = 'vc_tv' AND ms.active = true
       AND sa.closed_at IS NULL AND sa.expected_on = true
       AND sa.opened_at <= now() - ($2 || ' milliseconds')::interval
       AND (ms.silenced_until IS NULL OR ms.silenced_until <= now())
     ORDER BY sa.opened_at`,
    [locationId, DOWN_BEFORE_NOTIFY_MS]
  );
  return rows.map((r) => ({
    alertId: r.alert_id, systemId: r.system_id, tvId: r.external_ref, name: r.name,
    since: r.opened_at, serviceCallId: r.service_call_id,
  }));
}

async function systemAtLocation(svc, systemId, locationId) {
  const s = await systemWithLocation(svc, systemId);
  return s && String(s.location_id) === String(locationId) ? s : null;
}

async function agentClear({ locationId, systemId, duration }) {
  return withServiceClient(async (svc) => {
    const system = await systemAtLocation(svc, systemId, locationId);
    if (!system) return { ok: false, error: 'Not found.' };
    const r = await setSilence({ systemId, duration, by: null });
    if (!r.ok) return r;
    return { ok: true, silencedUntil: r.system.silenced_until, attention: await getAttention(svc, locationId) };
  });
}

// Which Service Call destinations a bar-raised TV call goes to: the
// owner-editable list (owner_notes 'av_service_call_destinations',
// comma-separated ids), else every active destination named
// "Maintenance" or starting "Owner".
async function avServiceCallDestinations(svc) {
  const { rows: note } = await svc.query("SELECT body FROM owner_notes WHERE note_key = 'av_service_call_destinations'");
  const ids = note[0] && note[0].body ? note[0].body.split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (ids.length) {
    const { rows } = await svc.query('SELECT id FROM service_call_destinations WHERE active = true AND id = ANY($1::uuid[])', [ids]);
    if (rows.length) return rows.map((r) => r.id);
  }
  const { rows } = await svc.query(
    `SELECT id FROM service_call_destinations WHERE active = true AND (name ILIKE 'maintenance%' OR name ILIKE 'owner%') ORDER BY name`
  );
  return rows.map((r) => r.id);
}

async function agentServiceCall({ locationId, systemId }) {
  return withServiceClient(async (svc) => {
    const system = await systemAtLocation(svc, systemId, locationId);
    if (!system) return { ok: false, error: 'Not found.' };
    const { rows: alerts } = await svc.query('SELECT * FROM system_alerts WHERE system_id = $1 AND closed_at IS NULL', [systemId]);
    const alert = alerts[0];
    if (!alert) return { ok: false, error: 'That TV is back — nothing to report.' };
    if (alert.service_call_id) return { ok: true, serviceCallId: alert.service_call_id, already: true, attention: await getAttention(svc, locationId) };

    // Filed under the owner (a service call needs a person; the bar's
    // iPad isn't one), routed to the TV destinations, equipment "TV".
    const { rows: owners } = await svc.query(`SELECT id FROM people WHERE role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1`);
    if (!owners[0]) return { ok: false, error: 'No owner account to file the call under.' };
    const { rows: eq } = await svc.query(`SELECT id FROM equipment_types WHERE active = true AND name ILIKE 'tv%' ORDER BY name LIMIT 1`);
    const destinationIds = await avServiceCallDestinations(svc);
    const since = alert.opened_at;
    const description = `${system.name} isn't responding — reported from the ${system.location_name} TV Staff page. Down since ${since instanceof Date ? since.toLocaleString('en-US', { timeZone: BUSINESS_TZ }) : since}. Turn On from the iPad didn't bring it back.`;
    const { rows: created } = await svc.query(
      `INSERT INTO service_calls (location_id, equipment_type_id, equipment_other, description, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [locationId, eq[0] ? eq[0].id : null, eq[0] ? null : 'TV', description, owners[0].id]
    );
    const callId = created[0].id;
    if (destinationIds.length) {
      const values = destinationIds.map((_, i) => `($1, $${i + 2})`).join(',');
      await svc.query(`INSERT INTO service_call_recipients (call_id, destination_id) VALUES ${values}`, [callId, ...destinationIds]);
    }
    await svc.query('UPDATE system_alerts SET service_call_id = $1, notified_at = now(), last_notified_at = now() WHERE id = $2', [callId, alert.id]);
    const call = await servicecalls.getCall(svc, callId);
    if (call) await servicecalls.notifyNewCall(svc, call).catch((err) => console.error('[monitoring] service call notify error', err));
    await notifyAlert(svc, system, { ...alert, service_call_id: callId }, 'service_call').catch((err) => console.error('[monitoring] notify(service_call) error', err));
    return { ok: true, serviceCallId: callId, attention: await getAttention(svc, locationId) };
  });
}

// ---------------------------------------------------------------------
// TV hours per location (manager/owner).
// ---------------------------------------------------------------------
async function setAvHours({ locationId, start, end }) {
  const ok = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
  if (!ok(start) || !ok(end)) return { ok: false, error: 'Times need to look like 10:00 and 02:00.' };
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('UPDATE locations SET av_hours_start = $2, av_hours_end = $3 WHERE id = $1 RETURNING id, name, av_hours_start, av_hours_end', [locationId, start, end]);
    if (!rows[0]) return { ok: false, error: 'Not found.' };
    return { ok: true, location: rows[0] };
  });
}

async function systemWithLocation(svc, systemId) {
  const { rows } = await svc.query(
    `SELECT ms.*, l.name AS location_name FROM monitored_systems ms JOIN locations l ON l.id = ms.location_id WHERE ms.id = $1`,
    [systemId]
  );
  return rows[0];
}

// Who could be told about this system at all: the owner (every
// location), anyone with Monitoring access at one of that system's bar
// (people can work at several bars — patch_033), and anyone routed to it
// via monitoring_alert_routes. Each comes back with their channel and
// per-category prefs; modeFor() then says whether they want this
// category right away, in the daily summary, or not at all.
//
// Bug fixed 2026-09-01: this used to INNER JOIN employee_apps for every
// recipient including the owner, but 'monitoring' was never in
// employees.js's APP_KEYS, so no one — not even the owner — ever had an
// enabled row there. Every alert's recipient list was silently empty.
const DEFAULT_MODE = { av: 'daily' }; // everything else: 'immediate'
const MODES = ['off', 'immediate', 'daily'];
function modeFor(prefs, category) {
  const p = prefs && prefs[category];
  return MODES.includes(p) ? p : (DEFAULT_MODE[category] || 'immediate');
}

async function recipientsFor(svc, system) {
  const { rows } = await svc.query(
    `SELECT p.*, mns.notify_channel, mns.prefs FROM people p
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

// Alert emails sent so far this bar-day (the 6am summary is logged under
// its own related_table and doesn't count).
async function alertEmailsSentToday(svc) {
  const { rows } = await svc.query(
    `SELECT count(*)::int AS n FROM notifications_log
     WHERE related_table = 'system_alerts' AND channel = 'email' AND status IN ('sent','simulated')
       AND sent_at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`,
    [BUSINESS_TZ]
  );
  return rows[0].n;
}

function minutesSince(iso) {
  return Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

// kind: 'opened' (after the 3-minute hold; `alert` may be an array when
// several things at the bar dropped together), 'closed' (back to normal),
// 'service_call' (the bar's iPad escalated a TV). Right-away people get
// opened/closed; a service call goes to everyone who gets TV alerts at
// all, right away or daily — that's the point of the button.
async function notifyAlert(svc, system, alert, kind) {
  const alerts = Array.isArray(alert) ? alert : [alert];
  const first = alerts[0];
  const category = system.category;
  const catLabel = { network: 'network device', av: 'TV', hvac: 'HVAC unit', refrigeration: 'cooler', freezer: 'freezer', ice_machine: 'ice machine', power: 'power' }[category] || 'system';
  const recipients = (await recipientsFor(svc, system)).filter((p) => {
    const mode = modeFor(p.prefs, category);
    return kind === 'service_call' ? mode !== 'off' : mode === 'immediate';
  });
  if (!recipients.length) return;

  const names = alerts.map((a) => a.system_name || system.name);
  let subject; let text;
  if (kind === 'opened') {
    subject = alerts.length === 1
      ? `⚠ ${names[0]} is ${first.status} — ${system.location_name}`
      : `⚠ ${alerts.length} ${catLabel}s ${first.status} — ${system.location_name}`;
    text = (alerts.length === 1 ? `${first.message}\n\n` : `${alerts.length} ${catLabel}s at ${system.location_name} went ${first.status} together:\n${names.map((n) => `  • ${n}`).join('\n')}\n\n`)
      + `Down since: ${first.opened_at}\n\nYou'll get one note when it recovers. Anything still down is in the 6am summary. To quiet it, open the app and press Silence on it.`;
  } else if (kind === 'service_call') {
    subject = `⚠ TV needs service: ${system.name} — ${system.location_name}`;
    text = `The bar reported ${system.name} at ${system.location_name} from the TV Staff page. It has been unreachable since ${first.opened_at} and Turn On didn't bring it back.\n\nA service call has been opened (Service Calls app). Open the app to view.`;
  } else {
    subject = `✓ ${system.name} recovered — ${system.location_name}`;
    text = `${system.name} at ${system.location_name} is back to normal.\n\nWas ${first.status} from ${first.opened_at} until now.`;
  }

  let sentToday = await alertEmailsSentToday(svc);
  for (const person of recipients) {
    const channel = person.notify_channel || 'email'; // default until they set a preference
    if ((channel === 'email' || channel === 'both') && person.email) {
      if (sentToday >= DAILY_ALERT_EMAIL_BUDGET) {
        console.warn(`[monitoring] daily alert email budget (${DAILY_ALERT_EMAIL_BUDGET}) reached — not emailing ${person.email}: ${subject}`);
        await svc.query(
          `INSERT INTO notifications_log (related_table, related_id, channel, recipient, status, detail) VALUES ('system_alerts', $1, 'email', $2, 'budget', $3)`,
          [first.id, person.email, subject]
        );
      } else {
        await notify.sendEmail(svc, 'system_alerts', first.id, person.email, subject, text);
        sentToday++;
      }
    }
    if ((channel === 'sms' || channel === 'both') && person.phone) {
      await notify.sendSms(svc, 'system_alerts', first.id, person.phone, `${subject}\n${first.message || ''}`.slice(0, 300));
    }
  }
}

// ---------------------------------------------------------------------
// The 6am daily summary (patch_034). One email per person, covering the
// bars they work at (owner: all), for the categories they take as a
// daily summary: everything still down (silenced ones marked), and what
// went down and recovered in the last 24 hours. Nothing to say -> no
// email. Runs once per bar-day, guarded by monitoring_summary_runs.
// ---------------------------------------------------------------------
async function runDailySummaryIfDue(now = new Date()) {
  const p = barParts(now);
  if (p.hour !== 6) return { ran: false };
  return withServiceClient(async (svc) => {
    const { rowCount } = await svc.query('INSERT INTO monitoring_summary_runs (run_date) VALUES ($1) ON CONFLICT DO NOTHING', [p.ymd]);
    if (!rowCount) return { ran: false, reason: 'already ran today' };
    const sent = await sendDailySummaries(svc);
    await svc.query('UPDATE monitoring_summary_runs SET sent_count = $2 WHERE run_date = $1', [p.ymd, sent]);
    return { ran: true, sent };
  });
}

async function sendDailySummaries(svc) {
  const { rows: people } = await svc.query(
    `SELECT p.*, mns.notify_channel, mns.prefs,
            ARRAY(SELECT el.location_id FROM employee_locations el WHERE el.person_id = p.id) AS location_ids,
            ARRAY(SELECT r.location_id FROM monitoring_alert_routes r WHERE r.person_id = p.id) AS route_location_ids,
            EXISTS (SELECT 1 FROM monitoring_alert_routes r WHERE r.person_id = p.id AND r.location_id IS NULL) AS routed_everywhere,
            EXISTS (SELECT 1 FROM employee_apps ea WHERE ea.person_id = p.id AND ea.app_key = 'monitoring' AND ea.enabled = true) AS has_app
     FROM people p LEFT JOIN monitoring_notify_settings mns ON mns.person_id = p.id
     WHERE p.status = 'active' AND p.email IS NOT NULL
       AND (p.role = 'owner'
            OR EXISTS (SELECT 1 FROM employee_apps ea WHERE ea.person_id = p.id AND ea.app_key = 'monitoring' AND ea.enabled = true)
            OR EXISTS (SELECT 1 FROM monitoring_alert_routes r WHERE r.person_id = p.id))`
  );
  const { rows: openAlerts } = await svc.query(
    `SELECT sa.*, ms.name AS system_name, ms.category, ms.location_id, l.name AS location_name,
            (ms.silenced_until IS NOT NULL AND ms.silenced_until > now()) AS silenced
     FROM system_alerts sa JOIN monitored_systems ms ON ms.id = sa.system_id JOIN locations l ON l.id = ms.location_id
     WHERE sa.closed_at IS NULL AND sa.expected_on = true AND ms.active = true ORDER BY l.name, ms.category, sa.opened_at`
  );
  const { rows: recovered } = await svc.query(
    `SELECT sa.*, ms.name AS system_name, ms.category, ms.location_id, l.name AS location_name
     FROM system_alerts sa JOIN monitored_systems ms ON ms.id = sa.system_id JOIN locations l ON l.id = ms.location_id
     WHERE sa.closed_at >= now() - interval '24 hours' AND sa.expected_on = true
       AND sa.closed_at - sa.opened_at >= ($1 || ' milliseconds')::interval
     ORDER BY l.name, sa.closed_at DESC`,
    [DOWN_BEFORE_NOTIFY_MS]
  );
  const catName = (c) => ({ network: 'Network', av: 'TVs & AV', hvac: 'HVAC', refrigeration: 'Refrigeration', freezer: 'Freezer', ice_machine: 'Ice machine', power: 'Power', other: 'Other' }[c] || c);
  const fmt = (d) => new Date(d).toLocaleString('en-US', { timeZone: BUSINESS_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let sent = 0;
  for (const person of people) {
    const everywhere = person.role === 'owner' || person.routed_everywhere;
    const myLocs = new Set([...(person.location_ids || []), ...(person.route_location_ids || [])].filter(Boolean).map(String));
    const wants = (a) => modeFor(person.prefs, a.category) === 'daily' && (everywhere || myLocs.has(String(a.location_id)));
    const down = openAlerts.filter(wants);
    const back = recovered.filter(wants);
    if (!down.length && !back.length) continue;
    const lines = [];
    if (down.length) {
      lines.push(`STILL DOWN (${down.length})`);
      for (const a of down) lines.push(`  • ${a.location_name} — ${catName(a.category)}: ${a.system_name}, since ${fmt(a.opened_at)}${a.silenced ? ' (silenced)' : ''}${a.service_call_id ? ' (service call open)' : ''}`);
      lines.push('');
    }
    if (back.length) {
      lines.push(`WENT DOWN AND CAME BACK, LAST 24 HOURS (${back.length})`);
      for (const a of back) lines.push(`  • ${a.location_name} — ${catName(a.category)}: ${a.system_name}, ${fmt(a.opened_at)} to ${fmt(a.closed_at)}`);
      lines.push('');
    }
    lines.push('Open Systems Monitoring in the app for details. To change what lands in this summary, see Alert Notifications.');
    const subject = down.length ? `Morning summary: ${down.length} thing${down.length === 1 ? '' : 's'} still down` : 'Morning summary: all clear now';
    const r = await notify.sendEmail(svc, 'monitoring_summary', person.id, person.email, subject, lines.join('\n'));
    if (r && r.ok) sent++;
  }
  return sent;
}

// ---------------------------------------------------------------------
// Notification channel preference — self-service, mirrors the
// reminder_settings pattern (no RLS on that table either; scoped by
// req.person.id in the route handler).
// ---------------------------------------------------------------------
const PREF_CATEGORIES = ['network', 'av', 'refrigeration', 'freezer', 'ice_machine', 'hvac', 'power', 'other'];

async function getNotifySettings(personId) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT * FROM monitoring_notify_settings WHERE person_id = $1', [personId]);
    const row = rows[0] || { person_id: personId, notify_channel: 'email', prefs: {} };
    // Resolved view: every category with its effective mode, so the page
    // never has to know the defaults.
    const effective = {};
    for (const c of PREF_CATEGORIES) effective[c] = modeFor(row.prefs, c);
    return { ...row, prefs: row.prefs || {}, effective, defaults: { ...Object.fromEntries(PREF_CATEGORIES.map((c) => [c, DEFAULT_MODE[c] || 'immediate'])) }, dailyBudget: DAILY_ALERT_EMAIL_BUDGET };
  });
}

// channel and/or prefs — either may be omitted. prefs: { category: mode }.
async function setNotifySettings(personId, { channel, prefs } = {}) {
  if (channel !== undefined && !['email', 'sms', 'both'].includes(channel)) return { ok: false, error: 'Invalid channel.' };
  const cleaned = {};
  if (prefs !== undefined) {
    if (!prefs || typeof prefs !== 'object') return { ok: false, error: 'Invalid settings.' };
    for (const [c, m] of Object.entries(prefs)) {
      if (!PREF_CATEGORIES.includes(c)) continue;
      if (!MODES.includes(m)) return { ok: false, error: `Pick Off, Right away, or Daily summary for ${c}.` };
      cleaned[c] = m;
    }
  }
  return withServiceClient(async (svc) => {
    await svc.query(
      `INSERT INTO monitoring_notify_settings (person_id, notify_channel, prefs, updated_at)
       VALUES ($1, COALESCE($2, 'email'), COALESCE($3::jsonb, '{}'::jsonb), now())
       ON CONFLICT (person_id) DO UPDATE SET
         notify_channel = COALESCE($2, monitoring_notify_settings.notify_channel),
         prefs = COALESCE($3::jsonb, monitoring_notify_settings.prefs),
         updated_at = now()`,
      [personId, channel === undefined ? null : channel, prefs === undefined ? null : JSON.stringify(cleaned)]
    );
    return { ok: true };
  });
}
async function setNotifyChannel(personId, channel) { return setNotifySettings(personId, { channel }); }

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
    svc.query(`SELECT * FROM monitored_systems WHERE active = true AND kind LIKE 'unifi_%'`)
      .then((r) => r.rows)
  );
  if (!systems.length) return; // nothing registered yet — deploy-safe empty state

  const deviceSystems = systems.filter((s) => s.kind !== 'unifi_wan' && s.external_ref);
  const wanSystems = systems.filter((s) => s.kind === 'unifi_wan');

  // ---- devices (gateways, switches, APs) ----
  if (deviceSystems.length) {
    const devicesById = new Map();
    try {
      // GET /v1/devices — data[]: { hostId, hostName, devices[]: { id, mac, name, model, ip, status, ... } }
      const resp = await unifiRequest('/devices');
      const groups = resp.data || resp.hosts || (Array.isArray(resp) ? resp : []);
      for (const g of groups) {
        const list = Array.isArray(g.devices) ? g.devices : (Array.isArray(g) ? g : [g]);
        for (const d of list) {
          for (const key of [d.id, d.mac, d.deviceId]) if (key) devicesById.set(String(key).toLowerCase(), d);
        }
      }
    } catch (err) {
      console.error('[monitoring] UniFi devices fetch failed', err.message);
      devicesById.clear();
      // whole device pass skipped, not marked offline — an API outage isn't the device being down
    }
    if (devicesById.size) {
      for (const system of deviceSystems) {
        const device = devicesById.get(String(system.external_ref).toLowerCase());
        const status = findDeviceStatus(device);
        await recordStatus({ systemId: system.id, status, detail: device || null }).catch((err) =>
          console.error(`[monitoring] recordStatus failed for ${system.name}`, err)
        );
      }
    }
  }

  // ---- internet lines: measured speed vs. par ----
  if (wanSystems.length) {
    let metrics = null;
    try {
      const end = new Date();
      const begin = new Date(end.getTime() - 30 * 60 * 1000);
      metrics = await unifiRequest(`https://api.ui.com/ea/isp-metrics/5m?beginTimestamp=${encodeURIComponent(begin.toISOString())}&endTimestamp=${encodeURIComponent(end.toISOString())}`);
    } catch (err) {
      console.error('[monitoring] UniFi ISP metrics fetch failed', err.message);
      return;
    }
    for (const system of wanSystems) {
      const cfg = wanConfig(system);
      const sample = latestWanSample(metrics, cfg.hostId, cfg.wan);
      const { status, pct } = sample
        ? speedStatus({ downloadMbps: sample.downloadMbps, parMbps: cfg.parMbps, warnPct: cfg.warnPct, up: sample.up })
        : { status: 'unknown', pct: null };
      const detail = {
        download_mbps: sample ? sample.downloadMbps : null,
        upload_mbps: sample ? sample.uploadMbps : null,
        latency_ms: sample ? sample.latencyMs : null,
        packet_loss: sample ? sample.packetLoss : null,
        par_mbps: cfg.parMbps, warn_pct: cfg.warnPct, pct_of_par: pct,
        measured_at: sample ? sample.metricTime : null,
      };
      await recordStatus({ systemId: system.id, status, detail }).catch((err) =>
        console.error(`[monitoring] recordStatus failed for ${system.name}`, err)
      );
    }
  }
}

// ---------------------------------------------------------------------
// UniFi connection check (Scotto, 2026-09-22: "walk me through double
// checking"). Calls the API with the configured key and reports, in
// plain terms, what it can see: consoles (hosts), every adopted device
// with the id/MAC the registry needs, and the newest ISP reading per
// console. Never throws — every failure comes back as a message. Run
// once at boot (logged) and on demand from Add / Manage.
// ---------------------------------------------------------------------
function guessKind(d) {
  const m = `${d.model || ''} ${d.shortname || ''} ${d.name || ''} ${(d.uidb && d.uidb.id) || ''}`.toLowerCase();
  if (/udm|ucg|uxg|dream|gateway|usg/.test(m)) return 'unifi_gateway';
  if (/usw|switch|flex/.test(m)) return 'unifi_switch';
  if (/u6|u7|uap|ap |access point|nano|lite|pro ap|beacon/.test(m)) return 'unifi_ap';
  return 'unifi_other';
}

async function unifiProbe() {
  if (!unifiConfigured()) return { ok: false, configured: false, error: 'UNIFI_API_KEY is not set on the server.' };
  const out = { ok: true, configured: true, hosts: [], devices: [], isp: [], errors: [] };
  try {
    const resp = await unifiRequest('/hosts');
    const list = resp.data || resp.hosts || (Array.isArray(resp) ? resp : []);
    for (const h of list) {
      const rs = h.reportedState || {};
      out.hosts.push({
        id: h.id || h.hostId, type: h.type || null, ip: h.ipAddress || rs.ip || null,
        name: rs.hostname || rs.name || (h.userData && h.userData.name) || null,
        state: rs.state || h.state || null,
        wans: Array.isArray(rs.wans) ? rs.wans.map((w) => ({ name: w.name || w.interface || null, up: w.up ?? w.state ?? null, ip: w.ip || null, isp: w.ispName || null })) : null,
      });
    }
  } catch (err) { out.errors.push(`hosts: ${err.message}`); out.ok = false; }
  try {
    const resp = await unifiRequest('/devices');
    const groups = resp.data || resp.hosts || (Array.isArray(resp) ? resp : []);
    for (const g of groups) {
      const list = Array.isArray(g.devices) ? g.devices : [];
      for (const d of list) {
        out.devices.push({ hostId: g.hostId || null, hostName: g.hostName || null, id: d.id || null, mac: d.mac || null, name: d.name || null, model: d.model || d.shortname || null, ip: d.ip || null, status: d.status || d.state || null, kind: guessKind(d), raw: findDeviceStatus(d) });
      }
    }
  } catch (err) { out.errors.push(`devices: ${err.message}`); out.ok = false; }
  // ISP metrics: Ubiquiti has moved this endpoint around (ea vs v1,
  // duration vs begin/end). Try the known spellings in order and keep
  // the first that returns samples; log each attempt's shape so a miss
  // can be diagnosed from the logs alone.
  out.ispAttempts = [];
  let resp = null;
  const end = new Date(); const begin = new Date(end.getTime() - 60 * 60 * 1000);
  const attempts = [
    `https://api.ui.com/ea/isp-metrics/5m?beginTimestamp=${encodeURIComponent(begin.toISOString())}&endTimestamp=${encodeURIComponent(end.toISOString())}`,
    'https://api.ui.com/ea/isp-metrics/5m?duration=24h',
    'https://api.ui.com/ea/isp-metrics/5m',
    'https://api.ui.com/ea/isp-metrics/1h?duration=7d',
    'https://api.ui.com/v1/isp-metrics/5m?duration=24h',
  ];
  for (const url of attempts) {
    try {
      const r = await unifiRequest(url);
      const n = Array.isArray(r.data) ? r.data.length : (Array.isArray(r) ? r.length : 0);
      out.ispAttempts.push({ url: url.replace(/\?.*/, '?…'), items: n, preview: JSON.stringify(r).slice(0, 300) });
      if (n) { resp = r; break; }
    } catch (err) {
      out.ispAttempts.push({ url: url.replace(/\?.*/, '?…'), error: err.message.slice(0, 200) });
    }
  }
  try {
    const items = resp ? (resp.data || resp) : [];
    for (const it of Array.isArray(items) ? items : []) {
      const hostId = it.hostId || it.host_id || null;
      const periods = it.periods || [];
      const last = periods[periods.length - 1];
      const keys = last && last.data ? Object.keys(last.data) : [];
      out.isp.push({
        hostId, periods: periods.length, wanKeys: keys,
        latest: keys.map((k) => ({ wan: k, ...(latestWanSample({ data: [{ hostId, periods: [last] }] }, hostId, k) || {}) })),
        rawLatest: last ? JSON.stringify(last).slice(0, 600) : null,
      });
    }
    if (!out.isp.length) out.errors.push('isp-metrics: no samples came back from any spelling of the endpoint (see attempts). ISP metrics need the console\'s periodic speed test enabled: UniFi Network → Settings → Internet → the WAN → Speed Test.');
  } catch (err) { out.errors.push(`isp-metrics: ${err.message}`); }
  return out;
}

// Logged at boot so a fresh key can be verified from Render's logs
// without signing in anywhere.
async function logUnifiProbe() {
  if (!unifiConfigured()) { console.log('[monitoring] UniFi: no API key set — network polling off'); return; }
  const p = await unifiProbe();
  console.log(`[monitoring] UniFi check: ${p.hosts.length} console(s), ${p.devices.length} device(s), ${p.isp.length} ISP series${p.errors.length ? ' — ' + p.errors.join(' | ') : ''}`);
  for (const h of p.hosts) console.log(`[monitoring]   console ${h.name || '?'} id=${h.id} state=${h.state || '?'} ip=${h.ip || '?'}`);
  for (const d of p.devices) console.log(`[monitoring]   device ${d.name || '?'} model=${d.model || '?'} mac=${d.mac || '?'} id=${d.id || '?'} status=${d.status || '?'} -> ${d.raw} (${d.kind})`);
  for (const a of p.ispAttempts || []) console.log(`[monitoring]   isp try ${a.url}: ${a.error ? 'error ' + a.error : a.items + ' item(s) ' + a.preview}`);
  for (const i of p.isp) console.log(`[monitoring]   isp host=${i.hostId} wans=${i.wanKeys.join(',') || 'none'} latest=${JSON.stringify(i.latest)}`);
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
  // What the bar's iPad should be showing right now (patch_034).
  const attention = await withServiceClient((svc) => getAttention(svc, locationId));
  return { ok: true, count, attention };
}

module.exports = {
  unifiProbe, logUnifiProbe, unifiConfigured,
  speedStatus, wanConfig, latestWanSample, findDeviceStatus, DEFAULT_WARN_PCT,
  setSilence, setGroupSilence, isSilenced, DOWN_BEFORE_NOTIFY_MS, DAILY_ALERT_EMAIL_BUDGET,
  getAttention, agentClear, agentServiceCall, setAvHours, withinAvHours, barParts,
  runDailySummaryIfDue, sendDailySummaries, setNotifySettings, modeFor, PREF_CATEGORIES,
  requireMonitoringAccess, listSystems, addSystem, updateSystem, archiveSystem, moveSystem,
  listStatusHistory, listAlerts, recordStatus,
  getNotifySettings, setNotifyChannel,
  listAlertRoutes, addAlertRoute, removeAlertRoute,
  pollUnifiSystems, unifiConfigured,
  reportAvHealth,
  getCriticalSystemsStatus,
};
