// Shared across every page: session storage, the fetch wrapper, and the
// step-up flow. Loaded before each page's own script.

function getToken() { return localStorage.getItem('bp_token'); }
function setToken(t) { if (t) localStorage.setItem('bp_token', t); else localStorage.removeItem('bp_token'); }
function getPerson() { try { return JSON.parse(localStorage.getItem('bp_person') || 'null'); } catch (e) { return null; } }
function setPerson(p) { if (p) localStorage.setItem('bp_person', JSON.stringify(p)); else localStorage.removeItem('bp_person'); }
function getAppAccess() { try { return JSON.parse(localStorage.getItem('bp_appAccess') || '[]'); } catch (e) { return []; } }
function setAppAccess(a) { localStorage.setItem('bp_appAccess', JSON.stringify(a || [])); }
function getDeviceToken() { return localStorage.getItem('bp_deviceToken'); }
function setDeviceToken(t) { if (t) localStorage.setItem('bp_deviceToken', t); else localStorage.removeItem('bp_deviceToken'); }

function clearSession() { setToken(null); setPerson(null); setAppAccess([]); }

function goLogin(message) {
  clearSession();
  const params = message ? ('?msg=' + encodeURIComponent(message)) : '';
  window.location.href = '/index.html' + params;
}

function logout() { clearSession(); window.location.href = '/index.html'; }

// Core fetch wrapper — always sends the bearer token when we have one,
// always sends/receives JSON, and surfaces the two session-related error
// codes the backend uses (SESSION_EXPIRED, STEP_UP_REQUIRED) as
// recognizable errors instead of generic failures.
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, Object.assign({}, opts, {
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }));
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }

  if (res.status === 401 && data && data.error === 'SESSION_EXPIRED') {
    goLogin('Your session ended — please sign in again.');
    throw Object.assign(new Error('Session expired'), { code: 'SESSION_EXPIRED' });
  }
  if (res.status === 403 && data && data.error === 'STEP_UP_REQUIRED') {
    throw Object.assign(new Error(data.message || 'Please re-enter your password to continue.'), { code: 'STEP_UP_REQUIRED' });
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Request failed (${res.status})`);
    err.code = data && data.error;
    err.raw = data;
    throw err;
  }
  return data;
}

// Re-enters the password inline and mints a fresh short-lived FULL
// session token. Used both proactively (opening an owner-only screen)
// and reactively (a write call came back STEP_UP_REQUIRED).
async function stepUp() {
  const person = getPerson();
  if (!person) { goLogin(); return false; }
  const password = window.prompt('Re-enter your password to continue:');
  if (!password) return false;
  try {
    const result = await api('/api/auth/step-up', { method: 'POST', body: { personId: person.id, password } });
    if (result.ok) { setToken(result.token); return true; }
    alert(result.error || 'Incorrect password.');
    return false;
  } catch (e) {
    alert(e.message);
    return false;
  }
}

// Runs fn(); if the server says the session isn't full-tier (anymore or
// yet), prompts for step-up once and retries.
async function withStepUp(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.code === 'STEP_UP_REQUIRED') {
      const ok = await stepUp();
      if (ok) return await fn();
    }
    throw e;
  }
}

function requireAuth() {
  const token = getToken();
  const person = getPerson();
  if (!token || !person) { goLogin(); return null; }
  return person;
}

function requireRole(roles) {
  const person = requireAuth();
  if (!person) return null;
  if (!roles.includes(person.role)) {
    document.getElementById('app').innerHTML =
      '<div class="card"><p>You don\'t have access to this page.</p><p><a href="/dashboard.html">Back to home</a></p></div>';
    return null;
  }
  return person;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderTopbar(activeLabel) {
  const person = getPerson();
  const el = document.getElementById('topbar');
  if (!el) return;
  el.innerHTML = `
    <div class="brand">🍸 Bar Ops${activeLabel ? ' · ' + escapeHtml(activeLabel) : ''}</div>
    <div class="who">
      ${person ? escapeHtml(person.name) + ' <span class="muted">(' + escapeHtml(person.role) + ')</span><br>' : ''}
      <a class="logout" href="#" onclick="logout(); return false;">Sign out</a>
    </div>`;
}
