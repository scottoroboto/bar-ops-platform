// Cash Out — the bar iPad's opening/closing count (server/cashout.js).
// Name → PIN → opening or closing → one amount per screen → done.
// Blind: nothing here ever shows over or short. At closing the only
// number shown back is how much to drop.
// Buttons carry data-act/data-id and one listener handles them, so no
// name or id is ever pasted into an onclick.

const IDLE_MS = 90 * 1000;
const RESULT_MS = 45 * 1000;
const S = {
  ctx: null, person: null, pass: null, kind: null, closingId: null,
  steps: [], i: 0, amounts: {}, entry: '', pin: '', error: '', busy: false, screen: 'loading',
  setupToken: null, setupLocations: [],
};

// Opened from Venue Control's Cash Out tab: ?back= is the TV Staff page
// on the bar's Pi. Only a plain http(s) address on the bar's own network
// (private IP or .local) is accepted, so the link can't be pointed at
// some other site. Kept for the session so it survives the whole count.
const BACK_KEY = 'co_back';
function backUrl() {
  const fromQuery = new URLSearchParams(location.search).get('back');
  const candidate = fromQuery || (() => { try { return sessionStorage.getItem(BACK_KEY); } catch (e) { return null; } })();
  if (!candidate) return null;
  let u;
  try { u = new URL(candidate); } catch (e) { return null; }
  const host = u.hostname;
  const local = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local') || host === 'localhost';
  if (!/^https?:$/.test(u.protocol) || !local) return null;
  try { sessionStorage.setItem(BACK_KEY, u.href); } catch (e) { /* private mode */ }
  return u.href;
}
const BACK = backUrl();
if (BACK && location.search) history.replaceState(null, '', location.pathname);

function money(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function main() { return document.getElementById('coMain'); }
function errHtml() { return S.error ? `<div class="co-err">${escapeHtml(S.error)}</div>` : ''; }

async function call(method, path, body, token) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error && data.error !== 'PIN_LOCKED' ? data.error : (data.message || data.error || 'Something went wrong. Try again.')), { status: r.status });
  return data;
}

// ---- Start / reset ----------------------------------------------------
async function load() {
  S.error = '';
  const token = getDeviceToken();
  if (!token) return renderSetup();
  try {
    S.ctx = await call('GET', '/api/cashout/kiosk?deviceToken=' + encodeURIComponent(token));
    document.getElementById('coBar').innerHTML = `Cash Out<b>${escapeHtml(S.ctx.location.name)}</b>${BACK ? '<a href="#" data-act="back-vc" style="display:block; margin-top:4px; color:var(--accent); font-size:15px;">‹ Back to TVs</a>' : ''}`;
    reset();
  } catch (e) {
    if (e.status === 403) return renderSetup();
    main().innerHTML = `<div class="co-err">${escapeHtml(e.message)}</div><button class="co-btn" data-act="retry">Try again</button>`;
  }
}

function reset() {
  Object.assign(S, { person: null, pass: null, kind: null, closingId: null, steps: [], i: 0, amounts: {}, entry: '', pin: '', error: '', busy: false });
  renderNames();
}

// ---- Screens ------------------------------------------------------------
function renderNames() {
  S.screen = 'names';
  const people = S.ctx.bartenders;
  main().innerHTML = `
    <h1>Who’s counting?</h1>
    <p class="lead">Tap your name.</p>
    ${people.length
      ? `<div class="co-grid">${people.map(p => `<button class="co-btn" data-act="person" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`).join('')}</div>`
      : `<div class="co-err">No bartenders with a PIN are set up for ${escapeHtml(S.ctx.location.name)} yet. Ask a manager.</div>`}`;
}

