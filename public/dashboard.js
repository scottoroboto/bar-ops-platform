// Icon glyphs are small PNG data URIs (Scotto's chosen icon set — flat
// white glyph on a solid blue rounded-square chip). Baked-in background
// means the tile chip itself needs no separate color styling; the image
// is the whole icon.
const ICONS = {
  monitoring: 'data:image/png;base64,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',
  service_calls: 'data:image/png;base64,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',
  time_clock: 'data:image/png;base64,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',
  scheduling: 'data:image/png;base64,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',
  employees: 'data:image/png;base64,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',
  my_account: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACABAMAAAAxEHz4AAAAElBMVEUQct77/P0AAABop+n7/flmmuog7WQpAAAABnRSTlP+/wD8LQQQw6w2AAAFBklEQVR42q1awW7jNhB9HHp7a0A1x2ZtVnveQIl7XuwXLPKpi35BkV56SSMEBXpaR06aNhevBB+KAg3JHiTbFDWUZTk8WRL5NDMcvnmkLFI0zV7m2F70tgXkF725EJsxhbYFZDZgvMlB2lIA8Ph2+sv7HMOafP/79Pyu+Z3U9qtp9ffzwPFwz2L9b6E8AMq+qYa+voYQ63RW7QDu/8FB4wEnvloBAAQANi0OHA8YmxZbgKczjGjXnzYAVHtzaHNr3cRg9u2vowAehQMIsNc/Y1R7OStqF87GjYe8vgImwNN/IwHMxAIEmGwkAF5yQKQWxVgAEDThzbvR43F5BaSEI5pOyR4HUAgNlY8eLx2I9PjxMMAE8hgXLr8SvsQfzyGSRGEe7/EbSEezYC4WiQJEslBRKy3F50As1PbniYrnUuSRFK0HQkXy/SVigQzfKZY8whseQNruvYJHmPCxad5fzgHc1KVDFMMBLuq+a4MbACizJQCI0xW7IBkHCgBwM7O5ka8rALDZQAALAM4vVcZVAFji4AAUABcwvasAiGEACTO+uZMMARAAoCM91QAABYCYJW50hBa5xs0XbtkoEOdByed3CeC0A/A5yAEFuB4G6eQCcTkQaxWTC3TF9+PrMRfEzx0PyGeFJPGZQAMi67XAAni7uzxRgFjuru+6PgQWZIDb5kAjAZFkHo2HLB5Y0II/3/x49H2wfbMg/RDKojt3t7WVUQDLGuCb0AkCdULAdbT+FMsegEFl0vQAKC8EIlyim1wS8WmUfoiyMLrdLp1pNL4XOWu2CZ9QsJSpa3XbHx08abkwUO/JqAu5Z2usoud7+CC2lDNvGkwUQHkdTeTFMpjHo0ReCCCH5KIJgk29BNhLZjwrD5m5qAsmzqCrQQDtURJ8ilXtQHG03tjjBcHlY2LgBlSK18iDK/Crzq+xZSxdmURqbycGWNn78FYDAK16AXoT6XZdlrPV4LVgupxiOqsjXDDxPBixGsMkA+QcmGehTa5PKysvZ7IlFgkWSNYmMtGhBe1SsBMGJyqLk2rAW7IlLnbbDf8lpi8PjC94A/27KblVFIC2LsqOKt7JlKC08XWXUXuPfGmgkAcVeFHdYIqQHzsCQyKyMdiC7hEYtlGLzE40q1H6BIbr1bsFR08UtZTfD+/jg6oPQ3A1hnhXY/Vl75aHABQxEnY4726nqFsMRKwSVii6JYL2F9b+AkvMteL7VhDMhpDA+cCZ4ADFFDnik5a5rfkEn3CeCpgyXM9lCcVFh8CVo4SbrYTt3r1zBwCnTVXadlvhAu39VBTA6Ho53c5299areikxe2omWncNBzbnFs1ZRsIbwAHU0iQBjCvT2TqdVXkznhMq3CGMqxRQl5Mb4KYuMeypRCwPqCkMcnOotkTkVCJyDGQqVR+hoQSQNIdqZTn8IMptzviSvVKE+rRJkAkHSZwQIapzohrJz6M6kyJESdEzC2k2ESizqFLV/TJtDnQkSgiQ6qMUUkp4dwzAJSjcXR3Wchx9NA49OcaCj0T06RiAJ430mMP1bJK+wicSeshGx3CqQYA9HQtwUQAEfBydCfkEIKD4cyzAh/pDFU1HzsOPD7rmg4cfRoVRniwaQrFLNQZAnOgNI30/KgofftrKcnE/08+HOiBsstP132VOPR84PtXVDsD9tf4jez5o/PS+xcr0mCo5eC5kJqbnDRW+2sd7wF7mNIxgbeH9feB//Bd1oSY/Y3sAAAAASUVORK5CYII=',
};

