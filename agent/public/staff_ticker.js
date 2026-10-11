// The NEXT line on a source card or TVs-rail row: "NEXT 7:30p · title".
// A line too long for its box scrolls sideways on a loop so the whole
// title can be read; short ones sit still. Shared by staff_sources.js and
// staff_tvs.js; call armTickers() after every render.
function fmtNextTime(epochSec) {
  if (!epochSec) return '';
  const d = new Date(Number(epochSec) * 1000);
  let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}${ap}`;
}
function nextLineHtml(next, cls) {
  if (!next || !next.title) return '';
  const t = fmtNextTime(next.startTime);
  return `<span class="${cls}"><span class="k">NEXT</span>${t ? `<span class="t">${escapeHtml(t)}</span> · ` : ''}${escapeHtml(next.title)}</span>`;
}
function armTickers(root) {
  const scope = root || document;
  scope.querySelectorAll('.sc-next, .tvsrc-next').forEach((el) => {
    if (el.querySelector('.inner')) return;
    if (el.scrollWidth <= el.clientWidth + 2) return;
    const html = el.innerHTML; const text = el.textContent;
    el.classList.add('scroll');
    el.innerHTML = `<span class="inner" data-text="${text.replace(/"/g, '&quot;')}">${html}</span>`;
    const w = el.querySelector('.inner').scrollWidth / 2;
    el.style.setProperty('--dur', `${Math.max(8, Math.round(w / 28))}s`);
  });
}
