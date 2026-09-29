// Shared by the TVs tab (capture lives there: it needs the highlighted TVs)
// and the Scenes & Events tab (Apply / End / Edit / scenes). Each page
// supplies api(), escapeHtml(), fmtClock(), TVS, renderBulkProgress(),
// flashAttention() and refreshAll(); the modal lives in #evOverlay/#evPanel.
// =======================================================================
// EVENTS & SCENES (patch_043). "Scenes are how the bar normally looks,
// events are what's on tonight." Everything here talks only to this box's
// /api/events and /api/scenes; the box talks to the cloud.
//   - Anyone with a pass: Apply now / End (plain confirm, no PIN), tap a
//     scene, answer the conflict popup.
//   - Owner or manager (the pass says): Capture event from the highlighted
//     TVs, edit, delete, Capture scene.
// A capture changes nothing on any TV -- it saves the setup for later.
// =======================================================================
let EVENTS = { events: [], scenes: [], pending_conflict: null, is_manager: false };
let EV_CONFLICT_SHOWN = null;   // pending event id the popup is already open for
let evCountdownTimer = null;
const EV_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function refreshEvents(rerender = true) {
  try {
    EVENTS = await api('/api/events');
  } catch (e) { return; }
  if (rerender) {
    if (typeof renderPage === 'function' && !(typeof TV_REMOTE_OPEN !== 'undefined' && TV_REMOTE_OPEN)) renderPage();
    if (typeof renderEventsSection === 'function') renderEventsSection();
  }
  const pc = EVENTS.pending_conflict;
  if (pc && EV_CONFLICT_SHOWN !== pc.event_id) openConflictModal(pc);
  if (!pc && EV_CONFLICT_SHOWN != null) { EV_CONFLICT_SHOWN = null; closeEvModal(); }
}

