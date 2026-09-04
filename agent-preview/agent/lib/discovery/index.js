// Orchestrates Phase 1 Discovery & Diagnostics (docs/venue-control.md §9):
// runs a scan, keeps the result in the local SQLite cache, pushes it to the
// cloud, and drives the Test/Adopt steps against whichever run is current.
// This is the module agent/server.js's /api/discovery/* routes call into.
const scanner = require('./scanner');
const cloud = require('./cloud');
const cache = require('../cache');
const wol = require('../drivers/wol');

const TEST_TIMEOUT_MS = 3000;
const WOL_POLL_WINDOW_MS = 15000; // §9.2: "Send magic packet, poll state for 15s"
const WOL_POLL_INTERVAL_MS = 1500;

function runKey(id) { return `discovery:run:${id}`; }

function nextRunId() {
  const n = (cache.get('discovery:nextRunId') || 0) + 1;
  cache.set('discovery:nextRunId', n);
  return n;
}

function getRun(id) {
  const key = id === 'latest' ? runKey(cache.get('discovery:lastRunId')) : runKey(id);
  return cache.get(key);
}

// ------------------------------------------------------------------ scan

async function runScan({ ranges, deep }) {
  const result = await scanner.scan({ ranges, deep });
  const localId = nextRunId();
  let run = { id: localId, ...result, synced: false, cloud_run_id: null };

  const pushResult = await cloud.pushRun(run);
  if (pushResult.ok) {
    run.synced = true;
    run.cloud_run_id = pushResult.cloudRunId;
    const cloudIdByIp = new Map(pushResult.devices.map((d) => [d.ip, d.id]));
    run.devices = run.devices.map((d) => ({ ...d, cloud_device_id: cloudIdByIp.get(d.ip) || null }));
  } else {
    run.sync_error = pushResult.error;
  }

  cache.set(runKey(localId), run);
  cache.set('discovery:lastRunId', localId);
  return run;
}

// Re-pushes a run that failed to sync the first time (e.g. the scan
// happened during a brief internet blip) -- called on demand rather than
// automatically, so a scan taken during a real outage doesn't retry forever
// in the background.
async function resyncRun(id) {
  const run = getRun(id);
  if (!run) throw new Error(`No discovery run #${id} in the local cache.`);
  if (run.synced) return run;
  const pushResult = await cloud.pushRun(run);
  if (pushResult.ok) {
    run.synced = true;
    run.cloud_run_id = pushResult.cloudRunId;
    delete run.sync_error;
    const cloudIdByIp = new Map(pushResult.devices.map((d) => [d.ip, d.id]));
    run.devices = run.devices.map((d) => ({ ...d, cloud_device_id: cloudIdByIp.get(d.ip) || null }));
    cache.set(runKey(run.id), run);
  } else {
    run.sync_error = pushResult.error;
    cache.set(runKey(run.id), run);
  }
  return run;
}

// ------------------------------------------------------------------ test

function resolveTargets(run, targets) {
  if (targets === 'all') return run.devices;
  const list = Array.isArray(targets) ? targets : [targets];
  const set = new Set(list);
  return run.devices.filter((d) => set.has(d.ip) || set.has(d.cloud_device_id));
}