const APP_INFO = {
  monitoring: { label: 'Systems Monitoring', icon: ICONS.monitoring, href: '/monitoring.html' },
  service_calls: { label: 'Service Calls', icon: ICONS.service_calls, href: '/servicecalls.html' },
  time_clock: { label: 'Time Clock', icon: ICONS.time_clock, href: '/timeclock.html' },
  scheduling: { label: 'Scheduling', icon: ICONS.scheduling, href: '/scheduling.html' },
};

// One tile renderer for every icon on this page — real apps, the
// Employees admin tile, and My Account all go through this so they look
// and behave consistently (icon chip + optional review-count badge + label).
function tileHtml({ href, icon, label, note, count, disabled }) {
  const badge = count ? `<span class="tile-badge">${count > 99 ? '99+' : count}</span>` : '';
  const chip = `<span class="tile-icon-chip"><img src="${icon}" alt="" width="56" height="56"></span>`;
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
  // Badge is pending-time-off-to-approve — only meaningful for a manager/
  // owner who actually manages a schedule; safeCount already no-ops to 0
  // on a 403/empty response for anyone else.
  const schedEntry = access.find(a => a.app_key === 'scheduling');
  if (schedEntry && schedEntry.enabled && isManagerOrOwner) jobs.scheduling = safeCount('/api/scheduling/time-off/to-approve');
  if (isManagerOrOwner) jobs.employees = employeesReviewCount(person);

  const counts = {};
  await Promise.all(Object.keys(jobs).map(async (k) => { counts[k] = await jobs[k]; }));

  const tiles = keys.map((key) => {
    const info = APP_INFO[key];
    const entry = access.find(a => a.app_key === key);
    const enabled = !!(entry && entry.enabled);
    if (info.comingSoon) {
      return tileHtml({ icon: info.icon, label: info.label, note: 'coming soon', disabled: true });
    }
    if (!enabled) {
      return tileHtml({ icon: info.icon, label: info.label, note: 'not enabled', disabled: true });
    }
    return tileHtml({ icon: info.icon, label: info.label, href: info.href, count: counts[key] });
  });

  // Employees replaces the old duplicate "Admin" card — it's just another
  // tile now, gated the same way the card used to be (manager/owner only),
  // with a badge for anything waiting on a review.
  if (isManagerOrOwner) {
    tiles.push(tileHtml({ icon: ICONS.employees, label: 'Employees', href: '/employees.html', count: counts.employees }));
  }
  // My Account replaces the old inline Account card — always the last tile.
  tiles.push(tileHtml({ icon: ICONS.my_account, label: 'My Account', href: '/profile.html' }));

  grid.innerHTML = tiles.join('');

  if (!enabledAny) {
    document.getElementById('statusCard').style.display = '';
    document.getElementById('statusCard').innerHTML =
      `<p class="msg info">Nothing's turned on for your account yet — ask your manager or the owner.</p>`;
  }
})();
