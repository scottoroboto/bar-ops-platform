// Games on the Sources page (Scotto, 2026-10-05): the DIRECTV for Business
// app's Sports screen, on our own Sources page -- league tabs, Today /
// Upcoming / Completed, scores, and "put this game on a receiver", now or
// when it starts.
//
// Two sources, each doing what it's good at:
//  - ESPN's public scoreboard feed (site.api.espn.com): which games, teams,
//    logos, start times, live scores, and the networks carrying them.
//  - The bar's own DirecTV receivers' guide (SHEF /tv/getProgInfo with a
//    time): what is actually on a channel number at a time. A receiver can't
//    list or search its guide, only answer "what's on channel N at time T",
//    so we ask about the channels we know carry sports (plus any the owner
//    adds, like Sunday Ticket's 7xx block) and match team names in the guide
//    titles. That confirms a game's channel and finds games ESPN can't place
//    (package games, regional sports networks). A guide lookup never changes
//    what a receiver is showing.
//
// Channel numbers: owner's own setting > a favorite with the network's name
// > what the guide scan learned from callsigns > the defaults below.
const cache = require('./cache');
const directv = require('./drivers/directv');

const ESPN = process.env.SPORTS_ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports'; // override only for tests
const TIMEOUT_MS = 10000;
const TICK_MS = 30 * 1000;
const DAYS_BACK = 1;
const DAYS_AHEAD = 7;
const GUIDE_EVERY_MS = 15 * 60 * 1000;
const GUIDE_MAX_CALLS = 800;
const FIRE_EARLY_MS = 60 * 1000;          // tune a minute before the listed start
const PLAN_KEEP_MS = 12 * 60 * 60 * 1000; // finished plans stay visible this long

const LEAGUES = [
  { key: 'nfl', label: 'NFL', path: 'football/nfl' },
  { key: 'mlb', label: 'MLB', path: 'baseball/mlb' },
  { key: 'nba', label: 'NBA', path: 'basketball/nba' },
  { key: 'nhl', label: 'NHL', path: 'hockey/nhl' },
  { key: 'cfb', label: 'NCAAF', path: 'football/college-football', q: 'groups=80&limit=300' },
  { key: 'cbb', label: 'NCAAM', path: 'basketball/mens-college-basketball', q: 'limit=300' },
  { key: 'wnba', label: 'WNBA', path: 'basketball/wnba' },
  { key: 'mls', label: 'MLS', path: 'soccer/usa.1' },
  { key: 'epl', label: 'Premier League', path: 'soccer/eng.1' },
];

