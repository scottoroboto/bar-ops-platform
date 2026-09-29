// Music strip (Sept 2026): the bar's Sonos on every staff page. Loaded
// after the page's own script, so it borrows that page's STAFF_PASS and
// api(); it only draws the strip once the page has let the person in. Now
// playing, play / pause, skip, and STATIONS -> the Music page. No volume.
(function () {
  if (!/staff_(sources|tvs|layouts|power)\.html$/.test(location.pathname)) return;
  let stripEl = null;
  let last = null;
  let busy = null;

  function pass() { try { return STAFF_PASS; } catch (e) { return ''; } }
  async function call(path, opts) {
    const res = await fetch(path, { ...(opts || {}), headers: { 'Content-Type': 'application/json', 'x-staff-pass': pass() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function ensureStrip() {
    if (stripEl) return stripEl;
    stripEl = document.createElement('div');
    stripEl.className = 'mu-strip';
    document.body.appendChild(stripEl);
    document.body.classList.add('has-music-strip');
    return stripEl;
  }

  function render(m) {
    const el = ensureStrip();
    if (!m || !m.ok) {
      el.innerHTML = `<div class="mu-strip-art blank"></div><div class="mu-strip-text"><div class="s muted">${esc((m && m.error) || 'Music player not answering')}</div></div>
        <div class="mu-strip-btns"><a class="mu-strip-btn stations" href="/staff_music.html">MUSIC</a></div>`;
      return;
    }
    const t = m.track || {};
    const station = m.station && m.station.title ? m.station.title : '';
    el.innerHTML = `
      <div class="mu-strip-art">${t.art ? `<img src="${esc(t.art)}" alt="">` : '<div class="blank"></div>'}</div>
      <div class="mu-strip-text">
        <div class="s">${esc(t.title || (m.playing ? '…' : 'Paused'))}</div>
        <div class="ar">${esc(t.artist || '')}</div>
        <div class="stn">${esc(station)}</div>
      </div>
      <div class="mu-strip-btns">
        ${m.playing
          ? `<button class="mu-strip-btn play${busy === 'pause' ? ' busy' : ''}" data-cmd="pause" title="Pause">&#10074;&#10074;</button>`
          : `<button class="mu-strip-btn play${busy === 'play' ? ' busy' : ''}" data-cmd="play" title="Play">&#9654;</button>`}
        <button class="mu-strip-btn${busy === 'next' ? ' busy' : ''}" data-cmd="next">&#9197; SKIP</button>
        <a class="mu-strip-btn stations" href="/staff_music.html">STATIONS &#9652;</a>
      </div>`;
  }

  async function refresh() {
    const app = document.getElementById('app');
    if (!pass() || !app || app.style.display === 'none') return; // gate is up -- no strip
    try { last = await call('/api/music/state'); } catch (e) { last = { ok: false, error: e.message }; }
    render(last);
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.mu-strip-btn[data-cmd]');
    if (!btn || busy) return;
    busy = btn.getAttribute('data-cmd'); render(last);
    try { const r = await call(`/api/music/${busy}`, { method: 'POST' }); if (r.state) last = { ...last, ...r.state }; } catch (err) { alert(err.message); }
    busy = null; render(last);
    setTimeout(refresh, 1500);
  });

  setTimeout(refresh, 1500);
  setInterval(refresh, 8000);
})();