async function runOneTest(device, test) {
  const startedAt = Date.now();

  if (test === 'identity' || test === 'power_state') {
    try {
      // Re-run the sweep+interrogate shape (not a full range re-scan)
      // scoped to this one IP -- cheap and non-disruptive, matching §9.2's
      // "no" disruptive rating for both. This re-hits the actual identity
      // endpoint (not just OUI/port-signature guessing), so it genuinely
      // confirms the device is still there and reachable.
      const openPorts = device.open_ports || [];
      const probe = await Promise.race([
        (async () => {
          const swept = await scanner.tcpSweep([device.ip], openPorts.length ? openPorts : undefined);
          const stillOpen = swept.get(device.ip) || [];
          let interrogateResult = null;
          if (stillOpen.length) {
            try { interrogateResult = await scanner.interrogate(device.ip, stillOpen); } catch { interrogateResult = null; }
          }
          const reclassified = scanner.classifyDevice({ ip: device.ip, mac: device.mac, openPorts: stillOpen, interrogateResult });
          return { reachable: stillOpen.length > 0, open_ports: stillOpen, identity: reclassified.identity, classified_as: reclassified.classified_as };
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), TEST_TIMEOUT_MS)),
      ]);
      return { ok: true, test, latency_ms: Date.now() - startedAt, result: probe };
    } catch (err) {
      return { ok: false, test, latency_ms: Date.now() - startedAt, error: err.message };
    }
  }

  if (test === 'wol') {
    if (!device.mac) return { ok: false, test, error: 'No known MAC address for this device -- cannot send a magic packet.' };
    try {
      await wol.sendMagicPacket(device.mac);
    } catch (err) {
      return { ok: false, test, latency_ms: Date.now() - startedAt, error: err.message };
    }
    // Poll for the device coming back reachable for up to WOL_POLL_WINDOW_MS.
    const deadline = Date.now() + WOL_POLL_WINDOW_MS;
    let backOnline = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, WOL_POLL_INTERVAL_MS));
      const scannerMod = require('./scanner');
      const swept = await scannerMod.tcpSweep([device.ip], device.open_ports && device.open_ports.length ? device.open_ports : [8001, 8080, 8060]);
      if ((swept.get(device.ip) || []).length) { backOnline = true; break; }
    }
    return { ok: backOnline, test, latency_ms: Date.now() - startedAt, result: { back_online: backOnline } };
  }

  // round_trip / pair / power_cycle / channel: each needs a real per-vendor
  // command driver (Samsung WS pairing+control, DirecTV key-code tuning)
  // that docs/venue-control.md's own build order (§12) assigns to Phase 2/
  // 3/6, not Phase 1. Returned as a clear, diagnosable "not yet" rather
  // than a half-implemented command against real hardware nobody's
  // reviewed yet -- see the Phase 1 section of claude/project-status.md.
  return {
    ok: false,
    test,
    error: `The "${test}" test needs a device driver that hasn't been built yet (docs/venue-control.md §12, Phase 2/3/6) -- identity, power_state, and wol are the tests Phase 1 supports.`,
  };
}

async function runTest({ runId, targets, test }) {
  const run = getRun(runId || 'latest');
  if (!run) throw new Error(`No discovery run #${runId || 'latest'} in the local cache -- run a scan first.`);
  const devices = resolveTargets(run, targets);
  if (!devices.length) throw new Error('No matching devices found for the given targets.');

  // Bulk runs sequentially with concurrency 4 per §9.2.
  const results = [];
  let next = 0;
  async function worker() {
    while (next < devices.length) {
      const device = devices[next++];
      const outcome = await runOneTest(device, test);
      results.push({ ip: device.ip, cloud_device_id: device.cloud_device_id, ...outcome });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, devices.length) }, worker));

  // Persist test_results back onto the cached run's device records.
  const byIp = new Map(results.map((r) => [r.ip, r]));
  run.devices = run.devices.map((d) => {
    if (!byIp.has(d.ip)) return d;
    const r = byIp.get(d.ip);
    return { ...d, test_results: { ...(d.test_results || {}), [test]: { ok: r.ok, latency_ms: r.latency_ms, result: r.result, error: r.error, at: new Date().toISOString() } } };
  });
  cache.set(runKey(run.id), run);

  return { run_id: run.id, test, results };
}

// ------------------------------------------------------------------ adopt

async function adopt({ runId, deviceIp, deviceCloudId, as, fields }) {
  const run = getRun(runId || 'latest');
  if (!run) throw new Error(`No discovery run #${runId || 'latest'} in the local cache -- run a scan first.`);
  const device = run.devices.find((d) => d.ip === deviceIp || d.cloud_device_id === deviceCloudId);
  if (!device) throw new Error(`Device not found in run #${run.id}.`);
  if (!device.cloud_device_id) {
    throw new Error('This run has not synced to the cloud yet (no internet at scan time?) -- resync it before adopting from it.');
  }
  if (as !== 'tv' && as !== 'source') throw new Error('`as` must be "tv" or "source".');

  const adopted = await cloud.pushAdopt({
    discoveryDeviceId: device.cloud_device_id,
    as,
    fields: {
      ip: device.ip,
      mac: device.mac,
      ...fields,
    },
  });

  run.devices = run.devices.map((d) => (d.ip === device.ip ? { ...d, adopted_type: as, adopted_id: adopted.id } : d));
  cache.set(runKey(run.id), run);

  return adopted;
}

module.exports = { runScan, resyncRun, getRun, runTest, adopt };
