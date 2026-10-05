// Games strip on the Sources page (Scotto, 2026-10-05), modeled on the
// DIRECTV for Business app's Sports screen: league tabs, Today / Upcoming /
// Completed, scores, a game sheet, and putting a game on a receiver now or
// when it starts. Data from the box's /api/sports (lib/sports.js): ESPN's
// scores plus the receivers' own guide for channel numbers.
//
// Two ways to put a game on a receiver:
//  - tap the game: a sheet with the channel and every DirecTV receiver;
//  - hold the game, then drag it onto a receiver tile below.
// A game that hasn't started is set to tune a minute before its start.
// Uses staff_sources.js's globals: SOURCES, api, escapeHtml, tvsOnSlot,
// SOURCE_TITLES, renderSources, refreshSources.

let GAMES = null;          // last /api/sports view
let GAMES_V = 0;
let GAMES_EDIT = false;    // owner/manager: channel numbers, My Teams
let GAMES_TIMER = null;
const GM = {
  league: lsGet('vc_games_league', 'all'),
  day: lsGet('vc_games_day', 'today'),
  scores: lsGet('vc_games_scores', '1') === '1',
  open: lsGet('vc_games_open', '1') === '1',
};
let SHEET = null;          // { gameId, slots:Set, ch:index, editing }

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

async function loadGames() {
  try {
    const data = await api(`/api/sports${GAMES_V ? `?v=${GAMES_V}` : ''}`);
    GAMES_EDIT = !!data.canEdit;
    if (data.same) return;
    GAMES = data;
    GAMES_V = data.v;
    renderGames();
    renderSources();
    if (SHEET) renderGameSheet();
  } catch (e) {
    if (!GAMES) document.getElementById('gamesRow').innerHTML = `<p class="muted gm-empty">Games didn’t load: ${escapeHtml(e.message)}</p>`;
  }
}

function startGames() {
  if (!document.getElementById('gamesBox')) return;
  loadGames();
  if (GAMES_TIMER) clearInterval(GAMES_TIMER);
  GAMES_TIMER = setInterval(loadGames, 30000);
}

