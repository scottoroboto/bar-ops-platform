// Local Discovery & Diagnostics UI (docs/venue-control.md §9/§10 — "driven
// from the iPad"). Talks only to this agent's own API (/api/discovery/*),
// never straight to Supabase — the agent box is the only thing that can
// scan its own subnet, and it's the one place the admin PIN is checked.
let ADMIN_PIN = '';
let LAST_RUN = null;

function submitPin() {
  const pin = document.getElementById('pinInput').value;
  ADMIN_PIN = pin;
  // Prove the PIN actually works before showing the rest of the page —
  // GET /api/discovery/runs/latest is harmless and cheap to use as a check.
  api('/api/discovery/runs/latest').then(() => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = '';
    loadLatestRun();
  }).catch((e) => {
    // A 404 ("no run yet") still means the PIN was accepted — anything
    // else (401) means it wasn't.
    if (String(e.message).startsWith('404')) {
      document.getElementById('pinGate').style.display = 'none';
      document.getElementById('app').style.display = '';
      return;
    }
    document.getElementById('pinMsg').innerHTML = `<div class="msg error">Incorrect PIN.</div>`;
  });
}
document.getElementById('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-pin': ADMIN_PIN, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error || res.statusText}`);
  return data;
}

function confBadge(conf) { return `<span class="badge ${conf}">${conf}</span>`; }

function renderRun(run) {
  LAST_RUN = run;
  const metaEl = document.getElementById('runMeta');
  const syncNote = run.synced
    ? `<span class="badge on">synced</span>`
    : `<span class="badge off">not synced${run.sync_error ? ' — ' + escapeHtml(run.sync_error) : ''}</span> <button onclick="resyncRun(${run.id})">Retry sync</button>`;
  metaEl.innerHTML = `run #${run.id} · ${run.devices.length} device(s) of ${run.host_count} host(s) scanned · ${syncNote}`;

  const box = document.getElementById('resultsBox');
  if (!run.devices.length) { box.innerHTML = '<p class="muted">No devices answered this scan.</p>'; return; }
  box.innerHTML = `
    <table>
      <thead><tr><th>IP</th><th>MAC</th><th>Vendor</th><th>Ports</th><th>Classified as</th><th>Confidence</th><th>Adopted</th><th>Actions</th></tr></thead>
      <tbody>
        ${run.devices.map((d, i) => `
          <tr>
            <td class="mono">${escapeHtml(d.ip)}</td>
            <td class="mono">${escapeHtml(d.mac || '—')}</td>
            <td>${escapeHtml(d.oui_vendor || '—')}</td>
            <td class="mono">${(d.open_ports || []).join(', ') || '—'}</td>
            <td>${escapeHtml(d.classified_as)}</td>
            <td>${confBadge(d.confidence)}</td>
            <td>${d.adopted_type ? `<span class="badge on">${d.adopted_type} #${d.adopted_id}</span>` : '—'}</td>
            <td class="actions-cell">
              <select id="testSel_${i}">
                <option value="identity">identity</option>
                <option value="power_state">power_state</option>
                <option value="wol">wol</option>
                <option value="round_trip">round_trip</option>
                <option value="pair">pair</option>
                <option value="power_cycle">power_cycle</option>
                <option value="channel">channel</option>
              </select>
              <button onclick="runTest('${d.ip}', ${i})">Test</button>
              ${d.adopted_type ? '' : `<button class="primary" onclick="openAdopt('${d.ip}')">Adopt</button>`}
              ${d.test_results ? `<div class="muted" style="margin-top:4px;">${Object.entries(d.test_results).map(([t, r]) => `${t}: ${r.ok ? 'ok' : 'failed'}`).join(' · ')}</div>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadLatestRun() {
  try {
    const run = await api('/api/discovery/runs/latest');
    renderRun(run);
  } catch (e) {
    if (!String(e.message).startsWith('404')) {
      document.getElementById('resultsBox').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
    }
  }
}

async function startScan() {
  const btn = document.getElementById('scanBtn');
  const msgEl = document.getElementById('scanMsg');
  const rangesRaw = document.getElementById('rangesInput').value.trim();
  const ranges = rangesRaw ? rangesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  btn.disabled = true;
  msgEl.innerHTML = `<p class="muted">Scanning — this can take up to a minute for a full /24…</p>`;
  try {
    const { run } = await api('/api/discovery/scan', { method: 'POST', body: JSON.stringify({ ranges, deep: document.getElementById('deepCheck').checked }) });
    msgEl.innerHTML = '';
    renderRun(run);
  } catch (e) {
    msgEl.innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function resyncRun(id) {
  try {
    const { run } = await api(`/api/discovery/runs/${id}/resync`, { method: 'POST' });
    renderRun(run);
  } catch (e) {
    alert(e.message);
  }
}

async function runTest(ip, rowIndex) {
  const test = document.getElementById(`testSel_${rowIndex}`).value;
  const disruptive = ['round_trip', 'wol', 'power_cycle', 'channel'].includes(test);
  if (disruptive && !confirm(`"${test}" changes this device's state (or attempts to). Continue?`)) return;
  try {
    await api('/api/discovery/test', { method: 'POST', body: JSON.stringify({ run_id: LAST_RUN.id, targets: [ip], test }) });
    await loadLatestRun();
  } catch (e) {
    alert(e.message);
  }
}

