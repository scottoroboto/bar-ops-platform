// Sales Board settings (patch_055, per side since patch_080): one board
// per bar and side (T1 Kitchen, T1 Bar, ...). Per board: labor goal, the
// daily targets (forecast, or the owner's override for a day) and its TV
// links. Per bar: business day, food sales lines, manager access, the
// forecast's history and left-out days, and the last pulls from SpotOn.
let LOCATIONS = [];
let SETTINGS = null;
let LOC = null;
let SIDE = 'kitchen';
let DAYS = 7;
const person = getPerson();
if (!getToken()) goLogin();
renderTopbar('Sales Board');

function locId() { return LOC; }
function showMsg(text, kind) { document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'success'}">${escapeHtml(text)}</div>` : ''; }
const SIDE_LABEL = { kitchen: 'Kitchen', bar: 'Bar' };
const LOC_COLORS = ['#d8453c', '#e39200', '#2563eb', '#15803d'];
function locCode(l) { const m = String(l.name || '').match(/(\d+)\s*$/); return m ? `T${m[1]}` : String(l.name || '').slice(0, 3).toUpperCase(); }
function locColor(id) { const i = LOCATIONS.findIndex((l) => String(l.id) === String(id)); return LOC_COLORS[(i < 0 ? 0 : i) % LOC_COLORS.length]; }
function boardName() { const l = LOCATIONS.find((x) => String(x.id) === String(LOC)); return `${l ? locCode(l) : ''} ${SIDE_LABEL[SIDE]}`; }

async function init() {
  if (!person || person.role !== 'owner') { document.getElementById('app').innerHTML = '<div class="card"><p>Owner only. Managers open the board itself from the Dashboard when it is turned on for them.</p></div>'; return; }
  const locs = await api('/api/locations');
  LOCATIONS = (Array.isArray(locs) ? locs : []);
  const q = new URLSearchParams(location.search);
  const want = q.get('location_id') || initialLocationId(person, LOCATIONS);
  LOC = want && LOCATIONS.some((l) => String(l.id) === String(want)) ? want : (LOCATIONS[0] && LOCATIONS[0].id);
  SIDE = q.get('side') === 'bar' ? 'bar' : 'kitchen';
  await loadAll();
}

// The four (or more) boards, with each one's labor goal.
async function renderBoards() {
  const goals = {};
  await Promise.all(LOCATIONS.map(async (l) => { try { goals[l.id] = (await api(`/api/kitchen-board/settings/${l.id}`)).settings; } catch (e) { goals[l.id] = null; } }));
  document.getElementById('boards').innerHTML = LOCATIONS.flatMap((l) => ['kitchen', 'bar'].map((sd) => {
    const g = goals[l.id];
    const goal = g ? Number(sd === 'bar' ? g.bar_labor_goal : g.labor_goal_weekday) : null;
    const on = String(l.id) === String(LOC) && sd === SIDE;
    return `<button class="sb-bd${on ? ' on' : ''}" onclick="pickBoard('${escapeHtml(l.id)}', '${sd}')"><span class="sb-loc" style="background:${locColor(l.id)}">${escapeHtml(locCode(l))}</span><span>${SIDE_LABEL[sd]}<small>${goal != null ? `labor goal ${goal}%` : escapeHtml(l.name)}</small></span></button>`;
  })).join('');
}

function pickBoard(id, side) {
  LOC = id; SIDE = side === 'bar' ? 'bar' : 'kitchen';
  history.replaceState(null, '', `?location_id=${encodeURIComponent(LOC)}&side=${SIDE}`);
  showMsg('');
  document.getElementById('deviceSteps').innerHTML = '';
  loadAll();
}

