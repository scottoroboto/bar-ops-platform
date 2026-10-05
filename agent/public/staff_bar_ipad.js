// Bar iPad (patch_053): the iPad behind the bar is signed in for good with
// a pass the owner made in TV Admin (actor "device", named like
// "T1-Main Bar"). On that iPad the Power tab is hidden (Scotto,
// 2026-10-05); everything else works as for staff. Loaded last on every
// staff page, after the page has stored its pass.
(function () {
  function info(pass) {
    try { return JSON.parse(atob(String(pass).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; }
  }
  let pass = '';
  const m = (location.hash || '').match(/[#&]pass=([^&]+)/);
  if (m) pass = decodeURIComponent(m[1]);
  if (!pass) try { pass = localStorage.getItem('vc_staff_pass') || ''; } catch (e) { /* private mode */ }
  const data = pass ? info(pass) : null;
  if (!data || data.actor !== 'device') return;
  document.documentElement.classList.add('bar-ipad');
  if (/staff_power\.html$/.test(location.pathname)) { location.replace('/staff_tvs.html'); return; }
  document.querySelectorAll('a[href="/staff_power.html"]').forEach((a) => a.remove());
})();
