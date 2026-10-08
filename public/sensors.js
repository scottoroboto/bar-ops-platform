// Coolers (patch_059): the sensor boxes' temperatures for one bar, the
// alerts on them, naming new probes, limits per cooler, each box's
// report interval and troubleshooting mode, the gateway, and settings.
// Owner, or anyone with the Monitoring app at that bar.
let LOCATIONS = [];
let VIEW = null;
let OPEN = null;      // probe row id open in the detail panel
let RANGE = '24h';
const person = getPerson();
if (!getToken()) goLogin();
renderTopbar('Coolers');

function locId() { return document.getElementById('snLocation').value; }
function showMsg(text, kind) { document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'success'}">${escapeHtml(text)}</div>` : ''; }
const esc = escapeHtml;
const f1 = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}°`);
const ago = (m) => (m == null ? 'never' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`);
const batt = (n) => (n && n.batteryPct != null ? `${n.batteryPct}%` : (n && n.battMv === 0 ? 'USB' : '—'));
const stateLabel = { normal: 'normal', high: 'too warm', low: 'too cold', error: 'probe error', silent: 'no reports', unknown: 'waiting' };

async function init() {
  const locs = await api('/api/locations');
  LOCATIONS = (Array.isArray(locs) ? locs : []).filter((l) => person.role === 'owner' || myLocationIds(person).includes(String(l.id)));
  const sel = document.getElementById('snLocation');
  sel.innerHTML = LOCATIONS.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  const want = new URLSearchParams(location.search).get('location_id') || initialLocationId(person, LOCATIONS);
  if (want && LOCATIONS.some((l) => String(l.id) === String(want))) sel.value = want;
  await loadAll();
  setInterval(() => loadAll(true), 60000);
}

async function loadAll(quiet) {
  const id = locId();
  if (!id) return;
  rememberLocationId(id);
  try {
    VIEW = await api(`/api/sensors/view?location_id=${encodeURIComponent(id)}`);
    render();
    if (OPEN) await openDetail(OPEN, true);
  } catch (e) { if (!quiet) showMsg(e.message, 'error'); }
}

function tileHtml(p) {
  const n = p.node || {};
  return `<button class="sn-tile sn-${p.state}" onclick="openDetail('${p.id}')" title="${esc(p.name)}">
    <span class="nm">${esc(p.name)}${p.position ? ` · ${esc(p.position)}` : ''}</span>
    <span class="deg">${p.tempF == null ? '—' : Math.round(p.tempF) + '°'}</span>
    <span class="meta"><span>${p.state === 'normal' ? ago(p.minutesAgo) : esc(stateLabel[p.state] || p.state)}</span><span>${batt(n)}${n.signal ? ` · ${n.signal}` : ''}</span></span>
  </button>`;
}

