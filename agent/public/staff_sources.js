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

// Primary tap action per kind/state -- everything else (Guide/Info/keypad,
// the full remote, Roku's app grid) still lives one tap further in via the
// channel picker / apps dialog / remote panel, unchanged from before.
function cardTap(slot, kind) {
  const s = SOURCES.find((x) => Number(x.slot) === Number(slot));
  if (!s) return;
  if (kind === 'directv') {
    if (!s.live || !s.live.ok) { refreshSources(); return; } // not responding -- tap rechecks now instead of waiting for the next 15s tick
    if (s.live.active === false) { sendKey(slot, 'poweron').then(() => setTimeout(refreshSources, 800)); return; } // asleep -- tap to wake
    openChannelPicker(slot);
    return;
  }
  // roku
  if (!s.live || !s.live.ok) { refreshSources(); return; }
  openRokuApps(slot);
}

function renderSources() {
  document.getElementById('refreshedAt').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  const box = document.getElementById('sourcesBox');
  if (!SOURCES.length) { box.innerHTML = '<p class="muted">No sources configured yet. Add one from TSB Platform: Venue Control &rarr; Sources.</p>'; return; }
  box.innerHTML = SOURCES.map(sourceCardHtml).join('');
}

function parseChannel(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const [major, minor] = trimmed.split('.');
  if (!major || !/^\d+$/.test(major)) return null;
  return { major: Number(major), minor: minor && /^\d+$/.test(minor) ? Number(minor) : undefined };
}

async function goToChannel(slot) {
  const input = document.getElementById(`chan_${slot}`);
  const parsed = parseChannel(input.value);
  if (!parsed) { alert('Enter a channel like 206 or 206.1'); return; }
  try {
    await api(`/api/sources/${slot}/tune`, { method: 'POST', body: JSON.stringify(parsed) });
    input.value = '';
    await refreshSources();
  } catch (e) {
    alert(e.message);
  }
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

// Real SHEF key names (DirecTV's documented /remote/processKey vocabulary --
// same list agent/lib/drivers/directv.js's processKey() passes straight
// through as a query param, no translation layer needed here).
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
    <div class="remote-grid cols-5">
      <button class="small" onclick="remoteKey('rew')">Rew</button>
      <button class="small" onclick="remoteKey('play')">Play</button>
      <button class="small" onclick="remoteKey('stop')">Stop</button>
      <button class="small" onclick="remoteKey('ffwd')">Ffwd</button>
      <button class="small" onclick="remoteKey('record')">Rec</button>
    </div>
    <div class="remote-grid cols-2">
      <button onclick="remoteKey('dash')">Dash</button>
      <button class="primary" onclick="remoteKey('enter')">Enter</button>
    </div>
    <div class="remote-footer">Numeric channel entry lives in Channels… — this remote mirrors the physical one.</div>`;
}

// Roku ECP's own key vocabulary (agent/lib/drivers/roku.js's keypress() is a
// thin passthrough to /keypress/<key> — these are Roku's real key names,
// not an internal mapping). PowerOn/PowerOff only do anything on a Roku TV;
// a plain streaming stick/box has no power state and simply ignores them,
// same as it would from the physical remote.
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
      <button class="small" onclick="remoteKey('InstantReplay')">Replay</button>
      <button class="small" onclick="remoteKey('Info')">Options</button>
    </div>
    <div class="remote-grid cols-3">
      <button class="small" onclick="remoteKey('Rev')">Rev</button>
      <button class="small" onclick="remoteKey('Play')">Play</button>
      <button class="small" onclick="remoteKey('Fwd')">Fwd</button>
    </div>
    <div id="remoteRokuApps"><p class="muted" style="margin-top:12px;">Loading apps…</p></div>
    <div class="remote-footer">Tap an app to launch it. Full list: Apps… on the Sources tab.</div>`;
}

