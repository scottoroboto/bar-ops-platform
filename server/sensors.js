// Cooler temperature sensors (patch_059, Oct 2026).
//
// The bar's venue-control Pi posts batches of node reports here
// (ingest). Each report fans out into one sensor_readings row per probe;
// resends are harmless (unique on reading_uuid + probe_id). Unknown
// gateways, boxes and probes are created on first sight so the hardware
// never has to be pre-registered: a new probe shows up as "NEW 000098"
// until someone names it on the Coolers page.
//
// Alerts ride the existing monitoring pipeline: every gateway, box and
// probe has a monitored_systems row (category 'refrigeration'), and this
// module decides the status to record for each one -- a probe is
// 'warning' only after it has been out of range for its alert_after_min
// (door openings cause short spikes, the sustain time is deliberate),
// 'online' once it has been back inside the band for 5 minutes. A silent
// box is 'offline'; low battery and weak signal are quiet warnings
// (dashboard and 6am summary, no text).
//
// Everything is stored in Celsius (the firmware's unit); the UI shows
// Fahrenheit.
const { withServiceClient } = require('./db');
const monitoring = require('./monitoring');

const CLEAR_AFTER_MS = 5 * 60 * 1000;      // back inside the band this long before a temp alert clears
const CLEAR_MARGIN_C = 0.5;                 // and by this much
const ERROR_RUN_FOR_ALERT = 3;              // consecutive failed reads
const NO_PROBE_RUN_FOR_ALERT = 2;           // consecutive reports with no probe found
const GATEWAY_SILENT_MS = 5 * 60 * 1000;
const BATTERY_OK_MV = 3700;                 // a swap is obvious: above this clears battery_low
const SWAP_JUMP_MV = 300;
const WEAK_RSSI = -88;
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const READINGS_KEEP_DAYS = 90;
const INTERVALS = [60, 120, 300, 600, 900];

