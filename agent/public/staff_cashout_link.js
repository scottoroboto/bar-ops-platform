// "Cash Out" in the TV Staff tab bar: opens the bar's Cash Out page on the
// main Bar Ops site (the Pi only knows that site's address). Hidden until
// the address is known.
(function () {
  const a = document.getElementById('navCashOut');
  if (!a) return;
  fetch('/api/status').then((r) => r.json()).then((s) => {
    if (!s.cloudUrl) return;
    a.href = s.cloudUrl.replace(/\/$/, '') + '/cashout.html';
    a.style.display = '';
  }).catch(() => {});
})();