async function fillRemoteRokuApps(slot) {
  const el = document.getElementById('remoteRokuApps');
  if (!el) return;
  try {
    const { apps } = await api(`/api/sources/${slot}/apps`);
    if (REMOTE_SLOT !== slot) return; // closed/reopened for a different slot while this was in flight
    if (!apps.length) { el.innerHTML = '<p class="muted">No apps reported by this Roku.</p>'; return; }
    el.innerHTML = `<div class="remote-grid cols-4">${apps.slice(0, 8).map((a) => `
      <button class="small" onclick="launchRokuApp('${a.id}')">${escapeHtml(a.name)}</button>
    `).join('')}</div>`;
  } catch (e) {
    if (REMOTE_SLOT === slot) el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// Stage: the full sources grid, dimmed (see .remote-stage in staff-theme.css),
// with exactly one tile lit -- the source this remote is actually driving
// right now. Read-only; tapping it does nothing, it's context, not a control.
function renderRemoteStage() {
  const stage = document.getElementById('remoteStage');
  stage.innerHTML = `<div class="channel-grid">${SOURCES.map((s) => `
    <div class="channel-tile${Number(s.slot) === Number(REMOTE_SLOT) ? ' remote-target' : ''}">
      <span class="cat">slot ${s.slot} · ${escapeHtml(s.qam_channel)}</span>
      <span class="name">${escapeHtml(s.label)}</span>
      <span class="live-title">${s.kind === 'roku' ? (s.live && s.live.appId != null ? escapeHtml(s.live.appName || '') : '') : (s.live && s.live.major != null ? `${s.live.major}${s.live.minor != null ? '.' + s.live.minor : ''}` : '')}</span>
    </div>`).join('')}</div>`;
}

function openRemote(slot) {
  REMOTE_SLOT = slot;
  const source = SOURCES.find((s) => Number(s.slot) === Number(slot));
  if (!source) return;
  document.getElementById('remoteTitle').textContent = source.kind === 'roku' ? 'ROKU' : 'DIRECTV';
  document.getElementById('remoteSub').textContent = `${source.label} · ${source.qam_channel}`;
  document.getElementById('remotePanelBody').innerHTML = source.kind === 'roku' ? rokuRemoteHtml() : directvRemoteHtml();
  renderRemoteStage();
  document.getElementById('remoteOverlay').classList.add('open');
  if (source.kind === 'roku') fillRemoteRokuApps(slot);
}

function closeRemote() {
  document.getElementById('remoteOverlay').classList.remove('open');
  REMOTE_SLOT = null;
}

// Topbar's persistent "DirecTV Remote" shortcut -- unlike a card's own
// Remote… button (already scoped to one receiver), this one isn't bound to
// anything yet, so with more than one DirecTV receiver configured it asks
// first. With exactly one, it skips straight to that receiver's remote --
// no pointless single-item picker.
function openQuickDirectvRemote() {
  const directvSources = SOURCES.filter((s) => s.kind === 'directv');
  if (!directvSources.length) { alert('No DirecTV receivers configured yet.'); return; }
  if (directvSources.length === 1) { openRemote(directvSources[0].slot); return; }
  document.getElementById('quickRemoteGrid').innerHTML = directvSources.map((s) => `
    <button onclick="document.getElementById('quickRemoteDialog').close(); openRemote(${s.slot});">
      ${escapeHtml(s.label)} <span class="muted">(${escapeHtml(s.qam_channel)})</span>
    </button>
  `).join('');
  document.getElementById('quickRemoteDialog').showModal();
}

async function remoteKey(key) {
  if (REMOTE_SLOT == null) return;
  await sendKey(REMOTE_SLOT, key);
  refreshSources(); // a key like Home/PowerOn can change what's showing -- pick it up without waiting for the next 15s tick
}

async function loadFavorites() {
  try {
    FAVORITES = await api('/api/favorites');
    renderFavorites();
  } catch (e) {
    // Favorites are a convenience on top of manual tuning, which still
    // works -- fail quietly rather than blocking the page on this.
  }
}

function renderFavorites() {
  const card = document.getElementById('favCard');
  if (!FAVORITES.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  document.getElementById('favGrid').innerHTML = FAVORITES.map((f, i) => `
    <button class="fav-btn" style="${f.color ? `border-color:${escapeHtml(f.color)};` : ''}" onclick="openTuneFav(${i})">
      <span class="cat">${escapeHtml(f.category)}</span>
      <span>${escapeHtml(f.name)}</span>
    </button>
  `).join('');
}

let TUNE_FAV = null;

function openTuneFav(i) {
  TUNE_FAV = FAVORITES[i];
  document.getElementById('tuneFavTitle').textContent = `Tune to ${TUNE_FAV.name}`;
  document.getElementById('tuneFavMsg').innerHTML = '';
  const directvSources = SOURCES.filter((s) => s.kind === 'directv');
  document.getElementById('tuneFavChecks').innerHTML = directvSources.length
    ? directvSources.map((s) => `
        <label style="display:flex; align-items:center; gap:8px; padding:4px 0;">
          <input type="checkbox" class="tuneFavCheck" value="${s.slot}" checked>
          ${escapeHtml(s.label)} <span class="muted">(slot ${s.slot})</span>
        </label>
      `).join('')
    : '<p class="muted">No DirecTV receivers configured yet.</p>';
  document.getElementById('tuneFavDialog').showModal();
}

async function submitTuneFav() {
  const slots = Array.from(document.querySelectorAll('.tuneFavCheck:checked')).map((el) => Number(el.value));
  if (!slots.length) { document.getElementById('tuneFavMsg').innerHTML = '<div class="msg error">Pick at least one receiver.</div>'; return; }
  try {
    const { results } = await api('/api/sources/bulk/tune', {
      method: 'POST',
      body: JSON.stringify({ slots, major: TUNE_FAV.major, minor: TUNE_FAV.minor }),
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      document.getElementById('tuneFavMsg').innerHTML = `<div class="msg error">${failed.length} of ${results.length} failed: ${escapeHtml(failed.map((f) => `slot ${f.slot} (${f.error})`).join(', '))}</div>`;
    } else {
      document.getElementById('tuneFavDialog').close();
    }
    await refreshSources();
  } catch (e) {
    document.getElementById('tuneFavMsg').innerHTML = `<div class="msg error">${escapeHtml(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------
// Channel picker overlay (screens/02-staff-channel-picker.html). Scoped to
// one receiver (PICKER_SLOT) at a time -- opened from that receiver's
// "Channels…" button. Favorites grid sourced from the same /api/favorites
// data as the on-page favorites strip (no separate/fixed channel guide);
// live titles are fetched per-favorite via the existing proginfo endpoint
// and filled in progressively rather than blocking the grid on all of them.
// ---------------------------------------------------------------------
let PICKER_SLOT = null;
let pickerFillToken = 0;

function openChannelPicker(slot) {
  PICKER_SLOT = slot;
  const source = SOURCES.find((s) => Number(s.slot) === Number(slot));
  document.getElementById('pickerTitle').textContent = source ? `${source.label} — slot ${source.slot}` : `Slot ${slot}`;
  document.getElementById('pickerBlastRadius').innerHTML = blastRadiusHtml(slot);
  document.getElementById('pickerKeypadInput').value = '';
  renderPickerFavorites();
  document.getElementById('channelPicker').classList.add('open');
  loadTvs(); // refresh in the background so blast radius is current next time it's shown
}

function closeChannelPicker() {
  document.getElementById('channelPicker').classList.remove('open');
  PICKER_SLOT = null;
  pickerFillToken++; // stop any in-flight progressive fill from this session
}

function renderPickerFavorites() {
  const grid = document.getElementById('pickerFavGrid');
  if (!FAVORITES.length) { grid.innerHTML = '<p class="muted">No favorites saved yet — use the keypad below.</p>'; return; }
  grid.innerHTML = FAVORITES.map((f, i) => `
    <button class="channel-tile" style="${f.color ? `border-left-color:${escapeHtml(f.color)};` : ''}" onclick="tuneToFavorite(${i})">
      <span class="cat">${escapeHtml(f.category)}</span>
      <span class="name">${escapeHtml(f.name)}</span>
      ${f.major != null ? `<span class="live-title loading" id="pickerLive_${i}">Loading…</span>` : ''}
    </button>
  `).join('');
  fillPickerLiveTitles();
}

// Sequential on purpose -- DirecTV SHEF is single-threaded per receiver with
// a ~350ms minimum gap between calls (Phase 2), so firing every favorite's
// proginfo call at once wouldn't be faster, it would just queue behind
// itself while the whole grid sat on "Loading…". One at a time means each
// tile lights up with its real title as soon as that one call resolves.
async function fillPickerLiveTitles() {
  const myToken = ++pickerFillToken;
  const slot = PICKER_SLOT;
  for (let i = 0; i < FAVORITES.length; i++) {
    const f = FAVORITES[i];
    if (f.major == null) continue;
    if (myToken !== pickerFillToken) return; // overlay closed or reopened for a different slot
    const el = document.getElementById(`pickerLive_${i}`);
    if (!el) continue;
    try {
      const info = await api(`/api/sources/${slot}/proginfo?major=${encodeURIComponent(f.major)}${f.minor != null ? `&minor=${encodeURIComponent(f.minor)}` : ''}`);
      if (myToken !== pickerFillToken) return;
      const title = (info && (info.title || info.callsign)) || '';
      if (title) {
        el.textContent = title;
        el.classList.remove('loading');
      } else {
        el.remove(); // nothing usable came back -- drop the line rather than show a blank/wrong guess
      }
    } catch (e) {
      if (myToken !== pickerFillToken) return;
      el.remove();
    }
  }
}

async function tuneToFavorite(i) {
  const f = FAVORITES[i];
  try {
    await api(`/api/sources/${PICKER_SLOT}/tune`, { method: 'POST', body: JSON.stringify({ major: f.major, minor: f.minor }) });
    closeChannelPicker();
    await refreshSources();
  } catch (e) {
    alert(e.message);
  }
}

async function pickerSendKey(key) {
  try {
    await api(`/api/sources/${PICKER_SLOT}/key`, { method: 'POST', body: JSON.stringify({ key }) });
  } catch (e) {
    alert(e.message);
  }
}

function pickerKeypadPress(ch) {
  const input = document.getElementById('pickerKeypadInput');
  if (ch === 'clear') { input.value = ''; return; }
  if (ch === 'back') { input.value = input.value.slice(0, -1); return; }
  input.value += ch;
}

async function pickerKeypadTune() {
  const parsed = parseChannel(document.getElementById('pickerKeypadInput').value);
  if (!parsed) { alert('Enter a channel like 206 or 206.1'); return; }
  try {
    await api(`/api/sources/${PICKER_SLOT}/tune`, { method: 'POST', body: JSON.stringify(parsed) });
    closeChannelPicker();
    await refreshSources();
  } catch (e) {
    alert(e.message);
  }
}