let ADOPT_IP = null;

function openAdopt(ip) {
  ADOPT_IP = ip;
  document.getElementById('adoptMsg').innerHTML = '';
  renderAdoptFields();
  document.getElementById('adoptDialog').showModal();
}

function renderAdoptFields() {
  const as = document.getElementById('adoptAs').value;
  const el = document.getElementById('adoptFields');
  if (as === 'tv') {
    el.innerHTML = `
      <div class="field"><label>Name</label><input id="af_name" placeholder="Main Bar Left"></div>
      <div class="field"><label>Tag</label><input id="af_tag" placeholder="MB-01"></div>
      <div class="field"><label>Zone ID (optional)</label><input id="af_zoneId" type="number"></div>
      <div class="field"><label>Control method</label>
        <select id="af_controlMethod">
          <option value="samsung_ws_token">samsung_ws_token</option>
          <option value="samsung_ws_plain">samsung_ws_plain</option>
          <option value="samsung_legacy">samsung_legacy</option>
          <option value="wol_only">wol_only</option>
          <option value="unknown">unknown</option>
        </select>
      </div>
      <div class="field"><label><input type="checkbox" id="af_wolEnabled"> WoL enabled</label></div>
      <div class="field"><label>Default source slot (optional)</label><input id="af_defaultSourceSlot" type="number"></div>
    `;
  } else {
    el.innerHTML = `
      <div class="field"><label>Slot</label><input id="af_slot" type="number"></div>
      <div class="field"><label>QAM channel</label><input id="af_qamChannel" placeholder="14.1"></div>
      <div class="field"><label>Label</label><input id="af_label" placeholder="DirecTV 14"></div>
      <div class="field"><label>Kind</label>
        <select id="af_kind"><option value="directv">directv</option><option value="roku">roku</option><option value="static">static</option><option value="spare">spare</option></select>
      </div>
    `;
  }
}

async function submitAdopt() {
  const as = document.getElementById('adoptAs').value;
  const fields = as === 'tv'
    ? {
        name: document.getElementById('af_name').value,
        tag: document.getElementById('af_tag').value || null,
        zoneId: document.getElementById('af_zoneId').value ? Number(document.getElementById('af_zoneId').value) : null,
        controlMethod: document.getElementById('af_controlMethod').value,
        wolEnabled: document.getElementById('af_wolEnabled').checked,
        defaultSourceSlot: document.getElementById('af_defaultSourceSlot').value ? Number(document.getElementById('af_defaultSourceSlot').value) : null,
      }
    : {
        slot: Number(document.getElementById('af_slot').value),
        qamChannel: document.getElementById('af_qamChannel').value,
        label: document.getElementById('af_label').value,
        kind: document.getElementById('af_kind').value,
      };
  try {
    await api('/api/discovery/adopt', { method: 'POST', body: JSON.stringify({ run_id: LAST_RUN.id, ip: ADOPT_IP, as, ...fields }) });
    document.getElementById('adoptDialog').close();
    await loadLatestRun();
  } catch (e) {
    document.getElementById('adoptMsg').innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}
