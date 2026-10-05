// Runs first on every staff page, before the page reads its pass. If a
// manager signed in on this iPad (Manager button, staff_bar_ipad.js) and
// that sign-in has run out, or nobody has tapped for 5 minutes, put the
// iPad's own pass back so the page opens as the bar iPad again.
(function () {
  var IDLE_MS = 5 * 60 * 1000;
  function info(p) {
    try { return JSON.parse(atob(String(p).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; }
  }
  try {
    var base = localStorage.getItem('vc_base_pass');
    if (!base) return;
    var cur = info(localStorage.getItem('vc_staff_pass') || '');
    var elevated = cur && (cur.actor === 'manager' || cur.actor === 'admin');
    var seen = Number(localStorage.getItem('vc_mgr_seen') || 0);
    if (!elevated || !(cur.exp > Date.now()) || Date.now() - seen > IDLE_MS) {
      if (!elevated || !(cur.exp > Date.now()) || Date.now() - seen > IDLE_MS) localStorage.setItem('vc_staff_pass', base);
      localStorage.removeItem('vc_base_pass');
      localStorage.removeItem('vc_mgr_seen');
    }
  } catch (e) { /* private mode */ }
})();
