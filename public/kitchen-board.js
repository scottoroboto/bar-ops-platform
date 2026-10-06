// Kitchen board (patch_055). Opened by the kitchen TV with ?device=TOKEN,
// or by a signed-in owner/manager (location picker + a Settings link).
// Flips screen A (scoreboard) and B (hour by hour) on a timer, refreshes
// the numbers every 60 seconds, shows a stale banner when the newest
// SpotOn pull is more than 15 minutes old. No labor dollars anywhere.
const qs = new URLSearchParams(location.search);
const DEVICE = qs.get('device');
let LOCATION_ID = qs.get('location_id') || null;
let VIEW = null;
let SCREEN = 'A';
let flipTimer = null;
let lastGood = 0;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null ? '—' : `$${Math.round(n).toLocaleString()}`);

function fit() {
  const sx = window.innerWidth / 1920; const sy = window.innerHeight / 1080;
  document.getElementById('board').style.transform = `scale(${Math.min(sx, sy)})`;
}
window.addEventListener('resize', fit);

async function load() {
  try {
    let path = '/api/kitchen-board/view';
    if (DEVICE) path += `?device=${encodeURIComponent(DEVICE)}`;
    else if (LOCATION_ID) path += `?location_id=${encodeURIComponent(LOCATION_ID)}`;
    const headers = {};
    if (!DEVICE && typeof getToken === 'function' && getToken()) headers.Authorization = `Bearer ${getToken()}`;
    const res = await fetch(path, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    VIEW = data;
    lastGood = Date.now();
    render();
  } catch (e) {
    if (!VIEW) document.getElementById('board').innerHTML = `<div class="err">${esc(e.message)}${DEVICE ? '' : ' <br><br><a style="color:#fff" href="/index.html">Sign in</a>'}</div>`;
    else if (Date.now() - lastGood > 5 * 60000) { VIEW.stale = true; VIEW.lastError = e.message; render(); }
  }
}

function clockNow() {
  const tz = VIEW.timezone;
  const now = new Date();
  return {
    t: now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }),
    d: now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric' }),
  };
}
function asOf() {
  if (!VIEW.dataAsOf) return 'No data yet';
  return `Data as of ${new Date(VIEW.dataAsOf).toLocaleTimeString('en-US', { timeZone: VIEW.timezone, hour: 'numeric', minute: '2-digit' })}`;
}
function head(title) {
  const c = clockNow();
  const mins = VIEW.dataAsOf ? Math.round((Date.now() - new Date(VIEW.dataAsOf)) / 60000) : null;
  const stale = VIEW.stale ? `<div class="stale">⚠ ${esc(asOf())}${mins != null ? ` — SpotOn hasn't updated in ${mins} minutes.` : ' — the box hasn\'t sent anything.'} Numbers below may be behind.${VIEW.lastError ? ` (${esc(VIEW.lastError).slice(0, 80)})` : ''}</div>` : '';
  return `<div class="top"><div class="brand">${esc(VIEW.location)} · Kitchen <span class="tag">${title}</span></div>
    <div style="display:flex;gap:28px;align-items:center"><span class="asof${VIEW.stale ? ' late' : ''}">${esc(asOf())}</span><div class="clock"><div class="t">${esc(c.t)}</div><div class="d">${esc(c.d)}</div></div></div></div>${stale}`;
}

function tilesHtml(compact) {
  const f = VIEW.food; const l = VIEW.labor; const h = VIEW.hours;
  const foodBadge = f.soFar == null ? '<span class="badge na">NO DATA</span>' : f.onPace ? '<span class="badge hit">ON PACE</span>' : '<span class="badge over">BEHIND</span>';
  const laborBadge = l.pctProjected == null ? '<span class="badge na">—</span>' : l.hit ? '<span class="badge hit">HIT</span>' : '<span class="badge over">OVER</span>';
  const hoursBadge = !VIEW.scheduleKnown ? '<span class="badge na">NO SCHEDULE</span>' : h.over > 0.05 ? '<span class="badge over">OVER</span>' : '<span class="badge hit">ON PLAN</span>';
  const over = h.over > 0.05 ? `<span class="amber">+${h.over.toFixed(1)} hrs</span>` : `${h.over.toFixed(1)} hrs`;
  if (compact) {
    return `<div class="strip">
      <div class="tile"><div class="lbl">Food sales</div><div class="big">${money(f.soFar)}</div><div class="sub">of <b>${money(f.goal)}</b> goal</div></div>
      <div class="tile"><div class="lbl">Labor % at close</div>${laborBadge}<div class="big ${l.pctProjected == null ? 'dim' : l.hit ? 'blue' : 'amber'}">${l.pctProjected == null ? '—' : l.pctProjected + '%'}</div><div class="sub">goal <b>${l.goal}%</b></div></div>
      <div class="tile"><div class="lbl">Hours</div>${hoursBadge}<div class="big ${h.over > 0.05 ? 'amber' : ''}">${h.actual.toFixed(1)}</div><div class="sub">scheduled <b>${h.scheduledSoFar.toFixed(1)}</b> · ${over}</div></div>
      <div class="tile"><div class="lbl">Food cost</div><div class="big dim">—</div><div class="sub">Not set up yet</div></div>
    </div>`;
  }
  return `<div class="tiles">
    <div class="tile"><div class="lbl">Food sales</div>${foodBadge}
      <div class="big">${money(f.soFar)}</div><div class="sub">of <b>${money(f.goal)}</b> goal${f.pct != null ? ` · ${f.pct}%` : ''}</div>
      <div class="bar pace" style="--pace:${Math.round(f.paceFrac * 100)}%"><i style="width:${Math.min(100, f.pct || 0)}%"></i></div>
      <div class="sub" style="font-size:19px;margin-top:8px">White line = where we should be by now</div></div>
    <div class="tile"><div class="lbl">Labor % at close</div>${laborBadge}
      <div class="big ${l.pctProjected == null ? 'dim' : l.hit ? 'blue' : 'amber'}">${l.pctProjected == null ? '—' : l.pctProjected + '%'}</div><div class="sub">goal <b>${l.goal}%</b> or less · projected</div></div>
    <div class="tile"><div class="lbl">Hours so far</div>${hoursBadge}
      <div class="big ${h.over > 0.05 ? 'amber' : ''}">${h.actual.toFixed(1)}</div><div class="sub">scheduled <b>${h.scheduledSoFar.toFixed(1)}</b> · ${over}</div></div>
    <div class="tile"><div class="lbl">Food cost</div><span class="badge na">SOON</span><div class="big dim">—</div><div class="sub">Not set up yet</div></div>
  </div>`;
}

function screenA() {
  const on = VIEW.onClock.length ? VIEW.onClock.map((p) => `<tr><td class="n">${esc(p.name || 'Kitchen')}</td><td class="s">${esc(p.role || '')}</td><td class="t">${esc(p.inAt)}${p.offAt ? ` → ${esc(p.offAt)}` : ''}</td></tr>`).join('') : '<tr><td class="empty">Nobody clocked in</td></tr>';
  const off = VIEW.offPlan.length ? VIEW.offPlan.map((p) => `<tr><td class="n">${esc(p.name || 'Kitchen')}</td><td class="s">${esc(p.note)}</td><td class="t late">+${p.extraHours.toFixed(1)} h</td></tr>`).join('') : '';
  const notIn = VIEW.scheduledNotIn.map((p) => `<tr><td class="n">${esc(p.name || 'Scheduled')}</td><td class="s">${esc(p.slot)} · due ${esc(p.startAt)}</td><td class="t late">not in</td></tr>`).join('');
  const offBody = off || notIn ? off + notIn : `<tr><td class="empty">${VIEW.scheduleKnown ? 'Everyone on plan' : 'No kitchen schedule published for today'}</td></tr>`;
  const sc = VIEW.sevenCheck;
  const check = sc ? `<div class="check"><span class="k">7 PM CHECK</span><span>${money(sc.foodAt7)} by 7:00 PM — ${sc.keep ? 'above' : 'below'} the ${money(sc.line)} slow-night line.</span><span class="${sc.keep ? 'blue' : 'amber'}">${sc.keep ? 'KEEP THE SCHEDULE' : 'CUT NIGHT B EARLY'}</span></div>` : '';
  const week = VIEW.week.map((d) => `<div class="day ${d.state}"><div class="w">${d.day}</div><div class="p">${d.pct == null ? '—' : d.pct + '%'}</div><div class="r">${d.state === 'hit' ? 'HIT' : d.state === 'missed' ? 'MISSED' : d.state === 'live' ? '● LIVE' : '&nbsp;'}</div></div>`).join('');
  return head('Scoreboard') + tilesHtml(false) + `
    <div class="row2">
      <div class="panel"><h3><span>On the clock now · ${VIEW.onClock.length}</span><span>in → scheduled off</span></h3><table>${on}</table></div>
      <div class="panel"><h3><span>Off plan today</span><span>extra</span></h3><table>${offBody}</table></div>
    </div>${check}<div class="week">${week}</div><div class="dots"><span class="on"></span><span></span></div>`;
}

function screenB() {
  const hs = VIEW.hoursByHour;
  const max = Math.max(60, ...hs.map((h) => h.food || 0), ...hs.map((h) => h.expected || 0));
  const bars = hs.map((h) => `<div class="colbar ${h.food == null ? 'exp' : ''} ${h.current ? 'now' : ''}"><div class="v">${h.food != null ? '$' + h.food : h.expected != null ? '$' + h.expected : ''}</div><i style="height:${Math.round(((h.food != null ? h.food : h.expected || 0) / max) * 300)}px"></i></div>`).join('');
  const n = hs.length;
  return head('Hour by hour') + tilesHtml(true) + `
    <div class="chart" style="--n:${n}">
      <div class="cols" style="--n:${n}"><div class="rl">Food $</div>${bars}</div>
      <div class="cols" style="--n:${n};margin-top:6px"><div></div>${hs.map((h) => `<div class="hr ${h.current ? 'now' : ''}">${h.label}</div>`).join('')}</div>
      <div class="cols" style="--n:${n};margin-top:14px"><div class="rl">Planned cooks</div>${hs.map((h) => `<div class="cell plan ${h.food == null && !h.current ? 'dim' : ''}">${h.planned}</div>`).join('')}</div>
      <div class="cols" style="--n:${n}"><div class="rl">Actual cooks</div>${hs.map((h) => (h.actual == null ? '<div class="cell dim">·</div>' : `<div class="cell ${h.over ? 'over' : ''}">${h.actual}</div>`)).join('')}</div>
    </div>
    <div class="why">${VIEW.overNote ? `Where the hours went over: <b>${esc(VIEW.overNote)}</b>` : VIEW.scheduleKnown ? 'Cooks on vs planned, by hour.' : 'Publish today\'s kitchen schedule in Bar Ops to see planned cooks.'}</div>
    <div class="dots"><span></span><span class="on"></span></div>`;
}

function toolbar() {
  if (DEVICE) return '';
  const locs = (typeof getPerson === 'function' && getPerson()) ? (JSON.parse(localStorage.getItem('bp_locations') || '[]')) : [];
  const opts = locs.map((l) => `<option value="${esc(l.id)}" ${String(l.id) === String(LOCATION_ID) ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  return `<div class="toolbar">${opts ? `<select onchange="switchLocation(this.value)">${opts}</select>` : ''}<a href="/kitchen-board-settings.html${LOCATION_ID ? `?location_id=${encodeURIComponent(LOCATION_ID)}` : ''}">Settings</a><a href="/dashboard.html">Dashboard</a><button onclick="flip()">Flip</button></div>`;
}