async function loadAll() {
  const id = locId();
  if (!id) return;
  rememberLocationId(id);
  const l = LOCATIONS.find((x) => String(x.id) === String(id)) || {};
  const name = boardName();
  document.getElementById('openBoard').href = `/kitchen-board.html?location_id=${encodeURIComponent(id)}&side=${SIDE}`;
  document.getElementById('openBoard').textContent = `Open ${name} board`;
  document.getElementById('laborTitle').textContent = `${name} · labor`;
  document.getElementById('targetTitle').textContent = `${name} · daily target`;
  document.getElementById('tvTitle').textContent = `${name} · TV`;
  document.getElementById('locTitle').textContent = `${l.name || ''} · both boards`;
  document.getElementById('laborOf').textContent = `of ${SIDE === 'bar' ? 'bar' : 'kitchen'} sales`;
  document.getElementById('kitchenOnly').style.display = SIDE === 'kitchen' ? '' : 'none';
  document.getElementById('barRolesNote').style.display = SIDE === 'bar' ? '' : 'none';
  document.getElementById('deviceName').placeholder = `Where it is, e.g. ${SIDE_LABEL[SIDE]} TV`;
  renderBoards();
  try {
    const { settings: s, devices, pulls } = await api(`/api/kitchen-board/settings/${id}`);
    SETTINGS = s;
    document.getElementById('laborGoal').value = Number(SIDE === 'bar' ? s.bar_labor_goal : s.labor_goal_weekday);
    for (const [k, v] of [['slowNightLine', s.slow_night_line], ['rotateSeconds', s.rotate_seconds], ['dayStartHour', s.day_start_hour]]) document.getElementById(k).value = Number(v);
    document.getElementById('kitchenRoles').value = (s.kitchen_roles || []).join(', ');
    document.getElementById('foodKeys').value = (s.food_keys || []).join(', ');
    document.getElementById('showNames').checked = !!s.show_names;
    document.getElementById('managersCanView').checked = !!s.managers_can_view;
    const mine = (devices || []).filter((d) => (d.side || 'kitchen') === SIDE);
    document.getElementById('deviceList').innerHTML = mine.map((d) => `<div class="kb-dev"><span><b>${escapeHtml(d.name)}</b> <span class="muted" style="font-size:12px;">since ${new Date(d.created_at).toLocaleDateString()}</span></span>
      <button class="small ghost" style="margin:0;" onclick="removeDevice('${d.id}', '${escapeHtml(d.name).replace(/'/g, '&#39;')}')">Remove</button></div>`).join('') || '<div class="muted" style="font-size:12px;">No TV links for this board yet.</div>';
    document.getElementById('pulls').innerHTML = (pulls || []).map((p) => `<tr><td>${new Date(p.at).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}</td>
      <td class="${p.ok ? 'kb-ok' : 'kb-bad'}">${p.ok ? 'OK' : 'FAILED'}</td><td>${p.ok ? `${p.punches} punches · ${((p.ms || 0) / 1000).toFixed(0)}s` : escapeHtml(p.error || '')}</td></tr>`).join('') || '<tr><td class="muted">Nothing pulled yet. The bar\'s box needs SPOTON_USER / SPOTON_PASS in its .env.</td></tr>';
  } catch (e) { showMsg(e.message, 'error'); }
  loadTargets();
  loadForecast();
}