const cToF = (c) => (c == null ? null : Math.round((Number(c) * 9 / 5 + 32) * 10) / 10);
const fToC = (f) => (f == null ? null : Math.round((Number(f) - 32) * 5 / 9 * 100) / 100);
const fmtF = (c) => (c == null ? '—' : `${cToF(c).toFixed(1)}°F`);
const tail = (mac, n = 4) => String(mac || '').replace(/[^0-9A-Fa-f]/g, '').slice(-n).toUpperCase();
const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
function normMac(v) { return String(v || '').trim().toUpperCase(); }
function err(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

// ---------------------------------------------------------------------
// Registry (auto-created on first sight)
// ---------------------------------------------------------------------
async function settingsFor(svc, locationId) {
  const { rows } = await svc.query('SELECT * FROM sensor_settings WHERE location_id = $1', [locationId]);
  if (rows[0]) return rows[0];
  const ins = await svc.query('INSERT INTO sensor_settings (location_id) VALUES ($1) ON CONFLICT (location_id) DO UPDATE SET location_id = EXCLUDED.location_id RETURNING *', [locationId]);
  return ins.rows[0];
}

async function registerSystem(svc, { locationId, kind, name, externalRef }) {
  const { rows } = await svc.query(
    `INSERT INTO monitored_systems (location_id, category, kind, name, external_ref, config, sort_order)
     VALUES ($1, 'refrigeration', $2, $3, $4, '{"notify_hold_ms": 0}'::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM monitored_systems WHERE location_id = $1))
     RETURNING id`, [locationId, kind, name, externalRef]);
  return rows[0].id;
}

async function ensureGateway(svc, locationId, mac) {
  const m = normMac(mac);
  const { rows } = await svc.query('SELECT * FROM sensor_gateways WHERE gateway_mac = $1', [m]);
  if (rows[0]) return rows[0];
  const name = `Sensor gateway ${tail(m)}`;
  const systemId = await registerSystem(svc, { locationId, kind: 'sensor_gateway', name, externalRef: m });
  const ins = await svc.query(
    'INSERT INTO sensor_gateways (location_id, gateway_mac, label, system_id) VALUES ($1,$2,$3,$4) RETURNING *',
    [locationId, m, name, systemId]);
  return ins.rows[0];
}

async function ensureNode(svc, locationId, mac, kind) {
  const m = normMac(mac);
  const { rows } = await svc.query('SELECT * FROM sensor_nodes WHERE node_mac = $1', [m]);
  if (rows[0]) return rows[0];
  const k = ['temp', 'co2', 'hvac'].includes(kind) ? kind : 'temp';
  const label = `${k === 'co2' ? 'CO2 unit' : 'Box'} ${tail(m)}`;
  const systemId = await registerSystem(svc, { locationId, kind: 'sensor_node', name: label, externalRef: m });
  const ins = await svc.query(
    'INSERT INTO sensor_nodes (location_id, node_mac, kind, label, system_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [locationId, m, k, label, systemId]);
  return ins.rows[0];
}

async function ensureProbe(svc, locationId, probeId, nodeId, settings) {
  const pid = String(probeId || '').trim().toUpperCase();
  if (!/^[0-9A-F]{8,16}$/.test(pid)) return null;
  const { rows } = await svc.query('SELECT * FROM sensor_probes WHERE probe_id = $1', [pid]);
  if (rows[0]) return rows[0];
  const name = `NEW ${pid.slice(-6)}`;
  const systemId = await registerSystem(svc, { locationId, kind: 'sensor_probe', name, externalRef: pid });
  const ins = await svc.query(
    `INSERT INTO sensor_probes (probe_id, location_id, node_id, display_name, high_c, low_c, alert_after_min, system_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [pid, locationId, nodeId, name, settings.default_high_c, settings.default_low_c, settings.default_alert_after_min, systemId]);
  return ins.rows[0];
}

// ---------------------------------------------------------------------
// The probe state machine. Pure: mutates the row object, nothing else.
// ---------------------------------------------------------------------
function stepProbe(p, tempC, readAt) {
  const at = new Date(readAt);
  if (tempC == null) {
    p.error_run = Number(p.error_run || 0) + 1;
    p.cond = 'error';
    if (!p.cond_since) p.cond_since = at;
    if (p.error_run >= ERROR_RUN_FOR_ALERT && p.state !== 'error') { p.state = 'error'; p.state_since = at; }
    return;
  }
  p.error_run = 0;
  p.last_c = tempC;
  p.last_seen_at = at;
  const high = Number(p.high_c); const low = Number(p.low_c);
  const cond = tempC > high ? 'high' : tempC < low ? 'low' : 'normal';
  if (cond !== p.cond) { p.cond = cond; p.cond_since = at; }
  if (cond === 'high' || cond === 'low') {
    p.clear_since = null;
    const sustainedMs = at.getTime() - new Date(p.cond_since).getTime();
    if (sustainedMs >= Number(p.alert_after_min) * 60000 && p.state !== cond) { p.state = cond; p.state_since = at; }
    else if (p.state === 'error' || p.state === 'silent' || p.state === 'unknown') { p.state = 'normal'; p.state_since = at; }
    return;
  }
  // inside the band
  if (p.state === 'high' || p.state === 'low') {
    const backEnough = p.state === 'high' ? tempC <= high - CLEAR_MARGIN_C : tempC >= low + CLEAR_MARGIN_C;
    if (!backEnough) { p.clear_since = null; return; }
    if (!p.clear_since) { p.clear_since = at; return; }
    if (at.getTime() - new Date(p.clear_since).getTime() >= CLEAR_AFTER_MS) { p.state = 'normal'; p.state_since = at; p.clear_since = null; }
    return;
  }
  if (p.state !== 'normal') { p.state = 'normal'; p.state_since = at; }
}

function probeStatus(p) {
  const name = p.display_name;
  switch (p.state) {
    case 'high': return { status: 'warning', message: `${name} is ${fmtF(p.last_c)} (above ${fmtF(p.high_c)} for ${minutesBetween(p.cond_since, p.last_seen_at)} min).` };
    case 'low': return { status: 'warning', message: `${name} is ${fmtF(p.last_c)} (below ${fmtF(p.low_c)} for ${minutesBetween(p.cond_since, p.last_seen_at)} min). Lines may freeze.` };
    case 'error': return { status: 'warning', message: `${name}'s probe isn't reading (${p.error_run} failed reads). Check the cable at the box.` };
    case 'silent': return { status: 'unknown', message: null };
    case 'normal': return { status: 'online', message: null };
    default: return { status: 'unknown', message: null };
  }
}

function nodeStatus(n, settings) {
  const kinds = [];
  if (n.silent) kinds.push('silent');
  if (n.co2_state === 'alarm' || n.co2_state === 'warning' || n.co2_state === 'fault') kinds.push(`co2_${n.co2_state}`);
  if (n.no_probe_run >= NO_PROBE_RUN_FOR_ALERT) kinds.push('no_probe');
  if (n.battery_low) kinds.push('battery_low');
  if (n.signal_weak) kinds.push('signal_weak');
  const detail = { kinds, batt_mv: n.last_batt_mv, rssi: n.last_rssi, seq: n.last_seq, interval_s: n.last_interval_s || n.report_interval_s, mode: n.last_mode || 'normal', fw: n.fw_version, last_seen_at: n.last_seen_at };
  if (n.silent) {
    const mins = n.last_seen_at ? minutesBetween(n.last_seen_at, new Date()) : null;
    return { status: 'offline', quiet: false, detail, message: `${n.label} hasn't reported${mins != null ? ` for ${mins} min` : ' yet'}. Battery dead, out of range, or the gateway is down.` };
  }
  if (n.co2_ppm != null) detail.ppm = n.co2_ppm;
  if (n.co2_state === 'alarm') return { status: 'warning', quiet: false, detail, message: `CO2 ALARM at ${n.label}${n.co2_ppm != null ? `: ${Number(n.co2_ppm).toLocaleString()} ppm` : ''}. Keep people out of the cooler and ventilate.` };
  if (n.no_probe_run >= NO_PROBE_RUN_FOR_ALERT) return { status: 'warning', quiet: false, detail, message: `${n.label} found no probe ${n.no_probe_run} reports in a row. Cable unplugged or broken.` };
  if (n.co2_state === 'warning' || n.co2_state === 'fault') return { status: 'warning', quiet: true, detail, message: `${n.label} CO2 ${n.co2_state}.` };
  if (n.battery_low) return { status: 'warning', quiet: true, detail, message: `${n.label} battery is low (${(n.last_batt_mv / 1000).toFixed(2)} V). Swap it within about two weeks.` };
  if (n.signal_weak) return { status: 'warning', quiet: true, detail, message: `${n.label} has a weak radio signal (${n.last_rssi} dBm). Add an antenna or move it.` };
  return { status: 'online', quiet: true, detail, message: null };
}

async function saveProbe(svc, p) {
  await svc.query(
    `UPDATE sensor_probes SET node_id = $2, last_seen_at = $3, last_c = $4, state = $5, state_since = $6, cond = $7, cond_since = $8,
       clear_since = $9, error_run = $10 WHERE id = $1`,
    [p.id, p.node_id, p.last_seen_at, p.last_c, p.state, p.state_since, p.cond, p.cond_since, p.clear_since, p.error_run]);
  if (p.system_id) {
    const st = probeStatus(p);
    await monitoring.recordStatus({ systemId: p.system_id, status: st.status, message: st.message, detail: { state: p.state, temp_c: p.last_c, temp_f: cToF(p.last_c), last_seen_at: p.last_seen_at } }, svc);
  }
}

async function saveNode(svc, n, settings) {
  await svc.query(
    `UPDATE sensor_nodes SET last_seen_at = $2, last_rssi = $3, last_batt_mv = $4, prev_batt_mv = $5, last_seq = $6, last_interval_s = $7,
       last_mode = $8, fw_version = $9, fw_last_result = $10, no_probe_run = $11, co2_state = $12, battery_low = $13, signal_weak = $14, silent = $15
     WHERE id = $1`,
    [n.id, n.last_seen_at, n.last_rssi, n.last_batt_mv, n.prev_batt_mv, n.last_seq, n.last_interval_s, n.last_mode, n.fw_version, n.fw_last_result,
      n.no_probe_run, n.co2_state, n.battery_low, n.signal_weak, n.silent]);
  if (n.system_id) {
    const st = nodeStatus(n, settings);
    await monitoring.recordStatus({ systemId: n.system_id, status: st.status, message: st.message, detail: st.detail, quiet: st.quiet }, svc);
  }
}

// ---------------------------------------------------------------------
// Ingest: POST /api/venue/agent/sensors (the Pi, with its agent token)
// ---------------------------------------------------------------------
async function ingest(locationId, payload) {
  const body = payload || {};
  const readings = Array.isArray(body.readings) ? body.readings.slice() : [];
  const now = Date.now();
  return withServiceClient(async (svc) => {
    const settings = await settingsFor(svc, locationId);
    if (body.gateway_mac) {
      const gw = await ensureGateway(svc, locationId, body.gateway_mac);
      const g = body.gateway || {};
      await svc.query('UPDATE sensor_gateways SET last_seen_at = now(), last_uptime_s = $2, fw_version = COALESCE($3, fw_version) WHERE id = $1',
        [gw.id, Number.isFinite(Number(g.uptime_s)) ? Number(g.uptime_s) : gw.last_uptime_s, g.fw || null]);
      if (gw.system_id) await monitoring.recordStatus({ systemId: gw.system_id, status: 'online', detail: { uptime_s: g.uptime_s, fw: g.fw || gw.fw_version } }, svc);
    }

    readings.sort((a, b) => new Date(a.read_at) - new Date(b.read_at));
    const nodes = new Map();   // mac -> row (mutated)
    const probes = new Map();  // probe_id -> row (mutated)
    let accepted = 0; let duplicates = 0; let rejected = 0;

    for (const r of readings) {
      const readAt = new Date(r.read_at);
      if (!r.reading_uuid || !r.node_mac || Number.isNaN(readAt.getTime()) || readAt.getTime() > now + FUTURE_SLACK_MS) { rejected += 1; continue; }
      const mac = normMac(r.node_mac);
      let node = nodes.get(mac);
      if (!node) { node = await ensureNode(svc, locationId, mac, r.type); nodes.set(mac, node); }
      const newer = !node.last_seen_at || readAt >= new Date(node.last_seen_at);
      if (newer) {
        const batt = Number.isFinite(Number(r.batt_mv)) ? Number(r.batt_mv) : null;
        if (batt && node.last_batt_mv && batt - node.last_batt_mv > SWAP_JUMP_MV) {
          await svc.query(`INSERT INTO sensor_events (location_id, node_id, kind, at, detail) VALUES ($1,$2,'battery_swap',$3,$4)`,
            [locationId, node.id, readAt, JSON.stringify({ from_mv: node.last_batt_mv, to_mv: batt })]);
          node.battery_low = false;
        }
        if (Number.isFinite(Number(r.seq)) && node.last_seq != null && Number(r.seq) < node.last_seq && node.last_seq > 5) {
          await svc.query(`INSERT INTO sensor_events (location_id, node_id, kind, at, detail) VALUES ($1,$2,'reboot',$3,$4)`,
            [locationId, node.id, readAt, JSON.stringify({ seq_was: node.last_seq, seq_now: Number(r.seq) })]);
        }
        if (r.fw_update && r.fw_update !== node.fw_last_result) {
          await svc.query(`INSERT INTO sensor_events (location_id, node_id, kind, at, detail) VALUES ($1,$2,'fw_update',$3,$4)`,
            [locationId, node.id, readAt, JSON.stringify({ result: r.fw_update, fw: r.fw || null })]);
        }
        node.prev_batt_mv = node.last_batt_mv;
        node.last_batt_mv = batt;
        if (batt && batt > 0 && node.prev_batt_mv && node.prev_batt_mv > 0) {
          if (batt < settings.battery_low_mv && node.prev_batt_mv < settings.battery_low_mv) node.battery_low = true;
          if (batt > BATTERY_OK_MV) node.battery_low = false;
        }
        node.last_seen_at = readAt;
        node.last_rssi = Number.isFinite(Number(r.rssi)) ? Number(r.rssi) : node.last_rssi;
        node.last_seq = Number.isFinite(Number(r.seq)) ? Number(r.seq) : node.last_seq;
        node.last_interval_s = Number.isFinite(Number(r.interval_s)) ? Number(r.interval_s) : node.last_interval_s;
        node.last_mode = typeof r.mode === 'string' ? r.mode : node.last_mode;
        node.fw_version = r.fw || node.fw_version;
        node.fw_last_result = r.fw_update || node.fw_last_result;
        node.silent = false;
      }

      if (r.type === 'co2' && r.co2) {
        const c = r.co2;
        const ins = await svc.query(
          `INSERT INTO sensor_co2_readings (reading_uuid, node_id, location_id, read_at, ppm, temp_c, rh, state, muted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (reading_uuid) DO NOTHING`,
          [r.reading_uuid, node.id, locationId, readAt, c.ppm ?? null, c.c ?? null, c.rh ?? null, c.state || null, c.muted ?? null]);
        if (ins.rowCount) { accepted += 1; if (newer) { node.co2_state = c.state || node.co2_state; node.co2_ppm = c.ppm ?? null; } } else duplicates += 1;
        continue;
      }

      const list = Array.isArray(r.probes) ? r.probes : [];
      if (newer) node.no_probe_run = list.length ? 0 : Number(node.no_probe_run || 0) + 1;
      for (const pr of list) {
        let probe = probes.get(String(pr.id || '').toUpperCase());
        if (!probe) {
          probe = await ensureProbe(svc, locationId, pr.id, node.id, settings);
          if (!probe) { rejected += 1; continue; }
          probes.set(probe.probe_id, probe);
        }
        const tempC = pr.c == null || pr.c === '' || !Number.isFinite(Number(pr.c)) ? null : Math.round(Number(pr.c) * 100) / 100;
        const ins = await svc.query(
          `INSERT INTO sensor_readings (reading_uuid, probe_id, node_id, location_id, read_at, temp_c, rssi, batt_mv, seq)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (reading_uuid, probe_id) DO NOTHING`,
          [r.reading_uuid, probe.probe_id, node.id, locationId, readAt, tempC, node.last_rssi, node.last_batt_mv, node.last_seq]);
        if (!ins.rowCount) { duplicates += 1; continue; }
        accepted += 1;
        if (tempC != null) {
          await svc.query(
            `INSERT INTO sensor_hourly (probe_id, hour, min_c, max_c, sum_c, n) VALUES ($1, date_trunc('hour', $2::timestamptz), $3, $3, $3, 1)
             ON CONFLICT (probe_id, hour) DO UPDATE SET min_c = LEAST(sensor_hourly.min_c, EXCLUDED.min_c), max_c = GREATEST(sensor_hourly.max_c, EXCLUDED.max_c),
               sum_c = sensor_hourly.sum_c + EXCLUDED.sum_c, n = sensor_hourly.n + 1`,
            [probe.probe_id, readAt, tempC]);
        }
        if (!probe.last_seen_at || readAt >= new Date(probe.last_seen_at) || probe.state === 'silent') {
          probe.node_id = node.id;
          if (probe.state === 'silent') { probe.state = 'unknown'; }
          stepProbe(probe, tempC, readAt);
        }
      }
    }

    for (const p of probes.values()) await saveProbe(svc, p);
    for (const n of nodes.values()) await saveNode(svc, n, settings);
    return { ok: true, accepted, duplicates, rejected };
  });
}

// ---------------------------------------------------------------------
// The minute sweep (server/index.js): silence, gateways, weak signal.
// ---------------------------------------------------------------------
async function sweep() {
  return withServiceClient(async (svc) => {
    const { rows: nodes } = await svc.query(
      `SELECT n.*, ss.node_silent_min_min FROM sensor_nodes n LEFT JOIN sensor_settings ss ON ss.location_id = n.location_id
       WHERE n.last_seen_at IS NOT NULL`);
    let changed = 0;
    for (const n of nodes) {
      const inMode = (n.troubleshoot_until && new Date(n.troubleshoot_until) > new Date()) || (n.install_until && new Date(n.install_until) > new Date());
      const limitMs = Math.max((n.node_silent_min_min || 15) * 60, 3 * (n.last_interval_s || n.report_interval_s || 300)) * 1000;
      const silent = !inMode && Date.now() - new Date(n.last_seen_at).getTime() > limitMs;
      const { rows: sig } = await svc.query(
        `SELECT avg(rssi)::int AS avg_rssi, count(*)::int AS n FROM sensor_readings WHERE node_id = $1 AND read_at > now() - interval '24 hours' AND rssi IS NOT NULL`, [n.id]);
      const weak = sig[0] && sig[0].n >= 12 && sig[0].avg_rssi != null && sig[0].avg_rssi < WEAK_RSSI;
      if (silent !== n.silent || weak !== n.signal_weak) {
        n.silent = silent; n.signal_weak = weak;
        const settings = await settingsFor(svc, n.location_id);
        await saveNode(svc, n, settings);
        if (silent) {
          const { rows: ps } = await svc.query(`UPDATE sensor_probes SET state = 'silent', state_since = now() WHERE node_id = $1 AND state <> 'silent' RETURNING *`, [n.id]);
          for (const p of ps) if (p.system_id) await monitoring.recordStatus({ systemId: p.system_id, status: 'unknown', detail: { state: 'silent' } }, svc);
        }
        changed += 1;
      }
    }
    const { rows: gws } = await svc.query('SELECT * FROM sensor_gateways WHERE last_seen_at IS NOT NULL AND system_id IS NOT NULL');
    for (const g of gws) {
      const mins = minutesBetween(g.last_seen_at, new Date());
      if (Date.now() - new Date(g.last_seen_at).getTime() > GATEWAY_SILENT_MS) {
        await monitoring.recordStatus({ systemId: g.system_id, status: 'offline', message: `${g.label} hasn't checked in for ${mins} min. The bar's box or its internet is probably down; the coolers are not being watched.`, detail: { last_seen_at: g.last_seen_at } }, svc);
      }
    }
    return changed;
  });
}

async function prune() {
  return withServiceClient(async (svc) => {
    const a = await svc.query(`DELETE FROM sensor_readings WHERE read_at < now() - ($1 || ' days')::interval`, [READINGS_KEEP_DAYS]);
    const b = await svc.query(`DELETE FROM sensor_co2_readings WHERE read_at < now() - ($1 || ' days')::interval`, [READINGS_KEEP_DAYS]);
    return a.rowCount + b.rowCount;
  });
}

// ---------------------------------------------------------------------
// What the Pi pulls (GET /api/venue/agent/sensors/config)
// ---------------------------------------------------------------------
async function config(locationId) {
  return withServiceClient(async (svc) => {
    const { rows: probes } = await svc.query('SELECT probe_id, display_name, high_c, low_c, alert_after_min FROM sensor_probes WHERE location_id = $1 AND active ORDER BY sort_order, display_name', [locationId]);
    const { rows: nodes } = await svc.query('SELECT * FROM sensor_nodes WHERE location_id = $1 ORDER BY label', [locationId]);
    const now = Date.now();
    return {
      probes: probes.map((p) => ({ id: p.probe_id, name: p.display_name, high_c: Number(p.high_c), low_c: Number(p.low_c), alert_after_min: p.alert_after_min })),
      nodes: nodes.map((n) => ({
        mac: n.node_mac,
        report_interval_s: n.report_interval_s,
        troubleshoot: n.troubleshoot_until && new Date(n.troubleshoot_until).getTime() > now
          ? { interval_s: n.troubleshoot_interval_s, duration_s: Math.max(30, Math.round((new Date(n.troubleshoot_until).getTime() - now) / 1000)) } : null,
        install: !!(n.install_until && new Date(n.install_until).getTime() > now),
        target_fw: null,
      })),
      firmware: null,
    };
  });
}

// ---------------------------------------------------------------------
// What people see
// ---------------------------------------------------------------------
async function view(locationId) {
  return withServiceClient(async (svc) => {
    const settings = await settingsFor(svc, locationId);
    const { rows: probes } = await svc.query(
      `SELECT p.*, n.label AS node_label, n.node_mac, n.last_batt_mv, n.last_rssi, n.battery_low, n.signal_weak, n.silent AS node_silent,
              n.report_interval_s, n.last_interval_s, n.last_mode, n.troubleshoot_until, n.install_until, n.fw_version,
              ms.silenced_until, sa.id AS alert_id, sa.opened_at AS alert_opened_at, sa.acknowledged_at, sa.message AS alert_message
       FROM sensor_probes p
       LEFT JOIN sensor_nodes n ON n.id = p.node_id
       LEFT JOIN monitored_systems ms ON ms.id = p.system_id
       LEFT JOIN system_alerts sa ON sa.system_id = p.system_id AND sa.closed_at IS NULL
       WHERE p.location_id = $1 ORDER BY p.area NULLS LAST, p.sort_order, p.display_name`, [locationId]);
    const { rows: nodes } = await svc.query(
      `SELECT n.*, (SELECT count(*)::int FROM sensor_probes p WHERE p.node_id = n.id AND p.active) AS probe_count,
              sa.id AS alert_id, sa.message AS alert_message, sa.acknowledged_at
       FROM sensor_nodes n LEFT JOIN system_alerts sa ON sa.system_id = n.system_id AND sa.closed_at IS NULL
       WHERE n.location_id = $1 ORDER BY n.label`, [locationId]);
    const { rows: gateways } = await svc.query('SELECT * FROM sensor_gateways WHERE location_id = $1 ORDER BY label', [locationId]);
    const { rows: co2 } = await svc.query(
      `SELECT DISTINCT ON (node_id) node_id, read_at, ppm, temp_c, rh, state, muted FROM sensor_co2_readings WHERE location_id = $1 ORDER BY node_id, read_at DESC`, [locationId]);
    const { rows: events } = await svc.query(
      `SELECT e.*, n.label AS node_label FROM sensor_events e LEFT JOIN sensor_nodes n ON n.id = e.node_id WHERE e.location_id = $1 ORDER BY e.at DESC LIMIT 30`, [locationId]);
    const now = Date.now();
    const shape = (p) => ({
      id: p.id, probeId: p.probe_id, name: p.display_name, area: p.area, position: p.position, assigned: p.assigned, active: p.active, sortOrder: p.sort_order,
      highF: cToF(p.high_c), lowF: cToF(p.low_c), alertAfterMin: p.alert_after_min,
      tempF: cToF(p.last_c), tempC: p.last_c == null ? null : Number(p.last_c), state: p.state, stateSince: p.state_since, condSince: p.cond_since,
      lastSeenAt: p.last_seen_at, minutesAgo: p.last_seen_at ? minutesBetween(p.last_seen_at, now) : null,
      node: p.node_id ? { id: p.node_id, label: p.node_label, mac: p.node_mac, battMv: p.last_batt_mv, batteryPct: batteryPct(p.last_batt_mv), rssi: p.last_rssi, signal: signalGrade(p.last_rssi),
        batteryLow: p.battery_low, signalWeak: p.signal_weak, silent: p.node_silent, intervalS: p.last_interval_s || p.report_interval_s, mode: p.last_mode || 'normal',
        troubleshooting: !!(p.troubleshoot_until && new Date(p.troubleshoot_until).getTime() > now), installing: !!(p.install_until && new Date(p.install_until).getTime() > now), fw: p.fw_version } : null,
      silenced: !!(p.silenced_until && new Date(p.silenced_until).getTime() > now),
      alert: p.alert_id ? { id: p.alert_id, openedAt: p.alert_opened_at, acknowledgedAt: p.acknowledged_at, message: p.alert_message } : null,
    });
    const all = probes.map(shape);
    return {
      locationId,
      settings: { defaultHighF: cToF(settings.default_high_c), defaultLowF: cToF(settings.default_low_c), defaultAlertAfterMin: settings.default_alert_after_min, renotifyMin: settings.renotify_min },
      probes: all.filter((p) => p.assigned && p.active),
      unassigned: all.filter((p) => !p.assigned && p.active),
      inactive: all.filter((p) => !p.active),
      nodes: nodes.map((n) => ({
        id: n.id, mac: n.node_mac, label: n.label, kind: n.kind, probeCount: n.probe_count, lastSeenAt: n.last_seen_at, minutesAgo: n.last_seen_at ? minutesBetween(n.last_seen_at, now) : null,
        battMv: n.last_batt_mv, batteryPct: batteryPct(n.last_batt_mv), rssi: n.last_rssi, signal: signalGrade(n.last_rssi), batteryLow: n.battery_low, signalWeak: n.signal_weak, silent: n.silent,
        reportIntervalS: n.report_interval_s, activeIntervalS: n.last_interval_s, mode: n.last_mode || 'normal', pending: !!(n.last_interval_s && n.last_interval_s !== n.report_interval_s && !(n.troubleshoot_until && new Date(n.troubleshoot_until) > new Date())),
        troubleshootUntil: n.troubleshoot_until && new Date(n.troubleshoot_until).getTime() > now ? n.troubleshoot_until : null,
        installUntil: n.install_until && new Date(n.install_until).getTime() > now ? n.install_until : null,
        fw: n.fw_version, fwLastResult: n.fw_last_result, isTestNode: n.is_test_node, co2State: n.co2_state,
        alert: n.alert_id ? { id: n.alert_id, message: n.alert_message, acknowledgedAt: n.acknowledged_at } : null,
      })),
      gateways: gateways.map((g) => ({ id: g.id, mac: g.gateway_mac, label: g.label, lastSeenAt: g.last_seen_at, secondsAgo: g.last_seen_at ? Math.round((now - new Date(g.last_seen_at).getTime()) / 1000) : null, uptimeS: g.last_uptime_s, fw: g.fw_version })),
      co2: co2.map((c) => ({ nodeId: c.node_id, readAt: c.read_at, ppm: c.ppm, tempF: cToF(c.temp_c), rh: c.rh, state: c.state, muted: c.muted })),
      events: events.map((e) => ({ id: e.id, kind: e.kind, at: e.at, nodeLabel: e.node_label, probeId: e.probe_id, detail: e.detail })),
    };
  });
}

function batteryPct(mv) {
  if (!mv || mv <= 0) return null;
  const pts = [[4200, 100], [3900, 75], [3750, 50], [3600, 25], [3400, 10], [3300, 0]];
  if (mv >= 4200) return 100;
  if (mv <= 3300) return 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [v1, p1] = pts[i]; const [v2, p2] = pts[i + 1];
    if (mv <= v1 && mv >= v2) return Math.round(p2 + (mv - v2) / (v1 - v2) * (p1 - p2));
  }
  return null;
}
function signalGrade(rssi) {
  if (rssi == null) return null;
  return rssi >= -75 ? 'good' : rssi >= -85 ? 'ok' : 'weak';
}

// 24h = every reading; longer = hourly min/avg/max.
async function history(probeRowId, range) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT probe_id, display_name, high_c, low_c FROM sensor_probes WHERE id = $1', [probeRowId]);
    const p = rows[0];
    if (!p) throw err('Probe not found.', 404);
    const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 1;
    let points;
    if (days === 1) {
      const r = await svc.query('SELECT read_at, temp_c FROM sensor_readings WHERE probe_id = $1 AND read_at > now() - interval \'24 hours\' ORDER BY read_at', [p.probe_id]);
      points = r.rows.map((x) => ({ at: x.read_at, f: cToF(x.temp_c) }));
    } else {
      const r = await svc.query('SELECT hour, min_c, max_c, sum_c, n FROM sensor_hourly WHERE probe_id = $1 AND hour > now() - ($2 || \' days\')::interval ORDER BY hour', [p.probe_id, days]);
      points = r.rows.map((x) => ({ at: x.hour, minF: cToF(x.min_c), maxF: cToF(x.max_c), f: cToF(Number(x.sum_c) / Math.max(1, x.n)) }));
    }
    const vals = points.map((x) => x.f).filter((v) => v != null);
    const stats = vals.length ? { minF: Math.min(...points.map((x) => x.minF ?? x.f).filter((v) => v != null)), maxF: Math.max(...points.map((x) => x.maxF ?? x.f).filter((v) => v != null)), avgF: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 } : null;
    const { rows: alerts } = await svc.query(
      `SELECT sa.opened_at, sa.closed_at, sa.message, sa.acknowledged_at FROM system_alerts sa JOIN sensor_probes p ON p.system_id = sa.system_id
       WHERE p.id = $1 ORDER BY sa.opened_at DESC LIMIT 20`, [probeRowId]);
    return { name: p.display_name, highF: cToF(p.high_c), lowF: cToF(p.low_c), range: days === 1 ? '24h' : `${days}d`, points, stats, alerts };
  });
}

