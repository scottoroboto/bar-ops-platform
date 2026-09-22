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

// sameNetwork is the cloud's comparison of this device's public IP with the
// one the bar's box heartbeats from: true = same internet connection, so
// the box's LAN address will load; false = you're somewhere else (cellular,
// home, another bar) and it won't; null = can't tell. It's a heuristic, so
// a mismatch still leaves the button available -- just labeled honestly.
function networkNote(r) {
  if (r.sameNetwork === true) return `<span class="badge on">you’re on this bar’s network</span>`;
  if (r.sameNetwork === false) return `<span class="badge stale">network mismatch — you’re not on ${escapeHtml(r.locationName)}’s WiFi</span>`;
  return '';
}

function rowHtml(r) {
  const status = r.online
    ? `<span class="badge on">box online</span>`
    : `<span class="badge off">box offline</span> <span class="muted">last seen ${fmtAgo(r.lastSeenAt)}</span>`;
  let action;
  if (!r.online) action = `<button class="small ghost" style="margin-top:0;" disabled>Box not reachable</button>`;
  else if (r.sameNetwork === false) action = `<button class="small ghost" style="margin-top:0;" onclick="window.location.href='${escapeHtml(r.url)}'">Try anyway</button>`;
  else action = `<button class="small primary" style="margin-top:0;" onclick="window.location.href='${escapeHtml(r.url)}'">Open TV controls</button>`;
  return `
    <div class="list-row">
      <div class="name">${escapeHtml(r.locationName)}<div class="sub">${status}${r.lanIp ? ` <span class="muted">· ${escapeHtml(r.lanIp)}</span>` : ''} ${networkNote(r)}</div></div>
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
    // patch_036: the everyday PIN session isn't enough here — the server
    // answers STEP_UP_REQUIRED and withStepUp asks for the password. The
    // bar's trusted iPad is let through on device trust alone.
    rows = await withStepUp(() => api('/api/venue-control/staff-links' + (deviceToken ? '?deviceToken=' + encodeURIComponent(deviceToken) : '')));
  } catch (e) {
    hint.innerHTML = `<span class="msg error">${escapeHtml(e.message)}</span>`;
    return;
  }

  if (!rows.length) {
    hint.textContent = "TV Staff isn't switched on for you, or no bar's TV box is set up yet. A manager can turn it on for a shift from Employees.";
    return;
  }

  // One bar, it's up, and we're not sure we're somewhere else: don't make
  // them click twice. A known network mismatch drops through to the list
  // so the explanation is on screen instead of a dead page.
  if (rows.length === 1 && rows[0].online && rows[0].sameNetwork !== false) {
    hint.textContent = `Opening ${rows[0].locationName}'s TV controls…`;
    window.location.replace(rows[0].url);
    return;
  }

  const mismatched = rows.filter((r) => r.online && r.sameNetwork === false);
  if (rows.length === mismatched.length && mismatched.length) {
    hint.innerHTML = `<span class="msg error">You’re not on ${mismatched.length === 1 ? escapeHtml(mismatched[0].locationName) + '’s' : 'any bar’s'} network. The TV controls run on a box inside the bar and only load from that bar’s WiFi — join it and reload this page.</span>`;
  } else {
    hint.textContent = rows.some((r) => r.online)
      ? 'Pick the bar you’re at. You need to be on that bar’s WiFi for the controls to load.'
      : 'No TV box is reachable right now. Check that the box at the bar is powered on and plugged into the network.';
  }
  list.innerHTML = rows.map(rowHtml).join('');
})();
