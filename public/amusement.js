// Diamond Amusement — coin-op collections (patch_041). One page, hash-
// routed, phone-first. The collector's loop is: Home -> start a
// collection at a bar -> (scan the game's QR sticker, or tap it on the
// sheet) -> photo the scale display -> confirm the number -> bills ->
// save -> next game -> review -> finalize -> someone rings the total into
// SpotOn and taps "Mark posted". The owner also gets Games (add / move /
// retire / print stickers), Reports and Settings.
//
// Access levels come from /api/amusement/access: 'owner' | 'collector' |
// 'none'. Everything talks to server/amusement.js via server/index.js's
// /api/amusement/* routes.
let ME = null;
let LEVEL = 'none';
let CAPS = { photoReader: false, photoStorage: false };
let SETTINGS = null;
let LOCATIONS = [];
let SHEET = null;          // the collection currently open (from /collections/:id)
let SCAN_STREAM = null;    // getUserMedia stream while the scanner is up
let SCAN_TIMER = null;
let GAMES_FILTER = 'all';

const GRAMS_PER_LB = 453.59237;
const GAME_TYPES = [
  ['pool', 'Pool table'], ['video', 'Video game'], ['pinball', 'Pinball'], ['shuffleboard', 'Shuffleboard'],
  ['basketball', 'Basketball'], ['putt_putt', 'Putt Putt'], ['darts', 'Darts'], ['jukebox', 'Jukebox'], ['other', 'Other'],
];
const ICON_CAMERA = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const ICON_SCAN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 12h10"/></svg>';
const ICON_TICK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
const ICON_WARN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f0c265" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
const ICON_BACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
const ICON_CHEV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function $(id) { return document.getElementById(id); }
function showMsg(text, kind) { $('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : ''; }
function money(n) { const x = Number(n || 0); return '$' + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function fmtDay(iso) { if (!iso) return '—'; return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function fmtTime(iso) { if (!iso) return ''; return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function daysAgo(iso) { if (!iso) return null; return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); }
function typeLabel(t) { const f = GAME_TYPES.find((x) => x[0] === t); return f ? f[1] : (t || 'Other'); }
function go(hash) { window.location.hash = hash; }
function headHtml(title, sub, backHash, right) {
  return `<div class="am-head">
    <div style="display:flex; align-items:center; gap:10px; min-width:0;">
      ${backHash ? `<a class="am-back" href="${backHash}" aria-label="Back">${ICON_BACK}</a>` : ''}
      <h1 class="am-title" style="min-width:0;">${escapeHtml(title)}${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ''}</h1>
    </div>${right || ''}</div>`;
}
function errorCard(e) { return `<div class="card"><p class="msg error">${escapeHtml(e.message || String(e))}</p></div>`; }
function badge(text, cls) { return `<span class="badge ${cls || 'off'}">${escapeHtml(text)}</span>`; }

// The weight math, mirrored from server/amusement.js computeItem() for
// the live preview as the collector types. The server recomputes and
// stores its own answer on save; this is display only.
function previewQuarters(gross, tare, unit) {
  const g = num(gross, NaN);
  if (!Number.isFinite(g)) return null;
  const q = num(SETTINGS && SETTINGS.quarter_weight_g, 5.67);
  const toG = (v) => (unit === 'lb' ? v * GRAMS_PER_LB : v);
  const netG = Math.max(0, toG(g) - toG(num(tare)));
  const coins = Math.round(netG / q);
  return { netG, coins, dollars: coins * 0.25 };
}
function defaultTareFor(unit) {
  const g = num(SETTINGS && SETTINGS.default_tare_g);
  return unit === 'lb' ? Number((g / GRAMS_PER_LB).toFixed(3)) : g;
}

// Shrinks a phone photo (2–6 MB) to a ~1280 px JPEG before upload: faster
// on bar wifi, cheaper to read, and plenty for reading a scale display.
async function shrinkImage(file, maxSide = 1280) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob || file;
  } catch (e) {
    return file; // HEIC on a browser without decode support etc. — send as-is
  }
}

// Opens the camera (or photo picker) and resolves with the chosen File.
function pickPhoto() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = () => { const f = input.files && input.files[0]; input.remove(); resolve(f || null); };
    input.click();
  });
}

async function photoUrlFor(path) {
  if (!path) return null;
  try { const r = await api('/api/amusement/photo?path=' + encodeURIComponent(path)); return r.url; } catch (e) { return null; }
}