// DirecTV channel numbers. Locals are the Mobile-Pensacola market; the owner
// can change any of these from the Sources page.
const NETWORKS = [
  { keys: ['espn', 'espnhd'], major: 206, label: 'ESPN' },
  { keys: ['espn2', 'espn2hd'], major: 209, label: 'ESPN2' },
  { keys: ['espnu', 'espnuhd'], major: 208, label: 'ESPNU' },
  { keys: ['espnews', 'espnnews'], major: 207, label: 'ESPNews' },
  { keys: ['secn', 'secnetwork', 'sec', 'secnetworkhd'], major: 611, label: 'SEC Network' },
  { keys: ['accn', 'accnetwork', 'acc', 'accnx'], major: 612, label: 'ACC Network' },
  { keys: ['btn', 'bigtennetwork', 'bigten', 'b1g'], major: 610, label: 'Big Ten Network' },
  { keys: ['fs1', 'foxsports1', 'fs1hd'], major: 219, label: 'FS1' },
  { keys: ['fs2', 'foxsports2'], major: 618, label: 'FS2' },
  { keys: ['tbs', 'tbshd'], major: 247, label: 'TBS' },
  { keys: ['tnt', 'tnthd'], major: 245, label: 'TNT' },
  { keys: ['trutv', 'tru', 'trutvhd'], major: 246, label: 'truTV' },
  { keys: ['usa', 'usanetwork', 'usahd'], major: 242, label: 'USA' },
  { keys: ['nflnet', 'nflnetwork', 'nfln', 'nflhd'], major: 212, label: 'NFL Network' },
  { keys: ['mlbn', 'mlbnetwork', 'mlbnet', 'mlbhd'], major: 213, label: 'MLB Network' },
  { keys: ['nbatv', 'nbatvhd'], major: 216, label: 'NBA TV' },
  { keys: ['nhln', 'nhlnetwork', 'nhlhd'], major: 215, label: 'NHL Network' },
  { keys: ['cbssn', 'cbssportsnetwork', 'cbssports', 'cbssnhd'], major: 221, label: 'CBS Sports Network' },
  { keys: ['golf', 'golfchannel', 'golfhd'], major: 218, label: 'Golf Channel' },
  { keys: ['tennis', 'tennischannel', 'tenhd'], major: 217, label: 'Tennis Channel' },
  { keys: ['bein', 'beinsports', 'beinsportsusa'], major: 620, label: 'beIN Sports' },
  { keys: ['abc', 'wear', 'wearhd'], major: 3, label: 'ABC (WEAR 3)' },
  { keys: ['cbs', 'wkrg', 'wkrghd'], major: 5, label: 'CBS (WKRG 5)' },
  { keys: ['fox', 'wala', 'walahd'], major: 10, label: 'FOX (WALA 10)' },
  { keys: ['nbc', 'wpmi', 'wpmihd'], major: 15, label: 'NBC (WPMI 15)' },
];
const STREAMING = new Set(['espnplus', 'peacock', 'primevideo', 'amazonprimevideo', 'prime', 'appletv', 'appletvplus', 'mlstvseasonpass',
  'netflix', 'paramountplus', 'max', 'hbomax', 'youtube', 'youtubetv', 'mlbtv', 'nhlpowerplay', 'fubo', 'dazn', 'espnapp', 'foxone',
  'tubi', 'roku', 'victoryplus', 'fanduelsportsnetworkapp', 'nflplus', 'peacocktv', 'trutvapp', 'maxapp', 'foxsportsapp', 'nbcsportsapp']);
const PACKAGES = new Set(['nflsundayticket', 'sundayticket', 'mlbextrainnings', 'extrainnings', 'nhlcenterice', 'centerice', 'nbaleaguepass', 'leaguepass', 'nhlcentreice']);

function norm(s) { return String(s || '').toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, ''); }
const ALIAS = new Map();
for (const n of NETWORKS) for (const k of n.keys) ALIAS.set(k, n);
function canonical(name) { const k = norm(name); const n = ALIAS.get(k); return n ? n.keys[0] : k; }
function callsignKey(cs) { const k = norm(cs).replace(/hd$/, ''); const n = ALIAS.get(k) || ALIAS.get(k + 'hd'); return n ? n.keys[0] : null; }

let deps = { receivers: () => [], tune: async () => ({ ok: 0, total: 0, text: 'not started' }), favorites: () => [], timezone: () => 'America/Chicago' };

// ------------------------------------------------------------------ state
const feed = new Map(Object.entries(cache.get('sportsFeed') || {})); // `${league}:${yyyymmdd}` -> { at, ok, err, events }
let version = 1;
let lastError = null;
let lastOkAt = null;
let guide = cache.get('sportsGuide') || { at: 0, entries: [], receivers: 0, error: null }; // entries: { major, minor, callsign, title, episode, start, end }
let learned = cache.get('sportsLearned') || {}; // canonical network -> { major, minor, at } from guide callsigns
let plans = cache.get('sportsPlans') || [];
let tickTimer = null;
let guideRunning = null; // the scan in progress (a promise)
let sweepRunning = false;
let feedSavedAt = 0;
let viewMemo = { key: null, value: null };