// ------------------------------------------------------------------ helpers
const leagueLabel = (k) => ((GAMES && GAMES.leagues.find((l) => l.key === k)) || { label: k.toUpperCase() }).label;
const chLabel = (c) => (c ? `${c.major}${c.minor != null ? '-' + c.minor : ''}` : '');
function timeOf(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function dayOf(ymd) {
  const d = new Date(`${ymd}T12:00:00`);
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function statusText(g) {
  if (g.postponed) return 'Postponed';
  if (g.state === 'in') return g.detail || 'Live';
  if (g.state === 'post') return g.detail || 'Final';
  if (g.localDate === GAMES.today) return timeOf(g.start);
  return `${dayOf(g.localDate).split(',')[0]} ${timeOf(g.start)}`;
}
function gameById(id) { return GAMES && GAMES.games.find((g) => g.id === id); }
function tvOptions(g) { return (g.options || []).filter((o) => o.kind === 'tv'); }
function directvSources() { return SOURCES.filter((s) => s.kind === 'directv'); }
function plansFor(g) { return (GAMES.plans || []).filter((p) => p.gameId === g.id && p.status === 'waiting'); }
function srcLabel(slot) { const s = SOURCES.find((x) => Number(x.slot) === Number(slot)); return s ? s.label : `Slot ${slot}`; }

// The game a DirecTV receiver is showing right now, if any.
function gameOnSlot(slot) {
  if (!GAMES) return null;
  const s = SOURCES.find((x) => Number(x.slot) === Number(slot));
  if (!s || !s.live || !s.live.ok || s.live.active === false || s.live.major == null) return null;
  const now = Date.now();
  const list = GAMES.games.filter((g) => {
    if (g.postponed) return false;
    const t = new Date(g.start).getTime();
    const near = g.state === 'in' || (g.state === 'pre' && t - now < 15 * 60000 && t - now > -60 * 60000);
    return near && tvOptions(g).some((o) => Number(o.major) === Number(s.live.major) && (o.minor == null || s.live.minor == null || Number(o.minor) === Number(s.live.minor)));
  });
  if (list.length <= 1) return list[0] || null;
  const title = ((SOURCE_TITLES.get(Number(slot)) || {}).title || '').toLowerCase();
  return list.find((g) => title.includes(g.home.name.toLowerCase()) || title.includes(g.away.name.toLowerCase()))
    || list.find((g) => tvOptions(g).some((o) => o.confirmed && Number(o.major) === Number(s.live.major))) || list[0];
}
function slotsShowing(g) { return directvSources().filter((s) => { const x = gameOnSlot(s.slot); return x && x.id === g.id; }); }

// Extra lines for a DirecTV source tile (called from sourceCardHtml).
function sourceGameInfo(slot) {
  if (!GAMES) return null;
  const g = gameOnSlot(slot);
  const plan = (GAMES.plans || []).filter((p) => p.status === 'waiting' && p.slots.map(Number).includes(Number(slot)))
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0];
  if (!g && !plan) return null;
  return {
    headline: g ? `${g.away.name} @ ${g.home.name}` : null,
    line: g ? `${GM.scores && g.state !== 'pre' ? `${g.away.abbr} ${g.away.score ?? ''} – ${g.home.abbr} ${g.home.score ?? ''} · ` : ''}${statusText(g)}` : null,
    plan: plan ? `⏰ ${timeOf(plan.startAt)} ${plan.title} → ${plan.major}` : null,
  };
}

// ------------------------------------------------------------------ strip
function visibleGames() {
  if (!GAMES) return [];
  let list = GAMES.games;
  if (GM.league === 'mine') list = list.filter((g) => g.myTeam);
  else if (GM.league !== 'all') list = list.filter((g) => g.league === GM.league);
  const order = { in: 0, pre: 1, post: 2 };
  if (GM.day === 'today') {
    list = list.filter((g) => g.localDate === GAMES.today || g.state === 'in');
    list = list.slice().sort((a, b) => (order[a.state] - order[b.state]) || (new Date(a.start) - new Date(b.start)));
  } else if (GM.day === 'upcoming') {
    list = list.filter((g) => g.state === 'pre' && g.localDate > GAMES.today);
  } else {
    list = list.filter((g) => g.state === 'post' && (g.localDate === GAMES.today || g.localDate === GAMES.yesterday));
    list = list.slice().sort((a, b) => new Date(b.start) - new Date(a.start));
  }
  return list;
}

function teamRowHtml(t, g) {
  const logo = t.logo
    ? `<img src="${escapeHtml(t.logo)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'gm-logo-txt',textContent:'${escapeHtml(t.abbr || '?').replace(/'/g, '')}'}))">`
    : `<span class="gm-logo-txt">${escapeHtml(t.abbr || '?')}</span>`;
  const showScore = GM.scores && g.state !== 'pre' && t.score != null;
  const lost = g.state === 'post' && showScore && !t.winner && (g.away.winner || g.home.winner);
  return `<div class="gm-team${lost ? ' lost' : ''}">${logo}<span class="nm">${t.rank ? `<span class="rk">${t.rank}</span>` : ''}${escapeHtml(t.name)}</span><span class="sc">${showScore ? escapeHtml(t.score) : ''}</span></div>`;
}

function gameCardHtml(g) {
  const ch = g.channel;
  const showing = slotsShowing(g);
  const plans = plansFor(g);
  const tags = [];
  if (showing.length) tags.push(`<span class="gm-tag on">On ${escapeHtml(showing.map((s) => s.label).join(', '))}</span>`);
  if (plans.length) tags.push(`<span class="gm-tag plan">⏰ ${escapeHtml(plans.flatMap((p) => p.slots).map(srcLabel).join(', '))}</span>`);
  const chHtml = ch
    ? `<span class="gm-ch">${escapeHtml(chLabel(ch))} <b>${escapeHtml(ch.name)}</b>${ch.confirmed ? ' <i title="Checked on the receiver’s guide">✓</i>' : ''}</span>`
    : `<span class="gm-ch none">${escapeHtml(((g.options || [])[0] || {}).name || 'No TV listed')}</span>`;
  return `
    <button type="button" class="gm-card ${g.state}${g.postponed ? ' ppd' : ''}${showing.length ? ' showing' : ''}${g.myTeam ? ' mine' : ''}" data-game="${escapeHtml(g.id)}">
      <div class="gm-top"><span class="gm-lg">${escapeHtml(leagueLabel(g.league))}${g.note ? ` · ${escapeHtml(g.note)}` : ''}</span><span class="gm-st">${g.state === 'in' ? '<span class="gm-live"></span>' : ''}${escapeHtml(statusText(g))}</span></div>
      ${teamRowHtml(g.away, g)}
      ${teamRowHtml(g.home, g)}
      <div class="gm-bot">${chHtml}${tags.join('')}</div>
    </button>`;
}

function renderGames() {
  const box = document.getElementById('gamesBox');
  if (!box) return;
  box.classList.toggle('closed', !GM.open);
  const tabs = document.getElementById('gamesTabs');
  const row = document.getElementById('gamesRow');
  if (!GAMES) return;
  const leagues = [{ key: 'all', label: 'All' }, ...(GAMES.myTeams.length ? [{ key: 'mine', label: '★ My Teams' }] : []), ...GAMES.leagues];
  if (!leagues.some((l) => l.key === GM.league)) GM.league = 'all';
  tabs.innerHTML = `
    <div class="gm-leagues">${leagues.map((l) => `<button type="button" class="${GM.league === l.key ? 'active' : ''}" onclick="gamesLeague('${l.key}')">${escapeHtml(l.label)}</button>`).join('')}</div>
    <div class="gm-ctrls">
      <div class="gm-seg">${[['today', 'Today'], ['upcoming', 'Upcoming'], ['done', 'Completed']].map(([k, t]) => `<button type="button" class="${GM.day === k ? 'active' : ''}" onclick="gamesDay('${k}')">${t}</button>`).join('')}</div>
      <button type="button" class="gm-pill${GM.scores ? ' on' : ''}" onclick="gamesScores()">Scores ${GM.scores ? 'on' : 'off'}</button>
      ${GAMES_EDIT ? '<button type="button" class="gm-pill" onclick="openChannelSheet()">Channels</button>' : ''}
      <button type="button" class="gm-pill" onclick="gamesToggle()">${GM.open ? 'Hide' : 'Show games'}</button>
    </div>`;
  if (!GM.open) { row.innerHTML = ''; return; }
  const list = visibleGames();
  if (!list.length) {
    const what = GM.league === 'all' ? '' : GM.league === 'mine' ? 'My Teams ' : `${leagueLabel(GM.league)} `;
    const when = GM.day === 'today' ? 'today' : GM.day === 'upcoming' ? 'in the next week' : 'finished since yesterday';
    const err = GAMES.status && GAMES.status.error && !GAMES.games.length ? ` Scores aren’t loading: ${escapeHtml(GAMES.status.error)}` : '';
    row.innerHTML = `<p class="muted gm-empty">No ${what}games ${when}.${err}</p>`;
    return;
  }
  const keep = row.scrollLeft;
  let html = '';
  let lastDay = null;
  for (const g of list) {
    if (GM.day === 'upcoming' && g.localDate !== lastDay) { html += `<div class="gm-day">${escapeHtml(dayOf(g.localDate))}</div>`; lastDay = g.localDate; }
    html += gameCardHtml(g);
  }
  row.innerHTML = html;
  row.scrollLeft = keep;
}

function gamesLeague(k) { GM.league = k; lsSet('vc_games_league', k); document.getElementById('gamesRow').scrollLeft = 0; renderGames(); }
function gamesDay(k) { GM.day = k; lsSet('vc_games_day', k); document.getElementById('gamesRow').scrollLeft = 0; renderGames(); }
function gamesScores() { GM.scores = !GM.scores; lsSet('vc_games_scores', GM.scores ? '1' : '0'); renderGames(); renderSources(); }
function gamesToggle() { GM.open = !GM.open; lsSet('vc_games_open', GM.open ? '1' : '0'); renderGames(); }

// ------------------------------------------------------------------ toast
function gamesToast(text, bad) {
  let t = document.getElementById('gmToast');
  if (!t) { t = document.createElement('div'); t.id = 'gmToast'; t.className = 'gm-toast'; document.body.appendChild(t); }
  t.textContent = text;
  t.classList.toggle('bad', !!bad);
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3500);
}

