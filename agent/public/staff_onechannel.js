// One channel, one receiver (Scotto, 2026-10-23). The box refuses to tune
// a receiver to a channel another receiver is already showing (server.js
// blockDuplicateChannel: a 409 with `duplicate`, `watching` and
// `canOverride`). This turns that answer into the choice staff get:
//   - put the TVs that wanted it on the receiver that already has it;
//   - pick a different channel;
//   - owners/managers only: tune anyway.
// Shared by the Sources, TVs and Map pages; uses each page's api() and
// escapeHtml().
//
//   const r = await oneChannelTune((extra) => api(url, { method: 'POST', body: JSON.stringify({ ...body, ...extra }) }), { tvIds });
//   r.moved: the TVs went to the other receiver instead; r.cancelled: nothing changed;
//   anything else is the tune's own answer.
function oneChannelSheet(e, tvIds) {
  const d = e.data.duplicate || {};
  const ids = tvIds && tvIds.length ? tvIds.map(Number) : (e.data.watching || []).map((t) => Number(t.id));
  const names = tvIds && tvIds.length
    ? tvIds.map((id) => { const t = typeof tvById === 'function' ? tvById(id) : null; return t ? (t.tag || t.name) : `TV ${id}`; })
    : (e.data.watching || []).map((t) => t.name);
  const ch = `${d.major}${d.minor != null && d.minor !== '' ? `-${d.minor}` : ''}`;
  const canMove = d.slot != null && ids.length > 0;
  const tvText = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  return new Promise((resolve) => {
    let back = document.getElementById('oneChBack');
    if (back) back.remove();
    back = document.createElement('div');
    back.id = 'oneChBack';
    back.className = 'gm-sheet-back';
    back.style.display = 'flex';
    back.style.zIndex = '75';
    back.innerHTML = `<div class="gm-sheet gm-confirm">
        <div class="gs-label">Already on another receiver</div>
        <p class="gm-confirm-text">${d.multi ? `Channel <b>${escapeHtml(ch)}</b> goes on one receiver; TVs can share it.` : `Channel <b>${escapeHtml(ch)}</b> is already on <b>${escapeHtml(d.label || 'another receiver')}</b>.`}</p>
        <p class="gm-confirm-hint">${canMove ? `Put ${escapeHtml(tvText)} on ${escapeHtml(d.label)} instead, so this receiver stays free for another game.` : d.multi ? 'Pick one receiver for it.' : `Any TV that wants it can go on ${escapeHtml(d.label || 'that receiver')}.`}</p>
        <div class="mu-sheet-btns" style="flex-wrap:wrap;">
          ${canMove ? `<button type="button" class="mu-sheet-go" data-a="move" style="flex-basis:100%;">Put ${escapeHtml(tvText)} on ${escapeHtml(d.label)}</button>` : ''}
          <button type="button" class="mu-sheet-cancel" data-a="other">Pick a different channel</button>
          ${e.data.canOverride ? '<button type="button" class="mu-sheet-cancel" data-a="anyway">Tune anyway</button>' : ''}
        </div>
      </div>`;
    const done = (v) => { back.remove(); resolve({ choice: v, slot: d.slot, label: d.label, ids }); };
    back.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-a]');
      if (b) done(b.dataset.a);
      else if (ev.target === back) done('other');
    });
    document.body.appendChild(back);
  });
}

async function oneChannelTune(send, { tvIds } = {}) {
  try {
    return await send({});
  } catch (e) {
    if (!(e.status === 409 && e.data && e.data.duplicate)) throw e;
    const pick = await oneChannelSheet(e, tvIds);
    if (pick.choice === 'anyway') return send({ dupOk: true });
    if (pick.choice === 'move') {
      const r = await api('/api/tvs/bulk/slot', { method: 'POST', body: JSON.stringify({ slot: pick.slot, tv_ids: pick.ids }) });
      const failed = (r.results || []).filter((x) => !x.ok);
      return { moved: true, slot: pick.slot, label: pick.label, failed };
    }
    return { cancelled: true };
  }
}
