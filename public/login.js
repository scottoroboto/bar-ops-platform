let pendingPersonId = null;

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text
    ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

function showTab(which) {
  document.getElementById('tabPin').classList.toggle('active', which === 'pin');
  document.getElementById('tabFull').classList.toggle('active', which === 'full');
  document.getElementById('panelPin').style.display = which === 'pin' ? '' : 'none';
  document.getElementById('panelFull').style.display = which === 'full' ? '' : 'none';
}

function resetFullForm() {
  pendingPersonId = null;
  document.getElementById('passwordStep').style.display = '';
  document.getElementById('codeStep').style.display = 'none';
  document.getElementById('fullPassword').value = '';
  document.getElementById('codeInput').value = '';
}

async function afterLogin(token, person) {
  setToken(token);
  setPerson(person);
  try {
    const me = await api('/api/auth/me');
    setAppAccess(me.appAccess || []);
  } catch (e) { /* dashboard will just show nothing enabled */ }
  window.location.href = '/dashboard.html';
}

async function doPinLogin() {
  const username = document.getElementById('pinUsername').value.trim();
  const pin = document.getElementById('pinPin').value.trim();
  if (!username || !pin) { showMsg('Enter your username and PIN.', 'error'); return; }
  showMsg('');
  try {
    const body = { username, pin };
    const deviceToken = getDeviceToken();
    if (deviceToken) body.deviceToken = deviceToken;
    const result = await api('/api/auth/login-pin', { method: 'POST', body });
    if (!result.ok) {
      if (result.error === 'NEEDS_FIRST_LOGIN') {
        showMsg(result.message, 'info');
        showTab('full');
        document.getElementById('fullUsername').value = username;
        return;
      }
      showMsg(result.error || 'Sign-in failed.', 'error');
      return;
    }
    await afterLogin(result.token, result.person);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function doPasswordLogin() {
  const username = document.getElementById('fullUsername').value.trim();
  const password = document.getElementById('fullPassword').value;
  if (!username || !password) { showMsg('Enter your username and password.', 'error'); return; }
  showMsg('');
  try {
    const result = await api('/api/auth/login-password', { method: 'POST', body: { username, password } });
    if (!result.ok) { showMsg(result.error || 'Sign-in failed.', 'error'); return; }
    if (result.stage === 'verify_code') {
      pendingPersonId = result.personId;
      document.getElementById('passwordStep').style.display = 'none';
      document.getElementById('codeStep').style.display = '';
      document.getElementById('codeHint').textContent =
        `First time signing in — we sent a 6-digit code to your ${result.channel === 'sms' ? 'phone' : 'email'}. Enter it below.`;
      return;
    }
    await afterLogin(result.token, result.person);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function doVerifyCode() {
  const code = document.getElementById('codeInput').value.trim();
  if (!code) { showMsg('Enter the code.', 'error'); return; }
  showMsg('');
  try {
    const result = await api('/api/auth/verify-code', { method: 'POST', body: { personId: pendingPersonId, code } });
    if (!result.ok) { showMsg(result.error || 'Incorrect code.', 'error'); return; }
    await afterLogin(result.token, result.person);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function toggleForgotPanel() {
  const panel = document.getElementById('panelForgot');
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? '' : 'none';
  if (opening) document.getElementById('forgotUsername').focus();
}

async function submitForgotRequest() {
  const username = document.getElementById('forgotUsername').value.trim();
  const requestType = document.getElementById('forgotType').value;
  const note = document.getElementById('forgotNote').value.trim();
  const resultEl = document.getElementById('forgotResult');
  if (!username) { resultEl.innerHTML = '<p class="msg error">Enter your username.</p>'; return; }
  try {
    const result = await api('/api/auth/request-reset', { method: 'POST', body: { username, requestType, note } });
    resultEl.innerHTML = `<p class="msg success">${escapeHtml(result.message)}</p>`;
    document.getElementById('forgotForm').style.display = 'none';
  } catch (e) {
    resultEl.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

(function init() {
  const params = new URLSearchParams(window.location.search);
  const msg = params.get('msg');
  if (msg) showMsg(msg, 'info');
  if (getToken()) window.location.href = '/dashboard.html';
})();