// ---- Daily targets (patch_080) ------------------------------------------
let TARGETS = null;
async function loadTargets() {
  const box = document.getElementById('targets');
  try { TARGETS = await api(`/api/kitchen-board/targets/${locId()}?side=${SIDE}&days=14`); } catch (e) { box.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; return; }
  renderTargets();
}
function renderTargets() {
  const box = document.getElementById('targets');
  const t = TARGETS;
  if (!t) return;
  const day = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
  const rows = t.days.slice(0, DAYS).map((d, i) => {
    const label = i === 0 ? '<b>Today</b>' : day(d.date);
    const why = d.drivers.length ? `<span class="why">${d.drivers.map(escapeHtml).join(' · ')}</span>` : '';
    const target = d.override
      ? `<td class="n sb-set">${fcMoney(d.override.amount)}<button class="sb-x" title="Back to the forecast" onclick="clearTarget('${d.date}')">✕</button><small>${d.override.note ? `${escapeHtml(d.override.note)} · ` : ''}<a href="#" onclick="noteTarget('${d.date}'); return false;">${d.override.note ? 'edit' : 'add a note'}</a></small></td>`
      : `<td class="n"><input type="number" min="0" step="50" inputmode="numeric" placeholder="${d.forecast != null ? Math.round(d.forecast) : ''}" onkeydown="if(event.key==='Enter'){this.blur();}" onchange="setTarget('${d.date}', this.value)"></td>`;
    return `<tr><td>${label}${why}</td><td class="n">${fcMoney(d.forecast)}</td>${target}</tr>`;
  }).join('');
  const later = (t.later || []).length ? `<p class="sb-hint">Also set further out: ${t.later.map((x) => `${day(x.date)} ${fcMoney(x.amount)}${x.note ? ` (${escapeHtml(x.note)})` : ''}`).join(', ')}</p>` : '';
  box.innerHTML = `<div class="fc-wrap"><table class="sb-days"><thead><tr><th>Day</th><th class="n">Forecast</th><th class="n">Target</th></tr></thead><tbody>${rows}</tbody></table></div>${t.forecastReady ? '' : '<p class="sb-hint">The forecast needs more sales history; type a target for any day you want one.</p>'}${later}`;
  document.getElementById('moreDays').textContent = DAYS === 7 ? 'Next 2 weeks ›' : 'Just this week ‹';
}
function toggleDays() { DAYS = DAYS === 7 ? 14 : 7; renderTargets(); }
async function setTarget(date, value, note) {
  if (value === '' || value == null) return;
  try {
    await withStepUp(() => api(`/api/kitchen-board/targets/${locId()}`, { method: 'POST', body: { side: SIDE, date, amount: Number(value), note: note || null } }));
    await loadTargets();
  } catch (e) { showMsg(e.message, 'error'); }
}
async function clearTarget(date) {
  try {
    await withStepUp(() => api(`/api/kitchen-board/targets/${locId()}`, { method: 'POST', body: { side: SIDE, date, amount: null } }));
    await loadTargets();
  } catch (e) { showMsg(e.message, 'error'); }
}
function noteTarget(date) {
  const d = TARGETS.days.find((x) => x.date === date);
  if (!d || !d.override) return;
  const note = prompt('Why this target? (e.g. Private party)', d.override.note || '');
  if (note == null) return;
  setTarget(date, d.override.amount, note);
}

// ---- Sales forecast (patch_076) ----------------------------------------
const fcMoney = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString());
const fcDate = (ymd, opts) => new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', opts || { weekday: 'short', month: 'short', day: 'numeric' });
const fcSigned = (p) => (p == null ? '' : `${p >= 0 ? '+' : '−'}${Math.abs(p)}%`);

async function loadForecast() {
  const body = document.getElementById('fcBody');
  let fc;
  try { fc = await api(`/api/kitchen-board/forecast/${locId()}`); } catch (e) { body.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; return; }
  document.getElementById('fcHistoryFrom').value = fc.historyFrom || '';
  const h = fc.history || {};
  document.getElementById('fcHistoryNote').textContent = h.days
    ? `Learning from ${h.days.toLocaleString()} days of sales, ${fcDate(h.from, { month: 'short', day: 'numeric', year: 'numeric' })} to ${fcDate(h.to, { month: 'short', day: 'numeric', year: 'numeric' })}. The bar's box reads more each night between 2 and 7am until it reaches the date below; the forecast gets sharper as it does.`
    : 'No sales history yet.';
  if (!fc.ready) { body.innerHTML = `<p class="muted">${escapeHtml(fc.reason || 'Not enough history yet.')}</p>`; renderLeftOut(fc); return; }
  const acc = (a) => (a ? `typically within <b>${a.mape}%</b> · ${a.within15}% of days within 15%` : 'not enough days to check yet');
  const teams = (fc.teamEffects || []).filter((t) => t.games > 0).map((t) => `${escapeHtml(t.team)} <b>${fcSigned(t.food)}</b> kitchen, <b>${fcSigned(t.bar)}</b> bar <span class="muted">(${t.games} game${t.games === 1 ? '' : 's'})</span>`).join('<br>');
  const stats = `<div class="fc-stats">
    <div><span class="k">Kitchen, last 8 weeks</span>${acc(fc.accuracy.food)}</div>
    <div><span class="k">Bar, last 8 weeks</span>${acc(fc.accuracy.bar)}</div>
    <div><span class="k">Game-day lift so far</span>${teams || '<span class="muted">No game days in the history yet</span>'}</div>
  </div><p class="muted" style="font-size:12px; margin-top:-4px;">Accuracy is checked the honest way: each of the last 8 weeks predicted from only the days before it.</p>`;
  const rows = fc.days.map((d, i) => `<tr class="${d.drivers.length ? 'has-why' : ''}">
    <td style="white-space:nowrap;">${i === 0 ? '<b>Today</b>' : `${d.dow} ${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))}`}</td>
    <td class="n"><b>${fcMoney(d.food.fc)}</b><span class="fc-range">${fcMoney(d.food.lo)}–${fcMoney(d.food.hi)}</span></td>
    <td class="n"><b>${fcMoney(d.bar.fc)}</b><span class="fc-range">${fcMoney(d.bar.lo)}–${fcMoney(d.bar.hi)}</span></td>
    <td class="n">${fcMoney(d.food.fc + d.bar.fc)}</td>
  </tr>${d.drivers.length ? `<tr class="fc-why-row"><td colspan="4" class="fc-why">${d.drivers.map((x) => `${escapeHtml(x.label)}${x.food != null ? ` <b>${fcSigned(x.food)}</b>` : ''}`).join(' · ')}</td></tr>` : ''}`).join('');
  body.innerHTML = stats + `<div class="fc-wrap"><table class="fc-table"><thead><tr><th>Day</th><th class="n">Kitchen</th><th class="n">Bar</th><th class="n">Total</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="font-size:12px;">Small numbers are the likely range (8 days in 10 land inside it). The % next to a game or holiday is its usual effect on the kitchen.</p>`;
  renderLeftOut(fc);
}