function bump() { version += 1; }
function channelSettings() { return cache.get('sportsChannels') || {}; }     // canonical -> { major, minor } | { off: true }
function gameChannels() { return cache.get('sportsGameChannels') || {}; }    // gameId -> { major, minor, until }
function myTeams() { return cache.get('sportsMyTeams') || []; }              // ['nfl:10', ...]
function scanExtra() { return String(cache.get('sportsScanExtra') || ''); }  // "700-719, 620"

// ------------------------------------------------------------------ dates
function localDate(when, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(when));
}
function addDays(ymdDash, n) {
  const d = new Date(`${ymdDash}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ ESPN
async function getJson(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Bar Ops venue agent)' }, signal: controller.signal });
    if (!res.ok) throw new Error(`ESPN answered ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('ESPN didn’t answer (no internet at the bar?).');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function teamOf(c) {
  const t = (c && c.team) || {};
  const score = c && c.score != null && c.score !== '' ? String(typeof c.score === 'object' ? (c.score.displayValue ?? c.score.value ?? '') : c.score) : null;
  const rank = c && c.curatedRank && Number(c.curatedRank.current) > 0 && Number(c.curatedRank.current) < 99 ? Number(c.curatedRank.current) : null;
  return {
    id: String(t.id || ''),
    abbr: String(t.abbreviation || ''),
    name: String(t.shortDisplayName || t.name || t.displayName || 'TBD'),
    full: String(t.displayName || ''),
    location: String(t.location || ''),
    nick: String(t.name || ''),
    logo: t.logo || (Array.isArray(t.logos) && t.logos[0] && t.logos[0].href) || null,
    color: t.color ? `#${String(t.color).replace(/^#/, '')}` : null,
    score,
    rank,
    record: (c && Array.isArray(c.records) && c.records[0] && c.records[0].summary) || null,
    winner: !!(c && c.winner),
  };
}

function normalizeEvent(ev, league) {
  const comp = (ev.competitions || [])[0] || {};
  const st = ((ev.status || comp.status || {}).type) || {};
  const teams = comp.competitors || [];
  const away = teamOf(teams.find((t) => t.homeAway === 'away') || teams[0]);
  const home = teamOf(teams.find((t) => t.homeAway === 'home') || teams[1]);
  const nets = [];
  const add = (name, market, streaming) => {
    name = String(name || '').trim();
    if (!name || nets.some((n) => norm(n.name) === norm(name))) return;
    nets.push({ name, market: String(market || '').toLowerCase(), streaming: !!streaming });
  };
  for (const g of comp.geoBroadcasts || []) {
    add(g.media && (g.media.shortName || g.media.callLetters || g.media.name), g.market && (g.market.type || g.market), /stream/i.test((g.type && g.type.shortName) || ''));
  }
  for (const b of comp.broadcasts || []) for (const n of b.names || []) add(n, b.market);
  const rankMarket = (m) => (/national/.test(m) ? 0 : /home/.test(m) ? 1 : /away/.test(m) ? 2 : 3);
  nets.sort((a, b) => rankMarket(a.market) - rankMarket(b.market));
  const note = (Array.isArray(comp.notes) && comp.notes[0] && comp.notes[0].headline) || null;
  return {
    id: String(ev.id),
    league: league.key,
    start: ev.date || comp.date || null,
    state: st.state || 'pre',
    detail: String(st.shortDetail || st.detail || st.description || ''),
    postponed: /POSTPONED|CANCELED|CANCELLED|SUSPENDED|FORFEIT/i.test(String(st.name || '')),
    name: String(ev.shortName || ev.name || `${away.abbr} @ ${home.abbr}`),
    note,
    away,
    home,
    networks: nets,
  };
}

async function fetchDay(league, ymd) {
  const url = `${ESPN}/${league.path}/scoreboard?dates=${ymd}${league.q ? `&${league.q}` : ''}`;
  const data = await getJson(url);
  return (Array.isArray(data.events) ? data.events : []).map((ev) => normalizeEvent(ev, league)).filter((g) => g.start);
}

// How soon a league/day needs fetching again.
function dueIn(entry, offset) {
  if (!entry) return 0;
  if (!entry.ok) return 5 * 60 * 1000;
  const now = Date.now();
  if (offset <= 1) {
    const hot = (entry.events || []).some((g) => g.state === 'in'
      || (g.state === 'pre' && !g.postponed && Math.abs(new Date(g.start).getTime() - now) < 20 * 60 * 1000));
    if (hot) return 60 * 1000;
    return offset <= 0 ? 10 * 60 * 1000 : 30 * 60 * 1000;
  }
  return 2 * 60 * 60 * 1000;
}

async function sweep() {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const tz = deps.timezone();
    const today = localDate(Date.now(), tz);
    const want = [];
    for (const league of LEAGUES) {
      for (let off = -DAYS_BACK; off <= DAYS_AHEAD; off += 1) {
        const ymd = addDays(today, off).replace(/-/g, '');
        const key = `${league.key}:${ymd}`;
        const entry = feed.get(key);
        if (!entry || Date.now() - entry.at >= dueIn(entry, off)) want.push({ league, ymd, key });
      }
    }
    // Drop days that fell out of the window.
    const keep = new Set();
    for (const league of LEAGUES) for (let off = -DAYS_BACK; off <= DAYS_AHEAD; off += 1) keep.add(`${league.key}:${addDays(today, off).replace(/-/g, '')}`);
    for (const k of [...feed.keys()]) if (!keep.has(k)) { feed.delete(k); bump(); }
    if (!want.length) return;
    let changed = false;
    let failed = null;
    const queue = want.slice();
    await Promise.all([0, 1, 2].map(async () => {
      while (queue.length) {
        const w = queue.shift();
        try {
          const events = await fetchDay(w.league, w.ymd);
          const old = feed.get(w.key);
          if (!old || JSON.stringify(old.events) !== JSON.stringify(events)) changed = true;
          feed.set(w.key, { at: Date.now(), ok: true, events });
          lastOkAt = Date.now();
        } catch (err) {
          failed = err.message;
          const old = feed.get(w.key);
          feed.set(w.key, { at: Date.now(), ok: false, err: err.message, events: old ? old.events : [] });
        }
      }
    }));
    lastError = failed;
    if (changed) bump();
    // Kept through restarts, but written at most every 10 minutes: live
    // scores change every minute and the Pi's SD card doesn't need that.
    if (Date.now() - feedSavedAt > 10 * 60 * 1000) { feedSavedAt = Date.now(); cache.set('sportsFeed', Object.fromEntries(feed)); }
  } finally {
    sweepRunning = false;
  }
}

function allGames() {
  const byId = new Map();
  for (const entry of feed.values()) for (const g of entry.events || []) byId.set(g.id, g); // same game can sit on two ESPN days
  return [...byId.values()].sort((a, b) => new Date(a.start) - new Date(b.start));
}
function gameById(id) { return allGames().find((g) => g.id === String(id)) || null; }

// ------------------------------------------------------------------ channels
function favoriteFor(key) {
  for (const f of deps.favorites() || []) {
    if (f && f.major != null && canonical(f.name) === key) return { major: Number(f.major), minor: f.minor != null ? Number(f.minor) : null, from: 'favorite' };
  }
  return null;
}

// { major, minor, from } | { off: true } | null for one network name.
function channelFor(name) {
  const key = canonical(name);
  if (STREAMING.has(norm(name))) return { streaming: true };
  const set = channelSettings()[key];
  if (set) return set.off ? { off: true } : { major: Number(set.major), minor: set.minor != null ? Number(set.minor) : null, from: 'owner' };
  const fav = favoriteFor(key);
  if (fav) return fav;
  const l = learned[key];
  if (l) return { major: l.major, minor: l.minor, from: 'guide' };
  const n = ALIAS.get(key);
  if (n) return { major: n.major, minor: null, from: 'default' };
  if (PACKAGES.has(norm(name))) return { package: true };
  return null;
}

// Every channel number worth asking the guide about.
function scanChannels() {
  const out = new Map();
  const put = (major, minor) => { if (major > 0 && major < 10000) out.set(`${major}-${minor == null ? '' : minor}`, { major, minor: minor == null ? null : minor }); };
  for (const n of NETWORKS) { const c = channelFor(n.keys[0]); if (c && c.major) put(c.major, c.minor); }
  for (const v of Object.values(channelSettings())) if (v && !v.off && v.major) put(Number(v.major), v.minor != null ? Number(v.minor) : null);
  for (const part of scanExtra().split(/[,\s]+/)) {
    const m = part.match(/^(\d{1,4})(?:-(\d{1,4}))?$/);
    if (!m) continue;
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    for (let x = Math.min(a, b); x <= Math.max(a, b) && x - Math.min(a, b) < 300; x += 1) put(x, null);
  }
  return [...out.values()];
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function mentions(text, t) {
  const phrases = [t.full, t.name, t.nick, t.location].filter((p) => p && p.length >= 3 && p !== 'TBD');
  return phrases.some((p) => new RegExp(`(^|[^a-z])${escRe(p.toLowerCase())}($|[^a-z])`).test(text));
}
function guideMatches(g) {
  if (g.state === 'post' || g.postponed) return [];
  const at = g.state === 'in' ? Date.now() : new Date(g.start).getTime();
  if (at > Date.now() + 4 * 60 * 60 * 1000) return []; // the scan only looks a few hours ahead
  const hits = [];
  for (const e of guide.entries || []) {
    if (!(e.start <= at + 5 * 60 * 1000 && e.end > at)) continue;
    const text = `${e.title || ''} ${e.episode || ''}`.toLowerCase();
    if (mentions(text, g.away) && mentions(text, g.home)) hits.push(e);
  }
  return hits;
}

function chKey(c) { return `${c.major}-${c.minor == null ? '' : c.minor}`; }

// What a game can be tuned to, best first.
function optionsFor(g) {
  const opts = [];
  for (const n of g.networks) {
    const c = channelFor(n.name);
    if (n.streaming || (c && c.streaming)) opts.push({ name: n.name, kind: 'streaming' });
    else if (c && c.package) opts.push({ name: n.name, kind: 'package' });
    else if (c && c.off) opts.push({ name: n.name, kind: 'off' });
    else if (c && c.major) opts.push({ name: n.name, kind: 'tv', major: c.major, minor: c.minor, from: c.from });
    else opts.push({ name: n.name, kind: 'unknown' });
  }
  for (const e of guideMatches(g)) {
    const have = opts.find((o) => o.kind === 'tv' && o.major === e.major && (o.minor ?? null) === (e.minor ?? null));
    if (have) have.confirmed = true;
    else opts.push({ name: e.callsign || `Ch ${e.major}`, kind: 'tv', major: e.major, minor: e.minor, from: 'guide', confirmed: true });
  }
  const set = gameChannels()[g.id];
  if (set && set.major) {
    const have = opts.find((o) => o.kind === 'tv' && o.major === Number(set.major));
    if (have) have.pinned = true;
    else opts.unshift({ name: `Ch ${set.major}`, kind: 'tv', major: Number(set.major), minor: set.minor != null ? Number(set.minor) : null, from: 'owner', pinned: true });
  }
  const score = (o) => (o.kind !== 'tv' ? 9 : o.pinned ? 0 : o.confirmed ? 1 : 2);
  return opts.map((o, i) => ({ o, i })).sort((a, b) => score(a.o) - score(b.o) || a.i - b.i).map((x) => x.o);
}

// ------------------------------------------------------------------ guide scan
function guideTimes() {
  const now = Date.now();
  const times = [now];
  for (const g of allGames()) {
    const t = new Date(g.start).getTime();
    if (g.state === 'pre' && !g.postponed && t > now + 20 * 60 * 1000 && t < now + 3 * 60 * 60 * 1000) {
      if (times.every((x) => Math.abs(x - t) > 25 * 60 * 1000)) times.push(t + 5 * 60 * 1000);
    }
    if (times.length >= 4) break;
  }
  return times;
}

// A second ask while a scan is running waits for that scan.
function scanGuide() {
  if (!guideRunning) guideRunning = scanGuideNow().finally(() => { guideRunning = null; });
  return guideRunning;
}

async function scanGuideNow() {
  const rcvs = (deps.receivers() || []).filter((r) => r.ip);
  if (!rcvs.length) { guide = { ...guide, error: 'No DirecTV receiver is answering.' }; return guide; }
  const channels = scanChannels();
  const jobs = [];
  for (const t of guideTimes()) for (const c of channels) jobs.push({ ...c, t });
  jobs.length = Math.min(jobs.length, GUIDE_MAX_CALLS);
  const entries = new Map();
  const seenCallsign = new Map();
  let errors = 0;
  // One call at a time per receiver, so a staff tap never waits behind
  // more than one guide lookup in that receiver's SHEF queue.
  await Promise.all(rcvs.map(async (r) => {
    while (jobs.length) {
      const j = jobs.shift();
      try {
        const p = await directv.getProgInfo(r.ip, r.port || 8080, j.major, j.minor, j.t / 1000);
        if (!p || p.isOffAir) continue;
        const start = Number(p.startTime) * 1000 || j.t;
        const end = start + (Number(p.duration) || 3600) * 1000;
        entries.set(`${j.major}-${j.minor ?? ''}@${start}`, {
          major: j.major, minor: j.minor, callsign: p.callsign || null, title: p.title || '', episode: p.episodeTitle || '', start, end,
        });
        if (p.callsign) seenCallsign.set(chKey(j), p.callsign);
      } catch (err) {
        errors += 1; // channel not in the lineup, or a busy receiver -- skip it
      }
    }
  }));
  // A network's callsign on a channel number teaches us its number. When
  // the same network shows up on several numbers (an alternate feed), the
  // default number wins if it's one of them, else the lowest.
  const byNet = new Map();
  for (const [k, cs] of seenCallsign) {
    const net = callsignKey(cs);
    if (!net) continue;
    const [major, minor] = k.split('-');
    if (!byNet.has(net)) byNet.set(net, []);
    byNet.get(net).push({ major: Number(major), minor: minor === '' ? null : Number(minor), callsign: cs });
  }
  for (const [net, list] of byNet) {
    const def = ALIAS.get(net);
    const pick = list.find((c) => def && c.major === def.major) || list.sort((x, y) => x.major - y.major)[0];
    learned[net] = { ...pick, at: Date.now() };
  }
  cache.set('sportsLearned', learned);
  guide = { at: Date.now(), entries: [...entries.values()], receivers: rcvs.length, errors, channels: channels.length, error: entries.size ? null : 'The receivers didn’t answer guide lookups.' };
  cache.set('sportsGuide', guide);
  bump();
  return guide;
}

// ------------------------------------------------------------------ plans
function savePlans() { cache.set('sportsPlans', plans); bump(); }

async function runPlans() {
  const now = Date.now();
  let dirty = false;
  for (const p of plans) {
    if (p.status !== 'waiting') continue;
    const g = gameById(p.gameId);
    if (g) {
      if (g.start && g.start !== p.startAt) { p.startAt = g.start; dirty = true; }
      if (g.postponed) { p.status = 'cancelled'; p.result = 'Game postponed'; p.doneAt = now; dirty = true; continue; }
      if (g.state === 'post') { p.status = 'missed'; p.result = 'Game ended before it was tuned'; p.doneAt = now; dirty = true; continue; }
    }
    const startMs = new Date(p.startAt).getTime();
    const go = (g && g.state === 'in') || now >= startMs - FIRE_EARLY_MS;
    if (!go) continue;
    if (!g && now > startMs + 4 * 60 * 60 * 1000) { p.status = 'missed'; p.result = 'Game not found'; p.doneAt = now; dirty = true; continue; }
    p.status = 'tuning';
    savePlans();
    try {
      const r = await deps.tune(p.slots, p.major, p.minor, `game plan: ${p.title}`, p.by);
      p.status = r.ok === r.total ? 'done' : r.ok ? 'partial' : 'failed';
      p.result = r.text;
    } catch (err) {
      p.status = 'failed';
      p.result = err.message;
    }
    p.doneAt = Date.now();
    dirty = true;
  }
  const before = plans.length;
  plans = plans.filter((p) => !(p.doneAt && now - p.doneAt > PLAN_KEEP_MS));
  if (dirty || plans.length !== before) savePlans();
}

function addPlan({ gameId, slots, major, minor, by }) {
  const g = gameById(gameId);
  if (!g) throw new Error('That game isn’t in the list anymore.');
  if (g.state === 'post') throw new Error('That game is over.');
  slots = (Array.isArray(slots) ? slots : []).map(Number).filter((n) => Number.isFinite(n));
  if (!slots.length) throw new Error('Pick at least one receiver.');
  if (!(Number(major) > 0)) throw new Error('This game has no channel yet.');
  // One waiting plan per game: the sheet always sends the full set of receivers.
  plans = plans.filter((p) => !(p.status === 'waiting' && p.gameId === g.id));
  const plan = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    gameId: g.id, league: g.league, title: `${g.away.abbr || g.away.name} @ ${g.home.abbr || g.home.name}`,
    slots, major: Number(major), minor: minor != null && minor !== '' ? Number(minor) : null,
    startAt: g.start, by: by || 'staff', createdAt: new Date().toISOString(), status: 'waiting',
  };
  plans.push(plan);
  savePlans();
  return plan;
}

function cancelPlan(id) {
  const p = plans.find((x) => x.id === id);
  if (!p) throw new Error('That plan is gone.');
  if (p.status === 'waiting') { p.status = 'cancelled'; p.result = 'Cancelled'; p.doneAt = Date.now(); }
  savePlans();
  return p;
}

// ------------------------------------------------------------------ settings
function parseChannel(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,4})(?:[-.](\d{1,3}))?$/);
  return m ? { major: Number(m[1]), minor: m[2] != null ? Number(m[2]) : null } : null;
}

