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
      </div>`;
  }).join('');
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