// ---------------------------------------------------------------------
// Boot + routing
// ---------------------------------------------------------------------
async function init() {
  ME = requireAuth();
  if (!ME) return;
  renderTopbar('Diamond Amusement');
  try {
    const a = await api('/api/amusement/access');
    LEVEL = a.level;
    CAPS = { photoReader: !!a.photoReader, photoStorage: !!a.photoStorage };
  } catch (e) {
    $('panelMain').innerHTML = errorCard(e);
    return;
  }
  if (LEVEL === 'none') {
    $('panelMain').innerHTML = '<div class="card"><p>Diamond Amusement isn\'t turned on for you.</p><p><a href="/dashboard.html">Back to Apps Home</a></p></div>';
    $('bottomNav').style.display = 'none';
    return;
  }
  // A sticker scanned with the phone's own camera app lands here with
  // ?tag=DA-0007 — jump straight to that game's weigh screen.
  const params = new URLSearchParams(window.location.search);
  if (params.get('tag')) {
    history.replaceState(null, '', window.location.pathname);
    await openByTag(params.get('tag'));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

async function route() {
  stopScanner();
  document.querySelector('.wrap').classList.remove('has-footer');
  const h = (window.location.hash || '#home').slice(1);
  const [view, a, b] = h.split('/');
  renderBottomNav(view);
  showMsg('');
  try {
    if (view === 'collect') await renderSheet(a);
    else if (view === 'scan') await renderScan(a);
    else if (view === 'weigh') await renderWeigh(a, b);
    else if (view === 'review') await renderReview(a);
    else if (view === 'games') await renderGames();
    else if (view === 'game') await renderGameDetail(a);
    else if (view === 'reports') await renderReports(a);
    else if (view === 'settings') await renderSettings();
    else if (view === 'locations') await renderLocations();
    else await renderHome();
  } catch (e) {
    $('panelMain').innerHTML = errorCard(e);
  }
  window.scrollTo(0, 0);
}

function renderBottomNav(view) {
  const items = [
    ['home', 'Collect', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/></svg>', ['home', 'collect', 'scan', 'weigh', 'review']],
    ['games', 'Games', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="12" rx="3"/><path d="M8 13h.01M12 11h.01M16 13h.01M7 3h10"/></svg>', ['games', 'game', 'locations']],
    ['reports', 'Reports', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>', ['reports', 'settings']],
  ];
  const visible = LEVEL === 'owner' ? items : items.slice(0, 2);
  $('bottomNav').style.gridTemplateColumns = `repeat(${visible.length}, minmax(0, 1fr))`;
  $('bottomNav').innerHTML = visible.map(([key, label, icon, active]) =>
    `<a href="#${key}" class="${active.includes(view) ? 'active' : ''}">${icon}${label}</a>`).join('');
}

// ---------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------
async function renderHome() {
  const data = await api('/api/amusement/home');
  SETTINGS = data.settings;
  LOCATIONS = data.locations;
  CAPS.photoReader = !!data.photoReader;
  const live = LOCATIONS.filter((l) => !l.is_storage);
  const recentFinal = data.recent.filter((c) => c.status === 'final');
  const last30 = recentFinal.filter((c) => daysAgo(c.finalized_at) <= 30).reduce((s, c) => s + num(c.total), 0);
  const games = live.reduce((s, l) => s + l.game_count, 0);
  const dueCount = live.filter((l) => l.due).length;
  const queued = live.reduce((s, l) => s + l.queued_pos_count, 0);

  const locCards = live.map((l) => {
    let status;
    if (l.draft_collection_id) status = badge('In progress', 'on');
    else if (l.days_since === null) status = badge(l.game_count ? 'Never collected' : 'No games', l.game_count ? 'stale' : 'off');
    else if (l.due) status = badge(`Due · ${l.days_since} days`, 'stale');
    else status = badge(`Collected · ${l.days_since === 0 ? 'today' : l.days_since + ' days ago'}`, 'on');
    const cta = l.draft_collection_id
      ? `<button class="primary" onclick="go('#collect/${l.draft_collection_id}')">Continue collection</button>`
      : l.game_count
        ? `<button class="${l.due ? 'primary' : 'secondary'}" onclick="startCollection('${l.id}')">Start collection</button>`
        : `<button class="secondary" onclick="go('#games')">Add games</button>`;
    return `<div class="card am-loc">
      <div class="row"><div class="name">${escapeHtml(l.name)}</div>${status}</div>
      <div class="meta"><span>${l.game_count} game${l.game_count === 1 ? '' : 's'}</span>
        ${l.last_collected_at ? `<span>Last: ${fmtDay(l.last_collected_at)} · ${money(l.last_total)}</span>` : ''}
        ${l.queued_pos_count ? `<span style="color:#f0c265;">${l.queued_pos_count} not yet rung into SpotOn</span>` : ''}</div>
      ${cta}
    </div>`;
  }).join('');

  const recent = data.recent.slice(0, 8).map((c) => {
    const sub = c.status === 'draft'
      ? `In progress · ${c.item_count} weighed · started by ${escapeHtml(c.started_by_name || '')}`
      : `${c.item_count} games · by ${escapeHtml(c.finalized_by_name || '')} · ${c.pos_status === 'posted' ? 'posted to SpotOn' : '<span style="color:#f0c265;">not yet in SpotOn</span>'}`;
    const target = c.status === 'draft' ? `#collect/${c.id}` : `#review/${c.id}`;
    return `<div class="list-row am-tap" onclick="go('${target}')">
      <div><div class="name">${escapeHtml(c.location_name)} · ${fmtDay(c.finalized_at || c.started_at)}</div><div class="sub">${sub}</div></div>
      <div style="font-weight:700; font-variant-numeric: tabular-nums;">${money(c.total)}</div></div>`;
  }).join('');

  $('panelMain').innerHTML = `
    ${headHtml('Diamond Amusement', LEVEL === 'owner' ? 'Owner' : 'Collector')}
    <div class="am-stats">
      <div class="card"><div class="n">${money(last30)}</div><div class="l">Last 30 days</div></div>
      <div class="card"><div class="n">${games}</div><div class="l">Games on route</div></div>
      <div class="card"><div class="n" style="color:${dueCount ? '#f0c265' : 'inherit'}">${dueCount}</div><div class="l">Due now</div></div>
    </div>
    ${queued ? `<div class="msg info" style="margin-top:12px;">${queued} finalized collection${queued === 1 ? '' : 's'} still need${queued === 1 ? 's' : ''} to be rung into SpotOn.</div>` : ''}
    ${!CAPS.photoReader && LEVEL === 'owner' ? `<div class="msg info" style="margin-top:12px;">Photo reading is off (no ANTHROPIC_API_KEY on the server) — weights are typed for now.</div>` : ''}
    <div class="am-kicker">Locations</div>
    ${locCards || '<div class="card"><p class="muted">No locations yet. Add one under Games → Locations.</p></div>'}
    <div class="am-kicker">Recent</div>
    <div class="card" style="padding:4px 16px;">${recent || '<p class="muted">No collections yet.</p>'}</div>`;
}

async function startCollection(locationId) {
  try {
    const r = await api('/api/amusement/collections/start', { method: 'POST', body: { locationId } });
    go('#collect/' + r.collectionId);
  } catch (e) { showMsg(e.message, 'error'); }
}

// ---------------------------------------------------------------------
// The collection sheet
// ---------------------------------------------------------------------
async function loadSheet(id) {
  SHEET = await api('/api/amusement/collections/' + id);
  SETTINGS = SHEET.settings;
  return SHEET;
}

async function renderSheet(id) {
  const sheet = await loadSheet(id);
  const c = sheet.collection;
  if (c.status === 'final') { go('#review/' + id); return; }
  const nextGame = sheet.games.find((g) => !g.item_id);
  const rows = sheet.games.map((g) => {
    const done = !!g.item_id;
    const isNext = nextGame && nextGame.id === g.id;
    const detail = done
      ? `${g.gross_weight !== null ? `${num(g.gross_weight)} ${g.weight_unit} → ${money(g.quarters_amount)}` : 'no quarters'}${num(g.bills_amount) ? ` · bills ${money(g.bills_amount)}` : ''}${g.condition === 'issue' ? ' · <span style="color:#f0c265;">issue</span>' : ''}`
      : (isNext ? 'Tap to weigh' : 'Not weighed yet');
    return `<div class="am-game ${done ? 'done' : ''} ${g.condition === 'issue' ? 'issue' : ''} ${isNext ? 'next' : ''}" onclick="go('#weigh/${c.id}/${g.id}')">
      <span class="tick">${done ? ICON_TICK : ''}</span>
      <div class="body"><div class="name">${escapeHtml(g.name)} <span class="sub">· ${escapeHtml(g.tag_code)}${g.make || g.model ? ' · ' + escapeHtml([g.make, g.model].filter(Boolean).join(' ')) : ''}</span></div><div class="detail">${detail}</div></div>
      ${done ? `<div class="amt">${money(g.total)}</div>` : `<span style="color:${isNext ? 'var(--accent)' : 'var(--muted)'};">${ICON_CHEV}</span>`}
    </div>`;
  }).join('');

  const check = c.scale_check_g !== null
    ? `<div class="msg ${c.scale_check_ok ? 'success' : 'error'}" style="margin-bottom:10px;">Scale check: the $10 roll weighed ${num(c.scale_check_g)} g${c.scale_check_ok ? ' — good.' : ` — expected about ${num(SETTINGS.scale_check_roll_g)} g. Check the scale before weighing.`}</div>`
    : `<div class="card" style="padding:12px 14px; margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div><div style="font-weight:600; font-size:14px;">Scale check</div><div class="muted">Weigh the $10 roll of quarters first. It should read about ${num(SETTINGS.scale_check_roll_g)} g.</div></div>
          <button class="small secondary" style="margin:0; width:auto;" onclick="scaleCheckPrompt('${c.id}')">Check</button>
        </div></div>`;

  const period = c.period_start ? `Period: ${fmtDay(c.period_start)} → today (${daysAgo(c.period_start)} d)` : 'First collection here';
  document.querySelector('.wrap').classList.add('has-footer');
  $('panelMain').innerHTML = `
    ${headHtml(c.location_name + ' · collection', `${fmtDay(c.started_at)} · started ${fmtTime(c.started_at)} · ${period}`, '#home', badge('Draft', 'on'))}
    ${check}
    <button class="am-scanbar" onclick="go('#scan/${c.id}')">${ICON_SCAN}<span style="flex-grow:1;"><strong>Scan the game's sticker</strong> <span class="muted">· opens that game</span></span></button>
    <div class="am-kicker"><span>Games · ${sheet.progress.done} of ${sheet.progress.total} done</span><span style="color:#6be3a4; text-transform:none; letter-spacing:0;">${money(sheet.totals.total)} so far</span></div>
    ${rows || '<div class="card"><p class="muted">No games at this location. Add or move games under Games.</p></div>'}
    <div class="card" style="padding:10px 14px; border-style:dashed;"><div class="muted">Game not on this list? Add or move one from <a href="#games">Games</a>. ${sheet.progress.done === 0 ? `<a href="#" onclick="discardDraft('${c.id}'); return false;">Discard this collection.</a>` : ''}</div></div>
    <div class="am-footer"><div class="inner">
      <div class="totals">
        <div>Quarters<div class="v">${money(sheet.totals.quarters)}</div></div>
        <div>Bills<div class="v">${money(sheet.totals.bills)}</div></div>
        <div class="big">Total so far<div class="v">${money(sheet.totals.total)}</div></div>
      </div>
      <button class="primary" onclick="go('#review/${c.id}')" ${sheet.progress.done ? '' : 'disabled'}>Review &amp; finalize</button>
      <div class="muted" style="text-align:center;">Draft saves as you go.${sheet.progress.total - sheet.progress.done > 0 ? ` ${sheet.progress.total - sheet.progress.done} game${sheet.progress.total - sheet.progress.done === 1 ? '' : 's'} still to weigh.` : ''}</div>
    </div></div>`;
}

async function discardDraft(id) {
  if (!confirm('Discard this collection? Nothing has been weighed.')) return;
  try { await api(`/api/amusement/collections/${id}/discard`, { method: 'POST', body: {} }); go('#home'); }
  catch (e) { showMsg(e.message, 'error'); }
}

// The $10-roll check. Photo the scale with the roll on it (reader fills
// the grams), or just type what it says.
async function scaleCheckPrompt(collectionId) {
  const host = $('panelMain');
  const box = document.createElement('div');
  box.className = 'card';
  box.innerHTML = `
    <h2>Scale check</h2>
    <p class="muted" style="margin-top:-6px;">Put the $10 roll of quarters on the scale. Expected about ${num(SETTINGS.scale_check_roll_g)} g (±${num(SETTINGS.scale_check_tolerance_g)} g).</p>
    ${CAPS.photoReader ? `<button class="am-bigbtn" id="scPhoto">${ICON_CAMERA}<span><span class="t">Photo the scale display</span><br><span class="s">Reads the number for you</span></span></button><div class="am-or">or type what it shows</div>` : ''}
    <label for="scGrams">Grams</label>
    <input id="scGrams" type="number" inputmode="decimal" step="0.1" class="am-bigin" placeholder="${num(SETTINGS.scale_check_roll_g)}">
    <div id="scStatus"></div>
    <div class="stack-actions"><button class="secondary" id="scCancel">Skip</button><button class="primary" id="scSave" style="margin-top:10px;">Save check</button></div>`;
  host.prepend(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  let photoBlob = null;
  if ($('scPhoto')) $('scPhoto').onclick = async () => {
    const file = await pickPhoto();
    if (!file) return;
    $('scStatus').innerHTML = '<p class="muted">Reading the photo…</p>';
    photoBlob = await shrinkImage(file);
    const fd = new FormData();
    fd.append('photo', photoBlob, 'scale.jpg');
    try {
      const r = await apiUpload(`/api/amusement/collections/${collectionId}/read-scale`, fd);
      if (r.value !== null && r.value !== undefined) {
        const grams = r.unit === 'lb' ? r.value * GRAMS_PER_LB : r.value;
        $('scGrams').value = Math.round(grams * 10) / 10;
        $('scStatus').innerHTML = `<p class="muted">Read “${escapeHtml(r.raw || '')}” — check it matches the scale, then save.</p>`;
      } else {
        $('scStatus').innerHTML = `<p class="msg error">${escapeHtml(r.error || 'Could not read the photo — type the number instead.')}</p>`;
      }
    } catch (e) { $('scStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; }
  };
  $('scCancel').onclick = () => box.remove();
  $('scSave').onclick = async () => {
    const fd = new FormData();
    fd.append('grams', $('scGrams').value);
    if (photoBlob) fd.append('photo', photoBlob, 'scale.jpg');
    try {
      await apiUpload(`/api/amusement/collections/${collectionId}/scale-check`, fd);
      route();
    } catch (e) { $('scStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; }
  };
}

// ---------------------------------------------------------------------
// Scan a sticker
// ---------------------------------------------------------------------
function parseTag(text) {
  const s = String(text || '').trim();
  try {
    const u = new URL(s);
    const t = u.searchParams.get('tag');
    if (t) return t.toUpperCase();
  } catch (e) { /* not a URL */ }
  const m = s.match(/DA-?\d{1,6}/i);
  if (m) { const digits = m[0].replace(/\D/g, ''); return 'DA-' + digits.padStart(4, '0'); }
  return null;
}

async function openByTag(tag, collectionId) {
  const code = parseTag(tag);
  if (!code) { showMsg('That doesn\'t look like a game sticker.', 'error'); return; }
  let game;
  try { game = (await api('/api/amusement/games/by-tag/' + encodeURIComponent(code))).game; }
  catch (e) { showMsg(e.message, 'error'); return; }
  if (game.status !== 'active') { showMsg(`${game.name} is retired.`, 'error'); return; }
  // Scanned from inside a collection: it must be one of this location's
  // games, otherwise the sheet and the sticker disagree — say so.
  if (collectionId && SHEET && SHEET.collection.id === collectionId) {
    if (String(game.current_location_id) !== String(SHEET.collection.location_id)) {
      showMsg(`${game.name} is listed at ${game.location_name}, not ${SHEET.collection.location_name}. Move it under Games if it's really here.`, 'error');
      return;
    }
    go(`#weigh/${collectionId}/${game.id}`);
    return;
  }
  // Scanned cold (phone camera app): start or resume at the game's location.
  if (!game.current_location_id) { showMsg(`${game.name} isn't placed at a location yet.`, 'error'); return; }
  try {
    const r = await api('/api/amusement/collections/start', { method: 'POST', body: { locationId: game.current_location_id } });
    window.addEventListener('hashchange', route);
    go(`#weigh/${r.collectionId}/${game.id}`);
    if (!window.location.hash.startsWith('#weigh')) route();
  } catch (e) { showMsg(e.message, 'error'); }
}

async function renderScan(collectionId) {
  if (!SHEET || SHEET.collection.id !== collectionId) await loadSheet(collectionId);
  $('panelMain').innerHTML = `
    ${headHtml('Scan game sticker', SHEET.collection.location_name, '#collect/' + collectionId)}
    <div class="am-scanview"><video id="scanVideo" playsinline muted autoplay></video><div class="frame"></div><div class="hint">Point the camera at the sticker on the machine</div></div>
    <div id="scanStatus" class="muted" style="text-align:center; margin-bottom:10px;">Starting camera…</div>
    <div class="card">
      <label for="tagInput">No luck? Type the code on the sticker</label>
      <div style="display:flex; gap:8px;"><input id="tagInput" placeholder="DA-0007" autocapitalize="characters" style="flex-grow:1;"><button class="small" style="margin:0;" onclick="openByTag($('tagInput').value, '${collectionId}')">Open</button></div>
    </div>`;
  startScanner(collectionId);
}

async function startScanner(collectionId) {
  const video = $('scanVideo');
  const status = $('scanStatus');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status.textContent = 'This browser can\'t use the camera here — type the code below, or scan the sticker with your phone\'s camera app.'; return; }
  try {
    SCAN_STREAM = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    status.textContent = 'Camera permission was refused — type the code below, or scan the sticker with your phone\'s camera app.';
    return;
  }
  video.srcObject = SCAN_STREAM;
  await video.play().catch(() => {});
  status.textContent = 'Looking for a sticker…';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let detector = null;
  if (window.BarcodeDetector) { try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; } }
  let busy = false;
  SCAN_TIMER = setInterval(async () => {
    if (busy || !video.videoWidth) return;
    busy = true;
    try {
      let text = null;
      if (detector) {
        const codes = await detector.detect(video);
        if (codes.length) text = codes[0].rawValue;
      } else if (window.jsQR) {
        const w = Math.min(640, video.videoWidth);
        const h = Math.round(video.videoHeight * (w / video.videoWidth));
        canvas.width = w; canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (code && code.data) text = code.data;
      } else {
        status.textContent = 'QR reader still loading… or type the code below.';
      }
      if (text) {
        stopScanner();
        status.textContent = 'Found it.';
        await openByTag(text, collectionId);
        if (window.location.hash.startsWith('#scan')) startScanner(collectionId); // a bad tag: keep scanning
      }
    } catch (e) { /* keep trying */ }
    busy = false;
  }, 250);
}

function stopScanner() {
  if (SCAN_TIMER) { clearInterval(SCAN_TIMER); SCAN_TIMER = null; }
  if (SCAN_STREAM) { SCAN_STREAM.getTracks().forEach((t) => t.stop()); SCAN_STREAM = null; }
}

// ---------------------------------------------------------------------
// Weigh one game
// ---------------------------------------------------------------------
async function renderWeigh(collectionId, gameId) {
  const sheet = await loadSheet(collectionId);
  const c = sheet.collection;
  if (c.status === 'final') { go('#review/' + collectionId); return; }
  const g = sheet.games.find((x) => x.id === gameId);
  if (!g) { $('panelMain').innerHTML = errorCard(new Error('That game is not on this sheet. Move it here under Games first.')); return; }
  const idx = sheet.games.findIndex((x) => x.id === gameId);
  const nextGame = sheet.games.slice(idx + 1).find((x) => !x.item_id) || sheet.games.find((x) => !x.item_id && x.id !== gameId);
  const unit = g.item_id ? g.weight_unit : (SETTINGS.weight_unit || 'g');
  const tare = g.item_id ? num(g.tare_weight) : defaultTareFor(unit);
  const state = {
    unit, gross: g.item_id && g.gross_weight !== null ? num(g.gross_weight) : '', tare,
    photoPath: g.weight_photo_path || null, readValue: g.item_id ? g.weight_read_value : null, readUnit: g.item_id ? g.weight_read_unit : null,
    localPhotoUrl: null, condition: g.condition || 'ok',
  };

  $('panelMain').innerHTML = `
    ${headHtml(g.name, `${escapeHtml([g.make, g.model].filter(Boolean).join(' ') || typeLabel(g.game_type))} · ${c.location_name} · game ${idx + 1} of ${sheet.games.length}`, '#collect/' + collectionId, `<span class="muted" style="white-space:nowrap;">${money(g.price_per_play)} / play</span>`)}
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <div class="am-kicker" style="margin:0;">Quarters · by weight</div>
        <div class="am-unit-toggle"><button id="unitG" class="${unit === 'g' ? 'on' : ''}">g</button><button id="unitLb" class="${unit === 'lb' ? 'on' : ''}">lb</button></div>
      </div>
      <div id="photoBox"></div>
      ${CAPS.photoReader ? `<button class="am-bigbtn" id="photoBtn">${ICON_CAMERA}<span><span class="t">Photo the scale display</span><br><span class="s">Reads the number for you · you confirm it</span></span></button><div class="am-or">or type what the scale shows</div>` : ''}
      <div id="readBox"></div>
      <div class="am-grid2">
        <div><label for="gross">Gross (<span id="unitLabel1">${unit}</span>)</label><input id="gross" type="number" inputmode="decimal" step="any" class="am-bigin" value="${state.gross}" placeholder="0"></div>
        <div><label for="tare">Bucket tare (<span id="unitLabel2">${unit}</span>)</label><input id="tare" type="number" inputmode="decimal" step="any" class="am-bigin" value="${tare}"></div>
      </div>
      <div class="am-conv"><span id="convText">—</span><span class="v" id="convDollars">$0.00</span></div>
      <div class="muted" style="font-size:11px; margin-top:6px;">1 quarter = ${num(SETTINGS.quarter_weight_g)} g. Rounded to the nearest coin.</div>
    </div>

    <div class="card">
      <div class="am-kicker" style="margin:0 0 10px;">Bills${g.accepts_bills ? ' · from acceptor' : ''}</div>
      <div class="am-grid4">
        <div><label for="b1">$1 ×</label><input id="b1" type="number" inputmode="numeric" min="0" value="${g.item_id ? g.bills_1 : ''}" placeholder="0"></div>
        <div><label for="b5">$5 ×</label><input id="b5" type="number" inputmode="numeric" min="0" value="${g.item_id ? g.bills_5 : ''}" placeholder="0"></div>
        <div><label for="b10">$10 ×</label><input id="b10" type="number" inputmode="numeric" min="0" value="${g.item_id ? g.bills_10 : ''}" placeholder="0"></div>
        <div><label for="b20">$20 ×</label><input id="b20" type="number" inputmode="numeric" min="0" value="${g.item_id ? g.bills_20 : ''}" placeholder="0"></div>
      </div>
      <div class="am-conv"><span>Bills total <span class="muted">(or type a flat amount)</span></span><span style="display:flex; align-items:center; gap:6px;"><span class="muted">$</span><input id="billsFlat" type="number" inputmode="decimal" step="0.01" min="0" style="width:110px; margin:0; font-weight:700; text-align:right;" value="${g.item_id && g.bills_flat_amount !== null ? num(g.bills_flat_amount) : ''}" placeholder="0.00"></span></div>
    </div>

    <div class="card">
      <div class="am-grid2">
        <div><label for="meter">Coin meter (optional)</label><input id="meter" type="number" inputmode="numeric" min="0" value="${g.item_id && g.meter_reading !== null ? g.meter_reading : ''}" placeholder="—"></div>
        <div><label>Condition</label><div class="am-cond"><button type="button" class="ok ${state.condition === 'ok' ? 'on' : ''}" id="condOk">OK</button><button type="button" class="issue ${state.condition === 'issue' ? 'on' : ''}" id="condIssue">Issue</button></div></div>
      </div>
      <label for="note">Note</label><input id="note" placeholder="e.g. coin jam, bill acceptor rejecting $20s" value="${escapeHtml(g.note || '')}">
    </div>
    <div id="saveStatus"></div>
    <div class="am-footer"><div class="inner">
      <div style="display:flex; justify-content:space-between; align-items:baseline;"><span class="muted">This game</span><span style="font-size:26px; font-weight:800; color:#6be3a4; font-variant-numeric: tabular-nums;" id="gameTotal">$0.00</span></div>
      <button class="primary" id="saveBtn">${g.item_id ? 'Save changes' : (nextGame ? `Save &amp; next → ${escapeHtml(nextGame.name)}` : 'Save')}</button>
      ${g.item_id ? `<button class="ghost small" style="width:100%;" id="clearBtn">Remove this game's entry</button>` : ''}
    </div></div>`;
  document.querySelector('.wrap').classList.add('has-footer');

  const recalc = () => {
    const p = previewQuarters($('gross').value, $('tare').value, state.unit);
    const bills = billsPreview();
    if (p) {
      $('convText').textContent = `${Math.round(p.netG)} g net ≈ ${p.coins.toLocaleString()} quarters`;
      $('convDollars').textContent = money(p.dollars);
    } else { $('convText').textContent = 'Enter the gross weight'; $('convDollars').textContent = '$0.00'; }
    $('gameTotal').textContent = money((p ? p.dollars : 0) + bills);
  };
  const billsPreview = () => {
    const counted = num($('b1').value) + num($('b5').value) * 5 + num($('b10').value) * 10 + num($('b20').value) * 20;
    return counted > 0 ? counted : num($('billsFlat').value);
  };
  ['gross', 'tare', 'b1', 'b5', 'b10', 'b20', 'billsFlat'].forEach((id) => { $(id).addEventListener('input', recalc); });
  const setUnit = (u) => {
    if (state.unit === u) return;
    const gross = num($('gross').value, NaN);
    const t = num($('tare').value, NaN);
    const conv = (v) => (u === 'lb' ? v / GRAMS_PER_LB : v * GRAMS_PER_LB);
    if (Number.isFinite(gross) && $('gross').value !== '') $('gross').value = Number(conv(gross).toFixed(u === 'lb' ? 3 : 0));
    if (Number.isFinite(t)) $('tare').value = Number(conv(t).toFixed(u === 'lb' ? 3 : 0));
    state.unit = u;
    $('unitG').className = u === 'g' ? 'on' : ''; $('unitLb').className = u === 'lb' ? 'on' : '';
    $('unitLabel1').textContent = u; $('unitLabel2').textContent = u;
    recalc();
  };
  $('unitG').onclick = () => setUnit('g');
  $('unitLb').onclick = () => setUnit('lb');
  $('condOk').onclick = () => { state.condition = 'ok'; $('condOk').classList.add('on'); $('condIssue').classList.remove('on'); };
  $('condIssue').onclick = () => { state.condition = 'issue'; $('condIssue').classList.add('on'); $('condOk').classList.remove('on'); };

  const renderPhotoBox = async () => {
    const url = state.localPhotoUrl || (state.photoPath ? await photoUrlFor(state.photoPath) : null);
    if (!url) { $('photoBox').innerHTML = ''; return; }
    $('photoBox').innerHTML = `<div class="am-photo"><img src="${url}" alt="Scale display"><div class="bar"><span>${state.photoPath ? 'Photo saved with this reading' : 'Photo not stored (storage off) — reading kept'}</span>${CAPS.photoReader ? '<a href="#" id="retake">Retake</a>' : ''}</div></div>`;
    if ($('retake')) $('retake').onclick = (e) => { e.preventDefault(); $('photoBtn').click(); };
  };
  if ($('photoBtn')) $('photoBtn').onclick = async () => {
    const file = await pickPhoto();
    if (!file) return;
    $('photoBtn').disabled = true;
    $('readBox').innerHTML = '<p class="muted" style="text-align:center;">Reading the photo…</p>';
    try {
      const blob = await shrinkImage(file);
      if (state.localPhotoUrl) URL.revokeObjectURL(state.localPhotoUrl);
      state.localPhotoUrl = URL.createObjectURL(blob);
      const fd = new FormData();
      fd.append('photo', blob, 'scale.jpg');
      const r = await apiUpload(`/api/amusement/collections/${collectionId}/read-scale`, fd);
      state.photoPath = r.photoPath || state.photoPath;
      await renderPhotoBox();
      if (r.value !== null && r.value !== undefined) {
        state.readValue = r.value; state.readUnit = r.unit;
        setUnit(r.unit === 'lb' ? 'lb' : 'g');
        $('gross').value = r.value;
        recalc();
        $('readBox').innerHTML = `<div class="am-warn">${ICON_WARN}<span><strong>We read ${escapeHtml(String(r.value))} ${escapeHtml(r.unit)}${r.confidence === 'low' ? ' (not sure)' : ''}.</strong> ${escapeHtml(ME.name.split(' ')[0])}, check it matches the scale — fix the number below if not, then save. Your confirmation is recorded with the photo.</span></div>`;
      } else {
        $('readBox').innerHTML = `<p class="msg error">${escapeHtml(r.error || 'Could not read the display — type the number below.')}</p>`;
      }
    } catch (e) {
      $('readBox').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
    }
    $('photoBtn').disabled = false;
  };

  $('saveBtn').onclick = async () => {
    const grossRaw = $('gross').value;
    const hasBills = billsPreview() > 0;
    if (grossRaw === '' && !hasBills) { $('saveStatus').innerHTML = '<p class="msg error">Enter the weight, or bills, before saving. If the game earned nothing, enter 0.</p>'; return; }
    $('saveBtn').disabled = true;
    try {
      await api(`/api/amusement/collections/${collectionId}/items/${gameId}`, { method: 'POST', body: {
        grossWeight: grossRaw === '' ? null : grossRaw, tareWeight: $('tare').value, weightUnit: state.unit,
        bills1: $('b1').value, bills5: $('b5').value, bills10: $('b10').value, bills20: $('b20').value, billsFlatAmount: $('billsFlat').value,
        meterReading: $('meter').value, condition: state.condition, note: $('note').value,
        weightPhotoPath: state.photoPath, weightReadValue: state.readValue, weightReadUnit: state.readUnit,
      } });
      if (state.localPhotoUrl) URL.revokeObjectURL(state.localPhotoUrl);
      if (!g.item_id && nextGame) go(`#weigh/${collectionId}/${nextGame.id}`);
      else go('#collect/' + collectionId);
    } catch (e) {
      $('saveStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
      $('saveBtn').disabled = false;
    }
  };
  if ($('clearBtn')) $('clearBtn').onclick = async () => {
    if (!confirm(`Remove ${g.name}'s entry from this collection?`)) return;
    try { await api(`/api/amusement/collections/${collectionId}/items/${gameId}/remove`, { method: 'POST', body: {} }); go('#collect/' + collectionId); }
    catch (e) { $('saveStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; }
  };
  recalc();
  renderPhotoBox();
}

// ---------------------------------------------------------------------
// Review / finalize / POS
// ---------------------------------------------------------------------
async function renderReview(collectionId) {
  const sheet = await loadSheet(collectionId);
  const c = sheet.collection;
  const done = sheet.games.filter((g) => g.item_id);
  const missing = sheet.games.filter((g) => !g.item_id);
  const days = Math.max(1, daysAgo(c.period_start || c.started_at) || 1);
  const isFinal = c.status === 'final';
  const rows = done.map((g) => `<tr>
      <td>${escapeHtml(g.name)}${g.condition === 'issue' ? ' <span class="badge stale">issue</span>' : ''}${g.note ? `<div class="muted" style="font-size:11px;">${escapeHtml(g.note)}</div>` : ''}</td>
      <td class="r muted">${g.gross_weight !== null ? `${num(g.gross_weight)} ${g.weight_unit}` : '—'}</td>
      <td class="r muted">${num(g.bills_amount) ? money(g.bills_amount) : '—'}</td>
      <td class="r b">${money(g.total)}</td></tr>`).join('');
  const posBlock = isFinal
    ? (c.pos_status === 'posted'
      ? `<div class="msg success">Rung into SpotOn ${fmtDay(c.pos_posted_at)} ${fmtTime(c.pos_posted_at)} by ${escapeHtml(c.pos_posted_by_name || '')}${c.pos_reference ? ` · ref ${escapeHtml(c.pos_reference)}` : ''}. <a href="#" onclick="markPosted('${c.id}', true); return false;">Undo</a></div>`
      : `<div class="card"><div class="am-kicker" style="margin:0 0 8px;">SpotOn</div>
          <p style="margin:0 0 8px;">Ring <strong>${money(c.total)}</strong> into ${escapeHtml(c.location_name)}'s SpotOn as an <strong>${escapeHtml(c.pos_department || 'Amusement')}</strong> sale, then mark it here.</p>
          <label for="posRef">Ticket / reference (optional)</label><input id="posRef" placeholder="SpotOn ticket #">
          <button class="primary" onclick="markPosted('${c.id}', false)">Mark posted to SpotOn</button></div>`)
    : `<div class="card"><div class="am-kicker" style="margin:0 0 10px;">What happens on finalize</div>
        <div class="am-steps">
          <div class="s"><span class="num">1</span><span>The sheet locks. Per-game amounts, weights and photos are kept for reports.</span></div>
          <div class="s"><span class="num">2</span><span>A <strong>${money(sheet.totals.total)} ${escapeHtml(c.pos_department || 'Amusement')}</strong> sale is queued for ${escapeHtml(c.location_name)}'s SpotOn.</span></div>
          <div class="s"><span class="num">3</span><span>Whoever rings it in taps <strong>Mark posted</strong> so the two systems agree.</span></div>
        </div></div>`;

  document.querySelector('.wrap').classList.toggle('has-footer', !isFinal);
  $('panelMain').innerHTML = `
    ${headHtml(`${c.location_name} · ${fmtDay(c.finalized_at || c.started_at)}`, `${isFinal ? `Finalized ${fmtTime(c.finalized_at)} by ${c.finalized_by_name || ''}` : 'Review'} · ${days}-day period`, isFinal ? '#home' : '#collect/' + collectionId, badge(isFinal ? (c.pos_status === 'posted' ? 'Posted' : 'Final · not in SpotOn') : 'Review', isFinal ? (c.pos_status === 'posted' ? 'on' : 'stale') : 'on'))}
    <div class="card am-total"><div class="l">COLLECTION TOTAL</div><div class="n">${money(sheet.totals.total)}</div>
      <div class="meta"><span>Quarters ${money(sheet.totals.quarters)}</span><span>Bills ${money(sheet.totals.bills)}</span><span>${money(sheet.totals.total / days)} / day</span></div></div>
    ${c.scale_check_g !== null ? `<div class="muted" style="margin:-6px 0 12px; text-align:center;">Scale check: $10 roll weighed ${num(c.scale_check_g)} g${c.scale_check_ok ? ' ✓' : ' (out of tolerance)'}</div>` : ''}
    ${missing.length && !isFinal ? `<div class="msg error">Not weighed yet: ${escapeHtml(missing.map((g) => g.name).join(', '))}. Finalize will record them as $0 if you continue.</div>` : ''}
    <div class="card" style="padding:4px 16px;"><table class="am-table"><thead><tr><th>Game</th><th class="r">Weight</th><th class="r">Bills</th><th class="r">Total</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${posBlock}
    ${isFinal ? `<div class="card"><label for="cnote">Collection note</label><input id="cnote" value="${escapeHtml(c.note || '')}" placeholder="Anything to remember about this visit"><button class="secondary" onclick="saveNote('${c.id}')">Save note</button></div>` : ''}
    <div id="reviewStatus"></div>
    ${!isFinal ? `<div class="am-footer"><div class="inner">
      <button class="primary" onclick="finalize('${c.id}', ${missing.length ? 'true' : 'false'})">Finalize · ${money(sheet.totals.total)}</button>
      <div class="am-grid2"><a class="secondary" style="text-align:center; padding:11px; border-radius:10px; border:1px solid var(--card-border); color:var(--muted); font-weight:600; font-size:14px; text-decoration:none;" href="#collect/${c.id}">Back to sheet</a><button class="ghost" style="margin:0; width:100%;" onclick="window.print()">Print / share</button></div>
    </div></div>` : ''}`;
}

async function finalize(id, hasMissing) {
  if (hasMissing && !confirm('Some games haven\'t been weighed. Finalize anyway and record them as $0?')) return;
  try {
    await api(`/api/amusement/collections/${id}/finalize`, { method: 'POST', body: { allowMissing: hasMissing } });
    go('#review/' + id);
    route();
  } catch (e) { $('reviewStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; }
}
async function markPosted(id, undo) {
  try {
    await api(`/api/amusement/collections/${id}/posted`, { method: 'POST', body: { undo, reference: $('posRef') ? $('posRef').value : null } });
    route();
  } catch (e) { showMsg(e.message, 'error'); }
}
async function saveNote(id) {
  try { await api(`/api/amusement/collections/${id}/note`, { method: 'POST', body: { note: $('cnote').value } }); showMsg('Note saved.', 'success'); }
  catch (e) { showMsg(e.message, 'error'); }
}

// ---------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------
async function renderGames() {
  const [gr, lr] = await Promise.all([api('/api/amusement/games?all=1'), api('/api/amusement/locations' + (LEVEL === 'owner' ? '?all=1' : ''))]);
  LOCATIONS = lr.locations;
  const games = gr.games;
  const isOwner = LEVEL === 'owner';
  const filters = [['all', `All · ${games.filter((g) => g.status === 'active').length}`]]
    .concat(LOCATIONS.filter((l) => l.active).map((l) => [l.id, `${l.name} · ${games.filter((g) => g.status === 'active' && g.current_location_id === l.id).length}`]))
    .concat([['retired', `Retired · ${games.filter((g) => g.status === 'retired').length}`]]);
  const shown = games.filter((g) => GAMES_FILTER === 'all' ? g.status === 'active' : GAMES_FILTER === 'retired' ? g.status === 'retired' : (g.status === 'active' && g.current_location_id === GAMES_FILTER));
  const byLoc = {};
  shown.forEach((g) => { const k = g.location_name || 'Unplaced'; (byLoc[k] = byLoc[k] || []).push(g); });
  const sections = Object.keys(byLoc).map((loc) => `
    <div class="am-kicker">${escapeHtml(loc)}</div>
    <div class="card" style="padding:4px 14px;">${byLoc[loc].map((g) => `
      <div class="list-row am-tap" onclick="go('#game/${g.id}')">
        <div><div class="name">${escapeHtml(g.name)}${g.last_condition === 'issue' ? ' <span class="badge stale">issue</span>' : ''}${g.status === 'retired' ? ' <span class="badge off">retired</span>' : ''}</div>
          <div class="sub">${escapeHtml(typeLabel(g.game_type))}${g.make || g.model ? ' · ' + escapeHtml([g.make, g.model].filter(Boolean).join(' ')) : ''} · ${money(g.price_per_play)}/play · ${g.accepts_bills ? 'quarters + bills' : 'quarters only'} · ${escapeHtml(g.tag_code)}</div></div>
        <div style="text-align:right;">${g.per_day_90d !== null ? `<div style="font-weight:600; font-variant-numeric: tabular-nums;">${money(g.per_day_90d)}/day</div><div class="muted" style="font-size:11px;">90-day</div>` : '<div class="muted" style="font-size:11px;">no data</div>'}</div>
      </div>`).join('')}</div>`).join('');

  $('panelMain').innerHTML = `
    ${headHtml('Games', `${games.filter((g) => g.status === 'active').length} active`, null, isOwner ? `<button class="small" style="margin:0;" onclick="gameForm()">+ Add game</button>` : '')}
    <div class="am-filter">${filters.map(([k, label]) => `<button class="${GAMES_FILTER === k ? 'on' : ''}" onclick="GAMES_FILTER='${k}'; renderGames()">${escapeHtml(label)}</button>`).join('')}</div>
    <div id="gameFormBox"></div>
    ${sections || '<div class="card"><p class="muted">Nothing here yet.</p></div>'}
    ${isOwner ? `<div class="am-kicker">Admin</div><div class="card" style="padding:4px 14px;">
      <div class="list-row am-tap" onclick="go('#locations')"><div><div class="name">Locations</div><div class="sub">Which bars have games, collection cadence, POS department</div></div>${ICON_CHEV}</div>
      <div class="list-row am-tap" onclick="window.open('/amusement-tags.html', '_blank')"><div><div class="name">Print QR stickers</div><div class="sub">One sticker per active game, for scanning at the machine</div></div>${ICON_CHEV}</div>
      <div class="list-row am-tap" onclick="go('#settings')"><div><div class="name">Settings</div><div class="sub">Quarter weight, bucket tare, scale-check roll</div></div>${ICON_CHEV}</div>
    </div>` : ''}`;
}

function gameForm(game) {
  const g = game || {};
  const box = $('gameFormBox');
  const placeable = LOCATIONS.filter((l) => l.active);
  box.innerHTML = `<div class="card am-inline-form">
    <h2>${g.id ? 'Edit game' : 'Add a game'}</h2>
    <label for="gfName">Name</label><input id="gfName" value="${escapeHtml(g.name || '')}" placeholder="Pool table 1">
    <div class="am-grid2">
      <div><label for="gfType">Type</label><select id="gfType">${GAME_TYPES.map(([k, l]) => `<option value="${k}" ${g.game_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${!g.id ? `<div><label for="gfLoc">Where is it</label><select id="gfLoc">${placeable.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}</select></div>` : '<div></div>'}
    </div>
    <div class="am-grid2">
      <div><label for="gfMake">Make</label><input id="gfMake" value="${escapeHtml(g.make || '')}" placeholder="Valley"></div>
      <div><label for="gfModel">Model</label><input id="gfModel" value="${escapeHtml(g.model || '')}" placeholder="7 ft"></div>
    </div>
    <div class="am-grid2">
      <div><label for="gfSerial">Serial</label><input id="gfSerial" value="${escapeHtml(g.serial || '')}"></div>
      <div><label for="gfPrice">Price per play ($)</label><input id="gfPrice" type="number" step="0.25" min="0" value="${g.id ? num(g.price_per_play) : '1.00'}"></div>
    </div>
    <div class="toggle-row" style="margin-top:12px;"><span class="label">Takes bills</span><label class="switch"><input type="checkbox" id="gfBills" ${g.accepts_bills ? 'checked' : ''}><span class="slider"></span></label></div>
    <label for="gfNotes">Notes</label><input id="gfNotes" value="${escapeHtml(g.notes || '')}">
    <div id="gfStatus"></div>
    <div class="stack-actions"><button class="secondary" onclick="$('gameFormBox').innerHTML=''">Cancel</button><button class="primary" style="margin-top:10px;" id="gfSave">${g.id ? 'Save' : 'Add game'}</button></div>
  </div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('gfSave').onclick = async () => {
    const body = { name: $('gfName').value, gameType: $('gfType').value, make: $('gfMake').value, model: $('gfModel').value, serial: $('gfSerial').value,
      pricePerPlay: $('gfPrice').value, acceptsBills: $('gfBills').checked, notes: $('gfNotes').value };
    if (!g.id) body.locationId = $('gfLoc').value;
    try {
      const r = await withStepUp(() => api(g.id ? `/api/amusement/games/${g.id}/update` : '/api/amusement/games', { method: 'POST', body }));
      box.innerHTML = '';
      if (g.id) renderGameDetail(g.id); else { showMsg(`${r.game.name} added as ${r.game.tag_code}.`, 'success'); renderGames(); }
    } catch (e) { $('gfStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; }
  };
}

async function renderGameDetail(id) {
  const [d, lr] = await Promise.all([api('/api/amusement/games/' + id), api('/api/amusement/locations' + (LEVEL === 'owner' ? '?all=1' : ''))]);
  LOCATIONS = lr.locations;
  const g = d.game;
  const isOwner = LEVEL === 'owner';
  const hist = d.history.map((h) => `<tr><td>${fmtDay(h.finalized_at)}<div class="muted" style="font-size:11px;">${escapeHtml(h.location_name)}</div></td>
    <td class="r muted">${h.gross_weight !== null ? `${num(h.gross_weight)} ${h.weight_unit}` : '—'}</td><td class="r muted">${num(h.bills_amount) ? money(h.bills_amount) : '—'}</td>
    <td class="r b">${money(h.total)}<div class="muted" style="font-size:11px; font-weight:400;">${money(h.per_day)}/day</div></td></tr>`).join('');
  const places = d.placements.map((p) => `<div style="display:flex; justify-content:space-between; font-size:13px; padding:4px 0;"><span>${escapeHtml(p.location_name)}</span><span class="muted">${fmtDay(p.from_at)} → ${p.to_at ? fmtDay(p.to_at) : 'now'}</span></div>`).join('');
  $('panelMain').innerHTML = `
    ${headHtml(g.name, `${typeLabel(g.game_type)} · ${g.location_name || 'unplaced'} · ${g.tag_code}`, '#games', g.status === 'retired' ? badge('Retired', 'off') : '')}
    <div id="gameFormBox"></div>
    <div class="card">
      <div class="am-kv">
        <div><div class="k">Make / model</div><div>${escapeHtml([g.make, g.model].filter(Boolean).join(' ') || '—')}</div></div>
        <div><div class="k">Serial</div><div>${escapeHtml(g.serial || '—')}</div></div>
        <div><div class="k">Price per play</div><div>${money(g.price_per_play)} (${Math.round(num(g.price_per_play) * 4)} quarters)</div></div>
        <div><div class="k">Takes bills</div><div>${g.accepts_bills ? 'Yes' : 'No'}</div></div>
        <div><div class="k">Sticker</div><div>${escapeHtml(g.tag_code)}</div></div>
        <div><div class="k">Added</div><div>${fmtDate(g.created_at)}</div></div>
      </div>
      ${g.notes ? `<p class="muted" style="margin:10px 0 0;">${escapeHtml(g.notes)}</p>` : ''}
      <div style="padding-top:10px; margin-top:10px; border-top:1px solid var(--card-border);"><div class="k muted" style="font-size:11px; margin-bottom:4px;">Placement history</div>${places || '<div class="muted">—</div>'}</div>
      ${isOwner ? `<div class="am-actions3">
        <button class="secondary" onclick="gameForm(${JSON.stringify(g).replace(/"/g, '&quot;')})">Edit</button>
        <button class="ghost" onclick="movePrompt('${g.id}')">Move…</button>
        ${g.status === 'retired' ? `<button class="ghost" onclick="gameStatus('${g.id}', 'reactivate')">Reactivate</button>` : `<button class="ghost" style="color:#ff8a9a;" onclick="gameStatus('${g.id}', 'retire')">Retire</button>`}
      </div><div id="moveBox"></div>` : ''}
    </div>
    <div class="am-kicker">Earnings history</div>
    <div class="card" style="padding:4px 16px;">${hist ? `<table class="am-table"><thead><tr><th>Collected</th><th class="r">Weight</th><th class="r">Bills</th><th class="r">Total</th></tr></thead><tbody>${hist}</tbody></table>` : '<p class="muted">No collections yet.</p>'}</div>`;
}

function movePrompt(id) {
  $('moveBox').innerHTML = `<div style="margin-top:10px;"><label for="mvLoc">Move to</label><select id="mvLoc">${LOCATIONS.filter((l) => l.active).map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}</select>
    <button class="primary" onclick="moveGame('${id}')">Move game</button><div id="mvStatus"></div></div>`;
}
async function moveGame(id) {
  try { await withStepUp(() => api(`/api/amusement/games/${id}/move`, { method: 'POST', body: { locationId: $('mvLoc').value } })); renderGameDetail(id); }
  catch (e) { $('mvStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; }
}
async function gameStatus(id, action) {
  if (action === 'retire' && !confirm('Retire this game? It leaves the collection sheets but keeps its history.')) return;
  try { await withStepUp(() => api(`/api/amusement/games/${id}/${action}`, { method: 'POST', body: {} })); renderGameDetail(id); }
  catch (e) { showMsg(e.message, 'error'); }
}

// ---------------------------------------------------------------------
// Locations (owner)
// ---------------------------------------------------------------------
async function renderLocations() {
  const [lr, bars] = await Promise.all([api('/api/amusement/locations?all=1'), api('/api/locations')]);
  LOCATIONS = lr.locations;
  const rows = LOCATIONS.map((l) => `<div class="list-row">
    <div><div class="name">${escapeHtml(l.name)}${!l.active ? ' <span class="badge off">archived</span>' : ''}${l.is_storage ? ' <span class="badge off">storage</span>' : ''}</div>
      <div class="sub">${l.is_storage ? 'Not collected' : `Every ${l.collect_every_days} days · POS dept: ${escapeHtml(l.pos_department)}${l.bar_name ? ' · ' + escapeHtml(l.bar_name) : ''}`} · ${l.game_count} game${l.game_count === 1 ? '' : 's'}</div></div>
    <button class="small ghost" style="margin:0;" onclick='locForm(${JSON.stringify(l).replace(/'/g, '&#39;')})'>Edit</button></div>`).join('');
  $('panelMain').innerHTML = `
    ${headHtml('Locations', 'Where games live', '#games', `<button class="small" style="margin:0;" onclick="locForm()">+ Add</button>`)}
    <div id="locFormBox"></div>
    <div class="card" style="padding:4px 14px;">${rows}</div>`;
  window.__bars = bars;
}
function locForm(l) {
  l = l || {};
  const bars = window.__bars || [];
  $('locFormBox').innerHTML = `<div class="card am-inline-form">
    <h2>${l.id ? 'Edit location' : 'Add a location'}</h2>
    <label for="lfName">Name</label><input id="lfName" value="${escapeHtml(l.name || '')}">
    <label for="lfBar">Which bar (for SpotOn)</label><select id="lfBar"><option value="">— not one of ours —</option>${bars.map((b) => `<option value="${b.id}" ${l.location_id === b.id ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}</select>
    <div class="am-grid2">
      <div><label for="lfDept">POS department</label><input id="lfDept" value="${escapeHtml(l.pos_department || 'Amusement')}"></div>
      <div><label for="lfDays">Collect every (days)</label><input id="lfDays" type="number" min="1" value="${l.collect_every_days || 14}"></div>
    </div>
    ${l.id ? `<div class="toggle-row" style="margin-top:12px;"><span class="label">Active</span><label class="switch"><input type="checkbox" id="lfActive" ${l.active !== false ? 'checked' : ''}><span class="slider"></span></label></div>` : ''}
    <div id="lfStatus"></div>
    <div class="stack-actions"><button class="secondary" onclick="$('locFormBox').innerHTML=''">Cancel</button><button class="primary" style="margin-top:10px;" id="lfSave">Save</button></div></div>`;
  $('lfSave').onclick = async () => {
    const body = { name: $('lfName').value, locationId: $('lfBar').value || null, posDepartment: $('lfDept').value, collectEveryDays: $('lfDays').value };
    if (l.id) body.active = $('lfActive').checked;
    try { await withStepUp(() => api(l.id ? `/api/amusement/locations/${l.id}/update` : '/api/amusement/locations', { method: 'POST', body })); renderLocations(); }
    catch (e) { $('lfStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; }
  };
}

// ---------------------------------------------------------------------
// Reports (owner)
// ---------------------------------------------------------------------
async function renderReports(daysArg) {
  const days = num(daysArg, 90);
  const r = await api('/api/amusement/report?days=' + days);
  const s = r.summary;
  const withData = r.byGame.filter((g) => g.per_day !== null);
  const max = Math.max(1, ...withData.map((g) => g.per_day));
  const avg = s.avg_per_day_per_game || 0;
  const bars = withData.map((g) => `<div style="display:grid; grid-template-columns: 1fr 64px; gap:8px; align-items:center; margin-bottom:8px;">
      <div><div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:3px;"><span>${escapeHtml(g.name)} <span class="muted">· ${escapeHtml(g.location_name || '')}</span>${g.issues ? ' <span class="badge stale" style="font-size:10px;">issue</span>' : ''}</span></div>
        <div class="am-bar ${g.per_day < avg * 0.6 ? 'low' : ''}"><div style="width:${Math.round((g.per_day / max) * 100)}%"></div></div></div>
      <div style="text-align:right; font-weight:600; font-variant-numeric: tabular-nums;">${money(g.per_day)}<div class="muted" style="font-size:10px; font-weight:400;">/day</div></div></div>`).join('');
  const noData = r.byGame.filter((g) => g.per_day === null && g.status === 'active').map((g) => escapeHtml(g.name)).join(', ');
  const locs = r.byLocation.map((l) => `<div class="list-row"><div><div class="name">${escapeHtml(l.name)}</div><div class="sub">${l.collections} collection${l.collections === 1 ? '' : 's'}${l.queued_pos ? ` · <span style="color:#f0c265;">${l.queued_pos} not in SpotOn</span>` : ''}</div></div>
    <div style="text-align:right;"><div style="font-weight:700;">${money(l.earned)}</div><div class="muted" style="font-size:11px;">${l.per_day !== null ? money(l.per_day) + '/day' : '—'}</div></div></div>`).join('');
  const log = r.log.slice(0, 30).map((c) => `<div class="list-row am-tap" onclick="go('#review/${c.id}')"><div><div class="name">${fmtDay(c.finalized_at)} · ${escapeHtml(c.location_name)}</div><div class="sub">${escapeHtml(c.finalized_by_name || '')} · ${c.item_count} games${c.issue_count ? ` · ${c.issue_count} issue${c.issue_count === 1 ? '' : 's'}` : ''}</div></div>
    <div style="text-align:right;"><div style="font-weight:700;">${money(c.total)}</div><div style="font-size:11px; color:${c.pos_status === 'posted' ? '#6be3a4' : '#f0c265'};">${c.pos_status === 'posted' ? 'Posted' : 'Queued'}</div></div></div>`).join('');
  $('panelMain').innerHTML = `
    ${headHtml('Reports', `Last ${r.days} days`)}
    <div class="am-filter">${[30, 90, 180, 365].map((d) => `<button class="${r.days === d ? 'on' : ''}" onclick="go('#reports/${d}')">${d === 365 ? 'Year' : d + ' days'}</button>`).join('')}</div>
    <div class="am-stats">
      <div class="card"><div class="n">${money(s.earned)}</div><div class="l">Collected</div></div>
      <div class="card"><div class="n">${s.avg_per_day_per_game !== null ? money(s.avg_per_day_per_game) : '—'}</div><div class="l">Per game per day</div></div>
      <div class="card"><div class="n">${s.quarters_share !== null ? s.quarters_share + '%' : '—'}</div><div class="l">Quarters vs bills</div></div>
    </div>
    <div class="am-stats" style="margin-top:10px;">
      <div class="card"><div class="n">${s.collections}</div><div class="l">Collections</div></div>
      <div class="card"><div class="n" style="color:${s.queued_pos ? '#f0c265' : 'inherit'}">${s.queued_pos}</div><div class="l">Not in SpotOn</div></div>
      <div class="card"><div class="n" style="color:${s.games_with_issues ? '#f0c265' : 'inherit'}">${s.games_with_issues}</div><div class="l">Games with issues</div></div>
    </div>
    <div class="am-kicker">Earnings per game · $/day · best to worst</div>
    <div class="card">${bars || '<p class="muted">No finalized collections in this window.</p>'}${noData ? `<p class="muted" style="font-size:11px; margin:6px 0 0;">No data yet: ${noData}</p>` : ''}<p class="muted" style="font-size:11px; margin:8px 0 0;">Amber bars are well below the route average — the “which game should move or go?” view.</p></div>
    <div class="am-kicker">By location</div>
    <div class="card" style="padding:4px 14px;">${locs}</div>
    <div class="am-kicker">Collection log</div>
    <div class="card" style="padding:4px 14px;">${log || '<p class="muted">Nothing yet.</p>'}</div>`;
}

// ---------------------------------------------------------------------
// Settings (owner)
// ---------------------------------------------------------------------
async function renderSettings() {
  const s = (await api('/api/amusement/settings')).settings;
  SETTINGS = s;
  $('panelMain').innerHTML = `
    ${headHtml('Settings', 'Weights and the scale check', '#games')}
    <div class="card am-inline-form">
      <label for="stQ">Weight of one quarter (grams)</label><input id="stQ" type="number" step="0.001" value="${num(s.quarter_weight_g)}">
      <p class="muted" style="margin:6px 0 0;">A US quarter is 5.670 g. Only change this if you weigh a known roll and it's consistently off.</p>
      <label for="stTare">Default bucket tare (grams)</label><input id="stTare" type="number" step="0.1" value="${num(s.default_tare_g)}">
      <p class="muted" style="margin:6px 0 0;">The empty bucket or tray the quarters sit in. Pre-fills the tare on every weigh; can be changed per game.</p>
      <label for="stUnit">Scale unit</label><select id="stUnit"><option value="g" ${s.weight_unit === 'g' ? 'selected' : ''}>Grams</option><option value="lb" ${s.weight_unit === 'lb' ? 'selected' : ''}>Pounds</option></select>
      <div class="am-grid2">
        <div><label for="stRoll">Scale-check roll (grams)</label><input id="stRoll" type="number" step="0.1" value="${num(s.scale_check_roll_g)}"></div>
        <div><label for="stTol">Tolerance (± grams)</label><input id="stTol" type="number" step="0.1" value="${num(s.scale_check_tolerance_g)}"></div>
      </div>
      <p class="muted" style="margin:6px 0 0;">A $10 roll is 40 quarters = 226.8 g.</p>
      <div id="stStatus"></div>
      <button class="primary" id="stSave">Save settings</button>
    </div>`;
  $('stSave').onclick = async () => {
    try {
      await withStepUp(() => api('/api/amusement/settings', { method: 'POST', body: {
        quarter_weight_g: $('stQ').value, default_tare_g: $('stTare').value, weight_unit: $('stUnit').value,
        scale_check_roll_g: $('stRoll').value, scale_check_tolerance_g: $('stTol').value,
      } }));
      $('stStatus').innerHTML = '<p class="msg success">Saved.</p>';
    } catch (e) { $('stStatus').innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`; }
  };
}

init();
