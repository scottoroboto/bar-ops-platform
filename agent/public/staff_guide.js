// Channel guide sheet (Oct 2026), shared by the TVs and Map pages: what the
// DirecTV receivers' guide says is on right now, a find box, a direct
// lookup for any channel number, and "put it on this receiver". The data
// is /api/sports/guide (lib/sports.js guideNow); tuning is the same
// /api/sources/:slot/tune the rest of the page uses. Uses the page's
// SOURCES / tvsOnSlot when they're there, so both pages need no changes
// beyond the button.
(function () {
  let G = { q: '', data: null, sel: null, busy: false, timer: null, seq: 0 };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pinHeaders() {
    const pin = (typeof STAFF_PASS !== 'undefined' && STAFF_PASS) || (() => { try { return localStorage.getItem('vc_staff_pass'); } catch (e) { return null; } })();
    return pin ? { 'x-staff-pin': pin } : {};
  }
  async function call(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...pinHeaders(), ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || body.error || `Request failed (${res.status})`);
    return body;
  }
  function toast(text, bad) {
    if (typeof gamesToast === 'function') return gamesToast(text, bad);
    let el = document.getElementById('cgToast');
    if (!el) { el = document.createElement('div'); el.id = 'cgToast'; document.body.appendChild(el); }
    el.className = `cg-toast${bad ? ' bad' : ''}`; el.textContent = text; el.style.display = '';
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }
  function timeOf(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function chLabel(e) { return e.minor != null && e.minor !== '' ? `${e.major}-${e.minor}` : String(e.major); }
  function chId(e) { return `${e.major}-${e.minor == null ? '' : e.minor}`; }

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

  function rowHtml(e) {
    const id = chId(e);
    const sel = G.sel === id;
    const sub = e.episode && e.episode !== e.title ? e.episode : (e.network && e.network !== e.callsign ? '' : '');
    return `<button type="button" class="cg-row${sel ? ' sel' : ''}${e.onNow ? '' : ' soon'}" onclick="window.__cgPick('${id}')">
      <span class="cg-num">${esc(chLabel(e))}<small>${esc(e.network || e.callsign || '')}</small></span>
      <span class="cg-title">${esc(e.offAir ? 'Off air' : (e.title || '—'))}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="cg-when${e.onNow ? ' now' : ''}">${e.offAir ? '' : e.onNow ? `ON NOW · to ${esc(timeOf(e.end))}` : `at ${esc(timeOf(e.start))}`}</span>
    </button>` + (sel && !e.offAir ? putHtml(e) : '');
  }
  function putHtml(e) {
    const rcvs = receivers();
    if (!rcvs.length) return `<p class="cg-note">No DirecTV receivers on this page to put it on. Channel <b>${esc(chLabel(e))}</b>.</p>`;
    return `<div class="cg-put"><div class="gs-label">Put ${esc(chLabel(e))} ${esc(e.network || e.callsign || '')} on</div>
      <div class="gs-rcvs">${rcvs.map((r) => `<button type="button" class="gs-rcv${r.ok ? '' : ' down'}" ${r.ok ? `onclick="window.__cgTune(${r.slot}, '${id(e)}')"` : 'disabled'}>
        <span class="slot">${esc(r.label)}${r.qam ? ` · ${esc(r.qam)}` : ''}</span>
        <span class="t">${esc(r.ok ? (r.now || 'Idle') : 'Not responding')}</span>
        <span class="s">${esc(r.tvs == null ? '' : r.tvs ? `${r.tvs} TV${r.tvs === 1 ? '' : 's'} watching` : 'No TVs on it')}</span>
      </button>`).join('')}</div>
      <p class="cg-note">Every TV on that receiver changes with it.</p></div>`;
    function id(x) { return chId(x); }
  }

  function render() {
    const b = back();
    const d = G.data;
    let list;
    if (!d) list = '<p class="cg-note">Asking the receivers…</p>';
    else {
      const rows = [];
      if (d.lookup) rows.push(d.lookup.error ? `<p class="cg-note">Channel ${esc(String(d.lookup.major))}: ${esc(d.lookup.error)}</p>` : rowHtml(d.lookup));
      rows.push(...d.entries.map(rowHtml));
      if (!rows.length) rows.push(`<p class="cg-note">${d.scanning ? 'Checking the receivers’ guide — a few seconds.' : G.q ? `Nothing in the scanned channels matches “${esc(G.q)}”. Type a channel number to look it up directly.` : 'Nothing in the guide yet.'}</p>`);
      list = rows.join('');
    }
    const foot = d ? `${d.scanning ? 'Refreshing from the receivers… · ' : ''}${d.channels ? `${d.channels} channels` : ''}${d.at ? ` · checked ${esc(timeOf(d.at))}` : ''}${d.error ? ` · ${esc(d.error)}` : ''}` : '';
    b.innerHTML = `<div class="gm-sheet">
      <div class="gs-head"><span>Channel guide · on now</span><button type="button" class="gs-x" onclick="closeChannelGuide()">&times;</button></div>
      <input class="cg-search" id="cgSearch" type="search" placeholder="Team, show, network, or a channel number" value="${esc(G.q)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" oninput="window.__cgSearch(this.value)">
      <div class="cg-list">${list}</div>
      <p class="cg-note">${foot} Tap a channel, then a receiver. Only the channels the box scans show here; any other number can be typed in.</p>
    </div>`;
    const inp = document.getElementById('cgSearch');
    if (inp && document.activeElement !== inp && !G.sel && G.keepFocus) { inp.focus(); const v = inp.value; inp.value = ''; inp.value = v; }
  }

  async function load() {
    const seq = ++G.seq;
    try {
      const d = await call(`/api/sports/guide?q=${encodeURIComponent(G.q)}`);
      if (seq !== G.seq) return;
      G.data = d;
      render();
      clearTimeout(G.timer);
      if (d.scanning) G.timer = setTimeout(load, 4000);
    } catch (err) {
      if (seq !== G.seq) return;
      G.data = { entries: [], error: err.message, scanning: false, channels: 0, at: null };
      render();
    }
  }

  window.openChannelGuide = function () {
    G = { q: '', data: null, sel: null, busy: false, timer: null, seq: G.seq, keepFocus: true };
    render();
    load();
  };
  window.closeChannelGuide = function () {
    clearTimeout(G.timer); G.seq += 1;
    const b = document.getElementById('cgSheetBack'); if (b) b.style.display = 'none';
  };
  window.__cgSearch = function (v) {
    G.q = v; G.sel = null;
    clearTimeout(G.debounce);
    G.debounce = setTimeout(load, 250);
  };
  window.__cgPick = function (id) { G.sel = G.sel === id ? null : id; G.keepFocus = false; render(); };
  window.__cgTune = async function (slot, id) {
    if (G.busy) return;
    const all = [...(G.data && G.data.lookup && !G.data.lookup.error ? [G.data.lookup] : []), ...((G.data && G.data.entries) || [])];
    const e = all.find((x) => chId(x) === id);
    if (!e) return;
    G.busy = true;
    try {
      await call(`/api/sources/${slot}/tune`, { method: 'POST', body: JSON.stringify({ major: e.major, minor: e.minor == null ? undefined : e.minor }) });
      const r = receivers().find((x) => x.slot === slot);
      toast(`${r ? r.label : 'Receiver'} → ${chLabel(e)} ${e.network || e.callsign || ''}${e.title ? ` · ${e.title}` : ''}`);
      closeChannelGuide();
      if (typeof refreshSources === 'function') refreshSources(); else if (typeof refreshAll === 'function') refreshAll();
    } catch (err) { toast(err.message, true); }
    G.busy = false;
  };
})();
