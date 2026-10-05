// Which tabs this pass sees, and the Manager button. A bar iPad (patch_053)
// is signed in for good with a pass the owner made in TV Admin (actor
// "device", named like "T1-Main Bar"); Power is hidden there. Routines and
// Events show only for the owner and managers (Scotto, 2026-10-05).
// Manager (by the logo): the owner or a manager at this bar picks their
// name and enters their PIN; the page then runs on their short pass and
// signs itself back out after 5 minutes without a tap (or 30 minutes at
// most). staff_pass_boot.js does the switch-back on page load. Loaded last
// on every staff page, after the page has stored its pass.
(function () {
  var IDLE_MS = 5 * 60 * 1000;
  function info(pass) {
    try { return JSON.parse(atob(String(pass).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } return null; }

  var pass = '';
  var q = (location.search || '').match(/[?&]barpass=([^&]+)/);
  var m = (location.hash || '').match(/[#&]pass=([^&]+)/);
  if (q) pass = decodeURIComponent(q[1]);
  else if (m) pass = decodeURIComponent(m[1]);
  if (!pass) pass = ls('vc_staff_pass') || '';
  var data = pass ? info(pass) : null;
  if (!data) return;

  var manager = data.actor === 'admin' || data.actor === 'manager';
  var elevated = manager && !!ls('vc_base_pass');
  if (!manager && ls('vc_base_pass')) { ls('vc_base_pass', null); ls('vc_mgr_seen', null); }

  // ---- tabs
  var hide = [];
  if (!manager) hide.push('/staff_layouts.html', '/staff_events.html');
  if (data.actor === 'device') { document.documentElement.classList.add('bar-ipad'); hide.push('/staff_power.html'); }
  if (hide.indexOf(location.pathname) !== -1) { location.replace('/staff_tvs.html'); return; }
  hide.forEach(function (href) { document.querySelectorAll('a[href="' + href + '"]').forEach(function (a) { a.remove(); }); });

  // ---- Manager button by the logo (not for someone already in as owner/manager on their own)
  var brand = document.querySelector('.tb-brand');
  if (!brand || (manager && !elevated)) return;
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tb-mgr' + (elevated ? ' on' : '');
  btn.innerHTML = elevated ? esc(data.name || 'Manager') + ' &middot; Sign out' : 'Manager';
  var divider = brand.querySelector('.tb-divider');
  brand.insertBefore(btn, divider || null);

  function signOut() {
    var base = ls('vc_base_pass');
    if (base) ls('vc_staff_pass', base);
    ls('vc_base_pass', null); ls('vc_mgr_seen', null);
    location.href = '/staff_tvs.html';
  }

  if (elevated) {
    btn.onclick = signOut;
    ls('vc_mgr_seen', String(Date.now()));
    var lastWrite = 0;
    ['pointerdown', 'keydown'].forEach(function (ev) {
      document.addEventListener(ev, function () { var now = Date.now(); if (now - lastWrite > 5000) { lastWrite = now; ls('vc_mgr_seen', String(now)); } }, true);
    });
    setInterval(function () {
      var seen = Number(ls('vc_mgr_seen') || 0);
      if (Date.now() - seen > IDLE_MS || !(data.exp > Date.now())) signOut();
    }, 10000);
    return;
  }

  // ---- sign-in sheet: pick your name, enter your PIN
  var sheet = null;
  var people = null;
  var pick = null;
  var digits = '';
  var msg = '';
  function call(path, opts) {
    return fetch(path, Object.assign({}, opts || {}, { headers: { 'Content-Type': 'application/json', 'x-staff-pass': ls('vc_staff_pass') || pass } }))
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || r.statusText); return d; }); });
  }
  function close() { if (sheet) sheet.remove(); sheet = null; pick = null; digits = ''; msg = ''; }
  function render() {
    if (!sheet) return;
    var inner;
    if (!people) inner = '<div class="mgr-sub">Loading…</div>';
    else if (!pick) {
      inner = '<div class="mgr-sub">Who’s signing in?</div><div class="mgr-names">'
        + (people.length ? people.map(function (p, i) { return '<button type="button" data-i="' + i + '">' + esc(p.name) + '</button>'; }).join('') : '<div class="mgr-sub">No managers set up for this bar.</div>')
        + '</div>';
    } else {
      var dots = '';
      for (var k = 0; k < 4; k += 1) dots += '<span class="' + (k < digits.length ? 'f' : '') + '"></span>';
      var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'].map(function (key) {
        var label = key === 'back' ? '&larr;' : key === 'ok' ? 'Back' : key;
        return '<button type="button" data-k="' + key + '">' + label + '</button>';
      }).join('');
      inner = '<div class="mgr-sub">' + esc(pick.name) + ', enter your PIN</div><div class="mgr-dots">' + dots + '</div><div class="mgr-pad">' + keys + '</div>';
    }
    sheet.innerHTML = '<div class="mgr-card"><div class="mgr-title">Manager sign-in</div>' + inner
      + (msg ? '<div class="mgr-msg">' + esc(msg) + '</div>' : '')
      + '<div class="mgr-note">Unlocks Routines, Events and Power. Signs out by itself after 5 minutes without a tap.</div>'
      + '<button type="button" class="mgr-cancel" data-x="1">Cancel</button></div>';
  }
  function submit() {
    var pin = digits;
    msg = 'Checking…'; render();
    call('/api/manager/sign-in', { method: 'POST', body: JSON.stringify({ personId: pick.id, pin: pin }) }).then(function (r) {
      ls('vc_base_pass', ls('vc_staff_pass') || pass);
      ls('vc_staff_pass', r.pass);
      ls('vc_mgr_seen', String(Date.now()));
      location.href = location.pathname; // drop ?barpass so the manager pass is the one read
    }).catch(function (e) { digits = ''; msg = e.message; render(); });
  }
  btn.onclick = function () {
    sheet = document.createElement('div');
    sheet.className = 'mgr-back';
    document.body.appendChild(sheet);
    sheet.addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (e.target === sheet || (t && t.dataset.x)) return close();
      if (!t) return;
      if (t.dataset.i !== undefined) { pick = people[Number(t.dataset.i)]; digits = ''; msg = ''; return render(); }
      var k = t.dataset.k;
      if (!k) return;
      if (k === 'ok') { pick = null; digits = ''; msg = ''; return render(); }
      if (k === 'back') { digits = digits.slice(0, -1); return render(); }
      if (digits.length < 4) { digits += k; msg = ''; render(); if (digits.length === 4) submit(); }
    });
    render();
    call('/api/manager/people').then(function (r) { people = r.people || []; render(); }).catch(function (e) { people = []; msg = e.message; render(); });
  };
})();