// ------------------------------------------------------------------ actions
async function putGameOn(g, slots, opt, when) {
  if (!opt) { gamesToast('This game has no DirecTV channel yet.', true); return false; }
  const label = `${g.away.abbr || g.away.name} @ ${g.home.abbr || g.home.name}`;
  try {
    if (when === 'start') {
      await api('/api/sports/plans', { method: 'POST', body: JSON.stringify({ gameId: g.id, slots, major: opt.major, minor: opt.minor }) });
      gamesToast(`${label} goes on ${slots.map(srcLabel).join(', ')} at ${timeOf(g.start)} (channel ${chLabel(opt)}).`);
    } else {
      const r = await api('/api/sports/tune', { method: 'POST', body: JSON.stringify({ gameId: g.id, slots, major: opt.major, minor: opt.minor }) });
      gamesToast(r.ok === r.total ? `${label} is on ${slots.map(srcLabel).join(', ')} (channel ${chLabel(opt)}).` : `Only ${r.text}`, r.ok !== r.total);
      refreshSources();
    }
    GAMES_V = 0;
    loadGames();
    return true;
  } catch (e) {
    gamesToast(e.message, true);
    return false;
  }
}

async function cancelGamePlan(id) {
  try {
    await api(`/api/sports/plans/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
    GAMES_V = 0;
    await loadGames();
  } catch (e) { gamesToast(e.message, true); }
}

// ------------------------------------------------------------------ game sheet
function openGameSheet(id) {
  const g = gameById(id);
  if (!g) return;
  const opts = tvOptions(g);
  const planned = plansFor(g).flatMap((p) => p.slots.map(Number));
  SHEET = { gameId: id, slots: new Set(planned), ch: 0, editing: false };
  if (!opts.length) SHEET.ch = -1;
  ensureSheetBack().style.display = 'flex';
  renderGameSheet();
}
function ensureSheetBack() {
  let back = document.getElementById('gmSheetBack');
  if (!back) {
    back = document.createElement('div');
    back.id = 'gmSheetBack';
    back.className = 'gm-sheet-back';
    back.addEventListener('click', (e) => { if (e.target === back) closeGameSheet(); });
    document.body.appendChild(back);
  }
  return back;
}
function closeGameSheet() { SHEET = null; const b = document.getElementById('gmSheetBack'); if (b) b.style.display = 'none'; }

function sheetTeamHtml(t, g, side) {
  const star = GAMES_EDIT && t.id ? `<button type="button" class="gm-star${GAMES.myTeams.includes(`${g.league}:${t.id}`) ? ' on' : ''}" onclick="toggleMyTeam('${g.league}','${escapeHtml(t.id)}')" title="My Teams">★</button>` : '';
  return `
    <div class="gs-team ${side}">
      ${t.logo ? `<img src="${escapeHtml(t.logo)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'gm-logo-txt big',textContent:'${escapeHtml(t.abbr || '?').replace(/'/g, '')}'}))">` : `<span class="gm-logo-txt big">${escapeHtml(t.abbr || '?')}</span>`}
      <div class="gs-name">${t.rank ? `<span class="rk">${t.rank}</span>` : ''}${escapeHtml(t.name)}${star}</div>
      <div class="gs-rec">${escapeHtml(t.record || '')}</div>
      ${GM.scores && g.state !== 'pre' && t.score != null ? `<div class="gs-score">${escapeHtml(t.score)}</div>` : ''}
    </div>`;
}

function renderGameSheet() {
  const back = document.getElementById('gmSheetBack');
  const g = SHEET && gameById(SHEET.gameId);
  if (!back || !g) { closeGameSheet(); return; }
  const opts = tvOptions(g);
  if (SHEET.ch >= opts.length) SHEET.ch = opts.length ? 0 : -1;
  const opt = opts[SHEET.ch] || null;
  const others = (g.options || []).filter((o) => o.kind !== 'tv');
  const chips = opts.map((o, i) => `<button type="button" class="gs-chip${i === SHEET.ch ? ' sel' : ''}" onclick="SHEET.ch=${i};renderGameSheet()"><b>${escapeHtml(chLabel(o))}</b> ${escapeHtml(o.name)}${o.confirmed ? ' <i>✓ guide</i>' : ''}</button>`).join('')
    + others.map((o) => `<span class="gs-chip off">${escapeHtml(o.name)} <i>${o.kind === 'streaming' ? 'streaming' : o.kind === 'package' ? 'package — set channel' : o.kind === 'off' ? 'not on DirecTV' : 'no channel set'}</i></span>`).join('');
  const firstNet = (g.options || []).find((o) => o.kind !== 'streaming' && !/^Ch \d/.test(o.name));
  const edit = !GAMES_EDIT ? '' : SHEET.editing ? `
      <div class="gs-edit">
        <input id="gsChInput" inputmode="numeric" placeholder="Channel, like 705" value="${opt ? escapeHtml(chLabel(opt)) : ''}">
        <button type="button" onclick="saveGameChannel('game')">Just this game</button>
        ${firstNet ? `<button type="button" onclick="saveGameChannel('network','${escapeHtml(firstNet.name).replace(/'/g, '')}')">Every ${escapeHtml(firstNet.name)} game</button>` : ''}
        <button type="button" class="ghost" onclick="SHEET.editing=false;renderGameSheet()">Cancel</button>
      </div>`
    : '<button type="button" class="gs-link" onclick="SHEET.editing=true;renderGameSheet();setTimeout(()=>{const i=document.getElementById(\'gsChInput\');if(i)i.focus()},50)">Set channel…</button>';
  const showing = new Set(slotsShowing(g).map((s) => Number(s.slot)));
  const rcvs = directvSources().map((s) => {
    const sel = SHEET.slots.has(Number(s.slot));
    const now = typeof sourceNowInfo === 'function' ? sourceNowInfo(s) : { headline: s.label };
    const n = tvsOnSlot(s.slot).length;
    const down = !s.live || !s.live.ok;
    return `<button type="button" class="gs-rcv${sel ? ' sel' : ''}${showing.has(Number(s.slot)) ? ' has' : ''}${down ? ' down' : ''}" onclick="toggleSheetSlot(${Number(s.slot)})">
      <span class="slot">${escapeHtml(s.qam_channel)}</span>
      <span class="t">${escapeHtml(showing.has(Number(s.slot)) ? 'Showing this game' : down ? 'Not responding' : now.headline)}</span>
      <span class="s">${escapeHtml(s.label)} · ${n} TV${n === 1 ? '' : 's'}</span>
    </button>`;
  }).join('') || '<p class="muted">No DirecTV receivers set up.</p>';
  const plans = plansFor(g);
  const plansHtml = plans.map((p) => `<div class="gs-plan">⏰ Tunes ${escapeHtml(p.slots.map(srcLabel).join(', '))} to ${escapeHtml(String(p.major))} at ${escapeHtml(timeOf(p.startAt))}<button type="button" onclick="cancelGamePlan('${escapeHtml(p.id)}')">Cancel</button></div>`).join('');
  const n = SHEET.slots.size;
  const live = g.state === 'in';
  const future = g.state === 'pre' && !g.postponed;
  let btns = '<button type="button" class="mu-sheet-cancel" onclick="closeGameSheet()">Close</button>';
  if (live || (g.state === 'pre' && g.postponed === false)) btns += `<button type="button" class="${future ? 'mu-sheet-cancel' : 'mu-sheet-go'}" ${n && opt ? '' : 'disabled'} onclick="sheetGo('now')">Put on now${n ? ` (${n})` : ''}</button>`;
  if (future) btns += `<button type="button" class="mu-sheet-go" ${n && opt ? '' : 'disabled'} onclick="sheetGo('start')">When it starts${n ? ` (${n})` : ''}</button>`;
  back.innerHTML = `
    <div class="gm-sheet">
      <div class="gs-head"><span>${escapeHtml(leagueLabel(g.league))}${g.note ? ` · ${escapeHtml(g.note)}` : ''}</span><button type="button" class="gs-x" onclick="closeGameSheet()">&times;</button></div>
      <div class="gs-match">
        ${sheetTeamHtml(g.away, g, 'away')}
        <div class="gs-mid"><div class="gs-at">@</div><div class="gs-st${live ? ' live' : ''}">${live ? '<span class="gm-live"></span>' : ''}${escapeHtml(statusText(g))}</div><div class="gs-when">${escapeHtml(dayOf(g.localDate))} · ${escapeHtml(timeOf(g.start))}</div></div>
        ${sheetTeamHtml(g.home, g, 'home')}
      </div>
      <div class="gs-label">Channel ${edit}</div>
      <div class="gs-chips">${chips || '<span class="muted">No TV channel listed for this game.</span>'}</div>
      ${g.state === 'post' ? '' : `<div class="gs-label">Put it on</div><div class="gs-rcvs">${rcvs}</div>`}
      ${plansHtml}
      <div class="mu-sheet-btns">${btns}</div>
    </div>`;
}

function toggleSheetSlot(slot) {
  if (!SHEET) return;
  if (SHEET.slots.has(slot)) SHEET.slots.delete(slot); else SHEET.slots.add(slot);
  renderGameSheet();
}

async function sheetGo(when) {
  const g = gameById(SHEET.gameId);
  const opt = tvOptions(g)[SHEET.ch];
  const slots = [...SHEET.slots];
  if (await putGameOn(g, slots, opt, when)) closeGameSheet();
}

async function saveGameChannel(scope, network) {
  const g = gameById(SHEET.gameId);
  const value = (document.getElementById('gsChInput').value || '').trim();
  try {
    await api('/api/sports/channel', { method: 'POST', body: JSON.stringify(scope === 'game' ? { gameId: g.id, value } : { network, value }) });
    SHEET.editing = false;
    SHEET.ch = 0;
    GAMES_V = 0;
    await loadGames();
  } catch (e) { gamesToast(e.message, true); }
}

async function toggleMyTeam(league, teamId) {
  const on = !GAMES.myTeams.includes(`${league}:${teamId}`);
  try {
    await api('/api/sports/team', { method: 'POST', body: JSON.stringify({ league, teamId, on }) });
    GAMES_V = 0;
    await loadGames();
  } catch (e) { gamesToast(e.message, true); }
}

// ------------------------------------------------------------------ channels sheet (owner/manager)
async function openChannelSheet() {
  const back = ensureSheetBack();
  SHEET = null;
  back.style.display = 'flex';
  back.innerHTML = '<div class="gm-sheet"><p class="muted">Loading…</p></div>';
  try {
    const { channels, scanExtra } = await api('/api/sports/channels');
    const st = GAMES.status || {};
    back.innerHTML = `
      <div class="gm-sheet wide">
        <div class="gs-head"><span>Game channels</span><button type="button" class="gs-x" onclick="closeGameSheet()">&times;</button></div>
        <p class="gs-note">The DirecTV channel for each network. Blank goes back to the default. Type <b>off</b> for a network you don’t get.</p>
        <div class="gs-chlist">${channels.map((c) => `
          <label class="gs-chrow"><span class="n">${escapeHtml(c.label)}</span>
            <input data-net="${escapeHtml(c.key)}" inputmode="numeric" value="${c.off ? 'off' : c.custom ? escapeHtml(chLabel(c)) : ''}" placeholder="${escapeHtml(c.major ? chLabel(c) : '')}">
            <span class="f">${c.custom ? 'set here' : c.from === 'favorite' ? 'from Favorites' : c.from === 'guide' ? `guide: ${escapeHtml(c.learnedCallsign || '')}` : 'default'}</span></label>`).join('')}
        </div>
        <div class="gs-label">Also check these channels on the guide</div>
        <p class="gs-note">For package and regional games ESPN can’t place, like Sunday Ticket or Extra Innings. Ranges are fine: <b>701-719, 640</b>.</p>
        <input id="gsScanExtra" class="gs-wide-input" value="${escapeHtml(scanExtra || '')}" placeholder="701-719">
        <p class="gs-note">Guide last checked ${st.guideAt ? escapeHtml(new Date(st.guideAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : 'not yet'}${st.guideError ? ` · ${escapeHtml(st.guideError)}` : ` · ${st.guideEntries || 0} programs`}. Scores from ESPN${st.updatedAt ? `, updated ${escapeHtml(new Date(st.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : ''}${st.error ? ` · ${escapeHtml(st.error)}` : ''}.</p>
        <div class="mu-sheet-btns"><button type="button" class="mu-sheet-cancel" onclick="closeGameSheet()">Close</button><button type="button" class="mu-sheet-go" id="gsSaveCh" onclick="saveChannelSheet(this)">Save and check guide</button></div>
      </div>`;
  } catch (e) {
    back.innerHTML = `<div class="gm-sheet"><p class="muted">${escapeHtml(e.message)}</p><div class="mu-sheet-btns"><button type="button" class="mu-sheet-cancel" onclick="closeGameSheet()">Close</button></div></div>`;
  }
}

async function saveChannelSheet(btn) {
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const { channels } = await api('/api/sports/channels');
    for (const input of document.querySelectorAll('.gs-chrow input')) {
      const c = channels.find((x) => x.key === input.dataset.net);
      const was = c ? (c.off ? 'off' : c.custom ? chLabel(c) : '') : '';
      const now = input.value.trim().toLowerCase();
      if (now !== was) await api('/api/sports/channel', { method: 'POST', body: JSON.stringify({ network: input.dataset.net, value: now }) });
    }
    btn.textContent = 'Checking guide…';
    const r = await api('/api/sports/scan', { method: 'POST', body: JSON.stringify({ extra: document.getElementById('gsScanExtra').value, now: true }) });
    const g = r.guide || {};
    gamesToast(g.error ? `Saved. Guide: ${g.error}` : `Saved. Guide checked: ${g.entries} programs on ${g.channels} channels.`, !!g.error);
    closeGameSheet();
    GAMES_V = 0;
    loadGames();
  } catch (e) {
    gamesToast(e.message, true);
    btn.disabled = false;
    btn.textContent = 'Save and check guide';
  }
}

// ------------------------------------------------------------------ tap / hold-and-drag
// Tap a game: the sheet. Hold it (about half a second) and drag onto a
// DirecTV receiver tile: tune it there (or set it for the start).
const DRAG = { timer: null, active: false, id: null, x: 0, y: 0, ghost: null, target: null, moved: false };

function dragTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const card = el && el.closest('.source-card[data-slot]');
  return card && card.dataset.kind === 'directv' ? card : null;
}

function endDrag() {
  clearTimeout(DRAG.timer);
  DRAG.timer = null;
  if (DRAG.ghost) DRAG.ghost.remove();
  if (DRAG.target) DRAG.target.classList.remove('gm-drop');
  document.body.classList.remove('gm-dragging');
  DRAG.active = false;
  DRAG.ghost = null;
  DRAG.target = null;
}

function initGameGestures() {
  const row = document.getElementById('gamesRow');
  if (!row) return;
  row.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.gm-card');
    if (!card || (e.pointerType === 'mouse' && e.button !== 0)) return;
    DRAG.id = card.dataset.game;
    DRAG.x = e.clientX; DRAG.y = e.clientY; DRAG.moved = false;
    clearTimeout(DRAG.timer);
    DRAG.timer = setTimeout(() => {
      const g = gameById(DRAG.id);
      if (!g || g.state === 'post' || DRAG.moved) return;
      DRAG.active = true;
      document.body.classList.add('gm-dragging');
      const ghost = card.cloneNode(true);
      ghost.classList.add('gm-ghost');
      ghost.style.left = `${DRAG.x - 90}px`;
      ghost.style.top = `${DRAG.y - 50}px`;
      document.body.appendChild(ghost);
      DRAG.ghost = ghost;
      if (navigator.vibrate) navigator.vibrate(15);
    }, 450);
  });
  document.addEventListener('pointermove', (e) => {
    if (!DRAG.timer && !DRAG.active) return;
    if (!DRAG.active) {
      if (Math.abs(e.clientX - DRAG.x) > 8 || Math.abs(e.clientY - DRAG.y) > 8) { DRAG.moved = true; clearTimeout(DRAG.timer); DRAG.timer = null; }
      return;
    }
    DRAG.ghost.style.left = `${e.clientX - 90}px`;
    DRAG.ghost.style.top = `${e.clientY - 50}px`;
    const t = dragTargetAt(e.clientX, e.clientY);
    if (t !== DRAG.target) {
      if (DRAG.target) DRAG.target.classList.remove('gm-drop');
      DRAG.target = t;
      if (t) t.classList.add('gm-drop');
    }
    if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
    else if (e.clientY < 90) window.scrollBy(0, -14);
  });
  // Stop the page scrolling under a drag (iPad).
  document.addEventListener('touchmove', (e) => { if (DRAG.active) e.preventDefault(); }, { passive: false });
  document.addEventListener('pointerup', (e) => {
    if (!DRAG.active) { clearTimeout(DRAG.timer); DRAG.timer = null; return; }
    const target = dragTargetAt(e.clientX, e.clientY);
    const g = gameById(DRAG.id);
    endDrag();
    DRAG.justDragged = Date.now();
    if (!target || !g) return;
    const opt = tvOptions(g)[0];
    putGameOn(g, [Number(target.dataset.slot)], opt, g.state === 'pre' && new Date(g.start).getTime() - Date.now() > 2 * 60000 ? 'start' : 'now');
  });
  document.addEventListener('pointercancel', () => { if (DRAG.active) endDrag(); else { clearTimeout(DRAG.timer); DRAG.timer = null; } });
  row.addEventListener('click', (e) => {
    const card = e.target.closest('.gm-card');
    if (!card || (DRAG.justDragged && Date.now() - DRAG.justDragged < 400)) return;
    openGameSheet(card.dataset.game);
  });
  row.addEventListener('contextmenu', (e) => e.preventDefault());
}

initGameGestures();
if (typeof STAFF_PASS !== 'undefined' && STAFF_PASS) startGames();