function render() {
  if (!VIEW) return;
  document.getElementById('board').innerHTML = (SCREEN === 'A' ? screenA() : screenB()) + toolbar();
  fit();
  if (!flipTimer) flipTimer = setTimeout(() => { flipTimer = null; flip(); }, Math.max(10, VIEW.rotateSeconds || 45) * 1000);
}
function flip() { SCREEN = SCREEN === 'A' ? 'B' : 'A'; if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; } render(); }
function switchLocation(id) { LOCATION_ID = id; history.replaceState(null, '', `?location_id=${encodeURIComponent(id)}`); VIEW = null; load(); }

(async () => {
  if (!DEVICE && typeof getToken === 'function' && !getToken()) { location.href = '/index.html'; return; }
  if (!DEVICE && !LOCATION_ID) {
    try {
      const locs = await api('/api/locations');
      const list = Array.isArray(locs) ? locs : (locs.locations || []);
      localStorage.setItem('bp_locations', JSON.stringify(list.map((l) => ({ id: l.id, name: l.name }))));
      const p = getPerson();
      LOCATION_ID = (typeof initialLocationId === 'function' ? initialLocationId(p, list) : null) || (list[0] && list[0].id);
    } catch (e) { /* the view call will say */ }
  }
  await load();
  setInterval(load, 60000);
  setInterval(() => { if (VIEW) render(); }, 30000); // keep the clock moving
  if (DEVICE) { document.addEventListener('dblclick', () => document.documentElement.requestFullscreen && document.documentElement.requestFullscreen()); }
})();