function fmtClock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function fmtIsoTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}
function fmtEvDate(d) {
  if (!d) return '';
  return new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function eventWhen(e) {
  if (e.running) return `Running${e.ends_at ? ` until ${fmtIsoTime(e.ends_at)}` : ' — tap End when it\'s over'}`;
  if (e.waiting_behind && e.waiting_behind.length) return `Waiting for "${e.waiting_behind[0]}" to end`;
  if (e.kind === 'once') return `${fmtEvDate(e.event_date)} · ${fmtClock(e.start_time)}–${fmtClock(e.end_time)}`;
  if (e.kind === 'weekly') return `${(e.days || []).map((d) => EV_DAYS[d]).join(' ')} · ${fmtClock(e.start_time)}–${fmtClock(e.end_time)}`;
  return 'Manual — tap Apply when it starts';
}

function eventsBlockHtml() {
  const evs = EVENTS.events || [];
  const scenes = (EVENTS.scenes || []).filter((sc) => sc.enabled !== false);
  const rows = evs.length ? evs.map((e) => `
    <div class="ev-row ${e.running ? 'running' : ''}">
      <div class="ev-main">
        <div class="ev-name">${escapeHtml(e.name)}${e.enabled === false ? ' <span class="t">(off)</span>' : ''}</div>
        <div class="ev-when">${escapeHtml(eventWhen(e))} · ${e.tv_ids.length} TV${e.tv_ids.length === 1 ? '' : 's'}</div>
      </div>
      ${EVENTS.is_manager && !e.running ? `<button class="ghost" onclick="openEditEvent(${e.id})">Edit</button>` : ''}
      ${e.running
        ? `<button class="small off" onclick="confirmEndEvent(${e.id})">End</button>`
        : `<button class="small primary" ${e.items.length ? '' : 'disabled'} onclick="confirmApplyEvent(${e.id})">Apply</button>`}
    </div>`).join('') : `<div class="ev-empty">${EVENTS.is_manager ? 'No events yet. Highlight the TVs for one (pick a source first if it should change channel) and tap <b>Capture event</b>.' : 'No events set up. A manager captures them here.'}</div>`;
  return `
    <div class="ev-block">
      <div class="tvs-col-header"><span class="tvs-col-title">Events</span></div>
      <div class="ev-scroll">${rows}</div>
      <div class="tvs-col-header" style="margin-top:6px;"><span class="tvs-col-title">Scenes</span>${EVENTS.is_manager ? '<button class="small" onclick="openCaptureScene()">Capture scene</button>' : ''}</div>
      <div class="ev-scenes">${scenes.length ? scenes.map((sc) => `<button ${sc.item_count ? '' : 'disabled'} onclick="confirmApplyScene(${sc.id})">${escapeHtml(sc.name)}${sc.daily_time ? `<span class="t">${fmtClock(sc.daily_time)}</span>` : ''}</button>`).join('') : '<span class="ev-empty">No scenes yet.</span>'}</div>
    </div>`;
}

// ---- modal plumbing
function openEvModal(html) {
  document.getElementById('evPanel').innerHTML = html;
  document.getElementById('evOverlay').classList.add('open');
}
function closeEvModal() {
  document.getElementById('evOverlay').classList.remove('open');
  document.getElementById('evPanel').innerHTML = '';
  if (evCountdownTimer) { clearInterval(evCountdownTimer); evCountdownTimer = null; }
}
function evHeader(title) {
  return `<div class="fav-panel-header"><h1>${escapeHtml(title)}</h1><button class="close" onclick="closeEvModal()">&times;</button></div>`;
}
function evMsg(text, kind) {
  const el = document.getElementById('evModalMsg');
  if (el) el.innerHTML = text ? `<div class="msg ${kind || 'error'}">${escapeHtml(text)}</div>` : '';
}
function confirmModal(title, text, yesLabel, yesClass = 'primary') {
  return new Promise((resolve) => {
    openEvModal(`${evHeader(title)}<p>${text}</p>
      <div class="ev-actions"><button onclick="closeEvModal(); window.__evResolve(false)">Cancel</button><button class="${yesClass}" onclick="closeEvModal(); window.__evResolve(true)">${escapeHtml(yesLabel)}</button></div>`);
    window.__evResolve = resolve;
  });
}

// ---- apply / end / scenes
function evById(id) { return (EVENTS.events || []).find((e) => Number(e.id) === Number(id)); }

async function confirmApplyEvent(id) {
  const e = evById(id); if (!e) return;
  const when = e.kind === 'manual' ? '' : ` It's scheduled for ${e.kind === 'once' ? fmtEvDate(e.event_date) + ' ' : ''}${fmtClock(e.start_time)}.`;
  const ok = await confirmModal(`Start "${e.name}" now?`, `${e.tv_ids.length} TV${e.tv_ids.length === 1 ? '' : 's'} will change.${when}${e.end_time ? ` It ends at ${fmtClock(e.end_time)} unless you end it sooner.` : ''}`, 'Start now');
  if (!ok) return;
  await runApplyEvent(id);
}
function eventWorkingRows(e) {
  return (e.tv_ids || []).map((id) => { const t = TVS.find((tt) => Number(tt.id) === Number(id)); return { id, name: t ? (t.tag || t.name) : `TV ${id}`, status: 'working' }; });
}
async function runApplyEvent(id, choice) {
  const e = evById(id);
  renderBulkProgress(`${e.name} — starting`, eventWorkingRows(e));
  try {
    const r = await api(`/api/events/${id}/apply`, { method: 'POST', body: JSON.stringify(choice ? { choice } : {}) });
    if (r.conflict) { document.getElementById('bulkProgress').innerHTML = ''; openConflictModal(r.conflict); return; }
    if (r.deferred) document.getElementById('bulkProgress').innerHTML = '';
    if (r.deferred) { flashAttention(`"${e.name}" will start when ${r.behind.map((n) => `"${n}"`).join(', ')} ends.`); }
    else if (r.started) showEventResults(`${e.name} — started`, r.results);
  } catch (err) {
    flashAttention(err.message);
  }
  await refreshAll();
}
async function confirmEndEvent(id) {
  const e = evById(id); if (!e) return;
  const after = e.after_mode === 'leave' ? 'The TVs stay as they are.' : e.after_mode === 'scene' ? `The TVs go to the "${sceneName(e.after_layout_id)}" scene.` : 'The TVs go back to how they were.';
  const ok = await confirmModal(`End "${e.name}" now?`, after, 'End now', 'off');
  if (!ok) return;
  if (e.after_mode !== 'leave') renderBulkProgress(`${e.name} — ending`, eventWorkingRows(e));
  try {
    const r = await api(`/api/events/${id}/end`, { method: 'POST' });
    if (r.results && r.results.length) showEventResults(`${e.name} — ended`, r.results);
    else document.getElementById('bulkProgress').innerHTML = '';
  } catch (err) { document.getElementById('bulkProgress').innerHTML = ''; flashAttention(err.message); }
  await refreshAll();
}
function sceneName(id) { const sc = (EVENTS.scenes || []).find((x) => Number(x.id) === Number(id)); return sc ? sc.name : 'missing'; }
async function confirmApplyScene(id) {
  const sc = (EVENTS.scenes || []).find((x) => Number(x.id) === Number(id)); if (!sc) return;
  const ok = await confirmModal(`Set the room to "${sc.name}"?`, sc.kind === 'all_off' ? 'Every TV turns off.' : 'Every TV and source in this scene changes.', 'Apply scene');
  if (!ok) return;
  renderBulkProgress(`Scene ${sc.name}`, TVS.filter((t) => t.ip).map((t) => ({ id: t.id, name: t.tag || t.name, status: 'working' })));
  try {
    const r = await api(`/api/layouts/${id}/apply`, { method: 'POST' });
    showEventResults(`Scene ${sc.name}`, r.results);
  } catch (err) { flashAttention(err.message); }
  await refreshAll();
}
function showEventResults(title, results) {
  const rows = (results || []).map((r) => ({ id: r.target_id, name: r.name || r.label || `${r.target_type} #${r.target_id}`, status: r.ok ? 'done' : 'failed', error: r.error }));
  if (rows.length) renderBulkProgress(title, rows);
}

// ---- conflict popup (Switch / Stay / Split; no answer = Stay)
function openConflictModal(pc) {
  EV_CONFLICT_SHOWN = pc.event_id;
  const names = pc.conflicts.map((c) => `"${c.name}"`).join(' and ');
  const tvNames = pc.shared_tv_ids.map((id) => { const t = TVS.find((tt) => Number(tt.id) === Number(id)); return t ? (t.tag || t.name) : `TV ${id}`; });
  openEvModal(`${evHeader('Event conflict')}
    <p><b>${escapeHtml(pc.name)}</b> wants ${pc.shared_tv_ids.length} TV${pc.shared_tv_ids.length === 1 ? '' : 's'} that ${escapeHtml(names)} is using now.</p>
    <div class="ev-tvs">${escapeHtml(tvNames.join(', '))}</div>
    <div class="ev-choice">
      <button class="primary" onclick="resolveConflict('switch')">Switch to ${escapeHtml(pc.name)}<span class="sub">Ends ${escapeHtml(names)} on those TVs now.</span></button>
      <button onclick="resolveConflict('stay')">Stay on ${escapeHtml(pc.conflicts[0].name)}<span class="sub">${escapeHtml(pc.name)} starts when it's over, if there's time left.</span></button>
      ${pc.shared_tv_ids.length > 1 ? `<button onclick="resolveConflict('split')">Split the TVs<span class="sub">Every other TV down the list goes to ${escapeHtml(pc.name)}; the rest stay.</span></button>` : ''}
    </div>
    <div class="ev-countdown" id="evCountdown"></div>`);
  if (evCountdownTimer) clearInterval(evCountdownTimer);
  const tickDown = () => {
    const left = Math.max(0, Math.round((new Date(pc.expires_at).getTime() - Date.now()) / 1000));
    const el = document.getElementById('evCountdown');
    if (el) el.textContent = pc.source === 'schedule' ? `No answer in ${left}s = stay on the current event.` : 'Close this to leave things as they are.';
  };
  tickDown();
  evCountdownTimer = setInterval(tickDown, 1000);
}
async function resolveConflict(choice) {
  closeEvModal();
  EV_CONFLICT_SHOWN = null;
  try {
    const r = await api('/api/events/conflict/resolve', { method: 'POST', body: JSON.stringify({ choice }) });
    if (r.started) showEventResults(`${r.name} — started`, r.results);
    else if (r.deferred) flashAttention(`It will start when ${r.behind.map((n) => `"${n}"`).join(', ')} ends.`);
  } catch (err) { flashAttention(err.message); }
  await refreshAll();
}

// ---- capture / edit form (owner or manager)
function eventFormHtml(e, opts) {
  const kind = e.kind || 'manual';
  const days = (e.days || []).map(Number);
  const scenes = EVENTS.scenes || [];
  const picked = opts.pickedSource;
  let sourceLine = '';
  if (opts.capture) {
    const n = SELECTED_TV_IDS.size;
    const names = Array.from(SELECTED_TV_IDS).map((id) => { const t = TVS.find((tt) => Number(tt.id) === Number(id)); return t ? (t.tag || t.name) : null; }).filter(Boolean);
    sourceLine = `<div class="ev-tvs"><b>${n} TV${n === 1 ? '' : 's'}:</b> ${escapeHtml(names.join(', '))}</div>`;
    if (picked) {
      const live = picked.live || {};
      if (picked.kind === 'directv') {
        sourceLine += `<label>On source ${picked.slot} · ${escapeHtml(picked.label)} — channel</label><input id="evMajor" inputmode="numeric" value="${live.major != null ? live.major : ''}" placeholder="e.g. 206">`;
      } else {
        sourceLine += `<div class="ev-tvs">On source ${picked.slot} · ${escapeHtml(picked.label)}${picked.kind === 'roku' ? ' (the app it is on now)' : ''}</div>`;
      }
    } else {
      sourceLine += '<div class="ev-tvs">Each TV keeps the source and channel it is on right now. Pick a source in column 1 first if the event should change channel.</div>';
    }
  } else if (SELECTED_TV_IDS.size) {
    sourceLine = `<label style="display:flex; align-items:center; gap:8px; text-transform:none; letter-spacing:0;"><input type="checkbox" id="evRecapture" style="width:auto; min-height:0;"> Replace its TVs with the ${SELECTED_TV_IDS.size} highlighted now${picked ? ` on source ${picked.slot}` : ''}</label>`;
  }
  return `${evHeader(opts.capture ? 'Capture event' : `Edit "${e.name}"`)}
    ${opts.capture ? '<p>Nothing changes now — this saves the setup for later.</p>' : ''}
    ${sourceLine}
    <div id="evModalMsg"></div>
    <label>Name</label><input id="evName" value="${escapeHtml(e.name || '')}" placeholder="e.g. UFC 88" maxlength="60">
    <label>Note for staff (optional)</label><input id="evNote" value="${escapeHtml(e.note || '')}" placeholder="e.g. Sound on the wall TVs" maxlength="300">
    <label>When</label>
    <select id="evKind" onchange="evKindChanged()">
      <option value="manual" ${kind === 'manual' ? 'selected' : ''}>Manual — someone taps Apply</option>
      <option value="once" ${kind === 'once' ? 'selected' : ''}>One date</option>
      <option value="weekly" ${kind === 'weekly' ? 'selected' : ''}>Weekly</option>
    </select>
    <div id="evOnce" style="display:${kind === 'once' ? '' : 'none'};"><label>Date</label><input id="evDate" type="date" value="${escapeHtml(String(e.event_date || '').slice(0, 10))}"></div>
    <div id="evWeekly" style="display:${kind === 'weekly' ? '' : 'none'};"><label>Days</label><div class="ev-days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" class="${days.includes(d) ? 'active' : ''}" data-day="${d}" onclick="this.classList.toggle('active')">${EV_DAYS[d]}</button>`).join('')}</div></div>
    <div id="evTimes" class="ev-grid2" style="display:${kind === 'manual' ? 'none' : 'grid'};">
      <div><label>Starts</label><input id="evStart" type="time" value="${escapeHtml(e.start_time || '')}"></div>
      <div><label>Ends</label><input id="evEnd" type="time" value="${escapeHtml(e.end_time || '')}"></div>
    </div>
    <label>When it ends</label>
    <select id="evAfter" onchange="document.getElementById('evAfterScene').style.display = this.value === 'scene' ? '' : 'none'">
      <option value="restore" ${(e.after_mode || 'restore') === 'restore' ? 'selected' : ''}>Put the TVs back how they were</option>
      <option value="leave" ${e.after_mode === 'leave' ? 'selected' : ''}>Leave them as they are</option>
      <option value="scene" ${e.after_mode === 'scene' ? 'selected' : ''}>Go to a scene</option>
    </select>
    <div id="evAfterScene" style="display:${e.after_mode === 'scene' ? '' : 'none'};"><label>Scene</label><select id="evAfterLayout">${scenes.map((sc) => `<option value="${sc.id}" ${Number(sc.id) === Number(e.after_layout_id) ? 'selected' : ''}>${escapeHtml(sc.name)}</option>`).join('')}</select></div>
    <div class="ev-actions">
      ${opts.capture ? '' : `<button class="danger" onclick="deleteEvent(${e.id})" style="margin-right:auto;">Delete</button>`}
      <button onclick="closeEvModal()">Cancel</button>
      <button class="primary" onclick="saveEvent(${opts.capture ? 'null' : e.id})">${opts.capture ? 'Save event' : 'Save'}</button>
    </div>`;
}
function evKindChanged() {
  const k = document.getElementById('evKind').value;
  document.getElementById('evOnce').style.display = k === 'once' ? '' : 'none';
  document.getElementById('evWeekly').style.display = k === 'weekly' ? '' : 'none';
  document.getElementById('evTimes').style.display = k === 'manual' ? 'none' : 'grid';
}
function pickedSourceForForm() {
  if (PICKED_SLOT == null) return null;
  const s = sourceForSlot(PICKED_SLOT);
  return s ? { slot: s.slot, label: s.label, kind: s.kind, live: s.live } : null;
}
function openCaptureEvent() {
  if (!SELECTED_TV_IDS.size) { flashAttention('Highlight the TVs for the event first.'); return; }
  openEvModal(eventFormHtml({ kind: 'manual', after_mode: 'restore' }, { capture: true, pickedSource: pickedSourceForForm() }));
}
function openEditEvent(id) {
  const e = evById(id); if (!e) return;
  openEvModal(eventFormHtml(e, { capture: false, pickedSource: pickedSourceForForm() }));
}
function readEventForm() {
  const kind = document.getElementById('evKind').value;
  const body = {
    name: document.getElementById('evName').value.trim(),
    note: document.getElementById('evNote').value.trim(),
    kind,
    event_date: kind === 'once' ? document.getElementById('evDate').value : null,
    days: kind === 'weekly' ? Array.from(document.querySelectorAll('#evWeekly button.active')).map((b) => Number(b.dataset.day)) : [],
    start_time: kind === 'manual' ? null : document.getElementById('evStart').value,
    end_time: kind === 'manual' ? null : document.getElementById('evEnd').value,
    after_mode: document.getElementById('evAfter').value,
  };
  body.after_layout_id = body.after_mode === 'scene' ? (document.getElementById('evAfterLayout').value || null) : null;
  if (!body.name) throw new Error('Give the event a name.');
  if (kind === 'once' && (!body.event_date || !body.start_time || !body.end_time)) throw new Error('A one-time event needs a date, a start and an end.');
  if (kind === 'weekly' && (!body.days.length || !body.start_time || !body.end_time)) throw new Error('A weekly event needs days, a start and an end.');
  if (body.after_mode === 'scene' && !body.after_layout_id) throw new Error('Pick the scene to go to afterwards.');
  return body;
}
function captureFields() {
  const out = { tv_ids: Array.from(SELECTED_TV_IDS) };
  if (PICKED_SLOT != null) {
    out.slot = PICKED_SLOT;
    const majorEl = document.getElementById('evMajor');
    if (majorEl && majorEl.value.trim()) out.major = Number(majorEl.value.trim());
  }
  return out;
}
async function saveEvent(id) {
  let body;
  try { body = readEventForm(); } catch (err) { evMsg(err.message); return; }
  try {
    if (id == null) {
      const r = await api('/api/events', { method: 'POST', body: JSON.stringify({ ...body, ...captureFields() }) });
      closeEvModal();
      SELECTED_TV_IDS.clear();
      flashAttention(`Saved "${body.name}" (${r.item_count} item${r.item_count === 1 ? '' : 's'}). Nothing changed on the TVs.`);
    } else {
      const recap = document.getElementById('evRecapture');
      await api(`/api/events/${id}/update`, { method: 'POST', body: JSON.stringify({ ...body, ...(recap && recap.checked ? captureFields() : {}) }) });
      closeEvModal();
      flashAttention(`Saved "${body.name}".`);
    }
  } catch (err) { evMsg(err.message); return; }
  await refreshAll();
}
async function deleteEvent(id) {
  const e = evById(id); if (!e) return;
  const ok = await confirmModal(`Delete "${e.name}"?`, 'Gone for good.', 'Delete', 'danger');
  if (!ok) return;
  try { await api(`/api/events/${id}/delete`, { method: 'POST' }); } catch (err) { flashAttention(err.message); }
  await refreshAll();
}
function openCaptureScene() {
  openEvModal(`${evHeader('Capture scene')}
    <p>Saves what every source and TV is doing right now as a scene — how the bar normally looks. Nothing changes now.</p>
    <div id="evModalMsg"></div>
    <label>Name</label><input id="scName" placeholder="e.g. Open, Daily, Close" maxlength="60">
    <label>Runs daily at (optional)</label><input id="scTime" type="time">
    <div class="ev-actions"><button onclick="closeEvModal()">Cancel</button><button class="primary" onclick="saveScene()">Save scene</button></div>`);
}
async function saveScene() {
  const name = document.getElementById('scName').value.trim();
  const daily_time = document.getElementById('scTime').value || null;
  if (!name) { evMsg('Give the scene a name.'); return; }
  try {
    const r = await api('/api/scenes/capture', { method: 'POST', body: JSON.stringify({ name, daily_time }) });
    closeEvModal();
    flashAttention(`Saved scene "${name}" (${r.item_count} item${r.item_count === 1 ? '' : 's'}).`);
  } catch (err) { evMsg(err.message); return; }
  await refreshAll();
}