// ---------------------------------------------------------------------
// Setup (owner / managers with Monitoring)
// ---------------------------------------------------------------------
async function updateProbe(probeRowId, body) {
  const b = body || {};
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT * FROM sensor_probes WHERE id = $1', [probeRowId]);
    const p = rows[0];
    if (!p) throw err('Probe not found.', 404);
    const name = b.name != null ? String(b.name).trim().slice(0, 40) : p.display_name;
    if (!name) throw err('Give it a name.');
    const area = b.area !== undefined ? (['bar', 'kitchen', 'other'].includes(b.area) ? b.area : null) : p.area;
    const highC = b.highF != null ? fToC(b.highF) : Number(p.high_c);
    const lowC = b.lowF != null ? fToC(b.lowF) : Number(p.low_c);
    if (!(highC > lowC)) throw err('The high limit has to be above the low limit.');
    const after = b.alertAfterMin != null ? Math.max(1, Math.min(240, Math.round(Number(b.alertAfterMin)))) : p.alert_after_min;
    if (!Number.isFinite(after)) throw err('Minutes before alerting has to be a number.');
    const assigned = b.assigned !== undefined ? !!b.assigned : (p.assigned || !!(b.name && area));
    const { rows: out } = await svc.query(
      `UPDATE sensor_probes SET display_name = $2, area = $3, position = $4, high_c = $5, low_c = $6, alert_after_min = $7, assigned = $8,
         active = $9, sort_order = $10 WHERE id = $1 RETURNING *`,
      [probeRowId, name, area, b.position !== undefined ? (b.position ? String(b.position).slice(0, 20) : null) : p.position, highC, lowC, after, assigned,
        b.active !== undefined ? !!b.active : p.active, b.sortOrder != null ? Math.round(Number(b.sortOrder)) || 0 : p.sort_order]);
    if (p.system_id) await svc.query('UPDATE monitored_systems SET name = $2, active = $3 WHERE id = $1', [p.system_id, name, out[0].active]);
    return out[0];
  });
}

