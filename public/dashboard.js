// Icon glyphs are small inline SVGs (Feather-icon style: stroke-based,
// currentColor) so they render crisp at any size and pick up the chip's
// white color automatically — no external icon font/library needed.
const ICONS = {
  monitoring: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><polyline points="5 11 8 11 9.5 8 12 13.5 13.5 11 19 11"></polyline><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line><circle cx="19.5" cy="14.5" r="1.6" fill="#3fbf7f" stroke="#171a21" stroke-width="0.6"></circle></svg>`,
  service_calls: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`,
  time_clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"></circle><polyline points="12 7 12 12 15.5 13.8"></polyline></svg>`,
  scheduling: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`,
  employees: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
  my_account: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"></circle><circle cx="12" cy="10" r="3"></circle><path d="M6.5 18.2a5.5 5.5 0 0 1 11 0"></path></svg>`,
};

// Every tile uses the same coordinated blue chip, except Systems
// Monitoring, which gets its own slightly deeper blue shade (--tile-blue
// -monitoring) so it reads as a distinct category at a glance.
const APP_INFO = {
  monitoring: { label: 'Systems Monitoring', icon: ICONS.monitoring, color: 'var(--tile-blue-monitoring)', href: '/monitoring.html' },
  service_calls: { label: 'Service Calls', icon: ICONS.service_calls, color: 'var(--tile-blue)', href: '/servicecalls.html' },
  time_clock: { label: 'Time Clock', icon: ICONS.time_clock, color: 'var(--tile-blue)', href: '/timeclock.html' },
  scheduling: { label: 'Scheduling', icon: ICONS.scheduling, color: 'var(--tile-blue)', href: '#', comingSoon: true },
};

// One tile renderer for every icon on this page — real apps, the
// Employees admin tile, and My Account all go through this so they look
// and behave consistently (icon chip + optional review-count badge + label).
function tileHtml({ href, icon, color, label, note, count, disabled }) {
  const badge = count ? `<span class="tile-badge">${count > 99 ? '99+' : count}</span>` : '';
  const chip = `<span class="tile-icon-chip" style="background:${color}">${icon}</span>`;
  const iconBlock = `<span class="tile-icon-wrap">${chip}${badge}</span>`;
  const noteBlock = note ? `<div class="muted tile-note">${escapeHtml(note)}</div>` : '';
  const labelBlock = `<span class="tile-label">${escapeHtml(label)}</span>`;
  if (disabled) {
    return `<div class="app-tile disabled">${iconBlock}${labelBlock}${noteBlock}</div>`;
  }
  return `<a class="app-tile" href="${href}">${iconBlock}${labelBlock}${noteBlock}</a>`;
}

// Fetches a list endpoint just to count it for a badge. Never lets a
// failure (not enabled, network hiccup, role not permitted) break the
// rest of the grid — badges are a nice-to-have, not load-bearing.
async function safeCount(path) {
  try {
    const data = await api(path);
    return Array.isArray(data) ? data.length : 0;
  } catch (e) {
    return 0;
  }
}

// Sums everything a manager/owner might need to review: new applicants,
// pending pay-raise requests, and (owner only — the reset-requests route
// is owner-gated server-side) pending credential reset requests.
async function employeesReviewCount(person) {
  if (person.role !== 'manager' && person.role !== 'owner') return 0;
  let total = await safeCount('/api/employees/pending');
  total += await safeCount('/api/pay-rate-requests');
  if (person.role === 'owner') total += await safeCount('/api/reset-requests');
  return total;
}

(async function init() {
  const person = requireAuth();
  if (!person) return;
  renderTopbar('Apps Home');

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
  const isManagerOrOwner = person.role === 'manager' || person.role === 'owner';

  // Kick off counters only for tiles that'll actually be clickable, all in
  // parallel — no reason to block the grid render on these round-trips.
  const jobs = {};
  const scEntry = access.find(a => a.app_key === 'service_calls');
  if (scEntry && scEntry.enabled) jobs.service_calls = safeCount('/api/servicecalls?status=open');
  const monEntry = access.find(a => a.app_key === 'monitoring');
  if (monEntry && monEntry.enabled) jobs.monitoring = safeCount('/api/monitoring/alerts?openOnly=true');
  if (isManagerOrOwner) jobs.employees = employeesReviewCount(person);

  const counts = {};
  await Promise.all(Object.keys(jobs).map(async (k) => { counts[k] = await jobs[k]; }));

  const tiles = keys.map((key) => {
    const info = APP_INFO[key];
    const entry = access.find(a => a.app_key === key);
    const enabled = !!(entry && entry.enabled);
    if (info.comingSoon) {
      return tileHtml({ icon: info.icon, color: info.color, label: info.label, note: 'coming soon', disabled: true });
    }
    if (!enabled) {
      return tileHtml({ icon: info.icon, color: info.color, label: info.label, note: 'not enabled', disabled: true });
    }
    return tileHtml({ icon: info.icon, color: info.color, label: info.label, href: info.href, count: counts[key] });
  });

  // Employees replaces the old duplicate "Admin" card — it's just another
  // tile now, gated the same way the card used to be (manager/owner only),
  // with a badge for anything waiting on a review.
  if (isManagerOrOwner) {
    tiles.push(tileHtml({ icon: ICONS.employees, color: 'var(--tile-blue)', label: 'Employees', href: '/employees.html', count: counts.employees }));
  }
  // My Account replaces the old inline Account card — always the last tile.
  tiles.push(tileHtml({ icon: ICONS.my_account, color: 'var(--tile-blue)', label: 'My Account', href: '/profile.html' }));

  grid.innerHTML = tiles.join('');

  if (!enabledAny) {
    document.getElementById('statusCard').style.display = '';
    document.getElementById('statusCard').innerHTML =
      `<p class="msg info">Nothing's turned on for your account yet — ask your manager or the owner.</p>`;
  }
})();
