// Staff Lights tab (Sept 2026, Scotto's pick from the mockup): the Kasa
// plugs on the neon signs. Routines on the left with tonight's times and
// today's sunset/dusk; lights by group on the right with live on/off and
// watts. A tile that's ON but drawing ~0 W is a sign that's out (CHECK
// SIGN); a plug that doesn't answer is NO ANSWER, never drawn like OFF.
// Tapping a plug opens its sheet: ON / OFF / Blink to find, and its
// schedule (follow a routine, its own times, or none). Every OFF that
// covers more than one light is a hold. Local API only (agent/server.js
// /api/lights*), which the box answers without the internet.
let VIEW = null;
let SEL_ROUTINE = null;   // routine id whose lights are outlined
let SHEET = null;         // { id, draft } while a plug's sheet is open
let refreshTimer = null;
let clockTimer = null;
let toastTimer = null;

// ---- getting in: identical to the other staff pages (signed pass in #pass=, kept in localStorage)
const PASS_KEY = 'vc_staff_pass';
function readPassFromUrl() {
  const m = (location.hash || '').match(/[#&]pass=([^&]+)/);
  if (!m) return null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  return decodeURIComponent(m[1]);
}
function passInfo(pass) {
  try { return JSON.parse(atob(pass.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; }
}
function storedPass() {
  try {
    const p = localStorage.getItem(PASS_KEY) || '';
    const info = p ? passInfo(p) : null;
    return (info && info.exp > Date.now()) ? p : '';
  } catch (e) { return ''; }
}
function rememberPass(p) { try { localStorage.setItem(PASS_KEY, p); } catch (e) { /* private mode */ } }
function forgetPass() { try { localStorage.removeItem(PASS_KEY); } catch (e) { /* ignore */ } }
let STAFF_PASS = readPassFromUrl() || storedPass();
if (STAFF_PASS) rememberPass(STAFF_PASS);

function showGate(reason) {
  document.getElementById('pinGate').style.display = '';
  document.getElementById('app').style.display = 'none';
  const msg = document.getElementById('pinMsg');
  if (msg) msg.innerHTML = reason ? `<div class="msg error">${escapeHtml(reason)}</div>` : '';
  fetch('/api/status').then((r) => r.json()).then((s) => {
    const a = document.getElementById('openFromApp');
    if (a && s.cloudUrl) a.href = s.cloudUrl.replace(/\/$/, '') + '/tv-staff.html';
  }).catch(() => {});
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-staff-pass': STAFF_PASS, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { forgetPass(); STAFF_PASS = ''; showGate('Your TV session has ended. Open TV Staff from the Bar Ops app again.'); }
  if (!res.ok) throw new Error(data.error || data.message || `${res.status} ${res.statusText}`);
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function enter() {
  if (!STAFF_PASS) return showGate('');
  api('/api/lights').then((v) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    VIEW = v;
    render();
    updateTopbarClock();
    clearInterval(clockTimer); clockTimer = setInterval(updateTopbarClock, 15000);
    clearInterval(refreshTimer); refreshTimer = setInterval(refresh, 5000);
  }).catch((e) => {
    forgetPass();
    STAFF_PASS = '';
    showGate(/PASS_REQUIRED|401/.test(e.message) ? 'Your TV session has ended. Open TV Staff from the Bar Ops app again.' : e.message);
  });
}
enter();

async function refresh() {
  try { VIEW = await api('/api/lights'); render(); } catch (e) { /* keep the last picture; the gate handles 401 */ }
}

function updateTopbarClock() {
  const now = new Date();
  const day = document.getElementById('tbDay');
  if (!day) return;
  day.textContent = now.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
  document.getElementById('tbTime').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  document.getElementById('tbDate').textContent = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function toast(text, bad) {
  const el = document.getElementById('ltToast');
  el.textContent = text;
  el.className = `lt-toast${bad ? ' bad' : ''}`;
  el.style.display = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ---- time words -------------------------------------------------------------
const TZ = () => (VIEW && VIEW.timezone) || undefined;
function clock(iso, short) {
  if (!iso) return '—';
  const s = new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ(), hour: 'numeric', minute: '2-digit' });
  return short ? s.replace(':00 ', ' ').replace(' AM', 'A').replace(' PM', 'P') : s;
}
function inWords(iso) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
const KIND_WORD = { time: '', sunrise: 'Sunrise', sunset: 'Sunset', dawn: 'Dawn', dusk: 'Dusk', none: '—' };
function whenLabel(part) {
  // part: { kind, time, offset, at }
  if (!part || part.kind === 'none') return { big: '—', small: '' };
  if (part.kind === 'time') return { big: clock(part.at) !== '—' ? clock(part.at) : to12(part.time), small: '' };
  const off = Number(part.offset) || 0;
  return { big: `${KIND_WORD[part.kind]}${off ? ` ${off < 0 ? '−' : '+'}${Math.abs(off)}` : ''}`, small: part.at ? clock(part.at) : '' };
}
function to12(hhmm) {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function daysWord(days) {
  const d = (days || []).slice().sort();
  if (d.length === 7) return 'Every day';
  if (d.join() === '1,2,3,4,5') return 'Weekdays';
  if (d.join() === '0,6') return 'Weekends';
  return d.map((x) => DAY_SHORT[x]).join(' · ');
}

// ---- render ---------------------------------------------------------------------
function render() {
  if (!VIEW) return;
  renderRail();
  renderMain();
  if (SHEET) renderSheet();
}

function renderRail() {
  const v = VIEW;
  const sun = v.sun;
  document.getElementById('ltRail').innerHTML = `
    <div class="lt-head"><span class="lt-title">Routines</span><span class="sp"></span><span class="lt-sum">${v.routines.length} routine${v.routines.length === 1 ? '' : 's'}</span></div>
    ${sun ? `<div class="lt-sun"><span>☀ Sunset <b>${clock(sun.sunset)}</b></span><span class="dusk">☾ Dusk <b>${clock(sun.dusk)}</b></span></div>` : ''}
    <div class="lt-rscroll">
      ${v.routines.length ? v.routines.map(routineCard).join('') : '<p class="muted" style="padding:6px 4px;">No routines yet. They’re set up in TV Admin → Lights.</p>'}
    </div>
    <div class="lt-rail-foot">Tap a routine to see its lights. Routines are set up in TV Admin.</div>`;
}

function routineCard(r) {
  const on = whenLabel(r.on);
  const off = whenLabel(r.off);
  let next = r.enabled ? '' : 'Paused';
  if (r.enabled) {
    const soonest = [['ON', r.next_on], ['OFF', r.next_off]].filter((x) => x[1]).sort((a, b) => new Date(a[1]) - new Date(b[1]))[0];
    if (soonest) {
      const d = new Date(soonest[1]);
      next = d - Date.now() < 24 * 3600 * 1000
        ? `${soonest[0]} at ${clock(soonest[1])} · in <b>${inWords(soonest[1])}</b>`
        : `Next: ${d.toLocaleDateString('en-US', { timeZone: TZ(), weekday: 'short' })} ${soonest[0]} at ${clock(soonest[1])}`;
    }
  }
  return `<div class="lt-rt ${SEL_ROUTINE === r.id ? 'sel' : ''} ${r.enabled ? '' : 'paused'}" data-act="routine" data-id="${r.id}">
    <div class="top"><span class="nm">${escapeHtml(r.name)}</span><span class="cnt">${r.count} light${r.count === 1 ? '' : 's'}</span></div>
    <div class="days">${escapeHtml(daysWord(r.days))}${r.enabled ? '' : ' · paused'}</div>
    <div class="times">
      <div class="lt-t on"><div class="k">On</div><div class="v">${escapeHtml(on.big)}</div><div class="r">${escapeHtml(on.small || ' ')}</div></div>
      <div class="lt-t off"><div class="k">Off</div><div class="v">${escapeHtml(off.big)}</div><div class="r">${escapeHtml(off.small || ' ')}</div></div>
    </div>
    <div class="next"><span>${next}</span><span class="sp"></span>
      ${r.enabled && r.count ? `<button class="lt-mini on" data-act="run-on" data-id="${r.id}">Run ON</button><button class="lt-mini off hold-danger" data-hold-action="run-off" data-id="${r.id}"><span class="hold-fill"></span><span class="hold-label">Run OFF</span></button>` : ''}</div>
  </div>`;
}

function plugState(p) {
  if (!p.reachable) return 'nr';
  if (p.dead) return 'warn';
  return p.on ? 'on' : 'off';
}

function scheduleLines(p) {
  if (p.manual && p.manual.until) return [`<span class="man">Manual ${p.manual.on ? 'on' : 'off'}</span>`, `<span class="tm">until ${clock(p.manual.until, true)}</span>`];
  const times = p.on_at || p.off_at ? `${p.on_at ? clock(p.on_at, true) : '—'}–${p.off_at ? clock(p.off_at, true) : '—'}` : 'not today';
  if (p.schedule_mode === 'routine' && p.routine_name) return [`<span class="rn">${escapeHtml(p.routine_name)}</span>`, `<span class="tm">${times}</span>`];
  if (p.schedule_mode === 'own') return ['<span class="own">Own schedule</span>', `<span class="tm">${times}</span>`];
  if (p.manual) return [`<span class="man">Manual ${p.manual.on ? 'on' : 'off'}</span>`, '<span class="tm">no schedule</span>'];
  return ['<span class="tm">No schedule</span>', ''];
}

function renderMain() {
  const plugs = VIEW.plugs;
  const groups = [];
  for (const p of plugs) {
    let g = groups.find((x) => x.name === p.group);
    if (!g) { g = { name: p.group, plugs: [] }; groups.push(g); }
    g.plugs.push(p);
  }
  const on = plugs.filter((p) => p.reachable && p.on).length;
  const off = plugs.filter((p) => p.reachable && !p.on).length;
  const dead = plugs.filter((p) => p.dead).length;
  const nr = plugs.filter((p) => !p.reachable).length;
  const watts = plugs.reduce((s, p) => s + (p.reachable && p.watts ? p.watts : 0), 0);
  const selIds = SEL_ROUTINE ? new Set(plugs.filter((p) => p.schedule_mode === 'routine' && Number(p.routine_id) === SEL_ROUTINE).map((p) => p.id)) : null;
  document.getElementById('ltMain').innerHTML = `
    <div class="lt-head">
      <span class="lt-title">Lights</span><span class="sp"></span>
      <span class="lt-sum"><b>${on} on</b> · ${off} off${dead || nr ? ` · <span class="bad">${[dead ? `${dead} check sign` : '', nr ? `${nr} no answer` : ''].filter(Boolean).join(' · ')}</span>` : ''} · <span class="w">${Math.round(watts)} W</span></span>
    </div>
    <div class="lt-scroll">
      ${groups.length ? groups.map((g) => {
        const gOn = g.plugs.filter((p) => p.reachable && p.on).length;
        return `<div class="lt-group">
          <div class="lt-gh"><span class="gn">${escapeHtml(g.name)}</span><span class="gs"><b>${gOn}</b> / ${g.plugs.length} on</span><span class="sp"></span>
            <button class="lt-mini on" data-act="group-on" data-group="${escapeHtml(g.name)}">ALL ON</button>
            <button class="lt-mini off hold-danger" data-hold-action="group-off" data-group="${escapeHtml(g.name)}"><span class="hold-fill"></span><span class="hold-label">ALL OFF <span class="hold-chip">HOLD</span></span></button>
          </div>
          <div class="lt-grid">${g.plugs.map((p) => {
            const st = plugState(p);
            const word = st === 'nr' ? 'NO ANSWER' : st === 'warn' ? 'CHECK SIGN' : (p.on ? 'ON' : 'OFF');
            const w = st === 'warn' ? '0 W' : (p.reachable && p.on && p.watts !== null ? `${Math.round(p.watts)} W` : '');
            const [l1, l2] = scheduleLines(p);
            return `<div class="lt-tile ${st} ${selIds && selIds.has(p.id) ? 'hl' : ''}" data-act="plug" data-id="${p.id}">
              <span class="bulb"></span>
              <div class="nm">${escapeHtml(p.name)}</div>
              <div class="st"><span class="s">${word}</span>${w ? `<span class="w">${w}</span>` : ''}</div>
              <div class="sch">${l1}${l2}</div>
            </div>`;
          }).join('')}</div>
        </div>`;
      }).join('') : `<div class="lt-empty">No lights set up yet.<br><span class="muted">Plugs are found and named in TV Admin → Lights (use Blink to see which sign is which).</span></div>`}
    </div>`;
}

// ---- the plug sheet -------------------------------------------------------------
function openSheet(id) {
  const p = VIEW.plugs.find((x) => x.id === id);
  if (!p) return;
  const own = p.own || {};
  SHEET = {
    id,
    draft: {
      mode: p.schedule_mode,
      routineId: p.routine_id || (VIEW.routines[0] && VIEW.routines[0].id) || null,
      days: own.days && own.days.length ? own.days.slice() : [0, 1, 2, 3, 4, 5, 6],
      onKind: ['time', 'sunset', 'dusk'].includes(own.on_kind) ? own.on_kind : 'dusk',
      onTime: own.on_time || '18:00', onOffset: own.on_offset_min || 0,
      offKind: ['time', 'sunrise', 'dawn'].includes(own.off_kind) ? own.off_kind : 'time',
      offTime: own.off_time || '02:15', offOffset: own.off_offset_min || 0,
    },
  };
  renderSheet();
}
function closeSheet() { SHEET = null; document.getElementById('ltSheet').innerHTML = ''; }

function seg(options, value, act) {
  return `<div class="lt-seg sm">${options.map(([v, label]) => `<div class="${v === value ? 'sel' : ''}" data-act="${act}" data-v="${v}">${label}</div>`).join('')}</div>`;
}
function whenValue(which) {
  const d = SHEET.draft;
  const kind = which === 'on' ? d.onKind : d.offKind;
  if (kind === 'time') return `<input type="time" class="lt-val-in" data-act="time-${which}" value="${escapeHtml(which === 'on' ? d.onTime : d.offTime)}">`;
  const off = which === 'on' ? d.onOffset : d.offOffset;
  return `<div class="lt-step"><button data-act="step-${which}" data-v="-5">−</button><span>${off === 0 ? 'on time' : `${off < 0 ? '−' : '+'}${Math.abs(off)} min`}</span><button data-act="step-${which}" data-v="5">+</button></div>`;
}

function renderSheet() {
  const p = VIEW.plugs.find((x) => x.id === SHEET.id);
  if (!p) return closeSheet();
  const d = SHEET.draft;
  const st = plugState(p);
  const chip = st === 'nr' ? '<span class="lt-chip nr">NO ANSWER</span>' : st === 'warn' ? '<span class="lt-chip warn">ON · 0 W</span>' : `<span class="lt-chip ${p.on ? 'on' : ''}">${p.on ? `ON${p.watts !== null ? ` · ${Math.round(p.watts)} W` : ''}` : 'OFF'}</span>`;
  const following = p.schedule_mode === 'routine' && p.routine_name ? `Following <b class="rn">${escapeHtml(p.routine_name)}</b>.` : p.schedule_mode === 'own' ? 'On its own schedule.' : 'No schedule.';
  document.getElementById('ltSheet').innerHTML = `
  <div class="lt-scrim" data-act="scrim"><div class="lt-sheet" data-act="sheet">
    <div class="h"><span class="t">${escapeHtml(p.name)}</span><span class="lt-chip">${escapeHtml(p.group)}</span>${chip}</div>
    <div class="now">${following} A tap on ON or OFF holds until the next scheduled time.</div>
    <div class="lt-big">
      <button class="on" data-act="sheet-on">TURN ON</button>
      <button class="off" data-act="sheet-off">TURN OFF</button>
      <button class="id" data-act="sheet-blink">Blink to find</button>
    </div>
    <div class="lt-sec">Schedule</div>
    <div class="lt-seg">${[['routine', 'Follow a routine'], ['own', 'Own schedule'], ['none', 'No schedule']].map(([v, l]) => `<div class="${d.mode === v ? 'sel' : ''}" data-act="mode" data-v="${v}">${l}</div>`).join('')}</div>
    ${d.mode === 'routine' ? `
      <div class="lt-routines">${VIEW.routines.length ? VIEW.routines.map((r) => `<div class="lt-rchip ${Number(d.routineId) === r.id ? 'sel' : ''}" data-act="pick-routine" data-v="${r.id}"><b>${escapeHtml(r.name)}</b><span>${escapeHtml(whenLabel(r.on).big)} → ${escapeHtml(whenLabel(r.off).big)} · ${escapeHtml(daysWord(r.days))}</span></div>`).join('') : '<p class="muted">No routines yet. Set them up in TV Admin → Lights.</p>'}</div>` : ''}
    ${d.mode === 'own' ? `
      <div class="lt-row"><span class="lb on">ON</span>${seg([['time', 'Time'], ['sunset', 'Sunset'], ['dusk', 'Dusk']], d.onKind, 'on-kind')}${whenValue('on')}</div>
      <div class="lt-row"><span class="lb off">OFF</span>${seg([['time', 'Time'], ['sunrise', 'Sunrise'], ['dawn', 'Dawn']], d.offKind, 'off-kind')}${whenValue('off')}</div>
      <div class="lt-sec">Days</div>
      <div class="lt-days">${DAY_LETTERS.map((l, i) => `<div class="${d.days.includes(i) ? 'sel' : ''}" data-act="day" data-v="${i}">${l}</div>`).join('')}</div>` : ''}
    <div class="lt-foot"><button class="cancel" data-act="sheet-close">Close</button><button class="save" data-act="sheet-save">Save schedule</button></div>
  </div></div>`;
}

async function saveSchedule() {
  const d = SHEET.draft;
  const schedule = d.mode === 'routine'
    ? { mode: 'routine', routineId: d.routineId }
    : d.mode === 'own'
      ? { mode: 'own', days: d.days, onKind: d.onKind, onTime: d.onTime, onOffset: d.onOffset, offKind: d.offKind, offTime: d.offTime, offOffset: d.offOffset }
      : { mode: 'none' };
  try {
    const r = await api(`/api/lights/${SHEET.id}/schedule`, { method: 'POST', body: JSON.stringify({ schedule }) });
    if (r.view) VIEW = r.view;
    closeSheet();
    render();
    toast('Schedule saved.');
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- actions ----------------------------------------------------------------------
async function power(body, label) {
  try {
    const r = await api('/api/lights/power', { method: 'POST', body: JSON.stringify(body) });
    if (r.view) { VIEW = r.view; render(); }
    toast(r.ok ? `${label} ${body.on ? 'on' : 'off'}.` : `Couldn’t reach: ${r.failed.join(', ')}`, !r.ok);
  } catch (e) { toast(e.message, true); }
}
async function runRoutine(id, on) {
  const r0 = VIEW.routines.find((r) => r.id === id);
  try {
    const r = await api(`/api/lights/routines/${id}/run`, { method: 'POST', body: JSON.stringify({ on }) });
    if (r.view) { VIEW = r.view; render(); }
    toast(r.ok ? `${r0 ? r0.name : 'Routine'} ${on ? 'on' : 'off'}.` : `Couldn’t reach: ${r.failed.join(', ')}`, !r.ok);
  } catch (e) { toast(e.message, true); }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.hold-danger')) return; // holds fire on their own timer
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.getAttribute('data-act');
  const id = Number(el.getAttribute('data-id'));
  const v = el.getAttribute('data-v');
  const d = SHEET && SHEET.draft;
  switch (act) {
    case 'all-on': return power({ all: true, on: true }, 'All lights');
    case 'group-on': return power({ group: el.getAttribute('data-group'), on: true }, el.getAttribute('data-group'));
    case 'routine': SEL_ROUTINE = SEL_ROUTINE === id ? null : id; return render();
    case 'run-on': e.stopPropagation(); return runRoutine(id, true);
    case 'plug': return openSheet(id);
    case 'scrim': if (e.target === el) closeSheet(); return undefined;
    case 'sheet-close': return closeSheet();
    case 'sheet-on': case 'sheet-off': {
      const p = VIEW.plugs.find((x) => x.id === SHEET.id);
      return power({ ids: [SHEET.id], on: act === 'sheet-on' }, p ? p.name : 'Light');
    }
    case 'sheet-blink':
      toast('Blinking twice…');
      return api(`/api/lights/${SHEET.id}/blink`, { method: 'POST' }).then(() => toast('Done.')).catch((err) => toast(err.message, true));
    case 'mode': d.mode = v; return renderSheet();
    case 'pick-routine': d.routineId = Number(v); return renderSheet();
    case 'on-kind': d.onKind = v; return renderSheet();
    case 'off-kind': d.offKind = v; return renderSheet();
    case 'step-on': d.onOffset = Math.max(-240, Math.min(240, d.onOffset + Number(v))); return renderSheet();
    case 'step-off': d.offOffset = Math.max(-240, Math.min(240, d.offOffset + Number(v))); return renderSheet();
    case 'day': {
      const n = Number(v);
      d.days = d.days.includes(n) ? d.days.filter((x) => x !== n) : [...d.days, n].sort();
      return renderSheet();
    }
    case 'sheet-save': return saveSchedule();
    default: return undefined;
  }
});
document.addEventListener('change', (e) => {
  const act = e.target.getAttribute && e.target.getAttribute('data-act');
  if (!SHEET) return;
  if (act === 'time-on') SHEET.draft.onTime = e.target.value;
  if (act === 'time-off') SHEET.draft.offTime = e.target.value;
});

// ---- press-and-hold (every OFF that covers more than one light) --------------
const HOLD_MS = 900;
let holdState = null;
function holdFire(btn) {
  const action = btn.getAttribute('data-hold-action');
  if (action === 'all-off') return power({ all: true, on: false }, 'All lights');
  if (action === 'group-off') return power({ group: btn.getAttribute('data-group'), on: false }, btn.getAttribute('data-group'));
  if (action === 'run-off') return runRoutine(Number(btn.getAttribute('data-id')), false);
  return null;
}
function holdStart(btn) {
  holdCancel();
  if (btn.disabled) return;
  const fill = btn.querySelector('.hold-fill');
  const startedAt = performance.now();
  function step(now) {
    const pct = Math.min(1, (now - startedAt) / HOLD_MS);
    if (fill) fill.style.width = `${pct * 100}%`;
    if (pct >= 1) {
      holdState = null;
      if (fill) fill.style.width = '0%';
      holdFire(btn);
      return;
    }
    holdState.raf = requestAnimationFrame(step);
  }
  holdState = { btn, raf: requestAnimationFrame(step) };
}
function holdCancel() {
  if (!holdState) return;
  cancelAnimationFrame(holdState.raf);
  const fill = holdState.btn.querySelector('.hold-fill');
  if (fill) fill.style.width = '0%';
  holdState = null;
}
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.hold-danger');
  if (btn) { e.preventDefault(); e.stopPropagation(); holdStart(btn); }
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => document.addEventListener(ev, () => holdCancel()));
