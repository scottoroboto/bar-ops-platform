// Placeholder page — the real Venue Control app (device discovery, source/TV
// control, layouts, schedules) is not built yet; see docs/venue-control.md.
// This page exists now only to claim the Apps Home tile and prove the
// device-gating works, so the tile isn't sitting there unprotected while
// the real build waits on an on-site agent host.
//
// Gating is device-based, not role-based: the owner can open this from
// anywhere, but everyone else only sees/reaches it from a browser already
// marked as the location's trusted shared device (see getTrustedDeviceInfo()
// in common.js) — same mechanism as PIN-only login on a shared bar iPad,
// reused here instead of building a second pairing system.

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

(async function init() {
  const person = requireAuth();
  if (!person) return;

  const trustedDevice = await getTrustedDeviceInfo();
  const allowed = person.role === 'owner' || !!trustedDevice;

  if (!allowed) {
    document.getElementById('app').innerHTML =
      '<div class="card"><p>Venue Control is only available on the location\'s trusted device, or to the owner.</p>' +
      '<p><a href="/dashboard.html">Back to home</a></p></div>';
    return;
  }

  renderTopbar('Venue Control');

  const noteEl = document.getElementById('deviceNote');
  if (trustedDevice) {
    noteEl.textContent = `This device is trusted for ${trustedDevice.locationName}.`;
  } else if (person.role === 'owner') {
    noteEl.textContent = 'Viewing as owner — this browser is not a trusted device.';
  }

  // Sites admin (owner-only, regardless of device trust — this is setup,
  // not day-to-day TV control) — per-location on/off switch for Venue
  // Control, independent of a location's own active/archived state
  // (locations.active). Lets a location like Ticket 3, which is inactive
  // platform-wide, still be turned on here individually.
  if (person.role === 'owner') {
    document.getElementById('sitesCard').style.display = '';
    await loadSites();
  }
})();

let SITES = [];

async function loadSites() {
  try {
    SITES = await api('/api/venue-control/sites');
    renderSitesList();
  } catch (e) {
    document.getElementById('sitesList').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function renderSitesList() {
  const el = document.getElementById('sitesList');
  if (!SITES.length) { el.innerHTML = '<p class="muted">No locations yet.</p>'; return; }
  el.innerHTML = SITES.map(s => {
    const on = !!s.site_enabled;
    return `
      <div class="list-row">
        <div class="name">${escapeHtml(s.location_name)}
          ${!s.location_active ? '<span class="badge off">location archived</span>' : ''}
          <span class="badge ${on ? 'on' : 'off'}">${on ? 'Venue Control on' : s.site_id ? 'Venue Control off' : 'not added'}</span>
        </div>
        <div class="stack-actions" style="margin-top:0;">
          ${on
            ? `<button class="small ghost" onclick="setSiteEnabled('${s.location_id}', false)">Turn off</button>`
            : `<button class="small secondary" style="margin-top:0;" onclick="setSiteEnabled('${s.location_id}', true)">${s.site_id ? 'Turn on' : 'Add to Venue Control'}</button>`}
        </div>
        ${on ? renderAgentRow(s) : ''}
        <div id="tokenBox_${s.location_id}"></div>
      </div>`;
  }).join('');
}

// Agent status line — only shown once a site is on (matches the routes:
// there's nothing on-site to talk to for a site that isn't). "not
// registered yet" is the expected state until Scotto sets up the on-site
// box (see agent/README.md) and it calls POST /api/venue/agent/register at
// least once. "online"/"offline" is a simple staleness check against the
// agent's own 30s heartbeat cadence, not a live push.
function renderAgentRow(s) {
  let statusText, statusClass;
  if (!s.agent_hostname) {
    statusText = 'not registered yet';
    statusClass = 'off';
  } else {
    const ageMs = Date.now() - new Date(s.agent_last_seen_at).getTime();
    const stale = ageMs > 2 * 60 * 1000; // more than ~4 missed 30s heartbeats
    statusText = `${stale ? 'offline' : 'online'} — ${escapeHtml(s.agent_hostname)}, last seen ${formatAgo(ageMs)}`;
    statusClass = stale ? 'off' : 'on';
  }
  return `
    <div class="muted" style="margin-top:8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
      <span>Agent: <span class="badge ${statusClass}">${statusText}</span></span>
      <button class="small ghost" onclick="generateAgentToken('${s.location_id}')">${s.has_agent_token ? 'Regenerate agent token' : 'Generate agent token'}</button>
    </div>`;
}

function formatAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// Shown exactly once, inline, right under the row it belongs to — the
// server never returns this token again after this response (only its
// hash is stored), so there's no "view token" to come back to later.
async function generateAgentToken(locationId) {
  const box = document.getElementById(`tokenBox_${locationId}`);
  try {
    const result = await withStepUp(() => api(`/api/venue-control/sites/${locationId}/agent-token`, { method: 'POST' }));
    box.innerHTML = `
      <div class="msg info" style="margin-top:8px;">
        <p style="margin:0 0 6px;"><strong>Copy this now — it won't be shown again.</strong> Paste it into the agent's <code>.env</code> file as <code>AGENT_TOKEN</code> (see agent/README.md).</p>
        <code style="display:block; padding:8px; background:rgba(0,0,0,0.25); border-radius:6px; word-break:break-all; user-select:all;">${escapeHtml(result.agentToken)}</code>
        <button class="small ghost" style="margin-top:6px;" onclick="document.getElementById('tokenBox_${locationId}').innerHTML=''">Done, I copied it</button>
      </div>`;
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function setSiteEnabled(locationId, enabled) {
  try {
    await withStepUp(() => api(`/api/venue-control/sites/${locationId}/set-enabled`, { method: 'POST', body: { enabled } }));
    showMsg(enabled ? 'Venue Control turned on for this location.' : 'Venue Control turned off for this location.', 'success');
    await loadSites();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}