function renderLeftOut(fc) {
  const list = fc.leftOut || [];
  const out = document.getElementById('fcOut');
  out.innerHTML = list.length ? list.map((d) => `<div class="fc-out"><span><b>${fcDate(d.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</b> · ${fcMoney(d.total)}
      <span class="why">${escapeHtml(d.why)}${d.manual ? (d.byOwner ? ' · left out by you' : ' · left out at setup') : ' · left out by the app'}</span></span>
      <button class="small ghost" style="margin:0; flex-shrink:0;" onclick="setForecastDay('${d.date}', ${d.manual ? 'null' : 'false'})">${d.manual ? 'Put back' : 'Use it anyway'}</button></div>`).join('')
    : '<p class="muted" style="font-size:13px;">None.</p>';
  if ((fc.keptByOwner || []).length) {
    out.innerHTML += `<p class="muted" style="font-size:12.5px; margin-top:8px;">Kept by you even though they look unusual: ${fc.keptByOwner.map((d) => `${fcDate(d)} <a href="#" onclick="setForecastDay('${d}', null); return false;">let the app judge</a>`).join(', ')}</p>`;
  }
}

async function setForecastDay(date, excluded, reason) {
  try {
    await withStepUp(() => api(`/api/kitchen-board/forecast/${locId()}/day`, { method: 'POST', body: { date, excluded, reason } }));
    await loadForecast();
  } catch (e) { showMsg(e.message, 'error'); }
}

function leaveOutDay() {
  const date = document.getElementById('fcOutDate').value;
  const reason = document.getElementById('fcOutReason').value.trim();
  if (!date) { showMsg('Pick the day to leave out.', 'error'); return; }
  document.getElementById('fcOutDate').value = '';
  document.getElementById('fcOutReason').value = '';
  setForecastDay(date, true, reason || 'Left out by the owner');
}

async function saveHistoryFrom() {
  const date = document.getElementById('fcHistoryFrom').value;
  try {
    await withStepUp(() => api(`/api/kitchen-board/forecast/${locId()}/history-from`, { method: 'POST', body: { date } }));
    showMsg('Saved. The bar\'s box starts on it tonight between 2 and 7am.');
  } catch (e) { showMsg(e.message, 'error'); }
}

