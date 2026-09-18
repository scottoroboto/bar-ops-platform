// TV Staff — the hop from the cloud dashboard to the on-site box's own
// staff pages (agent/public/staff_tvs.html and friends), which is where
// live TV/receiver control actually happens. The box only exists on the
// bar's LAN, so this page just finds its current address (reported by the
// agent on every heartbeat — see /api/venue-control/staff-links) and sends
// the person there. On the shared iPad or a manager's phone there's
// normally exactly one bar to pick, so it goes straight through without
// showing a list; the owner sees one row per bar.

function fmtAgo(iso) {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} hr ago`;
  return `${Math.round(secs / 86400)} days ago`;
}

function rowHtml(r) {
  const status = r.online
    ? `<span class="badge on">online</span>`
    : `<span class="badge off">offline</span> <span class="muted">last seen ${fmtAgo(r.lastSeenAt)}</span>`;
  const action = r.online
    ? `<button class="small primary" style="margin-top:0;" onclick="window.location.href='${escapeHtml(r.url)}'">Open TV controls</button>`
    : `<button class="small ghost" style="margin-top:0;" disabled>Box not reachable</button>`;
  return `
    <div class="list-row">
      <div class="name">${escapeHtml(r.locationName)}<div class="sub">${status}${r.lanIp ? ` <span class="muted">· ${escapeHtml(r.lanIp)}</span>` : ''}</div></div>
      <div class="stack-actions" style="margin-top:0;">${action}</div>
    </div>`;
}

(async function init() {
  const person = requireAuth();
  if (!person) return;
  renderTopbar('TV Staff');
  const hint = document.getElementById('tvStaffHint');
  const list = document.getElementById('tvStaffList');

  let rows = [];
  try {
    const deviceToken = getDeviceToken();
    rows = await api('/api/venue-control/staff-links' + (deviceToken ? '?deviceToken=' + encodeURIComponent(deviceToken) : ''));
  } catch (e) {
    hint.innerHTML = `<span class="msg error">${escapeHtml(e.message)}</span>`;
    return;
  }

  if (!rows.length) {
    hint.textContent = "No bar's TV box is set up for this account or device yet. The owner turns a location on under TV Admin → Sites.";
    return;
  }

  // One bar and it's up: don't make them click twice.
  if (rows.length === 1 && rows[0].online) {
    hint.textContent = `Opening ${rows[0].locationName}'s TV controls…`;
    window.location.replace(rows[0].url);
    return;
  }

  hint.textContent = rows.some((r) => r.online)
    ? 'Pick the bar you’re at. You need to be on that bar’s WiFi for the controls to load.'
    : 'No TV box is reachable right now. Check that the box at the bar is powered on and plugged into the network.';
  list.innerHTML = rows.map(rowHtml).join('');
})();