function setNetworkChannel(network, value) {
  const key = canonical(network);
  if (!key) throw new Error('Which network?');
  const all = channelSettings();
  if (value === 'off') all[key] = { off: true };
  else if (value == null || value === '') delete all[key];
  else {
    const c = parseChannel(value);
    if (!c) throw new Error('Type a channel number, like 206.');
    all[key] = c;
  }
  cache.set('sportsChannels', all);
  bump();
}

function setGameChannel(gameId, value) {
  const all = gameChannels();
  if (value == null || value === '') delete all[gameId];
  else {
    const c = parseChannel(value);
    if (!c) throw new Error('Type a channel number, like 705.');
    all[gameId] = { ...c, until: Date.now() + 2 * 24 * 60 * 60 * 1000 };
  }
  for (const [k, v] of Object.entries(all)) if (v.until && v.until < Date.now()) delete all[k];
  cache.set('sportsGameChannels', all);
  bump();
}

function setMyTeam(league, teamId, on) {
  const key = `${league}:${teamId}`;
  const list = myTeams().filter((k) => k !== key);
  if (on) list.push(key);
  cache.set('sportsMyTeams', list);
  bump();
}

function setScanExtra(text) {
  const clean = String(text || '').replace(/[^\d,\s-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  cache.set('sportsScanExtra', clean);
  bump();
  scanGuide().catch(() => {});
  return clean;
}

function channelList() {
  const set = channelSettings();
  return NETWORKS.map((n) => {
    const c = channelFor(n.keys[0]) || {};
    return { key: n.keys[0], label: n.label, major: c.major || null, minor: c.minor ?? null, off: !!c.off, from: c.from || (c.off ? 'owner' : null), custom: !!set[n.keys[0]], learnedCallsign: learned[n.keys[0]] ? learned[n.keys[0]].callsign : null };
  }).concat(Object.entries(set).filter(([k]) => !ALIAS.has(k)).map(([k, v]) => ({ key: k, label: k, major: v.major || null, minor: v.minor ?? null, off: !!v.off, from: 'owner', custom: true })));
}

// ------------------------------------------------------------------ view
function clientTeam(t) {
  return { id: t.id, abbr: t.abbr, name: t.name, logo: t.logo, color: t.color, score: t.score, rank: t.rank, record: t.record, winner: t.winner };
}

// Same answer for every iPad until something changes or the minute ticks.
function view() {
  const key = `${version}:${Math.floor(Date.now() / 60000)}`;
  if (viewMemo.key !== key) viewMemo = { key, value: buildView() };
  return viewMemo.value;
}

function buildView() {
  const tz = deps.timezone();
  const mine = new Set(myTeams());
  const games = allGames().map((g) => {
    const options = optionsFor(g);
    const best = options.find((o) => o.kind === 'tv') || null;
    return {
      id: g.id, league: g.league, start: g.start, localDate: localDate(g.start, tz), state: g.state, detail: g.detail,
      postponed: g.postponed, name: g.name, note: g.note, away: clientTeam(g.away), home: clientTeam(g.home),
      options, channel: best ? { major: best.major, minor: best.minor, name: best.name, confirmed: !!best.confirmed, from: best.from } : null,
      myTeam: mine.has(`${g.league}:${g.away.id}`) || mine.has(`${g.league}:${g.home.id}`),
    };
  });
  const present = new Set(games.map((g) => g.league));
  return {
    v: version,
    today: localDate(Date.now(), tz),
    yesterday: addDays(localDate(Date.now(), tz), -1),
    leagues: LEAGUES.filter((l) => present.has(l.key)).map((l) => ({ key: l.key, label: l.label })),
    myTeams: [...mine],
    games,
    plans,
    status: {
      ok: !lastError, error: lastError, updatedAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
      guideAt: guide.at ? new Date(guide.at).toISOString() : null, guideError: guide.error || null, guideEntries: (guide.entries || []).length,
    },
  };
}

// ------------------------------------------------------------------ loop
let lastGuideAt = guide.at || 0;
async function tick() {
  await sweep().catch((err) => { lastError = err.message; });
  await runPlans().catch((err) => console.warn('[sports] plans:', err.message));
  if (Date.now() - lastGuideAt > GUIDE_EVERY_MS) {
    lastGuideAt = Date.now();
    scanGuide().catch((err) => console.warn('[sports] guide scan:', err.message));
  }
}

function start(options) {
  deps = { ...deps, ...(options || {}) };
  for (const p of plans) if (p.status === 'tuning') p.status = 'waiting'; // the box restarted mid-tune
  if (tickTimer || process.env.SPORTS_OFF === '1') return;
  lastGuideAt = Date.now() - GUIDE_EVERY_MS + 60 * 1000; // first guide scan a minute after boot, once the poller knows who's up
  tick();
  tickTimer = setInterval(tick, TICK_MS);
}

function version_() { return version; }

module.exports = {
  LEAGUES, NETWORKS, start, tick, sweep, scanGuide, view, version: version_, gameById, optionsFor,
  addPlan, cancelPlan, setNetworkChannel, setGameChannel, setMyTeam, setScanExtra, scanExtra, channelList, guideMatches,
  canonical, normalizeEvent, fetchDay, channelFor,
};
