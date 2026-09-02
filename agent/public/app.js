function timeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

function badge(ok, onText, offText) {
  return `<span class="badge ${ok ? 'on' : 'off'}">${ok ? onText : offText}</span>`;
}

async function refresh() {
  const el = document.getElementById('status');
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    const synced = !!s.lastHeartbeatOk;
    el.innerHTML = `
      <div class="row"><span class="k">Cloud sync</span>${badge(synced, 'connected', s.hasToken ? 'not connected' : 'no token set')}</div>
      <div class="row"><span class="k">Location</span><span>${s.site?.site?.name || '—'}</span></div>
      <div class="row"><span class="k">Registered</span><span>${timeAgo(s.lastRegisterAt)}</span></div>
      <div class="row"><span class="k">Last heartbeat</span><span>${timeAgo(s.lastHeartbeatAt)}</span></div>
      <div class="row"><span class="k">Config last checked</span><span>${timeAgo(s.lastConfigCheckAt)}</span></div>
      <div class="row"><span class="k">Uptime</span><span>${Math.floor(s.uptimeSeconds / 60)}m</span></div>
      <div class="row"><span class="k">Cloud URL</span><span class="muted">${s.cloudUrl}</span></div>
    `;
  } catch (e) {
    el.innerHTML = `<p class="muted">Can't reach the agent's own API — is the server running?</p>`;
  }
}

refresh();
setInterval(refresh, 5000);
