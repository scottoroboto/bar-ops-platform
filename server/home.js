// The home screen (Oct 2026 redesign): what the owner and managers see
// before the app tiles. One block per bar -- NETWORK, a BAR line and a
// Kitchen line (sales, labor, staff), coolers buttons, TVs and CO2 --
// plus the open alerts and the things waiting on them. Numbers come from
// what the platform already has: the network board, the kitchen board's
// SpotOn pull (sales and punches), the cooler sensors, TV health.
//
// Which lines a manager sees is the owner's call (home_lines, patch_060).
const { withServiceClient } = require('./db');
const monitoring = require('./monitoring');
const sensors = require('./sensors');
const kitchenboard = require('./kitchenboard');

const DEFAULT_TZ = 'America/Chicago';
const GEAR_KINDS = new Set(['unifi_gateway', 'unifi_agg', 'unifi_switch', 'meraki_switch', 'unifi_ap']);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function localParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
function hm(t) { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }

async function linesFor(svc, person) {
  if (person.role === 'owner') return { network: true, bar: true, kitchen: true, coolers: true };
  const { rows } = await svc.query('SELECT network, bar, kitchen, coolers FROM home_lines WHERE person_id = $1', [person.id]);
  const r = rows[0] || {};
  return { network: r.network !== false, bar: r.bar !== false, kitchen: r.kitchen !== false, coolers: r.coolers !== false };
}

async function getLines(personId) {
  return withServiceClient(async (svc) => linesFor(svc, { id: personId, role: 'manager' }));
}

