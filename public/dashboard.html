const APP_INFO = {
  time_clock: { label: 'Time Clock', icon: '⏱️', href: '/timeclock.html' },
  service_calls: { label: 'Service Calls', icon: '🛠️', href: '/servicecalls.html' },
  scheduling: { label: 'Scheduling', icon: '🗓️', href: '#', comingSoon: true },
};

(async function init() {
  const person = requireAuth();
  if (!person) return;
  renderTopbar('Home');

  if (person.status && person.status !== 'active') {
    document.getElementById('statusCard').style.display = '';
    document.getElementById('statusCard').innerHTML =
      `<p class="msg info">Your account isn't fully active yet.</p>`;
  }

  // Fetch fresh rather than trusting the cached copy from login time — an
  // owner/manager can toggle their OWN access from the Employees page,
  // and without this the dashboard kept showing "not enabled" for
  // anything turned on after that last login, until they signed out and
  // back in again.
  let access;
  try {
    const me = await api('/api/auth/me');
    access = me.appAccess || [];
    setAppAccess(access);
  } catch (e) {
    access = getAppAccess();
  }
  const grid = document.getElementById('appGrid');
  const keys = Object.keys(APP_INFO);
  const enabledAny = access.some(a => a.enabled);

  grid.innerHTML = keys.map((key) => {
    const info = APP_INFO[key];
    const entry = access.find(a => a.app_key === key);
    const enabled = !!(entry && entry.enabled);
    if (info.comingSoon) {
      return `<div class="app-tile disabled"><span class="icon">${info.icon}</span>${info.label}<div class="muted" style="margin-top:4px;">coming soon</div></div>`;
    }
    if (!enabled) {
      return `<div class="app-tile disabled"><span class="icon">${info.icon}</span>${info.label}<div class="muted" style="margin-top:4px;">not enabled</div></div>`;
    }
    return `<a class="app-tile" href="${info.href}"><span class="icon">${info.icon}</span>${info.label}</a>`;
  }).join('');

  if (!enabledAny) {
    document.getElementById('statusCard').style.display = '';
    document.getElementById('statusCard').innerHTML =
      `<p class="msg info">Nothing's turned on for your account yet — ask your manager or the owner.</p>`;
  }

  if (person.role === 'manager' || person.role === 'owner') {
    document.getElementById('adminCard').style.display = '';
    document.getElementById('adminLinks').innerHTML = `
      <button class="secondary" onclick="location.href='/employees.html'">Employees</button>
      <button class="secondary" onclick="location.href='/timeclock.html?view=roster'">Time Clock roster</button>
      <button class="secondary" onclick="location.href='/servicecalls.html'">Service Calls (all locations)</button>
    `;
  }
})();
