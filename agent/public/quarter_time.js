// Every time picker as a 15-minute dropdown (Scotto, 2026-10-01): "6:00 PM",
// "6:15 PM", ... A <select> whose values are "HH:MM" reads and sets just
// like the <input type="time"> it replaces, so page code doesn't change.
// A time already saved off the quarter hour (6:05) still shows, as its own
// choice. Same file on the cloud pages (public/quarter_time.js).
(function () {
  const pad = (n) => String(n).padStart(2, '0');
  const label = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const QUARTERS = [];
  for (let h = 0; h < 24; h += 1) for (let m = 0; m < 60; m += 15) QUARTERS.push(`${pad(h)}:${pad(m)}`);
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const norm = (v) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
    return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${pad(m[1])}:${m[2]}` : '';
  };

  function addOption(sel, hhmm) {
    if (!hhmm || [...sel.options].some((o) => o.value === hhmm)) return;
    const opt = new Option(label(hhmm), hhmm);
    const after = [...sel.options].find((o) => o.value && o.value > hhmm);
    sel.insertBefore(opt, after || null);
  }

  function upgrade(input) {
    if (input.dataset.noQuarter !== undefined) return;
    const sel = document.createElement('select');
    for (const a of [...input.attributes]) if (!['type', 'value', 'step', 'min', 'max'].includes(a.name)) sel.setAttribute(a.name, a.value);
    sel.add(new Option('—', ''));
    for (const q of QUARTERS) sel.add(new Option(label(q), q));
    // Setting a time that isn't on the list adds it, so nothing is lost.
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { const t = norm(v); addOption(this, t); desc.set.call(this, t); },
    });
    sel.value = input.value || input.getAttribute('value') || '';
    input.replaceWith(sel);
  }

  function scan(root) {
    if (root.matches && root.matches('input[type="time"]')) upgrade(root);
    if (root.querySelectorAll) root.querySelectorAll('input[type="time"]').forEach(upgrade);
  }
  const start = () => {
    scan(document.body);
    new MutationObserver((list) => { for (const m of list) m.addedNodes.forEach(scan); })
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