async function setLines(personId, body, updatedBy) {
  const b = body || {};
  return withServiceClient(async (svc) => {
    const cur = await linesFor(svc, { id: personId, role: 'manager' });
    const next = { network: b.network !== undefined ? !!b.network : cur.network, bar: b.bar !== undefined ? !!b.bar : cur.bar, kitchen: b.kitchen !== undefined ? !!b.kitchen : cur.kitchen, coolers: b.coolers !== undefined ? !!b.coolers : cur.coolers };
    await svc.query(
      `INSERT INTO home_lines (person_id, network, bar, kitchen, coolers, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (person_id) DO UPDATE SET network = EXCLUDED.network, bar = EXCLUDED.bar, kitchen = EXCLUDED.kitchen, coolers = EXCLUDED.coolers, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [personId, next.network, next.bar, next.kitchen, next.coolers, updatedBy || null]);
    return next;
  });
}

// Sales, labor and who is on, split bar vs kitchen, from the kitchen
// board's SpotOn pull. Only bars whose box pulls SpotOn have numbers.
async function sidesFor(svc, locationId, tz) {
  const kb = await kitchenboard.settingsFor(svc, locationId);
  const bdate = kitchenboard.businessDate(new Date(), tz, kb.day_start_hour);
  const { rows: snaps } = await svc.query('SELECT food_net, total_net, at FROM kb_sales_snapshots WHERE location_id = $1 AND business_date = $2 ORDER BY at DESC LIMIT 1', [locationId, bdate]);
  const snap = snaps[0] || null;
  const { rows: punches } = await svc.query('SELECT role_name, labor_total, is_clocked_out, clock_out FROM kb_punches WHERE location_id = $1 AND business_date = $2', [locationId, bdate]);
  const kitchenRoles = (kb.kitchen_roles || []).map((r) => String(r).toLowerCase());
  const isKitchen = (role) => kitchenRoles.includes(String(role || '').toLowerCase());
  const { ymd, minutes } = localParts(new Date(), tz);
  const { rows: shifts } = await svc.query(
    `SELECT s.start_time, s.end_time, sc.name AS schedule FROM shifts s JOIN schedules sc ON sc.id = s.schedule_id
     WHERE sc.location_id = $1 AND s.shift_date = $2 AND s.status = 'scheduled'`, [locationId, ymd]);
  const onNow = (sh) => { const a = hm(sh.start_time); const b = hm(sh.end_time); if (a == null || b == null) return false; return b >= a ? (minutes >= a && minutes < b) : (minutes >= a || minutes < b); };
  const side = (kitchen) => {
    const mine = punches.filter((p) => isKitchen(p.role_name) === kitchen);
    const labor = mine.reduce((a, p) => a + num(p.labor_total), 0);
    const on = mine.filter((p) => !p.is_clocked_out && !p.clock_out).length;
    const scheduled = shifts.filter((sh) => (/kitchen/i.test(sh.schedule || '')) === kitchen && onNow(sh)).length;
    let sales = null;
    if (snap) sales = kitchen ? (snap.food_net == null ? null : num(snap.food_net)) : (snap.total_net == null || snap.food_net == null ? null : Math.max(0, num(snap.total_net) - num(snap.food_net)));
    return { sales, laborPct: sales ? Math.round(labor / sales * 100) : null, laborHasData: mine.length > 0, staffOn: on, staffScheduled: scheduled, hasData: !!snap || mine.length > 0 };
  };
  return { bar: side(false), kitchen: side(true), asOf: snap ? snap.at : null, businessDate: bdate };
}

function coolerSummary(view, area) {
  const list = view.probes.filter((p) => p.area === area);
  const ok = list.filter((p) => p.state === 'normal').length;
  const bad = list.some((p) => p.state === 'high' || p.state === 'low' || p.state === 'error');
  const warn = list.some((p) => p.state === 'silent' || p.state === 'unknown');
  return { total: list.length, ok, level: !list.length ? 'none' : bad ? 'bad' : warn ? 'warn' : 'ok' };
}

async function tvsFor(svc, locationId) {
  const { rows } = await svc.query(
    `SELECT ms.id, ss.status, ss.detail FROM monitored_systems ms
     LEFT JOIN LATERAL (SELECT status, detail FROM system_status s WHERE s.system_id = ms.id ORDER BY checked_at DESC LIMIT 1) ss ON true
     WHERE ms.location_id = $1 AND ms.category = 'av' AND ms.kind = 'vc_tv' AND ms.active = true`, [locationId]);
  const total = rows.length;
  const unreachable = rows.filter((r) => r.status === 'offline').length;
  const on = rows.filter((r) => r.status === 'online' && r.detail && r.detail.power === 'on').length;
  return { total, on, unreachable };
}

async function view(person, locationIds) {
  return withServiceClient(async (svc) => {
    const lines = await linesFor(svc, person);
    const { rows: locs } = await svc.query('SELECT l.id, l.name, vs.timezone, vs.net_clients, vs.net_clients_at FROM locations l LEFT JOIN vc_sites vs ON vs.location_id = l.id WHERE l.id = ANY($1::uuid[]) AND l.active = true ORDER BY l.name', [locationIds]);
    const net = lines.network ? await monitoring.getNetworkBoard(svc, locs.map((l) => l.id)) : [];
    const locations = [];
    for (const l of locs) {
      const tz = l.timezone || DEFAULT_TZ;
      const n = net.find((r) => String(r.locationId) === String(l.id)) || null;
      const sides = (lines.bar || lines.kitchen) ? await sidesFor(svc, l.id, tz) : null;
      const sv = lines.coolers ? await sensors.view(l.id) : null;
      const tvs = await tvsFor(svc, l.id);
      const co2 = sv && sv.co2.length ? sv.co2[0] : null;
      const coolers = sv ? { bar: coolerSummary(sv, 'bar'), kitchen: coolerSummary(sv, 'kitchen'), other: coolerSummary(sv, 'other'), unassigned: sv.unassigned.length, boxesSilent: sv.nodes.filter((x) => x.silent).length } : null;
      const levels = [];
      if (n) levels.push(n.status === 'offline' ? 'bad' : n.status === 'warning' ? 'warn' : n.status === 'online' ? 'ok' : 'none');
      if (coolers) for (const k of ['bar', 'kitchen', 'other']) levels.push(coolers[k].level);
      const level = levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : levels.includes('ok') ? 'ok' : 'none';
      locations.push({
        id: l.id, name: l.name, level,
        network: n ? (() => {
          // "Gear" is the gateway, switches and access points that have
          // ever reported; internet lines and never-polled rows don't count.
          const gear = n.devices.filter((d) => GEAR_KINDS.has(d.kind) && d.reported);
          const clientsFresh = l.net_clients_at && Date.now() - new Date(l.net_clients_at).getTime() < 15 * 60 * 1000;
          return { status: n.status, gearUp: gear.filter((d) => d.status === 'online').length, gearTotal: gear.length,
            latencyMs: n.wan ? n.wan.latencyMs : null, lossPct: n.wan ? n.wan.lossPct : null, clients: clientsFresh ? l.net_clients : null, speed: n.speed, cascade: n.cascade };
        })() : null,
        bar: sides && lines.bar ? sides.bar : null,
        kitchen: sides && lines.kitchen ? sides.kitchen : null,
        asOf: sides ? sides.asOf : null,
        coolers,
        tvs,
        co2: co2 ? { ppm: co2.ppm, state: co2.state } : null,
      });
    }
    const alerts = (await monitoring.listAlerts(svc, { openOnly: true }))
      .filter((a) => locationIds.some((id) => String(id) === String(a.location_id)))
      .map((a) => ({ id: a.id, category: a.category, systemName: a.system_name, message: a.message, openedAt: a.opened_at, acknowledgedAt: a.acknowledged_at, silenced: a.silenced, locationName: a.location_name, status: a.status }));
    const { rows: pend } = await svc.query(`SELECT count(*)::int AS n FROM people WHERE status = 'pending_review' AND (location_id = ANY($1::uuid[]) OR $2)`, [locationIds, person.role === 'owner']);
    const { rows: games } = await svc.query(`SELECT count(*)::int AS n FROM amusement_collections c JOIN amusement_locations al ON al.id = c.location_id WHERE c.status = 'final' AND c.pos_status = 'queued' AND (al.location_id = ANY($1::uuid[]) OR $2)`, [locationIds, person.role === 'owner']);
    const { rows: calls } = await svc.query(`SELECT count(*)::int AS n FROM service_calls WHERE status = 'open' AND location_id = ANY($1::uuid[])`, [locationIds]);
    return { lines, locations, alerts, needs: { applicants: pend[0].n, gamesQueued: games[0].n, serviceCalls: calls[0].n }, at: new Date().toISOString() };
  });
}

module.exports = { view, getLines, setLines };
