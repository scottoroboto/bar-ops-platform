// Channel guide sheet (Oct 2026), shared by the TVs and Map pages: a time
// grid from the DirecTV receivers' guide, channels down and half hours
// across, like the DirecTV guide itself. Data: /api/sports/guide
// (lib/sports.js guideGrid). Tap a program, then a receiver, to put that
// channel on it (the page's own /api/sources/:slot/tune). A channel
// number the scan doesn't cover can be typed in and is added as a row.
(function () {
  const HALF = 30 * 60 * 1000;
  let G = { from: null, q: '', extra: [], data: null, sel: null, busy: false, timer: null, seq: 0, debounce: null };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pinHeaders() {
    const pin = (typeof STAFF_PASS !== 'undefined' && STAFF_PASS) || (() => { try { return localStorage.getItem('vc_staff_pass'); } catch (e) { return null; } })();
    return pin ? { 'x-staff-pin': pin } : {};
  }
  async function call(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...pinHeaders(), ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || body.error || `Request failed (${res.status})`), { status: res.status, data: body });
    return body;
  }
  function toast(text, bad) {
    if (typeof gamesToast === 'function') return gamesToast(text, bad);
    let el = document.getElementById('cgToast');
    if (!el) { el = document.createElement('div'); el.id = 'cgToast'; document.body.appendChild(el); }
    el.className = `cg-toast${bad ? ' bad' : ''}`; el.textContent = text; el.style.display = '';
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }
  function timeOf(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase(); }
  function dayOf(ms) { return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' }); }
  function chLabel(r) { return r.minor != null && r.minor !== '' ? `${r.major}-${r.minor}` : String(r.major); }
  function chId(r) { return `${r.major}-${r.minor == null ? '' : r.minor}`; }

  function back() {
    let b = document.getElementById('cgSheetBack');
    if (!b) {
      b = document.createElement('div');
      b.id = 'cgSheetBack';
      b.className = 'gm-sheet-back';
      b.addEventListener('click', (e) => { if (e.target === b) closeChannelGuide(); });
      document.body.appendChild(b);
    }
    b.style.display = 'flex';
    return b;
  }
  function receivers() {
    const list = (typeof SOURCES !== 'undefined' && Array.isArray(SOURCES)) ? SOURCES : [];
    return list.filter((s) => s.kind === 'directv').map((s) => ({
      slot: Number(s.slot), label: s.label, qam: String(s.qam_channel || '').replace(/\.1$/, ''), ok: !!(s.live && s.live.ok),
      tvs: typeof tvsOnSlot === 'function' ? tvsOnSlot(Number(s.slot)).length : null,
      now: s.live && (s.live.title || s.live.callsign) ? `${s.live.callsign ? s.live.callsign + ' · ' : ''}${s.live.title || ''}` : '',
    }));
  }

  function putHtml(row, prog) {
    const rcvs = receivers();
    const what = `${chLabel(row)} ${row.network || row.callsign || ''}${prog ? ` · ${prog.title}` : ''}`;
    if (!rcvs.length) return `<div class="cg-put"><p class="cg-note">Channel <b>${esc(chLabel(row))}</b>. No DirecTV receivers on this page to put it on.</p></div>`;
    return `<div class="cg-put"><div class="gs-label">Put ${esc(what)} on</div>
      <div class="gs-rcvs">${rcvs.map((r) => `<button type="button" class="gs-rcv${r.ok ? '' : ' down'}" ${r.ok ? `onclick="window.__cgTune(${r.slot}, '${esc(chId(row))}')"` : 'disabled'}>
        <span class="slot">${esc(r.label)}${r.qam ? ` · ${esc(r.qam)}` : ''}</span>
        <span class="t">${esc(r.ok ? (r.now || 'Idle') : 'Not responding')}</span>
        <span class="s">${esc(r.tvs == null ? '' : r.tvs ? `${r.tvs} TV${r.tvs === 1 ? '' : 's'} watching` : 'No TVs on it')}</span>
      </button>`).join('')}</div>
      <p class="cg-note">Every TV on that receiver changes with it.</p></div>`;
  }

  function render() {
    const b = back();
    const d = G.data;
    let body = '';
    if (!d) body = '<p class="cg-note">Asking the receivers…</p>';
    else {
      const span = d.to - d.from;
      const pct = (ms) => `${Math.max(0, Math.min(100, ((ms - d.from) / span) * 100))}%`;
      const head = `<div class="cg-grid-head"><div class="cg-chcol">${esc(dayOf(d.from))}</div><div class="cg-timeline">${d.slots.map((t) => `<span style="left:${pct(t)}">${esc(timeOf(t))}</span>`).join('')}</div></div>`;
      const nowLine = d.now >= d.from && d.now < d.to ? `<div class="cg-now" style="left:${pct(d.now)}"></div>` : '';  // drawn inside each strip, so it never crosses the receiver panel
      const rows = d.rows.map((r) => {
        const id = chId(r);
        const selHere = G.sel && G.sel.id === id;
        const blocks = r.programs.map((p, i) => {
          const s = Math.max(p.start, d.from), e = Math.min(p.end, d.to);
          const on = selHere && G.sel.i === i;
          return `<button type="button" class="cg-prog${p.onNow ? ' now' : ''}${on ? ' sel' : ''}" style="left:${pct(s)}; width:calc(${((e - s) / span) * 100}% - 2px)" onclick="window.__cgPick('${id}', ${i})" title="${esc(p.title)}${p.episode ? ' — ' + esc(p.episode) : ''} · ${esc(timeOf(p.start))}–${esc(timeOf(p.end))}"><b>${esc(p.title || '—')}</b>${p.episode && p.episode !== p.title ? `<small>${esc(p.episode)}</small>` : ''}</button>`;
        }).join('');
        const empty = !r.programs.length ? `<span class="cg-empty">${d.scanning ? 'checking…' : 'nothing listed'}</span>` : '';
        return `<div class="cg-row${selHere ? ' sel' : ''}"><button type="button" class="cg-chcol cg-ch" onclick="window.__cgPick('${id}', -1)"><b>${esc(chLabel(r))}</b><small>${esc(r.network || r.callsign || '')}</small></button><div class="cg-strip">${nowLine}${blocks}${empty}</div></div>` +
          (selHere ? putHtml(r, G.sel.i >= 0 ? r.programs[G.sel.i] : null) : '');
      }).join('');
      body = `<div class="cg-grid">${head}<div class="cg-rows">${rows || `<p class="cg-note">${d.scanning ? 'Checking the receivers’ guide — a few seconds.' : G.q ? `Nothing in these channels matches “${esc(G.q)}”. Type a channel number to add it.` : 'Nothing listed.'}</p>`}</div></div>`;
    }
    const foot = d ? `${d.scanning ? 'Reading the guide from the receivers… ' : ''}${d.scope === 'lineup' ? `Full lineup, ${d.lineup} channels, read ${esc(timeOf(d.at))}. ` : d.at ? `Game channels only, checked ${esc(timeOf(d.at))}. ` : ''}${d.error ? esc(d.error) + ' ' : ''}` : '';
    b.innerHTML = `<div class="gm-sheet cg-sheet">
      <div class="gs-head"><span>Channel guide</span><button type="button" class="gs-x" onclick="closeChannelGuide()">&times;</button></div>
      <div class="cg-tools">
        <input class="cg-search" id="cgSearch" type="search" placeholder="Team, show, network, or a channel number" value="${esc(G.q)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" oninput="window.__cgSearch(this.value)">
        <div class="cg-nav"><button type="button" class="map-bar-btn" onclick="window.__cgShift(-1)">&#8249; Earlier</button><button type="button" class="map-bar-btn" onclick="window.__cgShift(0)">Now</button><button type="button" class="map-bar-btn" onclick="window.__cgShift(1)">Later &#8250;</button></div>
      </div>
      ${body}
      <p class="cg-note">${foot}Tap a program, then a receiver. Any channel number can be typed in.</p>
    </div>`;
    if (G.keepFocus) { const inp = document.getElementById('cgSearch'); if (inp && document.activeElement !== inp) { inp.focus(); const v = inp.value; inp.value = ''; inp.value = v; } }
  }

  async function load() {
    const seq = ++G.seq;
    try {
      const qs = new URLSearchParams();
      if (G.from) qs.set('from', String(G.from));
      if (G.q) qs.set('q', G.q);
      if (G.extra.length) qs.set('extra', G.extra.join(','));
      const d = await call(`/api/sports/guide?${qs}`);
      if (seq !== G.seq) return;
      G.data = d;
      render();
      clearTimeout(G.timer);
      if (d.scanning) G.timer = setTimeout(load, 3000);
    } catch (err) {
      if (seq !== G.seq) return;
      G.data = null;
      back().querySelector('.cg-note, .gm-sheet');
      render();
      const n = document.querySelector('#cgSheetBack .cg-note'); if (n) n.textContent = err.message;
    }
  }

  window.openChannelGuide = function () {
    G = { from: null, q: '', extra: [], data: null, sel: null, busy: false, timer: null, seq: G.seq, keepFocus: false };
    render();
    load();
  };
  window.closeChannelGuide = function () {
    clearTimeout(G.timer); G.seq += 1;
    const b = document.getElementById('cgSheetBack'); if (b) b.style.display = 'none';
  };
  window.__cgSearch = function (v) {
    G.q = v; G.sel = null; G.keepFocus = true;
    const m = v.trim().match(/^(\d{1,4})(?:-(\d{1,4}))?$/);
    if (m) { const key = m[2] ? `${m[1]}-${m[2]}` : m[1]; if (!G.extra.includes(key)) G.extra.push(key); }
    clearTimeout(G.debounce);
    G.debounce = setTimeout(load, 300);
  };
  window.__cgShift = function (dir) {
    const base = G.data ? G.data.from : Date.now();
    G.from = dir === 0 ? null : base + dir * 3 * 60 * 60 * 1000;
    G.sel = null; G.keepFocus = false;
    load();
  };
  window.__cgPick = function (id, i) {
    G.keepFocus = false;
    G.sel = G.sel && G.sel.id === id && G.sel.i === i ? null : { id, i };
    render();
  };
  window.__cgTune = async function (slot, id) {
    if (G.busy || !G.data) return;
    const row = G.data.rows.find((r) => chId(r) === id);
    if (!row) return;
    G.busy = true;
    try {
      const body = { major: row.major, minor: row.minor == null ? undefined : row.minor };
      const t = typeof oneChannelTune === 'function'
        ? await oneChannelTune((extra) => call(`/api/sources/${slot}/tune`, { method: 'POST', body: JSON.stringify({ ...body, ...extra }) }))
        : await call(`/api/sources/${slot}/tune`, { method: 'POST', body: JSON.stringify(body) });
      if (t.cancelled) { G.busy = false; return; }
      const r = receivers().find((x) => x.slot === slot);
      if (t.moved) toast(t.failed.length ? `Moved to ${t.label}, except ${t.failed.map((x) => x.name).join(', ')}` : `Those TVs are on ${t.label} now (it already has ${chLabel(row)})`, t.failed.length > 0);
      else toast(`${r ? r.label : 'Receiver'} → ${chLabel(row)} ${row.network || row.callsign || ''}`);
      closeChannelGuide();
      if (typeof refreshSources === 'function') refreshSources(); else if (typeof refreshAll === 'function') refreshAll();
    } catch (err) { toast(err.message, true); }
    G.busy = false;
  };
})();