async function updateNode(nodeId, body) {
  const b = body || {};
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT * FROM sensor_nodes WHERE id = $1', [nodeId]);
    const n = rows[0];
    if (!n) throw err('Box not found.', 404);
    const label = b.label != null ? String(b.label).trim().slice(0, 40) || n.label : n.label;
    const interval = b.reportIntervalS != null ? Number(b.reportIntervalS) : n.report_interval_s;
    if (!INTERVALS.includes(interval)) throw err('Report every 1, 2, 5, 10 or 15 minutes.');
    const { rows: out } = await svc.query(
      `UPDATE sensor_nodes SET label = $2, report_interval_s = $3, is_test_node = $4 WHERE id = $1 RETURNING *`,
      [nodeId, label, interval, b.isTestNode !== undefined ? !!b.isTestNode : n.is_test_node]);
    if (n.system_id) await svc.query('UPDATE monitored_systems SET name = $2 WHERE id = $1', [n.system_id, label]);
    return out[0];
  });
}

// Troubleshooting mode: report every 30 s for 15 min, then back to normal
// on its own (the node counts down itself). Pressing again restarts it.
async function setMode(nodeId, { mode, on, intervalS, durationS }) {
  return withServiceClient(async (svc) => {
    const { rows } = await svc.query('SELECT * FROM sensor_nodes WHERE id = $1', [nodeId]);
    const n = rows[0];
    if (!n) throw err('Box not found.', 404);
    if (mode === 'troubleshoot') {
      const i = Math.max(15, Math.min(60, Math.round(Number(intervalS) || n.troubleshoot_interval_s || 30)));
      const d = Math.max(300, Math.min(3600, Math.round(Number(durationS) || n.troubleshoot_duration_s || 900)));
      const { rows: out } = await svc.query(
        `UPDATE sensor_nodes SET troubleshoot_until = $2, troubleshoot_interval_s = $3, troubleshoot_duration_s = $4 WHERE id = $1 RETURNING *`,
        [nodeId, on ? new Date(Date.now() + d * 1000) : null, i, d]);
      return out[0];
    }
    if (mode === 'install') {
      const { rows: out } = await svc.query('UPDATE sensor_nodes SET install_until = $2 WHERE id = $1 RETURNING *', [nodeId, on ? new Date(Date.now() + 10 * 60 * 1000) : null]);
      return out[0];
    }
    throw err('Unknown mode.');
  });
}