function render() {
  const v = VIEW;
  // alerts
  const probeAlerts = [...v.probes, ...v.unassigned].filter((p) => p.alert).map((p) => ({ id: p.alert.id, text: p.alert.message, ack: p.alert.acknowledgedAt, quiet: false, probe: p.id }));
  const nodeAlerts = v.nodes.filter((n) => n.alert).map((n) => ({ id: n.alert.id, text: n.alert.message, ack: n.alert.acknowledgedAt, quiet: !(n.silent || n.co2State === 'alarm') }));
  const alerts = [...probeAlerts, ...nodeAlerts];
  document.getElementById('alertsBox').innerHTML = alerts.length ? `<div class="card"><div class="sn-kick" style="margin-top:0;"><span>Needs attention · ${alerts.length}</span></div>
    ${alerts.map((a) => `<div class="sn-alert ${a.quiet ? 'quiet' : ''}"><div style="font-size:13px;">${esc(a.text || '')}${a.ack ? ` <span class="sn-pill">acknowledged</span>` : ''}</div>
      <div class="sn-inline">${a.probe ? `<button class="small secondary" onclick="openDetail('${a.probe}')">Detail</button>` : ''}${a.ack ? '' : `<button class="small" onclick="ackAlert('${a.id}')">Acknowledge</button>`}</div></div>`).join('')}</div>` : '';

  // coolers by area
  const areas = [['bar', 'Bar'], ['kitchen', 'Kitchen'], ['other', 'Other']];
  const groups = areas.map(([k, label]) => ({ label, list: v.probes.filter((p) => p.area === k) })).filter((g) => g.list.length);
  document.getElementById('coolersBox').innerHTML = `<div class="card">
    ${groups.length ? groups.map((g) => `<div class="sn-kick"><span>${g.label} · ${g.list.length}</span></div><div class="sn-tiles">${g.list.map(tileHtml).join('')}</div>`).join('')
    : `<p class="muted">No coolers named yet.${v.unassigned.length ? ' New probes are waiting below: tap one to name it and say which cooler it is in.' : ' Nothing has reported from this bar\'s sensor boxes yet.'}</p>`}
  </div>`;

  // unassigned
  document.getElementById('newBox').innerHTML = v.unassigned.length ? `<div class="card"><div class="sn-kick" style="margin-top:0;"><span>New probes · ${v.unassigned.length}</span><span style="text-transform:none; letter-spacing:0;">tap to name</span></div>
    <div class="sn-tiles">${v.unassigned.map(tileHtml).join('')}</div>
    <p class="muted" style="font-size:12px; margin-top:8px;">A probe keeps its id when it is moved to another box, so name the cooler, not the box.</p></div>` : '';

  // boxes
  document.getElementById('nodesBox').innerHTML = `<div class="card"><div class="sn-kick" style="margin-top:0;"><span>Sensor boxes · ${v.nodes.length}</span>
      ${v.nodes.length ? `<span class="sn-inline" style="text-transform:none; letter-spacing:0;">all report every <select id="snAllInterval" onchange="setAllInterval(this.value)"><option value="">…</option>${intervalOptions(null)}</select></span>` : ''}</div>
    ${v.nodes.length ? v.nodes.map((n) => `<div class="sn-row" style="flex-wrap:wrap;">
      <div style="flex:1; min-width:180px;"><b>${esc(n.label)}</b> <span class="muted" style="font-size:11px;">${esc(n.mac)}</span>
        <div class="muted" style="font-size:12px;">${n.kind === 'co2' ? `CO2 ${co2Text(n)}` : `${n.probeCount} probe${n.probeCount === 1 ? '' : 's'}`} · battery ${batt(n)}${n.battMv ? ` (${(n.battMv / 1000).toFixed(2)} V)` : ''} · signal ${n.rssi != null ? `${n.rssi} dBm ${n.signal}` : '—'} · ${ago(n.minutesAgo)}${n.fw ? ` · fw ${esc(n.fw)}` : ''}
        ${n.silent ? ' <span class="sn-pill bad">silent</span>' : ''}${n.batteryLow ? ' <span class="sn-pill warn">swap battery</span>' : ''}${n.signalWeak ? ' <span class="sn-pill warn">weak signal</span>' : ''}${n.pending ? ' <span class="sn-pill">interval pending</span>' : ''}${n.troubleshootUntil ? ` <span class="sn-pill ok">troubleshooting · ${Math.max(0, Math.round((new Date(n.troubleshootUntil) - Date.now()) / 60000))} min left</span>` : ''}${n.installUntil ? ' <span class="sn-pill ok">install mode</span>' : ''}</div></div>
      <div class="sn-inline">
        <select onchange="setNodeInterval('${n.id}', this.value)" title="Report interval">${intervalOptions(n.reportIntervalS)}</select>
        ${n.troubleshootUntil ? `<button class="small secondary" onclick="setMode('${n.id}','troubleshoot',false)">Stop</button>` : `<button class="small secondary" onclick="setMode('${n.id}','troubleshoot',true)">Troubleshoot 15 min</button>`}
        <button class="small ghost" onclick="renameNode('${n.id}', '${esc(n.label).replace(/'/g, '&#39;')}')">Rename</button>
      </div></div>`).join('') : '<p class="muted">No boxes have reported yet.</p>'}
    <p class="muted" style="font-size:12px; margin-top:8px;">Battery per interval, 18650 cell: 1 min ≈ 3–4 months · 2 min ≈ 6–8 · 5 min ≈ 12+ · 10–15 min ≈ 18+. A change takes effect at the box's next report. Troubleshoot: every 30 s for 15 min, then back by itself.</p>
  </div>`;

  // gateways
  document.getElementById('gatewaysBox').innerHTML = `<div class="card"><div class="sn-kick" style="margin-top:0;"><span>Gateway</span></div>
    ${v.gateways.length ? v.gateways.map((g) => `<div class="sn-row"><span><b>${esc(g.label)}</b> <span class="muted" style="font-size:11px;">${esc(g.mac)}${g.fw ? ` · fw ${esc(g.fw)}` : ''}</span></span>
      <span class="${g.secondsAgo != null && g.secondsAgo > 300 ? 'sn-pill bad' : 'sn-pill ok'}">${g.secondsAgo == null ? 'never' : g.secondsAgo < 90 ? `checked in ${g.secondsAgo} s ago` : ago(Math.round(g.secondsAgo / 60))}</span></div>`).join('')
    : '<p class="muted">No gateway has checked in from this bar\'s box yet. Plug the gateway into the venue-control Pi\'s USB; it shows up here within a minute.</p>'}</div>`;

  // events
  document.getElementById('eventsBox').innerHTML = v.events.length ? `<div class="card"><div class="sn-kick" style="margin-top:0;"><span>Recent</span></div>
    ${v.events.slice(0, 10).map((e) => `<div class="sn-row"><span>${esc(e.nodeLabel || '')} · ${esc(eventText(e))}</span><span class="muted">${new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>`).join('')}</div>` : '';

  // settings (owner)
  document.getElementById('settingsBox').innerHTML = person.role === 'owner' ? `<div class="card"><div class="sn-kick" style="margin-top:0;"><span>Defaults for new probes · ${esc(locName())}</span></div>
    <div class="sn-grid">
      <label>High limit (°F)<input id="sHigh" type="number" step="0.5" value="${v.settings.defaultHighF}"></label>
      <label>Low limit (°F)<input id="sLow" type="number" step="0.5" value="${v.settings.defaultLowF}"></label>
      <label>Minutes out of range before alerting<input id="sAfter" type="number" step="1" min="1" value="${v.settings.defaultAlertAfterMin}"></label>
      <label>Remind every (minutes) until acknowledged<input id="sRenotify" type="number" step="5" min="5" value="${v.settings.renotifyMin}"></label>
    </div>
    <button class="secondary" onclick="saveSettings()">Save defaults</button>
    <p class="muted" style="font-size:12px;">Who gets cooler texts: Systems Monitoring → Alerts → routes, and each person's own channel under Notifications. Each cooler's own limits are on its detail.</p></div>` : '';
}

function locName() { const l = LOCATIONS.find((x) => String(x.id) === String(locId())); return l ? l.name : ''; }
function intervalOptions(sel) { return [[60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min'], [900, '15 min']].map(([v, l]) => `<option value="${v}" ${Number(sel) === v ? 'selected' : ''}>${l}</option>`).join(''); }
function co2Text(n) { const c = (VIEW.co2 || []).find((x) => x.nodeId === n.id); return c ? `${c.ppm} ppm · ${c.state}` : (n.co2State || '—'); }
function eventText(e) {
  const d = e.detail || {};
  if (e.kind === 'battery_swap') return `battery swapped (${(d.from_mv / 1000).toFixed(2)} → ${(d.to_mv / 1000).toFixed(2)} V)`;
  if (e.kind === 'reboot') return 'restarted';
  if (e.kind === 'fw_update') return `firmware update ${d.result}${d.fw ? ` (${d.fw})` : ''}`;
  if (e.kind === 'install_check') return `installed · signal ${d.grade || ''}`;
  return e.kind;
}

// ---- detail ----------------------------------------------------------
async function openDetail(probeId, keep) {
  OPEN = probeId;
  const p = [...VIEW.probes, ...VIEW.unassigned, ...VIEW.inactive].find((x) => x.id === probeId);
  if (!p) { OPEN = null; document.getElementById('detailBox').innerHTML = ''; return; }
  const box = document.getElementById('detailBox');
  let h = null;
  try { h = await api(`/api/sensors/probes/${probeId}/history?range=${RANGE}`); } catch (e) { /* chart just stays empty */ }
  const n = p.node || {};
  box.innerHTML = `<div class="card" id="detailCard">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
      <div><div class="sn-kick" style="margin:0 0 4px;"><span>${p.assigned ? esc(p.area || '') : 'New probe'}</span></div>
        <h2 style="margin:0;">${esc(p.name)}${p.position ? ` · ${esc(p.position)}` : ''}</h2>
        <div class="muted" style="font-size:12px;">${esc(stateLabel[p.state] || p.state)} · ${ago(p.minutesAgo)}${p.node ? ` · ${esc(n.label)} · battery ${batt(n)} · signal ${n.rssi != null ? `${n.rssi} dBm` : '—'}` : ''}</div></div>
      <div style="text-align:right;"><div style="font-family:'Barlow Condensed','Arial Narrow',sans-serif; font-style:italic; font-weight:800; font-size:44px; line-height:1; color:${p.state === 'high' || p.state === 'low' ? '#ff9fab' : p.state === 'normal' ? '#9fe8c0' : '#c4c8d0'};">${p.tempF == null ? '—' : p.tempF.toFixed(1) + '°'}</div>
        <button class="small ghost" style="margin:6px 0 0;" onclick="closeDetail()">Close</button></div>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; flex-wrap:wrap; gap:6px;">
      <span class="sn-seg">${['24h', '7d', '30d', '90d'].map((r) => `<button class="secondary ${RANGE === r ? 'on' : ''}" onclick="setRange('${r}')">${r}</button>`).join('')}</span>
      ${h && h.stats ? `<span class="muted" style="font-size:12px;">low ${f1(h.stats.minF)} · avg ${f1(h.stats.avgF)} · high ${f1(h.stats.maxF)}</span>` : ''}
    </div>
    ${chartHtml(h, p)}
    <div class="sn-grid">
      <label>Name<input id="pName" value="${esc(p.assigned ? p.name : '')}" placeholder="Draft 3, Walk-in, Bottle left…"></label>
      <label>Where<select id="pArea"><option value="">—</option><option value="bar" ${p.area === 'bar' ? 'selected' : ''}>Bar</option><option value="kitchen" ${p.area === 'kitchen' ? 'selected' : ''}>Kitchen</option><option value="other" ${p.area === 'other' ? 'selected' : ''}>Other</option></select></label>
      <label>Position (two-probe cooler)<input id="pPos" value="${esc(p.position || '')}" placeholder="left / right"></label>
      <label>Order<input id="pSort" type="number" step="1" value="${p.sortOrder || 0}"></label>
      <label>High limit (°F)<input id="pHigh" type="number" step="0.5" value="${p.highF}"></label>
      <label>Low limit (°F)<input id="pLow" type="number" step="0.5" value="${p.lowF}"></label>
      <label>Minutes before alerting<input id="pAfter" type="number" step="1" min="1" value="${p.alertAfterMin}"></label>
      <label>&nbsp;<span class="sn-inline" style="margin-top:6px;"><button class="primary" style="margin:0;" onclick="saveProbe('${p.id}')">Save</button>${p.active ? `<button class="ghost" style="margin:0;" onclick="retireProbe('${p.id}')">Retire</button>` : `<button class="secondary" style="margin:0;" onclick="saveProbe('${p.id}', true)">Bring back</button>`}</span></label>
    </div>
    <div class="muted" style="font-size:12px; margin-top:8px;">Probe id ${esc(p.probeId)}. Who gets told, and how, is set under Systems Monitoring.</div>
    ${h && h.alerts && h.alerts.length ? `<div class="sn-kick"><span>History</span></div>${h.alerts.map((a) => `<div class="sn-row"><span>${esc(a.message || '')}</span><span class="muted" style="white-space:nowrap;">${new Date(a.opened_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}${a.closed_at ? ' · cleared' : ' · open'}</span></div>`).join('')}` : ''}
  </div>`;
  if (!keep) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeDetail() { OPEN = null; document.getElementById('detailBox').innerHTML = ''; }
function setRange(r) { RANGE = r; if (OPEN) openDetail(OPEN, true); }

function chartHtml(h, p) {
  if (!h || !h.points || !h.points.length) return '<p class="muted" style="font-size:12px;">No readings in this range yet.</p>';
  const pts = h.points;
  const vals = pts.flatMap((x) => [x.f, x.minF, x.maxF]).filter((v) => v != null);
  const lo = Math.min(...vals, p.lowF) - 2; const hi = Math.max(...vals, p.highF) + 2;
  const pct = (v) => Math.max(2, Math.round((v - lo) / (hi - lo) * 100));
  const lineAt = (v, color, label) => `<div style="position:absolute; left:0; right:0; bottom:${pct(v)}%; border-top:1px dashed ${color}; font-size:10px; color:${color};"><span style="position:absolute; right:0; top:-13px;">${label}</span></div>`;
  const first = pts[0].at; const last = pts[pts.length - 1].at;
  const fmt = (iso) => new Date(iso).toLocaleString([], RANGE === '24h' ? { hour: 'numeric' } : { month: 'short', day: 'numeric' });
  return `<div class="sn-bars">${lineAt(p.highF, '#ff9fab', `${p.highF}° high`)}${lineAt(p.lowF, '#8fb6ff', `${p.lowF}° low`)}
    ${pts.map((x) => x.f == null ? '<span class="x" style="height:2%"></span>' : `<span class="${x.f > p.highF ? 'h' : x.f < p.lowF ? 'l' : ''}" style="height:${pct(x.maxF != null ? x.maxF : x.f)}%" title="${fmt(x.at)} ${f1(x.f)}"></span>`).join('')}</div>
    <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--muted); margin-top:3px;"><span>${fmt(first)}</span><span>${fmt(last)}</span></div>`;
}

// ---- actions ----------------------------------------------------------
async function saveProbe(id, bringBack) {
  const body = {
    name: document.getElementById('pName').value, area: document.getElementById('pArea').value || null, position: document.getElementById('pPos').value,
    sortOrder: document.getElementById('pSort').value, highF: document.getElementById('pHigh').value, lowF: document.getElementById('pLow').value,
    alertAfterMin: document.getElementById('pAfter').value, assigned: !!(document.getElementById('pName').value.trim() && document.getElementById('pArea').value),
  };
  if (bringBack) body.active = true;
  try { await withStepUp(() => api(`/api/sensors/probes/${id}`, { method: 'POST', body })); showMsg('Saved.'); await loadAll(); } catch (e) { showMsg(e.message, 'error'); }
}
async function retireProbe(id) {
  if (!confirm('Retire this probe? It stops showing and alerting; its history is kept.')) return;
  try { await withStepUp(() => api(`/api/sensors/probes/${id}`, { method: 'POST', body: { active: false } })); OPEN = null; await loadAll(); } catch (e) { showMsg(e.message, 'error'); }
}
async function ackAlert(id) {
  try { await api(`/api/monitoring/alerts/${id}/ack`, { method: 'POST', body: {} }); await loadAll(); } catch (e) { showMsg(e.message, 'error'); }
}
async function setNodeInterval(id, v) {
  try { await withStepUp(() => api(`/api/sensors/nodes/${id}`, { method: 'POST', body: { reportIntervalS: Number(v) } })); showMsg('Interval set; the box picks it up at its next report.'); await loadAll(); } catch (e) { showMsg(e.message, 'error'); await loadAll(); }
}
async function setAllInterval(v) {
  if (!v) return;
  try { await withStepUp(() => api(`/api/sensors/locations/${locId()}/interval`, { method: 'POST', body: { intervalS: Number(v) } })); showMsg('Interval set for every box at this bar.'); await loadAll(); } catch (e) { showMsg(e.message, 'error'); }
}
async function setMode(id, mode, on) {
  try { await api(`/api/sensors/nodes/${id}/mode`, { method: 'POST', body: { mode, on } }); showMsg(on ? 'Troubleshooting starts at the box\'s next report (up to one interval away).' : 'Stopped.'); await loadAll(); } catch (e) { showMsg(e.message, 'error'); }
}
async function renameNode(id, current) {
  const label = prompt('Name for this box (where it is, or a number on the lid):', current);
  if (label == null) return;
  try { await withStepUp(() => api(`/api/sensors/nodes/${id}`, { method: 'POST', body: { label } })); await loadAll(); } catch (e) { showMsg(e.message, 'error'); }
}
async function saveSettings() {
  const body = { defaultHighF: document.getElementById('sHigh').value, defaultLowF: document.getElementById('sLow').value, defaultAlertAfterMin: document.getElementById('sAfter').value, renotifyMin: document.getElementById('sRenotify').value };
  try { await withStepUp(() => api(`/api/sensors/settings/${locId()}`, { method: 'POST', body })); showMsg('Defaults saved.'); await loadAll(); } catch (e) { showMsg(e.message, 'error'); }
}

init().catch((e) => showMsg(e.message, 'error'));
