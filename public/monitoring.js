let ME = null;
let IS_MANAGER = false;
let LOCATIONS = [];
let STATUS_SYSTEMS = []; // last-loaded systems from loadStatus(), keyed off by toggleHistory() for the equipment-details line
let ROUTING_PEOPLE = []; // last-loaded /api/employees, for the Alert Routing "who" picker

const CATEGORY_LABEL = {
  network: 'Network', hvac: 'HVAC', refrigeration: 'Refrigeration', freezer: 'Freezer',
  ice_machine: 'Ice Machine', power: 'Power', av: 'TVs & AV', other: 'Other',
};

// Status tab visual language (card-grid dashboard) — one small stroke-based
// icon per category (all 16x16, currentColor) and one color/label per
// status, shared by the stat strip, site scorecards, and system tiles below.
// Deliberately brighter/more saturated than this app's shared --danger/
// --warn/--success tokens (used by badges elsewhere in Bar Ops) — Scotto
// asked for a punchier red/yellow/green specifically for Monitoring's own
// status language, so these are local literals rather than the shared CSS
// variables, to avoid changing color elsewhere in the platform.
const STATUS_META = {
  online: { label: 'Online', dot: '#00e676', badgeClass: 'on' },
  warning: { label: 'Warning', dot: '#ffea00', badgeClass: 'stale' },
  offline: { label: 'Offline', dot: '#ff1744', badgeClass: 'danger' },
  unknown: { label: 'Unknown', dot: '#9aa3b2', badgeClass: 'off' },
};
function statusMeta(status) { return STATUS_META[status] || STATUS_META.unknown; }

// hex -> "rgba(r, g, b, a)", for tinting a status color's dot into a light
// chip background at a given opacity without hand-maintaining a second
// parallel color table.
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const CATEGORY_ICON = {
  network: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="8" rx="2"></rect><circle cx="8" cy="13" r="1"></circle><circle cx="12" cy="13" r="1"></circle><path d="M12 9V6a2 2 0 0 1 2-2h1"></path></svg>',
  hvac: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"></path></svg>',
  refrigeration: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="1.5"></rect><path d="M6 9h12"></path></svg>',
  freezer: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M4.5 6l15 12M19.5 6l-15 12"></path></svg>',
  ice_machine: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"></rect><path d="M5 12h14M12 5v14"></path></svg>',
  power: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"></path></svg>',
  other: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"></rect><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"></circle></svg>',
};
function categoryIcon(cat) { return CATEGORY_ICON[cat] || CATEGORY_ICON.other; }

// Short badge label for a category's monogram chip on a site scorecard —
// see siteScoreCardHtml() below.
const CATEGORY_MONO = {
  network: 'NET', hvac: 'HVAC', refrigeration: 'RFG', freezer: 'FRZ',
  ice_machine: 'ICE', power: 'PWR', av: 'AV', other: 'OTH',
};

// Category types with no live data source yet (see server/monitoring.js —
// only 'kind's starting 'unifi_' are actually polled today). Shown as a
// grayed-out roadmap strip at the bottom of the Status tab rather than
// pretending they're monitored.
const UPCOMING_CATEGORIES = ['hvac', 'refrigeration', 'freezer', 'ice_machine', 'power'];

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

function locationName(id) { const l = LOCATIONS.find(l => l.id === id); return l ? l.name : '—'; }

