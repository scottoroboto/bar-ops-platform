// "Cash Out" in the TV Staff tab bar: opens the bar's Cash Out page on the
// main Bar Ops site (the Pi only knows that site's address), telling it
// which page to come back to when the count is done. Hidden until the
// address is known.
(function () {
  const a = document.getElementById('navCashOut');
  if (!a) return;
  fetch('/api/status').then((r) => r.json()).then((s) => {
    if (!s.cloudUrl) return;
    const back = location.origin + location.pathname;
    a.href = s.cloudUrl.replace(/\/$/, '') + '/cashout.html?back=' + encodeURIComponent(back);
    a.style.display = '';
  }).catch(() => {});
})();
