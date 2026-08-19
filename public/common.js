// Shared across every page: session storage, the fetch wrapper, and the
// step-up flow. Loaded before each page's own script.

// The separate Jotform "hire pack" form — sensitive tax/W-4/direct-deposit/
// SSN/ID-upload info, kept encrypted in Jotform and never touched by this
// app. Basic info (name/email/phone) lives here in the app instead; this
// link is where people go to fill out or update the sensitive half.
const JOTFORM_HIRE_PACK_URL = 'https://form.jotform.com/262307421577053';

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

// Builds a small in-page modal asking for the password, and resolves with
// what was entered (or null on cancel). Deliberately NOT window.prompt()/
// alert() — those are native browser dialogs that block the entire tab,
// including clicks and navigation, until dismissed. If one of those opens
// off-screen or gets missed, the whole page looks frozen with "nothing
// works" — which is exactly what a real in-page modal avoids.
function showStepUpModal(errorText) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'display:block; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:30;';

    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'display:block; position:fixed; inset:0; margin:auto; max-width:360px; height:fit-content; top:20%; z-index:31;';
    card.innerHTML = `
      <h2>Re-enter your password</h2>
      <p class="muted" style="margin-top:-8px;">This is a sensitive action — confirm it's really you before continuing.</p>
      ${errorText ? `<div class="msg error">${escapeHtml(errorText)}</div>` : ''}
      <input type="password" id="stepUpPassword" placeholder="Password" autocomplete="current-password" style="width:100%; margin-bottom:12px;">
      <div class="stack-actions">
        <button class="secondary" id="stepUpCancel">Cancel</button>
        <button class="primary" id="stepUpContinue">Continue</button>
      </div>`;

    function cleanup(value) {
      document.removeEventListener('keydown', onKeydown);
      backdrop.remove();
      card.remove();
      resolve(value);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') cleanup(null);
      if (e.key === 'Enter') cleanup(input.value || null);
    }

    document.body.appendChild(backdrop);
    document.body.appendChild(card);
    const input = card.querySelector('#stepUpPassword');
    card.querySelector('#stepUpCancel').onclick = () => cleanup(null);
    card.querySelector('#stepUpContinue').onclick = () => cleanup(input.value || null);
    backdrop.onclick = () => cleanup(null);
    document.addEventListener('keydown', onKeydown);
    input.focus();
  });
}

// Re-enters the password inline and mints a fresh short-lived FULL
// session token. Used both proactively (opening an owner-only screen)
// and reactively (a write call came back STEP_UP_REQUIRED).
async function stepUp(errorText) {
  const person = getPerson();
  if (!person) { goLogin(); return false; }
  const password = await showStepUpModal(errorText);
  if (!password) return false;
  try {
    const result = await api('/api/auth/step-up', { method: 'POST', body: { personId: person.id, password } });
    if (result.ok) { setToken(result.token); return true; }
    return stepUp(result.error || 'Incorrect password.');
  } catch (e) {
    return stepUp(e.message);
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
    <div class="topbar-row">
      <div class="brand">🍸 Bar Ops${activeLabel ? ' · ' + escapeHtml(activeLabel) : ''}</div>
      <div class="who">
        ${person ? escapeHtml(person.name) + ' <span class="muted">(' + escapeHtml(person.role) + ')</span><br>' : ''}
        <a class="logout" href="#" onclick="logout(); return false;">Sign out</a>
      </div>
    </div>
    ${person ? renderTopnav(person, activeLabel) : ''}`;
}

// A persistent row of tabs so every page is one click from every other
// page — previously some pages (like Employees) had no way back except
// the browser's own back button. Time Clock/Service Calls are always
// shown (each page itself explains if that app isn't turned on for you
// yet); Employees is manager/owner only, matching the server-side gate.
function renderTopnav(person, activeLabel) {
  const tabs = [
    { label: 'Home', href: '/dashboard.html' },
    { label: 'Time Clock', href: '/timeclock.html' },
    { label: 'Service Calls', href: '/servicecalls.html' },
  ];
  if (person.role === 'manager' || person.role === 'owner') {
    tabs.push({ label: 'Employees', href: '/employees.html' });
  }
  return `<nav class="topnav">${tabs.map(t =>
    `<a class="tab${t.label === activeLabel ? ' active' : ''}" href="${t.href}">${escapeHtml(t.label)}</a>`
  ).join('')}</nav>`;
}