async function setLocationInterval(locationId, intervalS) {
  const interval = Number(intervalS);
  if (!INTERVALS.includes(interval)) throw err('Report every 1, 2, 5, 10 or 15 minutes.');
  return withServiceClient(async (svc) => {
    const r = await svc.query('UPDATE sensor_nodes SET report_interval_s = $2 WHERE location_id = $1', [locationId, interval]);
    return r.rowCount;
  });
}

async function updateSettings(locationId, body) {
  const b = body || {};
  return withServiceClient(async (svc) => {
    const cur = await settingsFor(svc, locationId);
    const highC = b.defaultHighF != null ? fToC(b.defaultHighF) : Number(cur.default_high_c);
    const lowC = b.defaultLowF != null ? fToC(b.defaultLowF) : Number(cur.default_low_c);
    if (!(highC > lowC)) throw err('The high limit has to be above the low limit.');
    const after = b.defaultAlertAfterMin != null ? Math.max(1, Math.min(240, Math.round(Number(b.defaultAlertAfterMin)))) : cur.default_alert_after_min;
    const renotify = b.renotifyMin != null ? Math.max(5, Math.min(240, Math.round(Number(b.renotifyMin)))) : cur.renotify_min;
    const { rows } = await svc.query(
      `UPDATE sensor_settings SET default_high_c = $2, default_low_c = $3, default_alert_after_min = $4, renotify_min = $5, updated_at = now() WHERE location_id = $1 RETURNING *`,
      [locationId, highC, lowC, after, renotify]);
    return rows[0];
  });
}

// Which bar a probe / box belongs to, for the route guards.
async function probeLocation(probeRowId) {
  return withServiceClient(async (svc) => { const { rows } = await svc.query('SELECT location_id FROM sensor_probes WHERE id = $1', [probeRowId]); return rows[0] ? rows[0].location_id : null; });
}
async function nodeLocation(nodeId) {
  return withServiceClient(async (svc) => { const { rows } = await svc.query('SELECT location_id FROM sensor_nodes WHERE id = $1', [nodeId]); return rows[0] ? rows[0].location_id : null; });
}
async function alertLocation(alertId) {
  return withServiceClient(async (svc) => { const { rows } = await svc.query('SELECT ms.location_id FROM system_alerts sa JOIN monitored_systems ms ON ms.id = sa.system_id WHERE sa.id = $1', [alertId]); return rows[0] ? rows[0].location_id : null; });
}

module.exports = { ingest, sweep, prune, config, view, history, updateProbe, updateNode, setMode, setLocationInterval, updateSettings, probeLocation, nodeLocation, alertLocation, stepProbe, cToF, fToC, batteryPct, signalGrade, INTERVALS };
