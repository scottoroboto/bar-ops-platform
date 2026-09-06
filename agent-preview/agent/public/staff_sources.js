// Staff Sources tab (docs/venue-control.md §10/§12 Phase 2: "staff Sources
// tab"). Talks only to this agent's own local API (/api/sources,
// /api/favorites), never straight to a receiver from the browser and never
// to Supabase -- same "local UI, local API" shape as discovery.js.
let STAFF_PIN = '';
let SOURCES = [];
let FAVORITES = [];
let TVS = [];
let refreshTimer = null;

function submitPin() {
  STAFF_PIN = document.getElementById('pinInput').value;
  // GET /api/sources is harmless and always returns 200 (an empty array is
  // still success), so a clean response here is proof the PIN was accepted.
  api('/api/sources').then((sources) => {
    document.getElementById('pinGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    SOURCES = sources;
    renderSources();
    fillSourceTitles();
    loadFavorites();
    loadTvs();
    updateTopbarClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(updateTopbarClock, 15000);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshSources, 15000); // matches the agent poller's own 15s cadence
  }).catch(() => {
    document.getElementById('pinMsg').innerHTML = '<div class="msg error">Incorrect PIN.</div>';
  });
}

let clockTimer = null;

// Topbar clock (screens/01-staff-sources.html's header) -- pure client-side
// display, no server round-trip. Updated on the same cadence as everything
// else on this page rather than every second; a bar's channel-control
// screen doesn't need a ticking seconds display.
function updateTopbarClock() {
  const now = new Date();
  const day = document.getElementById('tbDay');
  const time = document.getElementById('tbTime');
  const date = document.getElementById('tbDate');
  if (!day) return;
  day.textContent = now.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
  time.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  date.textContent = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
document.getElementById('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-staff-pin': STAFF_PIN, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshSources() {
  try {
    SOURCES = await api('/api/sources');
    // Also refresh TV state on this same 15s cadence now that the card grid
    // shows a live "N TVs" count on every source (not just the channel
    // picker's on-demand blast radius, which is all loadTvs() was used for
    // before this round) -- best-effort, a stale count just lags one tick.
    loadTvs();
    renderSources();
    fillSourceTitles(); // progressive, doesn't block the render above
    if (REMOTE_SLOT != null) renderRemoteStage(); // keep the remote's dimmed stage current while it's open
  } catch (e) {
    // A transient failure here shouldn't yank the page out from under
    // someone mid-tap -- just leave the last-known state showing.
  }
}

// Read-only, used only to compute blast radius (how many TVs would be
// affected by re-tuning a given receiver) -- never used to control TVs from
// this page. Failing quietly here just means the blast-radius line doesn't
// show; it never blocks channel changes.
async function loadTvs() {
  try {
    TVS = await api('/api/tvs');
  } catch (e) { /* blast radius just won't show a count */ }
}

// Mirrors tvs.js's currentSourceInfo(t): a TV's live.slot (the last slot the
// system actually *commanded* it to, not a verified readback -- Samsung has
// no "what's the tuner showing" endpoint, §7.2) is the source of truth when
// present; default_source_slot is the fallback before that's ever been set,
// labeled unconfirmed so staff don't mistake a guess for a fact.
function currentSourceInfo(t) {
  if (t.live && t.live.slot != null) return { slot: Number(t.live.slot), confirmed: true };
  if (t.default_source_slot != null) return { slot: Number(t.default_source_slot), confirmed: false };
  return { slot: null, confirmed: false };
}

function tvsOnSlot(slot) {
  return TVS.filter((t) => currentSourceInfo(t).slot === Number(slot));
}

// Blast radius shown before the tap (§6), not after -- this is what stops
// someone from re-tuning a receiver and only afterward realizing it also
// feeds four other TVs.
function blastRadiusHtml(slot) {
  const tvs = tvsOnSlot(slot);
  if (!tvs.length) return '';
  const unconfirmed = tvs.filter((t) => !currentSourceInfo(t).confirmed).length;
  const names = tvs.map((t) => escapeHtml(t.name)).join(', ');
  const note = unconfirmed ? ` <span class="muted">(${unconfirmed} unconfirmed)</span>` : '';
  return `<div class="blast-radius">Changing this affects <span class="count">${tvs.length} TV${tvs.length === 1 ? '' : 's'}</span> right now: ${names}${note}</div>`;
}

// ---------------------------------------------------------------------
// Card grid (screens/01-staff-sources.html). Every card taps to the same
// controls the old plain list used (Channels…/Apps…/Remote… below), just
// reached by tapping the card itself instead of a row of small buttons --
// Guide/Info/the numeric keypad still live inside the channel picker
// overlay, nothing lost, see cardTap() below for the exact per-kind mapping.
//
// Two things the original design mockup showed that real hardware can't
// back up, dropped rather than faked (per Scotto's own call): the
// team-matchup-style game titles (real DirecTV/Roku only ever report a
// program/app title, never a formatted "Team A at Team B"), and the
// time-remaining progress bar (would need a live game clock this system
// has no source for). Everything else -- the card states, the branded
// header, the per-source "N TVs" count -- is real data, not illustrative.
// ---------------------------------------------------------------------

// slot -> { title, callsign } from /api/sources/:slot/proginfo, kept across
// refreshes so the headline doesn't flash blank every 15s -- only replaced
// once a fresher answer actually comes back (same "keep last-known" spirit
// as poller.js's own unreachable handling).
const SOURCE_TITLES = new Map();
let titleFillToken = 0;

// Only worth asking for a title when there's a real live tuned channel to
// ask about -- unreachable/asleep/roku/static/spare all skip this and use
// whatever their card state already shows instead.
async function fillSourceTitles() {
  const myToken = ++titleFillToken;
  const targets = SOURCES.filter((s) => s.kind === 'directv' && s.live && s.live.ok && s.live.active !== false && s.live.major != null);
  // Different receivers are independent (same reasoning as bulk/tune) --
  // fire every receiver's proginfo call in parallel; each one still queues
  // behind that one receiver's own SHEF gap internally.
  await Promise.all(targets.map(async (s) => {
    try {
      const info = await api(`/api/sources/${s.slot}/proginfo?major=${encodeURIComponent(s.live.major)}${s.live.minor != null ? `&minor=${encodeURIComponent(s.live.minor)}` : ''}`);
      if (myToken !== titleFillToken) return; // a newer refresh cycle started
      SOURCE_TITLES.set(Number(s.slot), { title: info && info.title, callsign: info && info.callsign });
    } catch (e) {
      // Leave whatever title this slot already had -- a blank/failed
      // proginfo call shouldn't blank out a headline that was showing fine
      // a moment ago.
    }
  }));
  if (myToken === titleFillToken) renderSources();
}

function formatChannel(live) {
  if (!live || live.major == null) return '';
  return `${live.major}${live.minor != null ? '.' + live.minor : ''}`;
}

function formatLastSeen(iso) {
  if (!iso) return 'not yet seen';
  return `last seen ${new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function tvCountLabel(slot, alert) {
  const n = tvsOnSlot(slot).length;
  if (alert) return n ? `${n} TV${n === 1 ? '' : 's'} affected` : 'no TVs affected';
  if (!n) return 'no TVs';
  return `${n} TV${n === 1 ? '' : 's'}`;
}

// One card's full render, branching on kind + live state. Every branch
// returns { stateClass, tapHandler, body } so the shared card shell (badge +
// tv-count top row) only has to be written once.
function sourceCardHtml(s) {
  const slot = Number(s.slot);
  const tvCount = tvsOnSlot(slot).length;

  if (s.kind === 'spare') {
    return `
      <div class="source-card sc-open no-tap">
        <span class="sc-slot">${escapeHtml(s.qam_channel)}</span>
        <div class="sc-headline">Open slot</div>
        <span class="sc-sub">nothing connected</span>
      </div>`;
  }

  if (s.kind === 'static') {
    return `
      <div class="source-card sc-static no-tap">
        <div class="sc-top"><span class="sc-slot">${escapeHtml(s.qam_channel)}</span><span class="sc-count">${tvCountLabel(slot, false)}</span></div>
        <div class="sc-headline">${escapeHtml(s.label)}</div>
        ${s.notes ? `<div class="sc-meta"><span class="sc-callsign">${escapeHtml(s.notes)}</span></div>` : '<div></div>'}
      </div>`;
  }

  const live = s.live;

  if (s.kind === 'directv') {
    if (!live || !live.ok) {
      return `
        <button type="button" class="source-card sc-alert" onclick="cardTap(${slot}, '${s.kind}')" title="Tap to check again">
          <div class="sc-top"><span class="sc-slot">${escapeHtml(s.qam_channel)}</span><span class="sc-count">${tvCountLabel(slot, true)}</span></div>
          <div class="sc-headline"><span class="sc-dot"></span>Not responding</div>
          <div class="sc-meta"><span class="sc-callsign">${escapeHtml(s.label)}</span><span class="sc-sub">${formatLastSeen(live && live.lastOkAt)}</span></div>
        </button>`;
    }
    if (live.active === false) {
      return `
        <button type="button" class="source-card sc-asleep" onclick="cardTap(${slot}, '${s.kind}')" title="Tap to wake">
          <div class="sc-top"><span class="sc-slot">${escapeHtml(s.qam_channel)}</span><span class="sc-count">${tvCountLabel(slot, false)}</span></div>
          <div class="sc-headline">Asleep</div>
          <div class="sc-meta"><span class="sc-callsign">${escapeHtml(s.label)}</span><span class="sc-sub">tap to wake</span></div>
        </button>`;
    }
    const t = SOURCE_TITLES.get(slot) || {};
    const headline = t.title || s.label;
    const callsign = t.callsign || s.label;
    return `
      <button type="button" class="source-card" onclick="cardTap(${slot}, '${s.kind}')">
        <div class="sc-top"><span class="sc-slot">${escapeHtml(s.qam_channel)}</span><span class="sc-count">${tvCountLabel(slot, false)}</span></div>
        <div class="sc-headline">${escapeHtml(headline)}</div>
        <div class="sc-meta"><span class="sc-callsign">${escapeHtml(callsign)}</span><span class="sc-sub">${escapeHtml(formatChannel(live))}</span></div>
      </button>`;
  }

  // roku
  if (!live || !live.ok) {
    return `
      <button type="button" class="source-card sc-alert" onclick="cardTap(${slot}, '${s.kind}')" title="Tap to check again">
        <div class="sc-top"><span class="sc-slot roku">${escapeHtml(s.qam_channel)}</span><span class="sc-count">${tvCountLabel(slot, true)}</span></div>
        <div class="sc-headline"><span class="sc-dot"></span>Not responding</div>
        <div class="sc-meta"><span class="sc-callsign">${escapeHtml(s.label)}</span><span class="sc-sub">${formatLastSeen(live && live.lastOkAt)}</span></div>
      </button>`;
  }
  if (live.appId == null) {
    return `
      <button type="button" class="source-card sc-idle" onclick="cardTap(${slot}, '${s.kind}')">
        <div class="sc-top"><span class="sc-slot roku">${escapeHtml(s.qam_channel)}</span><span class="sc-count">${tvCountLabel(slot, false)}</span></div>
        <div class="sc-headline">Idle</div>
        <div class="sc-meta"><span class="sc-callsign roku">${escapeHtml(s.label)}</span><span class="sc-sub">home screen</span></div>
      </button>`;
  }
  return `
    <button type="button" class="source-card" onclick="cardTap(${slot}, '${s.kind}')">
      <div class="sc-top"><span class="sc-slot roku">${escapeHtml(s.qam_channel)}</span><span class="sc-count">${tvCountLabel(slot, false)}</span></div>
      <div class="sc-headline">${escapeHtml(live.appName || `App ${live.appId}`)}</div>
      <div class="sc-meta"><span class="sc-callsign roku">${escapeHtml(s.label)}</span><span class="sc-sub">streaming</span></div>
    </button>`;
}

// Primary tap action per kind/state (round 4, 2026-09-06: a live card now
// opens the full remote directly -- Scotto's explicit "when user clicks on
// a source device, it opens the full remote for that device" -- replacing
// the old channel-picker-first / apps-dialog-first behavior below). Asleep
// and not-responding taps are unchanged: those still wake/recheck inline
// rather than opening a remote for a device that isn't actually up yet.
function cardTap(slot, kind) {
  const s = SOURCES.find((x) => Number(x.slot) === Number(slot));
  if (!s) return;
  if (kind === 'directv') {
    if (!s.live || !s.live.ok) { refreshSources(); return; } // not responding -- tap rechecks now instead of waiting for the next 15s tick
    if (s.live.active === false) { sendKey(slot, 'poweron').then(() => setTimeout(refreshSources, 800)); return; } // asleep -- tap to wake
    openRemote(slot);
    return;
  }
  // roku
  if (!s.live || !s.live.ok) { refreshSources(); return; }
  openRemote(slot);
}

function renderSources() {
  document.getElementById('refreshedAt').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  const box = document.getElementById('sourcesBox');
  if (!SOURCES.length) { box.innerHTML = '<p class="muted">No sources configured yet. Add one from TSB Platform: Venue Control &rarr; Sources.</p>'; return; }
  box.innerHTML = SOURCES.map(sourceCardHtml).join('');
}

async function sendKey(slot, key) {
  try {
    await api(`/api/sources/${slot}/key`, { method: 'POST', body: JSON.stringify({ key }) });
  } catch (e) {
    alert(e.message);
  }
}

let ROKU_APPS_SLOT = null;

async function openRokuApps(slot) {
  ROKU_APPS_SLOT = slot;
  document.getElementById('rokuAppsMsg').innerHTML = '';
  document.getElementById('rokuAppsGrid').innerHTML = '<p class="muted">Loading…</p>';
  document.getElementById('rokuAppsDialog').showModal();
  try {
    const { apps } = await api(`/api/sources/${slot}/apps`);
    if (!apps.length) {
      document.getElementById('rokuAppsGrid').innerHTML = '<p class="muted">No apps reported by this Roku.</p>';
      return;
    }
    document.getElementById('rokuAppsGrid').innerHTML = apps.map((a) => `
      <button class="fav-btn" onclick="launchRokuApp('${a.id}')">${escapeHtml(a.name)}</button>
    `).join('');
  } catch (e) {
    document.getElementById('rokuAppsGrid').innerHTML = '';
    document.getElementById('rokuAppsMsg').innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}

async function launchRokuApp(appId) {
  try {
    await api(`/api/sources/${ROKU_APPS_SLOT}/launch`, { method: 'POST', body: JSON.stringify({ appId }) });
    document.getElementById('rokuAppsDialog').close();
    await refreshSources();
  } catch (e) {
    document.getElementById('rokuAppsMsg').innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------
// Device-matched remote panels (screens/03-staff-remote-directv.html,
// screens/04-staff-remote-roku.html). Bound to one source (REMOTE_SLOT) at
// a time. Every button here sends exactly one real key over the same
// POST /api/sources/:slot/key route the channel picker's Guide/Info buttons
// already use (server.js dispatches DirecTV SHEF vs. Roku ECP by kind) --
// no new backend endpoint needed for either remote.
// ---------------------------------------------------------------------
let REMOTE_SLOT = null;
let REMOTE_KIND = null; // 'directv' | 'roku' -- which kind of device this remote is bound to, so the stage only ever shows "their devices" (Scotto's explicit instruction), never a mixed grid.

// Real SHEF key names (DirecTV's documented /remote/processKey vocabulary --
// same list agent/lib/drivers/directv.js's processKey() passes straight
// through as a query param, no translation layer needed here).
//
// Round 4 (2026-09-06) changes per Scotto's mockup-approval round:
//  - Rec button removed, Ffwd relabeled "Fwd" (still sends the real 'ffwd'
//    key -- only the button's label changed, not the command).
//  - Full numeric keypad added (1-9, Dash, 0, Enter) so a channel can be
//    dialed directly on this remote -- these are real SHEF digit/dash/enter
//    keys, the same ones the retired channel-picker's keypad used to send,
//    just moved onto this panel now that the picker is gone.
//  - NOT added: a Volume/Mute row. SHEF's real key vocabulary has no
//    volume/mute command -- DirecTV receivers pass audio straight through
//    and don't expose volume control over SHEF, that's the *TV's* job (see
//    the TVs page's own remote). The approved mockup included one for
//    visual completeness against the physical remote, but wiring it here
//    would just be dead buttons, so it's left off the real panel.
function directvRemoteHtml() {
  return `
    <div class="remote-grid cols-2">
      <button class="on" onclick="remoteKey('poweron')">POWER ON</button>
      <button class="off" onclick="remoteKey('poweroff')">POWER OFF</button>
    </div>
    <div class="remote-grid cols-3">
      <button onclick="remoteKey('guide')">Guide</button>
      <button onclick="remoteKey('list')">List</button>
      <button onclick="remoteKey('info')">Info</button>
    </div>
    <div class="remote-grid cols-3">
      <button onclick="remoteKey('menu')">Menu</button>
      <button onclick="remoteKey('exit')">Exit</button>
      <button onclick="remoteKey('back')">Back</button>
    </div>
    <div class="remote-grid cols-3">
      <button class="blank"></button>
      <button onclick="remoteKey('up')">▲</button>
      <button class="blank"></button>
      <button onclick="remoteKey('left')">◀</button>
      <button class="primary" onclick="remoteKey('select')">Select</button>
      <button onclick="remoteKey('right')">▶</button>
      <button class="blank"></button>
      <button onclick="remoteKey('down')">▼</button>
      <button class="blank"></button>
    </div>
    <div class="remote-grid cols-3">
      <button onclick="remoteKey('chanup')">CH ▲</button>
      <button onclick="remoteKey('prev')">Prev</button>
      <button onclick="remoteKey('chandown')">CH ▼</button>
    </div>
    <div class="remote-grid cols-4">
      <button onclick="remoteKey('rew')"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M11 12L20 6V18L11 12Z"/><path d="M4 12L13 6V18L4 12Z"/></svg>Rew</button>
      <button onclick="remoteKey('play')"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4L20 12L6 20V4Z"/></svg>Play</button>
      <button onclick="remoteKey('stop')"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>Stop</button>
      <button onclick="remoteKey('ffwd')"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M13 12L4 6V18L13 12Z"/><path d="M20 12L11 6V18L20 12Z"/></svg>Fwd</button>
    </div>
    <div class="remote-grid cols-3">
      <button class="keypad-digit" onclick="remoteKey('1')">1</button>
      <button class="keypad-digit" onclick="remoteKey('2')">2</button>
      <button class="keypad-digit" onclick="remoteKey('3')">3</button>
      <button class="keypad-digit" onclick="remoteKey('4')">4</button>
      <button class="keypad-digit" onclick="remoteKey('5')">5</button>
      <button class="keypad-digit" onclick="remoteKey('6')">6</button>
      <button class="keypad-digit" onclick="remoteKey('7')">7</button>
      <button class="keypad-digit" onclick="remoteKey('8')">8</button>
      <button class="keypad-digit" onclick="remoteKey('9')">9</button>
      <button onclick="remoteKey('dash')">Dash</button>
      <button class="keypad-digit" onclick="remoteKey('0')">0</button>
      <button class="primary" onclick="remoteKey('enter')">Enter</button>
    </div>
    <div class="remote-footer">Favorites live in the Favorites button up top — dial a channel directly with the keypad above.</div>`;
}

// Roku ECP's own key vocabulary (agent/lib/drivers/roku.js's keypress() is a
// thin passthrough to /keypress/<key> — these are Roku's real key names,
// not an internal mapping). PowerOn/PowerOff only do anything on a Roku TV;
// a plain streaming stick/box has no power state and simply ignores them,
// same as it would from the physical remote.
//
// Round 4 (2026-09-06): every physical button unchanged. The old "every app
// as a small button" grid at the bottom is replaced with a compact
// "Favorite Apps" row (fillRemoteRokuApps below) -- per Scotto's original
// request to make the bottom 4 app shortcuts changeable. There's no saved
// "favorite Roku apps" list in the config yet, so for now this shows this
// Roku's first 4 real reported apps in the bigger tile style the mockup
// used, with a "See all" link to the full list (the existing Apps dialog)
// rather than a non-functional Edit button — a real per-device favorite-apps
// picker (choose which 4, persisted) is a follow-up, not shipped here.
function rokuRemoteHtml() {
  return `
    <div class="remote-grid cols-2">
      <button class="on" onclick="remoteKey('PowerOn')">POWER ON</button>
      <button class="off" onclick="remoteKey('PowerOff')">POWER OFF</button>
    </div>
    <div class="remote-grid cols-2">
      <button onclick="remoteKey('Back')">Back</button>
      <button onclick="remoteKey('Home')">Home</button>
    </div>
    <div class="remote-grid cols-3">
      <button class="blank"></button>
      <button onclick="remoteKey('Up')">▲</button>
      <button class="blank"></button>
      <button onclick="remoteKey('Left')">◀</button>
      <button class="primary" onclick="remoteKey('Select')">OK</button>
      <button onclick="remoteKey('Right')">▶</button>
      <button class="blank"></button>
      <button onclick="remoteKey('Down')">▼</button>
      <button class="blank"></button>
    </div>
    <div class="remote-grid cols-2">
      <button onclick="remoteKey('InstantReplay')"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 1 2.5 5.8"/><path d="M4 17v-4h4"/></svg>Replay</button>
      <button onclick="remoteKey('Info')"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 4v16M4.5 8l15 8M19.5 8l-15 8"/></svg>Options</button>
    </div>
    <div class="remote-grid cols-3">
      <button onclick="remoteKey('Rev')"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M11 12L20 6V18L11 12Z"/><path d="M4 12L13 6V18L4 12Z"/></svg>Rev</button>
      <button onclick="remoteKey('Play')"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4L20 12L6 20V4Z"/></svg>Play</button>
      <button onclick="remoteKey('Fwd')"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M13 12L4 6V18L13 12Z"/><path d="M20 12L11 6V18L20 12Z"/></svg>Fwd</button>
    </div>
    <div class="section-row">
      <div class="section-label">Favorite Apps</div>
    </div>
    <div id="remoteRokuApps"><p class="muted" style="margin-top:8px;">Loading apps…</p></div>
    <div class="remote-footer" id="remoteRokuFooter">Tap an app to launch it.</div>`;
}

const FAV_APP_DOT_COLORS = ['var(--amber-bright)', 'var(--blue-fg)', 'var(--on-fg)', 'var(--muted-strong)'];

async function fillRemoteRokuApps(slot) {
  const el = document.getElementById('remoteRokuApps');
  const footer = document.getElementById('remoteRokuFooter');
  if (!el) return;
  try {
    const { apps } = await api(`/api/sources/${slot}/apps`);
    if (REMOTE_SLOT !== slot) return; // closed/reopened for a different slot while this was in flight
    if (!apps.length) { el.innerHTML = '<p class="muted">No apps reported by this Roku.</p>'; return; }
    const shown = apps.slice(0, 4);
    el.innerHTML = `<div class="remote-grid" style="grid-template-columns:repeat(2,1fr);">${shown.map((a, i) => `
      <button class="fav-app" onclick="launchRokuApp('${a.id}')">
        <span class="fa-dot" style="background:${FAV_APP_DOT_COLORS[i % FAV_APP_DOT_COLORS.length]};">${escapeHtml((a.name || '?').slice(0, 1).toUpperCase())}</span>
        <span class="fa-name">${escapeHtml(a.name)}</span>
      </button>
    `).join('')}</div>`;
    if (footer) {
      footer.innerHTML = apps.length > shown.length
        ? `Tap an app to launch it. <a href="#" onclick="event.preventDefault(); openRokuApps(${slot});">See all ${apps.length} apps…</a>`
        : 'Tap an app to launch it.';
    }
  } catch (e) {
    if (REMOTE_SLOT === slot) el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// Stage: ONLY the sources of the same kind as the one bound (REMOTE_KIND) --
// per Scotto's explicit instruction ("when they are opened, only their
// devices are available") -- e.g. the DirecTV remote's stage shows just the
// DirecTV receivers, never the Roku boxes or the static/spare slots mixed
// in. Exactly one tile is ever lit (.remote-target, full brightness) -- the
// one source this remote is actually driving right now; every other tile in
// the stage stays dimmed. Read-only; tapping it does nothing, it's context,
// not a control -- only one device is ever controlled at a time.
function remoteStageTileHtml(s) {
  const slot = Number(s.slot);
  const active = slot === Number(REMOTE_SLOT);
  let headline;
  if (s.kind === 'roku') {
    headline = !s.live || !s.live.ok ? 'Not responding' : (s.live.appId != null ? (s.live.appName || `App ${s.live.appId}`) : 'Idle');
  } else {
    headline = !s.live || !s.live.ok ? 'Not responding' : (s.live.active === false ? 'Asleep' : ((SOURCE_TITLES.get(slot) || {}).title || s.label));
  }
  return `
    <div class="remote-stage-tile${active ? ' remote-target' : ''}">
      <span class="rst-slot">${escapeHtml(s.qam_channel)}</span>
      <span class="rst-title">${escapeHtml(headline)}</span>
      <span class="rst-sub">${escapeHtml(s.label)}</span>
    </div>`;
}

function renderRemoteStage() {
  const stage = document.getElementById('remoteStage');
  const filtered = SOURCES.filter((s) => s.kind === REMOTE_KIND);
  stage.innerHTML = filtered.map(remoteStageTileHtml).join('');
}

// "Now playing" line for a source's remote header / stage tile -- exactly
// the same headline/callsign a card shows (sourceCardHtml above), just
// packaged for reuse here and in the Favorites overlay's receiver picker.
function sourceNowInfo(s) {
  const slot = Number(s.slot);
  const live = s.live;
  if (s.kind === 'roku') {
    if (!live || !live.ok) return { headline: 'Not responding', sub: s.label };
    if (live.appId == null) return { headline: 'Idle', sub: 'home screen' };
    return { headline: live.appName || `App ${live.appId}`, sub: 'streaming' };
  }
  if (!live || !live.ok) return { headline: 'Not responding', sub: s.label };
  if (live.active === false) return { headline: 'Asleep', sub: s.label };
  const t = SOURCE_TITLES.get(slot) || {};
  return { headline: t.title || s.label, sub: t.callsign || formatChannel(live) || s.label };
}

// Inline swap for #sourcesWrap -- the branded topbar stays on screen the
// whole time, exactly like the TVs page's TV Remote panel.
//
// Header (round 4, 2026-09-06): the old ALL-CAPS "DIRECTV"/"ROKU" title line
// is gone -- just the receiver name (bigger now) with its QAM slot below it,
// and, right-justified next to the close button, what it's actually showing
// right now (Scotto's original "make text for Directv number and current
// station larger and right justified next to X" request, now implemented
// for real rather than just in the mockup). There's no per-source "zone" in
// this app's data model (zones belong to TVs, not sources/receivers) so the
// second header line uses the receiver's real QAM slot instead of a
// fabricated zone name.
function openRemote(slot) {
  const source = SOURCES.find((s) => Number(s.slot) === Number(slot));
  if (!source) return;
  REMOTE_SLOT = slot;
  REMOTE_KIND = source.kind;
  const now = sourceNowInfo(source);
  document.getElementById('remoteRcvr').textContent = source.label;
  document.getElementById('remoteZone').textContent = `Channel ${source.qam_channel}`;
  document.getElementById('remoteNowChan').textContent = now.headline;
  document.getElementById('remoteNowProg').textContent = now.sub;
  document.getElementById('remoteBlastRadius').innerHTML = blastRadiusHtml(slot); // §6: shown before the tap, not after
  document.getElementById('remotePanelBody').innerHTML = source.kind === 'roku' ? rokuRemoteHtml() : directvRemoteHtml();
  renderRemoteStage();
  document.getElementById('sourcesWrap').style.display = 'none';
  document.getElementById('remoteOverlay').classList.add('open');
  if (source.kind === 'roku') fillRemoteRokuApps(slot);
}

function closeRemote() {
  document.getElementById('remoteOverlay').classList.remove('open');
  document.getElementById('sourcesWrap').style.display = '';
  REMOTE_SLOT = null;
  REMOTE_KIND = null;
}

async function remoteKey(key) {
  if (REMOTE_SLOT == null) return;
  await sendKey(REMOTE_SLOT, key);
  refreshSources(); // a key like Home/PowerOn can change what's showing -- pick it up without waiting for the next 15s tick
}

async function loadFavorites() {
  try {
    FAVORITES = await api('/api/favorites');
    // No inline render here anymore -- favorites now only ever render
    // inside the Favorites overlay (renderFavoritesOverlay below), built
    // fresh each time it's opened rather than kept live on the page.
  } catch (e) {
    // Favorites are a convenience on top of manual tuning, which still
    // works -- fail quietly rather than blocking the page on this.
  }
}

// ---------------------------------------------------------------------
// Favorites overlay (round 4, 2026-09-06), replacing both the old page-top
// favorites strip + its "which receiver(s)" bulk-tune dialog AND the old
// per-receiver channel picker's favorites grid. Favorites are DirecTV-only
// (a favorite is a saved channel, and only DirecTV receivers have
// channels), so this is one picker: every favorite on the left, every
// DirecTV receiver on the right. Tap a receiver to select it, then tap a
// favorite to tune that one receiver straight to it.
// ---------------------------------------------------------------------
let FAV_SELECTED_SLOT = null;

function openFavorites() {
  const directvSources = SOURCES.filter((s) => s.kind === 'directv');
  FAV_SELECTED_SLOT = directvSources.length ? Number(directvSources[0].slot) : null;
  renderFavoritesOverlay();
  document.getElementById('favOverlay').classList.add('open');
  loadTvs(); // best-effort refresh so anything blast-radius-related elsewhere stays current
}

function closeFavorites() {
  document.getElementById('favOverlay').classList.remove('open');
}

function selectFavReceiver(slot) {
  FAV_SELECTED_SLOT = Number(slot);
  renderFavoritesOverlay();
}

function renderFavoritesOverlay() {
  const tileGrid = document.getElementById('favTileGrid');
  const rcvGrid = document.getElementById('favRcvGrid');
  const footer = document.getElementById('favFooter');
  const directvSources = SOURCES.filter((s) => s.kind === 'directv');
  const selected = directvSources.find((s) => Number(s.slot) === Number(FAV_SELECTED_SLOT));

  tileGrid.innerHTML = FAVORITES.length
    ? FAVORITES.map((f, i) => `
        <button class="fav-tile" style="${f.color ? `border-left-color:${escapeHtml(f.color)};` : ''}" onclick="tuneFavoriteToSelected(${i})" ${selected ? '' : 'disabled'}>
          <span class="cat">${escapeHtml(f.category)}</span>
          <span class="name">${escapeHtml(f.name)}</span>
        </button>
      `).join('')
    : '<p class="muted">No favorites saved yet.</p>';

  rcvGrid.innerHTML = directvSources.length
    ? directvSources.map((s) => {
        const now = sourceNowInfo(s);
        const isSelected = Number(s.slot) === Number(FAV_SELECTED_SLOT);
        return `
          <button type="button" class="rcv-tile${isSelected ? ' selected' : ''}${s.live && s.live.ok === false ? ' alert' : ''}" onclick="selectFavReceiver(${s.slot})">
            <span class="rt-slot">${escapeHtml(s.qam_channel)}</span>
            <span class="rt-title">${escapeHtml(now.headline)}</span>
            <span class="rt-sub">${escapeHtml(s.label)}</span>
          </button>`;
      }).join('')
    : '<p class="muted">No DirecTV receivers configured yet.</p>';

  if (!selected) {
    footer.textContent = 'Pick a DirecTV receiver on the right, then tap a favorite to tune it.';
  } else {
    const affected = tvsOnSlot(selected.slot).length;
    const blastNote = affected ? ` — affects ${affected} TV${affected === 1 ? '' : 's'} right now` : '';
    footer.textContent = `Selected: ${selected.label} — tap a favorite on the left to tune it here${blastNote}.`;
  }
}

async function tuneFavoriteToSelected(i) {
  const f = FAVORITES[i];
  if (!f || FAV_SELECTED_SLOT == null) return;
  try {
    await api(`/api/sources/${FAV_SELECTED_SLOT}/tune`, { method: 'POST', body: JSON.stringify({ major: f.major, minor: f.minor }) });
    closeFavorites();
    await refreshSources();
  } catch (e) {
    alert(e.message);
  }
}
