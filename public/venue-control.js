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
})();