function keypad(withDot) {
  return `<div class="co-keys">
    ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-act="key" data-id="${n}">${n}</button>`).join('')}
    ${withDot ? `<button data-act="key" data-id=".">.</button>` : `<button class="muted-key" data-act="clear">Clear</button>`}
    <button data-act="key" data-id="0">0</button>
    <button class="muted-key" data-act="back-key">⌫</button>
  </div>`;
}

function renderPin() {
  S.screen = 'pin';
  main().innerHTML = `
    <h1>Hi, ${escapeHtml(S.person.name.split(' ')[0])}</h1>
    <p class="lead">Enter your PIN.</p>
    ${errHtml()}
    <div class="co-display pin">${S.pin ? '•'.repeat(S.pin.length) : '<span class="ph">••••</span>'}</div>
    ${keypad(false)}
    <div class="co-actions">
      <button class="co-btn" data-act="home">Not me</button>
      <button class="co-btn primary" data-act="pin-go" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Checking…' : 'Enter'}</button>
    </div>`;
}

function renderChoose() {
  S.screen = 'choose';
  main().innerHTML = `
    <h1>${escapeHtml(S.person.name.split(' ')[0])}, which count?</h1>
    <p class="lead">Nothing you enter is checked on screen. Just count carefully and enter what you have.</p>
    <div class="co-grid" style="grid-template-columns:1fr 1fr;">
      <button class="co-btn big" data-act="kind" data-id="opening">Opening count<span class="sub">Start of shift, every drawer</span></button>
      <button class="co-btn big" data-act="kind" data-id="closing">Closing count<span class="sub">End of shift</span></button>
    </div>
    <div class="co-actions"><button class="co-btn" data-act="home">Cancel</button></div>`;
}

function buildSteps() {
  const { drawers, bag } = S.ctx;
  const steps = [];
  if (S.kind === 'opening') {
    for (const d of drawers) steps.push({ type: 'amount', source: d, title: d.name, lead: 'Count everything in the drawer and enter the total.' });
  } else {
    steps.push({ type: 'station' });
    const closing = drawers.find(d => d.id === S.closingId);
    if (closing) {
      for (const d of drawers.filter(x => x.id !== closing.id)) {
        steps.push({ type: 'amount', source: d, title: d.name, lead: `Balance it to <b>${money(d.start)}</b>, then enter what’s in it.` });
      }
      if (bag) {
        const bills = bag.denominations.length ? ` (${bag.denominations.map(v => '$' + v).join('s and ')}s)` : '';
        steps.push({
          type: 'amount', source: bag, title: bag.name,
          lead: bag.tonight > 0 ? `Count it down to <b>${money(bag.tonight)}</b>${bills}, then enter what’s in it.` : `Count it${bills} and enter what’s in it.`,
        });
      }
      steps.push({ type: 'amount', source: closing, title: `${closing.name} (closing)`, lead: `Close out the POS. Then count <b>everything</b> in ${escapeHtml(closing.name)} and enter the total.` });
    }
  }
  steps.push({ type: 'review' });
  S.steps = steps;
}

function stepHeader() {
  return `<div class="co-step">${S.kind === 'opening' ? 'Opening' : 'Closing'} count · step ${S.i + 1} of ${S.steps.length}</div>`;
}

function renderStep() {
  S.screen = 'step';
  const step = S.steps[S.i];
  if (step.type === 'station') {
    main().innerHTML = `
      ${stepHeader()}
      <h1>Which drawer is the closing station?</h1>
      <p class="lead">The drawer all the other stations were transferred to.</p>
      ${errHtml()}
      <div class="co-grid">${S.ctx.drawers.map(d => `<button class="co-btn ${d.id === S.closingId ? 'primary' : ''}" data-act="station" data-id="${escapeHtml(d.id)}">${escapeHtml(d.name)}</button>`).join('')}</div>
      <div class="co-actions"><button class="co-btn" data-act="prev">Back</button></div>`;
    return;
  }
  if (step.type === 'review') {
    const rows = S.steps.filter(s => s.type === 'amount');
    main().innerHTML = `
      ${stepHeader()}
      <h1>Check and submit</h1>
      <p class="lead">Tap a line to fix it.</p>
      ${errHtml()}
      <div class="co-review">${rows.map(s => `
        <div class="row" data-act="goto" data-id="${S.steps.indexOf(s)}"><span>${escapeHtml(s.title)}</span><span class="amt">${money(S.amounts[s.source.id])}</span></div>`).join('')}
      </div>
      <div class="co-actions">
        <button class="co-btn" data-act="prev">Back</button>
        <button class="co-btn primary" data-act="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Saving…' : 'Submit'}</button>
      </div>`;
    return;
  }
  main().innerHTML = `
    ${stepHeader()}
    <h1>${escapeHtml(step.title)}</h1>
    <p class="lead">${step.lead}</p>
    ${errHtml()}
    <div class="co-display">${S.entry ? '$' + escapeHtml(S.entry) : '<span class="ph">$0</span>'}</div>
    ${keypad(true)}
    <div class="co-actions">
      <button class="co-btn" data-act="prev">Back</button>
      <button class="co-btn primary" data-act="next">Next</button>
    </div>`;
}

function renderResult(r) {
  S.screen = 'result';
  const first = escapeHtml(r.name.split(' ')[0]);
  let body;
  if (r.kind === 'opening') {
    body = `<div class="ok">✓</div><p>Opening count saved. Have a good shift, ${first}.</p>`;
  } else if (r.drop > 0) {
    body = `<p>Drop this in the drop safe with the POS cash-out report:</p>
      <div class="amount">${money(r.drop)}</div>
      <p>Leave <b>${money(r.closingStart)}</b> in ${escapeHtml(r.closingName)}.</p>`;
  } else {
    body = `<div class="ok">✓</div><p>Closing count saved. Nothing to drop. Leave everything in ${escapeHtml(r.closingName)}.</p>`;
  }
  main().innerHTML = `<div class="co-result">${body}</div>
    <div class="co-actions"><button class="co-btn primary" data-act="${BACK ? 'back-vc' : 'home'}">Done</button></div>`;
  clearTimeout(S.resultTimer);
  S.resultTimer = setTimeout(() => { if (S.screen === 'result') { if (BACK) goBack(); else reset(); } }, RESULT_MS);
}

// ---- Actions -----------------------------------------------------------
function typeKey(k) {
  if (S.screen === 'pin') {
    if (S.pin.length < 8) S.pin += k;
    S.error = '';
    return renderPin();
  }
  let e = S.entry;
  if (k === '.') { if (e.includes('.')) return; e = (e || '0') + '.'; }
  else {
    const [whole, frac] = e.split('.');
    if (frac !== undefined && frac.length >= 2) return;
    if (frac === undefined && whole.length >= 6) return;
    e = e === '0' ? k : e + k;
  }
  S.entry = e;
  S.error = '';
  renderStep();
}

function saveEntry() {
  const step = S.steps[S.i];
  if (!step || step.type !== 'amount') return true;
  if (S.entry === '' || S.entry === '.') { S.error = 'Enter the amount. Enter 0 if it’s empty.'; return false; }
  S.amounts[step.source.id] = Number(S.entry);
  return true;
}

function goTo(i) {
  S.i = Math.max(0, Math.min(i, S.steps.length - 1));
  const step = S.steps[S.i];
  S.entry = step.type === 'amount' && S.amounts[step.source.id] !== undefined ? String(S.amounts[step.source.id]) : '';
  S.error = '';
  renderStep();
}

async function signIn() {
  if (!S.pin) { S.error = 'Enter your PIN.'; return renderPin(); }
  S.busy = true; renderPin();
  try {
    const r = await call('POST', '/api/cashout/sign-in', { deviceToken: getDeviceToken(), personId: S.person.id, pin: S.pin });
    S.pass = r.pass;
    S.busy = false; S.pin = ''; S.error = '';
    renderChoose();
  } catch (e) {
    S.busy = false; S.pin = ''; S.error = e.message;
    renderPin();
  }
}

async function submit() {
  S.busy = true; S.error = ''; renderStep();
  const counts = S.steps.filter(s => s.type === 'amount').map(s => ({ sourceId: s.source.id, amount: S.amounts[s.source.id] }));
  try {
    const r = await call('POST', '/api/cashout/submit', {
      deviceToken: getDeviceToken(), pass: S.pass, kind: S.kind, counts, closingSourceId: S.closingId,
    });
    S.busy = false; S.pass = null;
    renderResult(r);
  } catch (e) {
    S.busy = false; S.error = e.message;
    if (e.status === 401) { S.pass = null; S.pin = ''; return renderPin(); }
    renderStep();
  }
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  switch (act) {
    case 'retry': return load();
    case 'home': return reset();
    case 'back-vc': ev.preventDefault(); return goBack();
    case 'person':
      S.person = S.ctx.bartenders.find(p => p.id === id) || null;
      S.pin = ''; S.error = '';
      return S.person ? renderPin() : renderNames();
    case 'key': return typeKey(id);
    case 'clear': S.pin = ''; return renderPin();
    case 'back-key':
      if (S.screen === 'pin') { S.pin = S.pin.slice(0, -1); return renderPin(); }
      S.entry = S.entry.slice(0, -1); return renderStep();
    case 'pin-go': return signIn();
    case 'kind':
      S.kind = id; S.closingId = null; S.amounts = {};
      buildSteps(); return goTo(0);
    case 'station':
      S.closingId = id; buildSteps(); return goTo(1);
    case 'prev':
      if (S.i === 0) return renderChoose();
      return goTo(S.i - 1);
    case 'next':
      if (!saveEntry()) return renderStep();
      return goTo(S.i + 1);
    case 'goto': return goTo(Number(id));
    case 'submit': return submit();
    case 'setup-signin': return setupSignIn();
    case 'setup-go': return setupDevice();
    default: return undefined;
  }
});

function goBack() {
  if (!BACK) return reset();
  reset();
  location.href = BACK;
}

// Any touch keeps the screen alive; 90s idle mid-count goes back to the
// name list and drops the pass, so nobody walks up to someone else's count.
let idleTimer = null;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (S.ctx && !['names', 'setup', 'loading'].includes(S.screen)) reset(); }, IDLE_MS);
}
document.addEventListener('pointerdown', touch);

// ---- One-time setup (owner) ------------------------------------------------
// The owner signs in right here; the session token only lives in memory
// long enough to trust this iPad, and is never stored on it.
function renderSetup(message) {
  S.screen = 'setup';
  document.getElementById('coBar').innerHTML = 'Cash Out';
  main().innerHTML = `
    <h1>Set up this iPad</h1>
    <p class="lead">This iPad isn’t set up for Cash Out yet. The owner signs in once to set it up for a bar. You won’t stay signed in.</p>
    ${message ? `<div class="co-err">${escapeHtml(message)}</div>` : ''}
    ${S.setupToken ? `
      <label for="setupBar">Bar</label>
      <select id="setupBar">${S.setupLocations.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}</select>
      <label for="setupLabel">Name for this iPad</label>
      <input id="setupLabel" value="Bar iPad">
      <div class="co-actions"><button class="co-btn primary" data-act="setup-go">Set up this iPad</button></div>`
    : `
      <label for="setupUser">Owner username</label>
      <input id="setupUser" autocapitalize="none" autocorrect="off" spellcheck="false">
      <label for="setupPass">Password</label>
      <input id="setupPass" type="password">
      <div class="co-actions"><button class="co-btn primary" data-act="setup-signin">Sign in</button></div>`}`;
}

async function setupSignIn() {
  try {
    const r = await call('POST', '/api/auth/login-password', {
      username: document.getElementById('setupUser').value.trim(), password: document.getElementById('setupPass').value,
    });
    if (!r.token) return renderSetup('Finish your first sign-in in the main app, then come back here.');
    if (!r.person || r.person.role !== 'owner') return renderSetup('Only the owner can set up Cash Out.');
    S.setupToken = r.token;
    S.setupLocations = await call('GET', '/api/locations', null, r.token);
    renderSetup();
  } catch (e) {
    renderSetup(e.message);
  }
}

async function setupDevice() {
  try {
    const r = await call('POST', '/api/cashout/setup', {
      locationId: document.getElementById('setupBar').value, label: document.getElementById('setupLabel').value,
    }, S.setupToken);
    setDeviceToken(r.deviceToken);
    S.setupToken = null; S.setupLocations = [];
    load();
  } catch (e) {
    renderSetup(e.message);
  }
}

load();
