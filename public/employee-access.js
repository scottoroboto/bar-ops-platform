// One page per employee for every switch the owner sets (Oct 2026):
// Access (apps, cash and inventory tiers, reach), Home (widgets),
// Notifications (morning summary, alert routes, alert modes), Scheduling
// (schedules, positions, managed schedules, department). Each tab ends
// with what the person set for themselves, read-only. Every switch saves
// on tap through the same routes the old pages used, so the rules those
// routes enforce still apply. Owner only.
let ME = null;
let PERSON_ID = null;
let V = null; // the /access view
let TAB = 'access';
const TABS = [
  { key: 'access', label: 'Access', sub: 'apps, cash, inventory', color: '#4f8dfd' },
  { key: 'home', label: 'Home', sub: 'widgets on their screen', color: '#3fbf7f' },
  { key: 'notif', label: 'Notifications', sub: 'alerts, morning summary', color: '#e0a83e' },
  { key: 'sched', label: 'Scheduling', sub: 'schedules, positions', color: '#9b6cf0' },
];

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
  if (text && kind === 'success') setTimeout(() => { const b = document.getElementById('msgBox'); if (b && b.textContent === text) b.innerHTML = ''; }, 2500);
}
function fmtWhen(iso) { return iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
function fmtDay(ymd) { return ymd ? new Date(String(ymd).slice(0, 10) + 'T12:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—'; }
function fmtHm(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return `${(h % 12) || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'a' : 'p'}`; }
function initials(name) { return String(name || '').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase(); }

async function load() {
  try { V = await api(`/api/employees/${PERSON_ID}/access`); } catch (e) { document.getElementById('acHead').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; return; }
  renderHead(); renderTabs(); renderPanel();
}

function renderHead() {
  const p = V.person;
  const locs = p.locationIds.map((id) => (V.locations.find((l) => l.id === id) || {}).name).filter(Boolean).join(', ') || 'no bar yet';
  document.getElementById('acHead').innerHTML = `
    <div class="ac-who">
      <div class="ac-avatar">${escapeHtml(initials(p.name))}</div>
      <div>
        <div class="ac-name">${escapeHtml(p.name)} <span class="ac-pill">${escapeHtml(p.role.toUpperCase())}</span>${p.status !== 'active' ? ` <span class="ac-pill off">${escapeHtml(p.status.toUpperCase())}</span>` : ''}</div>
        <div class="ac-sub">${escapeHtml(locs)}${p.position ? ' · ' + escapeHtml(p.position) : ''}${p.payRate ? ' · $' + Number(p.payRate).toFixed(2) + '/hr' : ''} · since ${fmtDay(p.since)}</div>
      </div>
      <a class="ac-back" href="/employees.html">Back to Employees</a>
    </div>`;
}

function renderTabs() {
  document.getElementById('acTabs').innerHTML = TABS.map((t) => `<button class="${t.key === TAB ? 'on' : ''}" style="--c:${t.color}" onclick="setTab('${t.key}')">${t.label}<small>${t.sub}</small></button>`).join('');
}
function setTab(k) { TAB = k; try { localStorage.setItem('ac_tab', k); } catch (e) {} renderTabs(); renderPanel(); }

function sw(on, handler, disabled) {
  return `<span class="switch ${disabled ? 'disabled' : ''}"><input type="checkbox" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="${handler}"><span class="slider"></span></span>`;
}
function row(label, sub, control) {
  return `<div class="ac-row"><div><div class="ac-l">${label}</div>${sub ? `<div class="ac-s">${sub}</div>` : ''}</div>${control}</div>`;
}
function ro(rows) {
  return `<div class="ac-ro"><div class="ac-ro-t">Their own settings (read only)</div><div class="ac-kv">${rows.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('')}</div></div>`;
}
function chips(items, handler) {
  return `<div class="ac-chips">${items.map((it) => `<button type="button" class="ac-chip ${it.on ? 'on' : ''}" onclick="${handler.replace('%ID%', it.id)}">${escapeHtml(it.label)}</button>`).join('')}</div>`;
}

function renderPanel() {
  const t = TABS.find((x) => x.key === TAB);
  const el = document.getElementById('acPanel');
  const inner = TAB === 'access' ? panelAccess() : TAB === 'home' ? panelHome() : TAB === 'notif' ? panelNotif() : panelSched();
  el.innerHTML = `<div class="card ac-panel" style="--c:${t.color}">${inner}</div>`;
}

// ---------------- Access ----------------
function panelAccess() {
  const p = V.person; const own = V.own;
  const isOwner = p.role === 'owner';
  const apps = V.apps.filter((a) => !a.managerOnly || p.role === 'manager');
  const half = Math.ceil(apps.length / 2);
  const appRow = (a) => row(escapeHtml(a.label), a.expiresAt ? `on until ${fmtWhen(a.expiresAt)}` : '', sw(a.enabled, `setApp('${a.key}', this.checked)`, isOwner));
  const tierSel = (kind, t) => `<select onchange="setTier('${kind}', this.value)">
      <option value="" ${!t.override ? 'selected' : ''}>Use position default (${escapeHtml(labelOf(t.options, t.positionDefault) || 'none set')})</option>
      ${t.options.map(([v, l]) => `<option value="${v}" ${t.override === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
    </select>`;
  return `
    <div class="ac-group">Apps on their dashboard</div>
    ${isOwner ? '<p class="muted">The owner has every app.</p>' : ''}
    <div class="ac-grid2"><div>${apps.slice(0, half).map(appRow).join('')}</div><div>${apps.slice(half).map(appRow).join('')}</div></div>
    <div class="ac-group">Tiers</div>
    ${row('Cash handling', `In effect now: <b>${escapeHtml(labelOf(V.tiers.cash.options, V.tiers.cash.effective))}</b>${!V.apps.find((a) => a.key === 'cash_handling').enabled && !isOwner ? ' (Cash Handling app is off, so no access)' : ''}. Position defaults are set on Cash Handling, Manage access.`, tierSel('cash', V.tiers.cash))}
    ${row('Inventory', `In effect now: <b>${escapeHtml(labelOf(V.tiers.inventory.options, V.tiers.inventory.effective))}</b>${!V.apps.find((a) => a.key === 'inventory_control').enabled && !isOwner ? ' (Inventory app is off, so no access)' : ''}. Position defaults are set on Inventory, Manage access.`, tierSel('inventory', V.tiers.inventory))}
    <div class="ac-group">Payroll</div>
    ${row('Tax and direct deposit info on file', 'Off means they see "finish payroll setup" on My Account and a banner on their home screen until they submit the form and you flip this on. Current staff were set to on.', sw(p.payrollOnFile, 'setPayroll(this.checked)'))}
    <div class="ac-group">Reach</div>
    ${row(`Reach: ${escapeHtml(p.reach)}`, 'What their account can see across every app, enforced in the database. The apps above sit on top of it.', `<select onchange="setRole(this)"><option value="staff" ${p.role === 'staff' ? 'selected' : ''}>Staff</option><option value="manager" ${p.role === 'manager' ? 'selected' : ''}>Manager</option><option value="maintenance" ${p.role === 'maintenance' ? 'selected' : ''}>Maintenance</option><option value="owner" ${p.role === 'owner' ? 'selected' : ''}>Owner</option></select>`)}
    ${ro([
      ['Phone', escapeHtml(own.phone || 'none on file')], ['Email', escapeHtml(own.email || 'none on file')],
      ['PIN', own.pin === 'locked' ? '<span class="bad">locked after 5 wrong tries</span>' : own.pin === 'set' ? '<span class="ok">set</span>' : 'not set'],
      ['Password', own.password === 'locked' ? '<span class="bad">locked</span>' : own.password.startsWith('verified') ? `<span class="ok">verified</span> ${fmtWhen(own.password.slice(9))}` : '<span class="warnc">never signed in</span>'],
      ['Last sign-in', own.lastSignIn ? `${fmtWhen(own.lastSignIn.at)}${own.lastSignIn.sharedDevice ? ', shared iPad' : ''}` : 'never'],
    ])}`;
}
function labelOf(options, v) { const o = options.find((x) => x[0] === v); return o ? o[1] : v || ''; }

async function setApp(appKey, enabled) {
  try {
    const r = await withStepUp(() => api(`/api/employees/${PERSON_ID}/app-access`, { method: 'POST', body: { appKey, enabled } }));
    if (!r.ok) { showMsg(r.error, 'error'); load(); return; }
    showMsg(`${enabled ? 'On' : 'Off'}: ${labelOf(V.apps.map((a) => [a.key, a.label]), appKey)}.`, 'success'); V = await api(`/api/employees/${PERSON_ID}/access`); renderPanel();
  } catch (e) { showMsg(e.message, 'error'); load(); }
}
async function setPayroll(onFile) {
  try { const r = await withStepUp(() => api(`/api/employees/${PERSON_ID}/payroll-on-file`, { method: 'POST', body: { onFile } })); if (!r.ok) { showMsg(r.error, 'error'); load(); return; } showMsg(onFile ? 'Marked on file.' : 'They will be asked to finish payroll setup.', 'success'); V.person.payrollOnFile = onFile; }
  catch (e) { showMsg(e.message, 'error'); load(); }
}
async function setTier(kind, value) {
  const base = kind === 'cash' ? '/api/cashhandling/access/overrides' : '/api/inventory/access/overrides';
  try {
    if (value) await withStepUp(() => api(base, { method: 'POST', body: { personId: PERSON_ID, tier: value } }));
    else await withStepUp(() => api(`${base}/${PERSON_ID}/revert`, { method: 'POST', body: {} }));
    showMsg('Saved.', 'success'); V = await api(`/api/employees/${PERSON_ID}/access`); renderPanel();
  } catch (e) { showMsg(e.message, 'error'); load(); }
}
async function setRole(sel) {
  const role = sel.value;
  if (!confirm(`Change ${V.person.name}'s reach to ${role}? This changes what they can see in every app.`)) { sel.value = V.person.role; return; }
  try {
    const r = await withStepUp(() => api(`/api/employees/${PERSON_ID}/role`, { method: 'POST', body: { role } }));
    if (!r.ok) { showMsg(r.error, 'error'); sel.value = V.person.role; return; }
    showMsg('Role changed.', 'success'); load();
  } catch (e) { showMsg(e.message, 'error'); sel.value = V.person.role; }
}

// ---------------- Home ----------------
function panelHome() {
  const p = V.person;
  if (p.role === 'owner') return '<div class="ac-group">Home widgets</div><p class="muted">The owner sees every widget.</p>';
  if (p.role === 'staff') return '<div class="ac-group">Home widgets</div><p class="muted">Widgets are for managers and maintenance. Staff see their apps only.</p>';
  const half = Math.ceil(V.widgets.length / 2);
  const wrow = (w) => row(escapeHtml(w.label), '', sw(w.on, `setWidget('${w.key}', this.checked)`));
  return `
    <div class="ac-group">Home widgets</div>
    <div class="ac-grid2"><div>${V.widgets.slice(0, half).map(wrow).join('')}</div><div>${V.widgets.slice(half).map(wrow).join('')}</div></div>
    <p class="muted" style="margin-top:10px;">Bar or kitchen for the morning summary follows these: bar widgets on means bar sections, kitchen widgets on means kitchen sections. Maintenance with none on gets both, for every bar.</p>`;
}
async function setWidget(key, on) {
  try { await withStepUp(() => api(`/api/employees/${PERSON_ID}/home-lines`, { method: 'POST', body: { [key]: on } })); showMsg('Widgets updated.', 'success'); }
  catch (e) { showMsg(e.message, 'error'); load(); }
}

// ---------------- Notifications ----------------
function panelNotif() {
  const p = V.person; const S = V.summary; const A = V.alerts; const own = V.own;
  const canSummary = p.role === 'manager' || p.role === 'maintenance' || p.role === 'owner';
  const routeChips = [{ id: '', label: 'Every bar', on: A.routes.some((r) => !r.locationId) }].concat(V.locations.map((l) => ({ id: l.id, label: l.name, on: A.routes.some((r) => r.locationId === l.id) })));
  const half = Math.ceil(A.categories.length / 2);
  const catRow = (c) => row(escapeHtml(c.label), '', `<select onchange="setAlertMode('${c.key}', this.value)"><option value="off" ${c.mode === 'off' ? 'selected' : ''}>Off</option><option value="immediate" ${c.mode === 'immediate' ? 'selected' : ''}>Right away</option><option value="daily" ${c.mode === 'daily' ? 'selected' : ''}>Daily summary</option></select>`);
  const last = S.last ? `${fmtWhen(S.last.created_at)}${S.last.is_test ? ' (test)' : ''}, email ${S.last.email_status || 'off'}, text ${S.last.sms_status || 'off'}` : 'never';
  return `
    <div class="ac-group">Morning summary</div>
    ${canSummary ? `
      ${row('Send a morning summary', 'One email or text at the hour they pick, for each bar they work at.', sw(S.enabled, "setSummary({ enabled: this.checked })"))}
      ${row('Sections', 'Needs-you is always on. Tap to turn a section on or off.', '')}
      ${chips(S.sectionList.map((s) => ({ id: s.key, label: s.label, on: !!S.sections[s.key] })), "toggleSection('%ID%')")}
      ${row('Day/night cutoff', '', `<select onchange="setSummary({ dayNightCutoff: Number(this.value) })">${[16, 17, 18, 19, 20, 21].map((h) => `<option value="${h}" ${S.dayNightCutoff === h ? 'selected' : ''}>${h - 12}:00 PM</option>`).join('')}</select>`)}
      ${row('Late clock-in after', '', `<select onchange="setSummary({ lateAfterMin: Number(this.value) })">${[5, 10, 15].map((m) => `<option value="${m}" ${S.lateAfterMin === m ? 'selected' : ''}>${m} minutes</option>`).join('')}</select>`)}
      <div class="ac-actions"><button class="ghost" onclick="sendSummaryTest()">Send them a test now</button><span id="summaryTestResult" class="muted"></span></div>`
      : '<p class="muted">The morning summary is for managers, maintenance and the owner.</p>'}
    <div class="ac-group">Equipment alerts, right away or daily</div>
    ${row('Routed for', 'Which bars\' equipment alerts reach this person, on top of Systems Monitoring access.', '')}
    ${chips(routeChips, "toggleRoute('%ID%')")}
    <div class="ac-grid2" style="margin-top:8px;"><div>${A.categories.slice(0, half).map(catRow).join('')}</div><div>${A.categories.slice(half).map(catRow).join('')}</div></div>
    ${ro([
      ['Notices by', escapeHtml(own.notifyChannel === 'both' ? 'Text and email' : own.notifyChannel === 'sms' ? 'Text' : 'Email')],
      ['Text consent', own.smsConsentAt ? `<span class="ok">agreed ${fmtWhen(own.smsConsentAt)}</span> for ${escapeHtml(own.smsConsentPhone || '')}` : '<span class="warnc">not agreed</span> (they tick the box under Systems Monitoring)'],
      ['Morning summary', canSummary ? `${S.channel === 'both' ? 'email and text' : S.channel === 'sms' ? 'text' : 'email'}, ${S.sendHour} AM` : '—'],
      ['Last summary', canSummary ? escapeHtml(last) : '—'],
      ['Clock-in reminders', own.reminders ? (own.reminders.clockIn || own.reminders.clockOut ? `<span class="ok">on</span> by ${escapeHtml(own.reminders.channel)}` : 'off') : 'off'],
    ])}`;
}
async function setSummary(body) {
  try {
    const r = await withStepUp(() => api(`/api/summary/settings/${PERSON_ID}`, { method: 'POST', body }));
    if (r && r.ok === false) { showMsg(r.error, 'error'); load(); return; }
    showMsg('Morning summary updated.', 'success'); V = await api(`/api/employees/${PERSON_ID}/access`); renderPanel();
  } catch (e) { showMsg(e.message, 'error'); load(); }
}
function toggleSection(key) { setSummary({ sections: { [key]: !V.summary.sections[key] } }); }
async function sendSummaryTest() {
  const out = document.getElementById('summaryTestResult'); out.textContent = 'Building…';
  try {
    const r = await withStepUp(() => api(`/api/summary/test/${PERSON_ID}`, { method: 'POST' }));
    out.innerHTML = r.ok ? r.results.map((x) => `${escapeHtml(x.location)}: email ${escapeHtml(x.emailStatus || 'off')}, text ${escapeHtml(x.smsStatus || 'off')}. <a href="${x.url}" target="_blank" rel="noopener">Open</a>`).join(' · ') : `<span class="bad">${escapeHtml(r.error)}</span>`;
  } catch (e) { out.innerHTML = `<span class="bad">${escapeHtml(e.message)}</span>`; }
}
async function toggleRoute(locationId) {
  const existing = V.alerts.routes.find((r) => (locationId ? r.locationId === locationId : !r.locationId));
  try {
    if (existing) await withStepUp(() => api(`/api/monitoring/alert-routes/${existing.id}/remove`, { method: 'POST', body: {} }));
    else { const r = await withStepUp(() => api('/api/monitoring/alert-routes', { method: 'POST', body: { personId: PERSON_ID, locationId: locationId || null } })); if (!r.ok) { showMsg(r.error, 'error'); return; } }
    showMsg('Alert routing updated.', 'success'); V = await api(`/api/employees/${PERSON_ID}/access`); renderPanel();
  } catch (e) { showMsg(e.message, 'error'); load(); }
}
async function setAlertMode(category, mode) {
  try {
    const r = await withStepUp(() => api(`/api/monitoring/notify-settings/${PERSON_ID}`, { method: 'POST', body: { prefs: { [category]: mode } } }));
    if (!r.ok) { showMsg(r.error, 'error'); load(); return; }
    showMsg('Alert settings saved.', 'success');
  } catch (e) { showMsg(e.message, 'error'); load(); }
}

// ---------------- Scheduling ----------------
function panelSched() {
  const p = V.person; const S = V.scheduling; const own = V.own;
  const dept = p.department || '';
  return `
    ${!S.schedulingOn ? '<p class="msg info">The Scheduling app is off for this person (Access tab). They can still be put on a schedule, but they will not see it until it is on.</p>' : ''}
    <div class="ac-group">Schedules they can be put on</div>
    ${chips(S.schedules.map((s) => ({ id: s.id, label: `${s.locationName} · ${s.name}`, on: s.qualified })), "toggleSchedule('%ID%')")}
    <div class="ac-group">Positions they can work</div>
    ${chips(S.positions.map((x) => ({ id: x.id, label: x.name, on: x.qualified })), "togglePosition('%ID%')")}
    ${p.role === 'manager' || p.role === 'owner' ? `<div class="ac-group">Schedules they manage</div>${chips(S.schedules.map((s) => ({ id: s.id, label: `${s.locationName} · ${s.name}`, on: s.manages })), "toggleManaged('%ID%')")}` : ''}
    <div class="ac-group">Department</div>
    ${row('Bar, kitchen or both', 'Scheduling and the morning summary use it to route service calls and applicants.', chips([['bar', 'Bar'], ['kitchen', 'Kitchen'], ['both', 'Both']].map(([v, l]) => ({ id: v, label: l, on: dept === v })), "setDepartment('%ID%')"))}
    ${ro([
      ['Availability', own.availability.length ? own.availability.map((a) => `${a.day} ${fmtHm(a.start)}–${fmtHm(a.end)}${a.note ? ' (' + escapeHtml(a.note) + ')' : ''}`).join(' · ') : 'nothing entered'],
      ['Time off', own.timeOff.length ? own.timeOff.map((t) => `${fmtDay(t.start)}–${fmtDay(t.end)} ${t.status}`).join(' · ') : 'none coming up'],
    ])}`;
}
async function saveIds(path, key, ids) {
  try { await withStepUp(() => api(path, { method: 'POST', body: { [key]: ids } })); showMsg('Saved.', 'success'); V = await api(`/api/employees/${PERSON_ID}/access`); renderPanel(); }
  catch (e) { showMsg(e.message, 'error'); load(); }
}
function toggleSchedule(id) { const ids = V.scheduling.schedules.filter((s) => (s.id === id ? !s.qualified : s.qualified)).map((s) => s.id); saveIds(`/api/scheduling/employees/${PERSON_ID}/schedules`, 'scheduleIds', ids); }
function togglePosition(id) { const ids = V.scheduling.positions.filter((s) => (s.id === id ? !s.qualified : s.qualified)).map((s) => s.id); saveIds(`/api/scheduling/employees/${PERSON_ID}/positions`, 'positionIds', ids); }
function toggleManaged(id) { const ids = V.scheduling.schedules.filter((s) => (s.id === id ? !s.manages : s.manages)).map((s) => s.id); saveIds(`/api/scheduling/employees/${PERSON_ID}/managed-schedules`, 'scheduleIds', ids); }
async function setDepartment(v) {
  const next = V.person.department === v ? null : v;
  try { const r = await withStepUp(() => api(`/api/employees/${PERSON_ID}/department`, { method: 'POST', body: { department: next } })); if (!r.ok) { showMsg(r.error, 'error'); return; } showMsg('Saved.', 'success'); V = await api(`/api/employees/${PERSON_ID}/access`); renderPanel(); }
  catch (e) { showMsg(e.message, 'error'); }
}

(function init() {
  ME = requireRole(['owner']);
  if (!ME) return;
  renderTopbar('Employee access');
  PERSON_ID = new URLSearchParams(location.search).get('id');
  if (!PERSON_ID) { document.getElementById('acHead').innerHTML = '<p class="msg error">No employee picked. <a href="/employees.html">Back to Employees</a></p>'; return; }
  const want = new URLSearchParams(location.search).get('tab');
  try { TAB = want || localStorage.getItem('ac_tab') || 'access'; } catch (e) { TAB = want || 'access'; }
  if (!TABS.some((t) => t.key === TAB)) TAB = 'access';
  load();
})();
