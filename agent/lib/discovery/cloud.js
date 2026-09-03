// Cloud calls specific to discovery (docs/venue-control.md §8.1's
// `POST /api/venue/agent/discovery` line, split here into the two concrete
// operations the spec's §9 flow actually needs: pushing a finished run+
// device list, and writing through an adopted device into vc_tvs/vc_sources).
// Kept separate from lib/sync.js, which owns register/config/heartbeat only
// -- same "each file owns one job" convention used elsewhere in this repo.
const { CLOUD_URL, AGENT_TOKEN } = require('../../config');

function authHeaders() {
  return { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json' };
}

// Pushes a completed scan (docs/venue-control.md §9.1's "Report" step) to
// the cloud, which persists it as a vc_discovery_runs row + vc_discovery_
// devices rows and hands back a cloud id for the run and for each device
// (keyed by ip) so later /test and /adopt calls can reference them.
//
// Deliberately does not throw on network failure -- discovery has to keep
// working through an ISP outage (§6's "agent holds no unique state" is
// about the *config* cache, but a scan run taken with no internet is still
// useful locally and shouldn't be lost or blocked). Callers check
// `result.ok` and fall back to treating the run as local-only/unsynced.
async function pushRun(run) {
  try {
    const res = await fetch(`${CLOUD_URL}/api/venue/agent/discovery/runs`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        ranges: run.ranges,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        hostCount: run.host_count,
        devices: run.devices,
      }),
    });
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text()}` };
    const data = await res.json();
    return { ok: true, cloudRunId: data.runId, devices: data.devices || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Writes an adopted device through to vc_tvs or vc_sources. Requires the
// device to already have a cloud discovery-device id (i.e. its run was
// successfully pushed via pushRun above) -- adopting a device from a run
// that never made it to the cloud isn't possible until connectivity is
// back and the run is re-pushed, since there's nothing in Supabase yet to
// attach the adoption to.
async function pushAdopt({ discoveryDeviceId, as, fields }) {
  const res = await fetch(`${CLOUD_URL}/api/venue/agent/discovery/adopt`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ discoveryDeviceId, as, ...fields }),
  });
  if (!res.ok) throw new Error(`adopt failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { pushRun, pushAdopt };