async function saveBody(body, done) {
  try {
    await withStepUp(() => api(`/api/kitchen-board/settings/${locId()}`, { method: 'POST', body }));
    showMsg(done || 'Saved. The board picks it up within a minute.');
    renderBoards();
  } catch (e) { showMsg(e.message, 'error'); }
}
function saveLabor() {
  const goal = Number(document.getElementById('laborGoal').value);
  if (SIDE === 'bar') return saveBody({ barLaborGoal: goal });
  return saveBody({ laborGoalWeekday: goal, laborGoalWeekend: goal, laborGoalWeek: goal, kitchenRoles: document.getElementById('kitchenRoles').value, slowNightLine: Number(document.getElementById('slowNightLine').value) });
}
function saveTv() { return saveBody({ rotateSeconds: Number(document.getElementById('rotateSeconds').value), showNames: document.getElementById('showNames').checked }); }
function saveLocation() { return saveBody({ dayStartHour: Number(document.getElementById('dayStartHour').value), foodKeys: document.getElementById('foodKeys').value, managersCanView: document.getElementById('managersCanView').checked }); }

async function makeDevice() {
  const name = document.getElementById('deviceName').value.trim();
  if (!name) { showMsg(`Name it for where it is, like ${SIDE_LABEL[SIDE]} TV.`, 'error'); return; }
  try {
    const r = await withStepUp(() => api(`/api/kitchen-board/devices/${locId()}`, { method: 'POST', body: { name, side: SIDE } }));
    await loadAll();
    document.getElementById('deviceSteps').innerHTML = `<div class="msg success" style="margin-top:8px;">
      <b>${escapeHtml(r.device.name)}</b> is set up. This link is shown once -- copy it now:<br>
      <div style="display:flex; gap:6px; margin:8px 0;"><input id="kbTvLink" value="${escapeHtml(r.url)}" readonly onclick="this.select()" style="flex:1; margin:0; font-size:12px;"><button class="small" style="margin:0;" onclick="copyTvLink(this)">Copy</button></div>
      <b>Windows TV computer:</b> <button class="small secondary" style="margin:0 4px;" onclick="downloadTvSetup()">Download the setup file</button> then double-click it (Windows may ask twice: Keep, then More info → Run anyway).
      It opens the board full screen now and at every start-up, and sets the computer to never sleep. At start-up it waits 20 seconds first; close that small window to get to the desktop instead.<br>
      <span class="muted">Anything else: open the link in a browser and press F11.</span></div>`;
  } catch (e) { showMsg(e.message, 'error'); }
}

async function copyTvLink(btn) {
  const input = document.getElementById('kbTvLink');
  input.select();
  try { await navigator.clipboard.writeText(input.value); } catch (e) { document.execCommand('copy'); }
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
}

// A Windows batch file with the TV link baked in: copies itself into the
// account's Startup folder, turns off sleep, and opens Edge in kiosk mode.
// Built here in the browser, nothing stored on the server.
function downloadTvSetup() {
  const url = document.getElementById('kbTvLink').value;
  const lines = [
    '@echo off',
    `title ${SIDE_LABEL[SIDE]} TV board`,
    'set "ME=%~f0"',
    'set "STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"',
    'if /I not "%~dp0"=="%STARTUP%\\" (',
    `  copy /Y "%ME%" "%STARTUP%\\${SIDE_LABEL[SIDE]}TV.bat" >nul`,
    '  powercfg -change -monitor-timeout-ac 0',
    '  powercfg -change -standby-timeout-ac 0',
    '  powercfg -change -hibernate-timeout-ac 0',
    '  echo Installed. The board will open at every start-up.',
    '  timeout /t 3 >nul',
    ') else (',
    `  echo Opening the ${SIDE} board in 20 seconds...`,
    '  echo Close this window now if you need the desktop instead.',
    '  timeout /t 20',
    ')',
    'set "EDGE=C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not exist "%EDGE%" set "EDGE=C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"',
    `start "" "%EDGE%" --kiosk "${url}" --edge-kiosk-type=fullscreen --no-first-run --disable-session-crashed-bubble`,
    '',
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Install ${SIDE_LABEL[SIDE]} TV.bat`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function removeDevice(id, name) {
  if (!confirm(`Remove ${name}? That screen stops working within a minute.`)) return;
  try { await withStepUp(() => api(`/api/kitchen-board/devices/${id}/remove`, { method: 'POST', body: {} })); await loadAll(); } catch (e) { showMsg(e.message, 'error'); }
}

init().catch((e) => showMsg(e.message, 'error'));