function fillLocationSelect(sel, defaultId) {
  sel.innerHTML = LOCATIONS.map(l => `<option value="${l.id}" ${l.id === defaultId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
}

function statusBadgeClass(status) {
  if (status === 'online') return 'on';
  if (status === 'offline') return 'danger';
  if (status === 'warning') return 'stale';
  return 'off';
}

function relTime(iso) {
  if (!iso) return 'never checked';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function setTab(which) {
  document.getElementById('panelStatus').style.display = which === 'status' ? '' : 'none';
  document.getElementById('panelAlerts').style.display = which === 'alerts' ? '' : 'none';
  document.getElementById('panelAdd').style.display = which === 'add' ? '' : 'none';
  document.getElementById('panelNotifications').style.display = which === 'notifications' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach(b => b.classList.toggle('active', b.dataset.tab === which));
  if (which === 'status') loadStatus();
  if (which === 'alerts') loadAlerts();
  if (which === 'add') renderAdd();
  if (which === 'notifications') renderNotifications();
}

function renderTabs() {
  const tabs = [{ key: 'status', label: 'Status' }, { key: 'alerts', label: 'Alerts' }];
  if (IS_MANAGER) tabs.push({ key: 'add', label: 'Add / Manage' });
  // Alert Routing and the old self-service "Notify Me" tab are one tab now
  // — Scotto was using Alert Routing for himself and didn't want a second,
  // separate button just for his own channel preference.
  tabs.push({ key: 'notifications', label: 'Alert Notifications' });
  document.getElementById('tabs').innerHTML = tabs.map(t =>
    `<button data-tab="${t.key}" onclick="setTab('${t.key}')">${t.label}</button>`).join('');
  setTab('status');
}

// ---------------- Status board (card-grid dashboard) ----------------
async function loadStatus() {
  const el = document.getElementById('panelStatus');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const [systems, alerts] = await Promise.all([
      api('/api/monitoring/systems'),
      api('/api/monitoring/alerts'),
    ]);
    if (!systems.length) {
      el.innerHTML = `<div class="card"><p class="muted">Nothing registered yet.${IS_MANAGER ? ' Add a system from the "Add / Manage" tab once you have a device to point it at.' : ' Check back once your manager has registered something.'}</p></div>`;
      return;
    }

    const openAlerts = alerts.filter(a => !a.closed_at)
      .sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at));

    const counts = { online: 0, warning: 0, offline: 0, unknown: 0 };
    for (const s of systems) counts[STATUS_META[s.last_status] ? s.last_status : 'unknown']++;

    STATUS_SYSTEMS = systems;
    const byLocation = {};
    for (const s of systems) (byLocation[s.location_name] = byLocation[s.location_name] || []).push(s);

    el.innerHTML = `
      ${openAlerts.length ? alertBannerHtml(openAlerts) : ''}
      ${statSummaryHtml(counts)}
      ${Object.keys(byLocation).sort().map(loc => siteScoreCardHtml(loc, byLocation[loc])).join('')}
      ${roadmapCardHtml()}
    `;
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function alertBannerHtml(openAlerts) {
  const top = openAlerts[0];
  const more = openAlerts.length > 1 ? ` <span class="alert-more">(+${openAlerts.length - 1} more)</span>` : '';
  return `<div class="alert-banner">
    <span class="dot"></span>
    <span class="sp"><b>${escapeHtml(top.system_name)}</b> at ${escapeHtml(top.location_name)} — ${escapeHtml(top.message)} · ${relTime(top.opened_at)}${more}</span>
    <span class="link" onclick="setTab('alerts')">View Alerts →</span>
  </div>`;
}

function statSummaryHtml(counts) {
  return `<div class="stat-strip">${['online', 'warning', 'offline', 'unknown'].map(key => {
    const m = statusMeta(key);
    return `<div class="stat-tile"><div class="n">${counts[key]}</div><div class="l"><span class="dot" style="background:${m.dot}"></span>${m.label}</div></div>`;
  }).join('')}</div>`;
}

// Site scorecard (all-locations dashboard) — a compact, collapsed-by-
// default card per location: a segmented status bar across the top (worst
// status first, left to right), an "N issues" badge when something's
// flagged, and one bold monogram chip per category with its border/fill
// colored by that category's worst status at this location. Click the
// header to expand into the same per-system tile grid the old always-
// expanded location cards used to show inline — nothing about drilling
// into an individual system's history (toggleHistory, below) changed.
function locSlug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

function siteScoreCardHtml(name, systems) {
  const counts = { online: 0, warning: 0, offline: 0, unknown: 0 };
  for (const s of systems) counts[STATUS_META[s.last_status] ? s.last_status : 'unknown']++;
  const issues = counts.offline + counts.warning;

  const barOrder = ['offline', 'warning', 'unknown', 'online'];
  const bar = barOrder.filter(k => counts[k])
    .map(k => `<div style="flex:${counts[k]}; background:${statusMeta(k).dot};"></div>`).join('');

  const byCategory = {};
  for (const s of systems) (byCategory[s.category] = byCategory[s.category] || []).push(s);
  const chips = Object.keys(byCategory).map(cat => {
    const inCat = byCategory[cat];
    const worst = inCat.some(s => s.last_status === 'offline') ? 'offline'
      : inCat.some(s => s.last_status === 'warning') ? 'warning'
      : inCat.every(s => (s.last_status || 'unknown') === 'online') ? 'online' : 'unknown';
    const dot = statusMeta(worst).dot;
    return `<div class="mono-chip" style="border-color:${dot}; color:${dot}; background:${hexToRgba(dot, 0.16)}" title="${CATEGORY_LABEL[cat] || cat}">${CATEGORY_MONO[cat] || cat.slice(0, 3).toUpperCase()}</div>`;
  }).join('');

  const slug = locSlug(name);
  return `<div class="site-scorecard" id="score-${slug}">
    <div class="top-bar">${bar}</div>
    <div class="score-body" onclick="toggleLocationCard('${slug}')">
      <div class="score-hd">
        <div><div class="score-nm">${escapeHtml(name)}</div><div class="score-frac">${counts.online} of ${systems.length} online</div></div>
        ${issues ? `<span class="score-badge">${issues} issue${issues > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="cat-row">${chips}</div>
    </div>
    <div class="score-expand" id="expand-${slug}">
      ${IS_MANAGER ? groupSilenceBarHtml(systems, byCategory) : ''}
      <div class="sys-grid" style="padding:0 18px 18px;">${systems.map(systemTileHtml).join('')}</div>
    </div>
  </div>`;
}

// ---- Silencing (patch_032) ----
// "Silence" on one tile quiets that piece of equipment; the bar at the
// top of an expanded location quiets a whole system there (all TVs, all
// network gear). Silenced things stay tracked and stay red on the
// dashboard — they just send nothing. Durations are fixed choices so
// nobody has to type a time on a phone.
const SILENCE_CHOICES = [['1h', '1 hour'], ['today', 'Rest of today'], ['1d', '1 day'], ['3d', '3 days'], ['7d', '7 days'], ['forever', 'Until turned back on']];

function silencedUntilText(s) {
  if (!s.silenced) return '';
  const until = s.silenced_until ? new Date(s.silenced_until) : null;
  const forever = !until || !isFinite(until.getTime()) || until.getFullYear() > 9000;
  const who = s.silenced_by_name ? ` by ${escapeHtml(s.silenced_by_name)}` : '';
  return forever ? `Silenced until turned back on${who}` : `Silenced until ${fmtDateTime(s.silenced_until)}${who}`;
}

function silenceMenuHtml(menuId, onPick) {
  // onPick is a JS snippet with DURATION as a placeholder
  return `<span class="silence-menu" id="${menuId}" style="display:none;">${SILENCE_CHOICES.map(([d, label]) =>
    `<button class="small ghost" onclick="${onPick.replace(/DURATION/g, d)}">${label}</button>`).join('')}</span>`;
}

function toggleSilenceMenu(menuId) {
  const el = document.getElementById(menuId);
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

// Internet line: measured speed against its par, from the last poll.
function speedLineHtml(s) {
  if (s.kind !== 'unifi_wan') return '';
  const d = s.last_detail || {};
  const par = (s.config || {}).par_mbps || d.par_mbps;
  const warn = (s.config || {}).warn_pct || d.warn_pct || 70;
  if (d.download_mbps == null) return `<div class="sys-speed muted">no speed reading yet${par ? ` · par ${par} Mbps, warn below ${warn}%` : ''}</div>`;
  const pct = d.pct_of_par != null ? d.pct_of_par : (par ? Math.round(d.download_mbps / par * 100) : null);
  const m = statusMeta(s.last_status || 'unknown');
  return `<div class="sys-speed"><b style="color:${m.dot}">↓ ${d.download_mbps} Mbps</b>${d.upload_mbps != null ? ` · ↑ ${d.upload_mbps}` : ''}${pct != null ? ` · <b style="color:${m.dot}">${pct}%</b> of ${par} par (warn below ${warn}%)` : ''}${d.latency_ms != null ? ` · ${d.latency_ms} ms` : ''}</div>`;
}

// TVs are handled at the bar first (patch_034): say where a down TV
// stands instead of implying an email went out.
function avStateNoteHtml(s) {
  if (s.category !== 'av' || !s.open_alert_id) return '';
  if (s.open_service_call_id) return `<div class="sys-checked">service call open · <a href="/servicecalls.html">view</a></div>`;
  if (s.open_alert_expected_on === false) return `<div class="sys-checked">outside TV hours — not flagged</div>`;
  return `<div class="sys-checked">flagged on the bar's iPad — waiting on them</div>`;
}

function tileSilenceHtml(s) {
  if (!IS_MANAGER) return s.silenced ? `<div class="sys-silence"><span class="badge stale">${silencedUntilText(s)}</span></div>` : '';
  if (s.silenced) {
    return `<div class="sys-silence"><span class="badge stale">${silencedUntilText(s)}</span>
      <button class="small ghost" onclick="silenceSystem('${s.id}','off')">Turn alerts back on</button></div>`;
  }
  const menuId = `smenu-${s.id}`;
  return `<div class="sys-silence">
    <button class="small ghost" onclick="toggleSilenceMenu('${menuId}')" title="Stop notifications for this one for a while">Silence…</button>
    ${silenceMenuHtml(menuId, `silenceSystem('${s.id}','DURATION')`)}
  </div>`;
}

function groupSilenceBarHtml(systems, byCategory) {
  const locationId = systems[0] && systems[0].location_id;
  return `<div class="group-silence">${Object.keys(byCategory).map(cat => {
    const inCat = byCategory[cat];
    const label = CATEGORY_LABEL[cat] || cat;
    const allQuiet = inCat.every(x => x.silenced);
    const menuId = `gmenu-${locSlug(systems[0].location_name)}-${cat}`;
    if (allQuiet) {
      return `<span class="group-silence-item"><span class="badge stale">All ${escapeHtml(label)} silenced</span>
        <button class="small ghost" onclick="silenceGroup('${locationId}','${cat}','off')">Turn back on</button></span>`;
    }
    return `<span class="group-silence-item">
      <button class="small ghost" onclick="toggleSilenceMenu('${menuId}')" title="Stop notifications for every ${escapeHtml(label)} item here">Silence all ${escapeHtml(label)}…</button>
      ${silenceMenuHtml(menuId, `silenceGroup('${locationId}','${cat}','DURATION')`)}
    </span>`;
  }).join('')}</div>`;
}

async function silenceSystem(id, duration) {
  try {
    const result = await withStepUp(() => api(`/api/monitoring/systems/${id}/silence`, { method: 'POST', body: { duration } }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg(duration === 'off' ? 'Alerts turned back on.' : 'Silenced.', 'success');
    reloadStatusKeepingOpen();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function silenceGroup(locationId, category, duration) {
  try {
    const result = await withStepUp(() => api('/api/monitoring/silence-group', { method: 'POST', body: { locationId, category, duration } }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg(duration === 'off' ? `Alerts turned back on for ${result.count} item${result.count === 1 ? '' : 's'}.` : `Silenced ${result.count} item${result.count === 1 ? '' : 's'}.`, 'success');
    reloadStatusKeepingOpen();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// Re-render the Status tab without collapsing the location card the
// person was just working in.
async function reloadStatusKeepingOpen() {
  const open = Array.from(document.querySelectorAll('.site-scorecard.open')).map(el => el.id);
  await loadStatus();
  open.forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('open'); });
}

function toggleLocationCard(slug) {
  document.getElementById(`score-${slug}`).classList.toggle('open');
}

function systemTileHtml(s) {
  const status = s.last_status || 'unknown';
  const m = statusMeta(status);
  return `<div class="sys-tile" style="border-left-color:${m.dot}">
    <div class="sys-tile-head" onclick="toggleHistory('${s.id}')">
      <div class="top-row">
        <div class="sys-icon">${categoryIcon(s.category)}</div>
        <div><div class="sys-name">${escapeHtml(s.name)}</div><div class="sys-sub">${CATEGORY_LABEL[s.category] || s.category} · ${escapeHtml(s.kind)}</div></div>
      </div>
      <div class="status-row"><span class="dot" style="background:${m.dot}"></span><span class="label" style="color:${m.dot}">${m.label}</span>${s.silenced ? ' <span class="badge stale" title="' + silencedUntilText(s) + '">silenced</span>' : ''}</div>
      ${speedLineHtml(s)}
      <div class="sys-checked">checked ${relTime(s.last_checked_at)} · history ▾</div>
      ${avStateNoteHtml(s)}
    </div>
    ${tileSilenceHtml(s)}
    <div id="hist-${s.id}" class="sys-hist" style="display:none;"></div>
  </div>`;
}

function roadmapCardHtml() {
  return `<div class="roadmap-card">
    <div class="title">More on the way</div>
    <div class="sub">Phase 2 adds these system types once sensor hardware is chosen — the registry's already built for them.</div>
    <div class="roadmap-row">
      ${UPCOMING_CATEGORIES.map(cat => `<div class="roadmap-item">
        <div class="roadmap-icon">${categoryIcon(cat)}</div>
        <div class="rl">${CATEGORY_LABEL[cat]}</div>
      </div>`).join('')}
    </div>
  </div>`;
}

function equipmentDetailsHtml(s) {
  if (!s) return '';
  const rows = [
    ['Location', s.location_name],
    ['Make', s.make],
    ['Model', s.model],
    ['Serial', s.serial_number],
  ].filter(([, v]) => v);
  if (!rows.length) return '';
  return `<div class="sys-equip">${rows.map(([label, v]) => `<span><b>${label}:</b> ${escapeHtml(v)}</span>`).join(' · ')}</div>`;
}

async function toggleHistory(systemId) {
  const el = document.getElementById(`hist-${systemId}`);
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : '';
  if (isOpen || el.dataset.loaded) return;
  el.innerHTML = '<p class="muted">Loading history…</p>';
  const equip = equipmentDetailsHtml(STATUS_SYSTEMS.find(s => s.id === systemId));
  try {
    const rows = await api(`/api/monitoring/systems/${systemId}/history?hours=24`);
    el.dataset.loaded = '1';
    const table = rows.length
      ? `<table><thead><tr><th>Checked</th><th>Status</th></tr></thead><tbody>
          ${rows.map(r => `<tr><td>${fmtDateTime(r.checked_at)}</td><td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td></tr>`).join('')}
        </tbody></table>`
      : '<p class="muted">No status checks in the last 24h yet.</p>';
    el.innerHTML = equip + table;
  } catch (e) {
    el.innerHTML = equip + `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// ---------------- Alerts ----------------
async function loadAlerts() {
  const el = document.getElementById('panelAlerts');
  el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  try {
    const alerts = await api('/api/monitoring/alerts');
    if (!alerts.length) { el.innerHTML = '<div class="card"><p class="muted">No alerts yet — good sign.</p></div>'; return; }
    const open = alerts.filter(a => !a.closed_at);
    const closed = alerts.filter(a => a.closed_at);
    el.innerHTML = `
      <div class="card">
        <h2>Open (${open.length})</h2>
        ${open.length ? open.map(alertRowHtml).join('') : '<p class="muted">Nothing open right now.</p>'}
      </div>
      <div class="card">
        <h2>Recent history</h2>
        ${closed.length ? closed.slice(0, 30).map(alertRowHtml).join('') : '<p class="muted">No resolved alerts yet.</p>'}
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`;
  }
}

function alertRowHtml(a) {
  const open = !a.closed_at;
  return `<div class="list-row">
    <div>
      <div class="name">${escapeHtml(a.system_name)} <span class="badge ${open ? 'danger' : 'off'}">${open ? 'open' : 'resolved'}</span></div>
      <div class="sub">${escapeHtml(a.location_name)} · ${escapeHtml(a.message)}</div>
      <div class="sub">opened ${fmtDateTime(a.opened_at)}${a.closed_at ? ' · closed ' + fmtDateTime(a.closed_at) : ''}</div>
      <div class="sub">${alertNoticeText(a)}</div>
    </div>
  </div>`;
}

// What actually went out for this alert — so a quiet phone and a red
// tile can be reconciled at a glance.
function alertNoticeText(a) {
  const open = !a.closed_at;
  if (a.service_call_id) return `service call opened from the bar's iPad · notified ${fmtDateTime(a.notified_at)}`;
  if (a.silenced && open) return 'silenced — no notifications while it stays quiet';
  if (a.category === 'av') {
    if (a.expected_on === false) return 'outside TV hours — a dark TV is normal then; not flagged';
    return open ? "flagged on the bar's iPad after 3 minutes — they can Turn On, Clear, or open a Service call" : 'recovered — was flagged on the bar\'s iPad only';
  }
  if (!a.notified_at) return open ? 'no notice sent yet — waits until it has been down 3 minutes' : 'recovered within 3 minutes — nobody was notified';
  return `notified ${fmtDateTime(a.notified_at)}${open ? ' · in the 6am summary until it recovers' : ''}`;
}

// ---------------- Add / Manage (manager/owner) ----------------
function renderAdd() {
  const el = document.getElementById('panelAdd');
  el.innerHTML = `
    <div class="card">
      <h2>Register a system</h2>
      <label for="asLocation">Location</label>
      <select id="asLocation"></select>
      <label for="asCategory">Category</label>
      <select id="asCategory">${Object.keys(CATEGORY_LABEL).map(k => `<option value="${k}">${CATEGORY_LABEL[k]}</option>`).join('')}</select>
      <label for="asKind">Kind</label>
      <input id="asKind" list="kindOptions" placeholder="e.g. unifi_switch, unifi_ap, unifi_gateway">
      <datalist id="kindOptions">
        <option value="unifi_wan"><option value="unifi_gateway"><option value="unifi_switch"><option value="unifi_ap">
      </datalist>
      <p class="muted" style="font-size:12px; margin:-6px 0 8px;">Kinds: <b>unifi_wan</b> = an internet line (fiber or cable) checked against its expected speed; <b>unifi_gateway</b> = the UDM Pro; <b>unifi_switch</b>; <b>unifi_ap</b> = a WAP.</p>
      <label for="asName">Name</label>
      <input id="asName" placeholder="e.g. Zone 2 Switch">
      <label for="asExternalRef">External ID <span class="muted">(optional — the UniFi device ID or MAC, for network kinds)</span></label>
      <input id="asExternalRef" placeholder="Leave blank until you have it">
      <div id="asWanFields" style="display:none;">
        <label for="asWan">Which line on the UDM</label>
        <select id="asWan"><option value="wan1">WAN 1 (fiber)</option><option value="wan2">WAN 2 (cable)</option></select>
        <label for="asPar">Expected speed, Mbps <span class="muted">("par" — 1000 for fiber, 300 for cable)</span></label>
        <input id="asPar" type="number" min="1" placeholder="1000">
        <label for="asWarnPct">Warn when below <span class="muted">(% of par)</span></label>
        <input id="asWarnPct" type="number" min="1" max="100" value="70">
      </div>
      <label for="asMake">Make <span class="muted">(optional)</span></label>
      <input id="asMake" placeholder="e.g. Ubiquiti">
      <label for="asModel">Model <span class="muted">(optional)</span></label>
      <input id="asModel" placeholder="e.g. USW-Pro-48-PoE">
      <label for="asSerial">Serial <span class="muted">(optional)</span></label>
      <input id="asSerial" placeholder="Nameplate serial number">
      <button class="primary" onclick="submitAddSystem()">Add system</button>
    </div>
    <div class="card">
      <h2>UniFi connection</h2>
      <p class="muted">Checks the UniFi API with the key on the server and lists what it can see. Use it to confirm the key works and to pick up device IDs for registering.</p>
      <button class="secondary" onclick="runUnifiProbe()">Check UniFi connection</button>
      <div id="unifiProbe"></div>
    </div>
    <div class="card">
      <h2>TV hours</h2>
      <p class="muted">When TVs are expected to be on at each bar. A TV that stops answering inside these hours is flagged on that bar's iPad; outside them a dark TV is normal and nothing happens. An end time earlier than the start means it runs past midnight.</p>
      <div id="avHoursList"></div>
    </div>
    <div class="card">
      <h2>Registered systems</h2>
      <div id="manageList"><p class="muted">Loading…</p></div>
    </div>`;
  fillLocationSelect(document.getElementById('asLocation'), myLocationIds(ME)[0]);
  const kindEl = document.getElementById('asKind');
  const syncWan = () => { document.getElementById('asWanFields').style.display = kindEl.value.trim() === 'unifi_wan' ? '' : 'none'; };
  kindEl.addEventListener('input', syncWan); kindEl.addEventListener('change', syncWan);
  renderAvHours();
  loadManageList();
}

async function runUnifiProbe() {
  const el = document.getElementById('unifiProbe');
  el.innerHTML = '<p class="muted">Asking UniFi…</p>';
  try {
    const p = await api('/api/monitoring/unifi/probe');
    if (!p.configured) { el.innerHTML = `<p class="msg error">${escapeHtml(p.error)}</p>`; return; }
    const kindLabel = { unifi_gateway: 'gateway (UDM)', unifi_switch: 'switch', unifi_ap: 'WAP', unifi_other: 'other' };
    el.innerHTML = `
      ${p.errors.length ? `<p class="msg ${p.ok ? 'info' : 'error'}">${p.errors.map(escapeHtml).join('<br>')}</p>` : '<p class="msg success">Connected. UniFi answered.</p>'}
      <div class="detail-label" style="margin-top:10px;">Consoles (${p.hosts.length})</div>
      ${p.hosts.length ? p.hosts.map(h => `<div class="list-row"><div><div class="name">${escapeHtml(h.name || '(unnamed)')} <span class="badge ${/online|connected/i.test(h.state || '') ? 'on' : 'off'}">${escapeHtml(h.state || '?')}</span></div><div class="sub">host id <code>${escapeHtml(h.id || '?')}</code>${h.ip ? ' · ' + escapeHtml(h.ip) : ''}${h.wans ? ' · WANs: ' + h.wans.map(w => escapeHtml((w.name || '?') + (w.up === true ? ' up' : w.up === false ? ' down' : ''))).join(', ') : ''}</div></div>
        <button class="small ghost" onclick="prefillSystem('unifi_wan','${escapeHtml(h.id || '')}','${escapeHtml((h.name || 'UDM') + ' fiber')}')">+ line</button></div>`).join('') : '<p class="muted">None — is the UDM signed in to your UniFi account (unifi.ui.com)?</p>'}
      <div class="detail-label" style="margin-top:14px;">Devices (${p.devices.length})</div>
      ${p.devices.length ? p.devices.map(d => `<div class="list-row"><div><div class="name">${escapeHtml(d.name || '(unnamed)')} <span class="badge ${d.raw === 'online' ? 'on' : d.raw === 'offline' ? 'danger' : 'off'}">${escapeHtml(d.status || '?')}</span></div><div class="sub">${escapeHtml(d.model || '?')} · ${escapeHtml(kindLabel[d.kind] || d.kind)} · mac <code>${escapeHtml(d.mac || '?')}</code>${d.ip ? ' · ' + escapeHtml(d.ip) : ''}</div></div>
        <button class="small ghost" onclick="prefillSystem('${d.kind === 'unifi_other' ? 'unifi_switch' : d.kind}','${escapeHtml(d.mac || d.id || '')}','${escapeHtml(d.name || d.model || 'Device')}')">+ register</button></div>`).join('') : '<p class="muted">No devices reported.</p>'}
      <div class="detail-label" style="margin-top:14px;">Internet readings (${p.isp.length})</div>
      ${p.isp.length ? p.isp.map(i => `<div class="list-row"><div><div class="name">console <code>${escapeHtml(i.hostId || '?')}</code> · ${i.periods} sample${i.periods === 1 ? '' : 's'} in the last 30 min</div>
        <div class="sub">${i.latest.length ? i.latest.map(l => `${escapeHtml(l.wan)}: ${l.downloadMbps != null ? '↓ ' + l.downloadMbps + ' Mbps' : 'no speed'}${l.uploadMbps != null ? ' ↑ ' + l.uploadMbps : ''}${l.latencyMs != null ? ' · ' + l.latencyMs + ' ms' : ''}${l.up === false ? ' · DOWN' : ''}`).join(' | ') : 'no WAN data in the newest sample'}</div>
        <div class="sub" style="word-break:break-all;">raw: ${escapeHtml(i.rawLatest || '')}</div></div></div>`).join('') : '<p class="muted">No internet readings yet.</p>'}`;
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// Fill the Register form from a probe row so nobody has to retype an id.
function prefillSystem(kind, externalRef, name) {
  document.getElementById('asCategory').value = 'network';
  document.getElementById('asKind').value = kind;
  document.getElementById('asKind').dispatchEvent(new Event('change'));
  document.getElementById('asExternalRef').value = externalRef;
  document.getElementById('asName').value = name;
  document.getElementById('asName').scrollIntoView({ behavior: 'smooth', block: 'center' });
  showMsg(`Filled in the form for ${name} — check the name, add the expected speed if it's a line, then press Add system.`, 'info');
}

function renderAvHours() {
  const mine = ME.role === 'owner' ? LOCATIONS : LOCATIONS.filter(l => myLocationIds(ME).includes(String(l.id)));
  document.getElementById('avHoursList').innerHTML = mine.length ? mine.map(l => `<div class="list-row">
    <div class="name">${escapeHtml(l.name)}</div>
    <div style="display:flex; gap:8px; align-items:center;">
      <input type="time" id="avs-${l.id}" value="${String(l.av_hours_start || '10:00').slice(0, 5)}" style="width:auto; margin:0;">
      <span class="muted">to</span>
      <input type="time" id="ave-${l.id}" value="${String(l.av_hours_end || '02:00').slice(0, 5)}" style="width:auto; margin:0;">
      <button class="small ghost" onclick="saveAvHours('${l.id}')">Save</button>
    </div>
  </div>`).join('') : '<p class="muted">No locations.</p>';
}
async function saveAvHours(locationId) {
  const start = document.getElementById(`avs-${locationId}`).value;
  const end = document.getElementById(`ave-${locationId}`).value;
  try {
    const result = await withStepUp(() => api(`/api/monitoring/locations/${locationId}/av-hours`, { method: 'POST', body: { start, end } }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    const l = LOCATIONS.find(x => x.id === locationId);
    if (l) { l.av_hours_start = start; l.av_hours_end = end; }
    showMsg('TV hours saved.', 'success');
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function loadManageList() {
  const el = document.getElementById('manageList');
  try {
    const systems = await api('/api/monitoring/systems');
    el.dataset.systemsJson = JSON.stringify(systems);
    if (!systems.length) { el.innerHTML = '<p class="muted">Nothing registered yet — add one above.</p>'; return; }
    // Grouped by location (server already returns them in that order) so
    // the up/down arrows move a system within its own location's list,
    // matching how they're grouped on the Status tab.
    const byLocation = {};
    for (const s of systems) (byLocation[s.location_name] = byLocation[s.location_name] || []).push(s);
    el.innerHTML = Object.keys(byLocation).map((loc) => {
      const rows = byLocation[loc];
      return `<div class="sc-divider"><span>${escapeHtml(loc)}</span></div>` +
        rows.map((s, i) => manageSystemRowHtml(s, i === 0, i === rows.length - 1)).join('');
    }).join('');
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

function manageSystemRowHtml(s, isFirst, isLast) {
  return `<div class="list-row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between;">
        <div>
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="sub">${CATEGORY_LABEL[s.category] || s.category} · ${escapeHtml(s.kind)}${s.external_ref ? ' · ' + escapeHtml(s.external_ref) : ' · no external ID yet'}</div>
          ${equipmentDetailsHtml(s)}
        </div>
        <div style="display:flex; gap:8px; align-items:start;">
          <button class="small ghost" ${isFirst ? 'disabled' : ''} onclick="moveSystem('${s.id}','up')" title="Move up">▲</button>
          <button class="small ghost" ${isLast ? 'disabled' : ''} onclick="moveSystem('${s.id}','down')" title="Move down">▼</button>
          <button class="small ghost" onclick="editSystemRow('${s.id}')">Edit</button>
          <button class="small ghost" onclick="archiveSystem('${s.id}')">Remove</button>
        </div>
      </div>
      <div id="edit-${s.id}" style="display:none;"></div>
    </div>`;
}

async function moveSystem(id, direction) {
  try {
    const result = await withStepUp(() => api(`/api/monitoring/systems/${id}/move`, { method: 'POST', body: { direction } }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    loadManageList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function editSystemRow(id) {
  const el = document.getElementById(`edit-${id}`);
  const isOpen = el.style.display !== 'none';
  el.style.display = isOpen ? 'none' : '';
  if (isOpen) return;
  const systems = JSON.parse(document.getElementById('manageList').dataset.systemsJson || '[]');
  const s = systems.find(x => x.id === id);
  if (!s) return;
  el.innerHTML = `<div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.12);">
    <label>Location</label>
    <select id="es-location-${id}"></select>
    <label>Category</label>
    <select id="es-category-${id}">${Object.keys(CATEGORY_LABEL).map(k => `<option value="${k}" ${k === s.category ? 'selected' : ''}>${CATEGORY_LABEL[k]}</option>`).join('')}</select>
    <label>Kind</label>
    <input id="es-kind-${id}" value="${escapeHtml(s.kind)}">
    <label>Name</label>
    <input id="es-name-${id}" value="${escapeHtml(s.name)}">
    <label>Make</label>
    <input id="es-make-${id}" value="${escapeHtml(s.make || '')}">
    <label>Model</label>
    <input id="es-model-${id}" value="${escapeHtml(s.model || '')}">
    <label>Serial</label>
    <input id="es-serial-${id}" value="${escapeHtml(s.serial_number || '')}">
    ${s.kind === 'unifi_wan' ? `
    <label>Which line on the UDM</label>
    <select id="es-wan-${id}"><option value="wan1" ${(s.config || {}).wan !== 'wan2' ? 'selected' : ''}>WAN 1 (fiber)</option><option value="wan2" ${(s.config || {}).wan === 'wan2' ? 'selected' : ''}>WAN 2 (cable)</option></select>
    <label>Expected speed, Mbps (par)</label>
    <input id="es-par-${id}" type="number" min="1" value="${(s.config || {}).par_mbps || ''}">
    <label>Warn when below (% of par)</label>
    <input id="es-warn-${id}" type="number" min="1" max="100" value="${(s.config || {}).warn_pct || 70}">` : ''}
    <div class="stack-actions">
      <button class="ghost" onclick="editSystemRow('${id}')">Cancel</button>
      <button class="primary" style="margin-top:0;" onclick="submitEditSystem('${id}')">Save</button>
    </div>
  </div>`;
  fillLocationSelect(document.getElementById(`es-location-${id}`), s.location_id);
}

async function submitEditSystem(id) {
  const locationId = document.getElementById(`es-location-${id}`).value;
  const category = document.getElementById(`es-category-${id}`).value;
  const kind = document.getElementById(`es-kind-${id}`).value.trim();
  const name = document.getElementById(`es-name-${id}`).value.trim();
  const make = document.getElementById(`es-make-${id}`).value.trim();
  const model = document.getElementById(`es-model-${id}`).value.trim();
  const serialNumber = document.getElementById(`es-serial-${id}`).value.trim();
  if (!kind || !name) { showMsg('Kind and name are both required.', 'error'); return; }
  let config;
  if (document.getElementById(`es-par-${id}`)) {
    config = { wan: document.getElementById(`es-wan-${id}`).value, par_mbps: Number(document.getElementById(`es-par-${id}`).value) || null, warn_pct: Number(document.getElementById(`es-warn-${id}`).value) || 70 };
  }
  try {
    const result = await withStepUp(() => api(`/api/monitoring/systems/${id}/update`, {
      method: 'POST', body: { locationId, category, kind, name, make: make || null, model: model || null, serialNumber: serialNumber || null, config },
    }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Saved.', 'success');
    loadManageList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function submitAddSystem() {
  const locationId = document.getElementById('asLocation').value;
  const category = document.getElementById('asCategory').value;
  const kind = document.getElementById('asKind').value.trim();
  const name = document.getElementById('asName').value.trim();
  const externalRef = document.getElementById('asExternalRef').value.trim();
  const make = document.getElementById('asMake').value.trim();
  const model = document.getElementById('asModel').value.trim();
  const serialNumber = document.getElementById('asSerial').value.trim();
  if (!kind || !name) { showMsg('Kind and name are both required.', 'error'); return; }
  const config = {};
  if (kind === 'unifi_wan') {
    config.wan = document.getElementById('asWan').value;
    config.par_mbps = Number(document.getElementById('asPar').value) || null;
    config.warn_pct = Number(document.getElementById('asWarnPct').value) || 70;
    if (externalRef) config.hostId = externalRef; // for a line, External ID = the UDM's host id
    if (!config.par_mbps) { showMsg('Enter the expected speed for this line.', 'error'); return; }
  }
  try {
    const result = await withStepUp(() => api('/api/monitoring/systems', {
      method: 'POST', body: { locationId, category, kind, name, externalRef: externalRef || null, config, make: make || null, model: model || null, serialNumber: serialNumber || null },
    }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Added.', 'success');
    document.getElementById('asKind').value = '';
    document.getElementById('asName').value = '';
    document.getElementById('asExternalRef').value = '';
    document.getElementById('asMake').value = '';
    document.getElementById('asModel').value = '';
    document.getElementById('asSerial').value = '';
    loadManageList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function archiveSystem(id) {
  if (!confirm('Remove this from monitoring? Its history is kept, it just stops appearing.')) return;
  try {
    const result = await withStepUp(() => api(`/api/monitoring/systems/${id}/archive`, { method: 'POST' }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    loadManageList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------- Alert Notifications (routing admin + everyone's own channel) ----------------
// "Notify this person about this category at this location" — independent
// of that person's own Monitoring dashboard access (server/monitoring.js's
// recipientsFor() unions this with the self-service opt-in + owner set).
// A manager only ever sees/creates routes for their own location; the
// server enforces that too (see /api/monitoring/alert-routes in
// server/index.js) — the location picker here is hidden for a manager
// rather than just disabled, so there's nothing misleading to click.
//
// The routing admin section (manager/owner only) and everyone's own "how
// should we reach you" channel preference (previously a separate "Notify
// Me" tab) live in one "Alert Notifications" tab now — same idea, one
// place to set it, whether you're routing alerts to other people or just
// setting your own.
async function renderNotifications() {
  const el = document.getElementById('panelNotifications');
  el.innerHTML = `
    ${IS_MANAGER ? `
    <div class="card">
      <h2>Route alerts to someone</h2>
      <p class="muted">Assign a person to be notified about a category of alerts — even if they don't have Monitoring dashboard access themselves. Leave category blank for "every category".</p>
      <label for="arPerson">Who</label>
      <select id="arPerson"></select>
      ${ME.role === 'owner' ? `<label for="arLocation">Location</label><select id="arLocation"><option value="">All locations</option></select>` : ''}
      <label for="arCategory">Category</label>
      <select id="arCategory"><option value="">All categories</option>${Object.keys(CATEGORY_LABEL).map(k => `<option value="${k}">${CATEGORY_LABEL[k]}</option>`).join('')}</select>
      <button class="primary" onclick="submitAddRoute()">Add routing</button>
    </div>
    <div class="card">
      <h2>Current routing</h2>
      <div id="routingList"><p class="muted">Loading…</p></div>
    </div>` : ''}
    <div class="card">
      <h2>How alerts work</h2>
      <p class="muted" style="margin-bottom:6px;"><b>TVs</b> are handled at the bar first: a TV that stops answering during TV hours shows up on that bar's iPad after 3 minutes, with Turn On, Clear, and Service call. Nobody is emailed about a TV unless the bar presses Service call, or in the 6am summary.</p>
      <p class="muted" style="margin-bottom:6px;"><b>Everything else</b> (network, coolers, ice machines…) sends one notice once it has been down 3 minutes straight, and one when it's back. No reminders. If several things at one bar drop together, that's one email.</p>
      <p class="muted"><b>The 6am summary</b> is one email a day listing what's still down and what came and went overnight. Nothing to report, no email. Alert emails are capped at <span id="budgetNote">${DAILY_BUDGET}</span> a day so they can never crowd out sign-in codes.</p>
    </div>
    <div class="card">
      <h2>My alert settings</h2>
      <p class="muted">For each kind of equipment: nothing, a notice right away, or just the 6am summary.</p>
      <div id="prefsTable"></div>
      <label for="notifyChannel">Send my notices by</label>
      <select id="notifyChannel">
        <option value="email">Email</option>
        <option value="sms">Text (SMS)</option>
        <option value="both">Both</option>
      </select>
      <p class="muted" id="smsNote" style="display:none;">Heads up — SMS isn't fully wired up yet on our end, so text alerts won't actually arrive until that's turned on. Email will still work.</p>
      <button class="primary" onclick="submitNotifySettings()">Save</button>
    </div>
    ${IS_MANAGER ? `
    <div class="card">
      <h2>Someone else's alert settings</h2>
      <p class="muted">Set what each employee gets. Only people who can see Monitoring, or are routed alerts above, receive anything at all.</p>
      <label for="prefsPerson">Employee</label>
      <select id="prefsPerson" onchange="loadPersonPrefs()"><option value="">Choose…</option></select>
      <div id="personPrefsBox" style="display:none;">
        <div id="personPrefsTable"></div>
        <label for="personChannel">Send their notices by</label>
        <select id="personChannel">
          <option value="email">Email</option>
          <option value="sms">Text (SMS)</option>
          <option value="both">Both</option>
        </select>
        <button class="primary" onclick="submitPersonPrefs()">Save for this person</button>
      </div>
    </div>` : ''}`;
  if (IS_MANAGER) {
    try {
      ROUTING_PEOPLE = (await api('/api/employees')).filter(p => p.status === 'active');
      const sel = document.getElementById('arPerson');
      sel.innerHTML = ROUTING_PEOPLE.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.position ? ' — ' + escapeHtml(p.position) : ''}</option>`).join('');
      if (ME.role === 'owner') {
        // Deliberately not fillLocationSelect() — that replaces the whole
        // <select> contents, which would wipe out the "All locations" option
        // already in the markup above.
        const locSel = document.getElementById('arLocation');
        locSel.innerHTML += LOCATIONS.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
      }
    } catch (e) {
      showMsg(e.message, 'error');
    }
    loadRoutingList();
  }
  document.getElementById('notifyChannel').addEventListener('change', updateSmsNote);
  loadNotifySettings();
}

async function loadRoutingList() {
  const el = document.getElementById('routingList');
  try {
    const routes = await api('/api/monitoring/alert-routes');
    el.innerHTML = routes.length ? routes.map(r => `<div class="list-row">
        <div>
          <div class="name">${escapeHtml(r.person_name)}</div>
          <div class="sub">${r.location_name ? escapeHtml(r.location_name) : 'All locations'} · ${r.category ? (CATEGORY_LABEL[r.category] || r.category) : 'All categories'}</div>
        </div>
        <button class="small ghost" onclick="removeRoute('${r.id}')">Remove</button>
      </div>`).join('') : '<p class="muted">No routing set up — everyone with Monitoring access gets every alert for their location, plus you.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

async function submitAddRoute() {
  const personId = document.getElementById('arPerson').value;
  if (!personId) { showMsg('Choose who to notify.', 'error'); return; }
  const locationEl = document.getElementById('arLocation');
  const locationId = locationEl ? locationEl.value : undefined; // omitted entirely for a manager — server forces their own location
  const category = document.getElementById('arCategory').value;
  try {
    const result = await withStepUp(() => api('/api/monitoring/alert-routes', {
      method: 'POST', body: { personId, locationId: locationId || null, category: category || null },
    }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Added.', 'success');
    loadRoutingList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function removeRoute(id) {
  try {
    const result = await withStepUp(() => api(`/api/monitoring/alert-routes/${id}/remove`, { method: 'POST' }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    loadRoutingList();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------- Notification channel helpers (used by renderNotifications) ----------------
const DAILY_BUDGET = 30; // mirrors server/monitoring.js DAILY_ALERT_EMAIL_BUDGET
const MODE_LABEL = { off: 'Nothing', immediate: 'Right away', daily: '6am summary only' };
const PREF_ORDER = ['network', 'av', 'refrigeration', 'freezer', 'ice_machine', 'hvac', 'power', 'other'];

function updateSmsNote() {
  const v = document.getElementById('notifyChannel').value;
  document.getElementById('smsNote').style.display = (v === 'sms' || v === 'both') ? '' : 'none';
}

// One row per category with a three-way pick; the server hands back the
// effective mode per category so defaults show as what they really are.
function prefsTableHtml(prefix, settings) {
  return `<table class="prefs-table"><tbody>${PREF_ORDER.map(c => `<tr>
    <td>${escapeHtml(CATEGORY_LABEL[c] || c)}${settings.defaults && !settings.prefs[c] ? ' <span class="muted" style="font-size:11px;">(default)</span>' : ''}</td>
    <td><select id="${prefix}-${c}">${['immediate', 'daily', 'off'].map(m => `<option value="${m}" ${settings.effective[c] === m ? 'selected' : ''}>${MODE_LABEL[m]}</option>`).join('')}</select></td>
  </tr>`).join('')}</tbody></table>`;
}
function readPrefs(prefix) {
  const prefs = {};
  PREF_ORDER.forEach(c => { const el = document.getElementById(`${prefix}-${c}`); if (el) prefs[c] = el.value; });
  return prefs;
}

async function loadNotifySettings() {
  try {
    const settings = await api('/api/monitoring/notify-settings');
    document.getElementById('prefsTable').innerHTML = prefsTableHtml('pref', settings);
    if (settings.dailyBudget) document.getElementById('budgetNote').textContent = settings.dailyBudget;
    document.getElementById('notifyChannel').value = settings.notify_channel || 'email';
    document.getElementById('notifyChannel').onchange = updateSmsNote;
    updateSmsNote();
    if (IS_MANAGER) {
      const people = ROUTING_PEOPLE.length ? ROUTING_PEOPLE : await api('/api/employees');
      ROUTING_PEOPLE = people;
      document.getElementById('prefsPerson').innerHTML = '<option value="">Choose…</option>' +
        people.filter(p => p.status === 'active').map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    }
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function submitNotifySettings() {
  const channel = document.getElementById('notifyChannel').value;
  try {
    const result = await api('/api/monitoring/notify-settings', { method: 'POST', body: { channel, prefs: readPrefs('pref') } });
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Saved.', 'success');
    loadNotifySettings();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}
async function submitNotifyChannel() { return submitNotifySettings(); }

async function loadPersonPrefs() {
  const id = document.getElementById('prefsPerson').value;
  const box = document.getElementById('personPrefsBox');
  if (!id) { box.style.display = 'none'; return; }
  try {
    const settings = await api(`/api/monitoring/notify-settings/${id}`);
    document.getElementById('personPrefsTable').innerHTML = prefsTableHtml('pp', settings);
    document.getElementById('personChannel').value = settings.notify_channel || 'email';
    box.style.display = '';
  } catch (e) {
    showMsg(e.message, 'error');
  }
}
async function submitPersonPrefs() {
  const id = document.getElementById('prefsPerson').value;
  if (!id) return;
  try {
    const result = await withStepUp(() => api(`/api/monitoring/notify-settings/${id}`, { method: 'POST', body: { channel: document.getElementById('personChannel').value, prefs: readPrefs('pp') } }));
    if (!result.ok) { showMsg(result.error, 'error'); return; }
    showMsg('Saved for that person.', 'success');
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

(async function init() {
  ME = requireAuth();
  if (!ME) return;
  renderTopbar('Systems Monitoring');
  IS_MANAGER = ME.role === 'manager' || ME.role === 'owner';
  const access = getAppAccess();
  const hasAccess = IS_MANAGER || access.some(a => a.app_key === 'monitoring' && a.enabled);
  if (!hasAccess) {
    document.getElementById('app').innerHTML = '<div class="card"><p>Systems Monitoring isn\'t enabled for your account yet — ask your manager.</p><p><a href="/dashboard.html">Back home</a></p></div>';
    return;
  }
  try {
    // Ticket 3 used to be filtered out here (it was being sold, deliberately
    // out of scope for monitoring — see db/patch_010_monitoring.sql). That
    // sale is off and it's being activated again, so it's back in scope
    // like every other location.
    LOCATIONS = await api('/api/locations');
    renderTabs();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
