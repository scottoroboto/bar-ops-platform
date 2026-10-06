// Kitchen board settings (patch_055): goals, which SpotOn jobs count as
// kitchen, which sales lines count as food, rotation, names on/off, the
// kitchen TV's device links (owner), and the last pulls from SpotOn.
let LOCATIONS = [];
const person = getPerson();
if (!getToken()) goLogin();
renderTopbar('Kitchen Board');

function locId() { return document.getElementById('kbLocation').value; }
function showMsg(text, kind) { document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'success'}">${escapeHtml(text)}</div>` : ''; }

async function init() {
  if (!person || !['owner', 'manager'].includes(person.role)) { document.getElementById('app').innerHTML = '<div class="card"><p>Managers and the owner only.</p></div>'; return; }
  const locs = await api('/api/locations');
  LOCATIONS = (Array.isArray(locs) ? locs : []).filter((l) => person.role === 'owner' || myLocationIds(person).includes(String(l.id)));
  const sel = document.getElementById('kbLocation');
  sel.innerHTML = LOCATIONS.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('');
  const want = new URLSearchParams(location.search).get('location_id') || initialLocationId(person, LOCATIONS);
  if (want && LOCATIONS.some((l) => String(l.id) === String(want))) sel.value = want;
  await loadAll();
}

async function loadAll() {
  const id = locId();
  if (!id) return;
  rememberLocationId(id);
  document.getElementById('openBoard').href = `/kitchen-board.html?location_id=${encodeURIComponent(id)}`;
  try {
    const { settings: s, devices, pulls } = await api(`/api/kitchen-board/settings/${id}`);
    for (const [k, v] of [['foodGoalWeekday', s.food_goal_weekday], ['foodGoalWeekend', s.food_goal_weekend], ['laborGoalWeekday', s.labor_goal_weekday], ['laborGoalWeekend', s.labor_goal_weekend],
      ['laborGoalWeek', s.labor_goal_week], ['slowNightLine', s.slow_night_line], ['rotateSeconds', s.rotate_seconds], ['dayStartHour', s.day_start_hour]]) {
      document.getElementById(k).value = Number(v);
    }
    document.getElementById('kitchenRoles').value = (s.kitchen_roles || []).join(', ');
    document.getElementById('foodKeys').value = (s.food_keys || []).join(', ');
    document.getElementById('showNames').checked = !!s.show_names;
    const dc = document.getElementById('devicesCard');
    dc.style.display = person.role === 'owner' ? '' : 'none';
    document.getElementById('deviceList').innerHTML = (devices || []).map((d) => `<div class="kb-dev"><span><b>${escapeHtml(d.name)}</b> <span class="muted" style="font-size:12px;">since ${new Date(d.created_at).toLocaleDateString()}</span></span>
      <button class="small ghost" style="margin:0;" onclick="removeDevice('${d.id}', '${escapeHtml(d.name).replace(/'/g, '&#39;')}')">Remove</button></div>`).join('') || '<div class="muted" style="font-size:12px;">No TV links yet.</div>';
    document.getElementById('pulls').innerHTML = (pulls || []).map((p) => `<tr><td>${new Date(p.at).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}</td>
      <td class="${p.ok ? 'kb-ok' : 'kb-bad'}">${p.ok ? 'OK' : 'FAILED'}</td><td>${p.ok ? `${p.punches} punches · ${((p.ms || 0) / 1000).toFixed(0)}s` : escapeHtml(p.error || '')}</td></tr>`).join('') || '<tr><td class="muted">Nothing pulled yet. The bar\'s box needs SPOTON_USER / SPOTON_PASS in its .env.</td></tr>';
  } catch (e) { showMsg(e.message, 'error'); }
}

async function saveSettings() {
  const body = {};
  for (const k of ['foodGoalWeekday', 'foodGoalWeekend', 'laborGoalWeekday', 'laborGoalWeekend', 'laborGoalWeek', 'slowNightLine', 'rotateSeconds', 'dayStartHour']) body[k] = Number(document.getElementById(k).value);
  body.kitchenRoles = document.getElementById('kitchenRoles').value;
  body.foodKeys = document.getElementById('foodKeys').value;
  body.showNames = document.getElementById('showNames').checked;
  try {
    await withStepUp(() => api(`/api/kitchen-board/settings/${locId()}`, { method: 'POST', body }));
    showMsg('Saved. The board picks it up within a minute.');
  } catch (e) { showMsg(e.message, 'error'); }
}

async function makeDevice() {
  const name = document.getElementById('deviceName').value.trim();
  if (!name) { showMsg('Name it for where it is, like Kitchen TV.', 'error'); return; }
  try {
    const r = await withStepUp(() => api(`/api/kitchen-board/devices/${locId()}`, { method: 'POST', body: { name } }));
    await loadAll();
    document.getElementById('deviceSteps').innerHTML = `<div class="msg success" style="margin-top:8px;">
      <b>${escapeHtml(r.device.name)}</b> is set up. This link is shown once -- copy it now:<br>
      <input value="${escapeHtml(r.url)}" readonly onclick="this.select()" style="width:100%; margin:8px 0; font-size:12px;">
      On the TV's computer: open Chrome, paste the link, press F11 for full screen. Double-click the board to go full screen too.</div>`;
  } catch (e) { showMsg(e.message, 'error'); }
}

async function removeDevice(id, name) {
  if (!confirm(`Remove ${name}? That screen stops working within a minute.`)) return;
  try { await withStepUp(() => api(`/api/kitchen-board/devices/${id}/remove`, { method: 'POST', body: {} })); await loadAll(); } catch (e) { showMsg(e.message, 'error'); }
}

init().catch((e) => showMsg(e.message, 'error'));
