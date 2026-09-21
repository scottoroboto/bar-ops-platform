// Inventory Control ("Stocktake") — Phase 1: liquor counting. Structured
// like public/cashhandling.js (tier-branched shell, blind count-entry
// discipline, shared reusable input components).
//
// Access here is a tier (full_authority/lead/counter/no_access) from
// /api/inventory/access, NOT the ordinary appAccess enabled flag — see
// server/inventorycontrol.js. Counter tier gets no tabs at all, per spec:
// straight to a Counts list scoped to in_progress sessions at their own
// location, then Areas -> Counting -> Review -> blind Submit. Lead and
// Full authority (and the owner) get the full tabbed shell (Counts /
// Catalog / Areas), can start new counts, manage the catalog and areas,
// and see the real Variance report instead of a blind Review when opening
// an already-submitted count.
//
// unit_cost is the one field a Counter must never see. The server already
// strips it (stripCostForTier in server/index.js) for every route a
// Counter can reach, so the client simply has no cost field to read on
// those responses — no client-side hiding logic needed here.
let ME = null;
let TIER = 'no_access';
let LOCATIONS = [];
let SELECTED_LOCATION_ID = null;
let AREAS_CACHE = []; // active areas at the selected location
let CATALOG_CACHE = {}; // item_id -> last-loaded catalog row, for the Edit form

// Which container the counts flow (Counts list -> Areas -> Counting ->
// Review/Variance) renders into — 'panelMain' for the Counter's single
// unTabbed flow, 'panelCounts' for the manager shell's Counts tab.
let COUNT_HOST = 'panelMain';

let CURRENT_COUNT = null;
let CURRENT_AREA = null; // { id, name }
let CURRENT_AREA_NAMES = {}; // areaId -> areaName, from the last-loaded progress screen
let ITEM_DETAIL_CACHE = {}; // item_id -> full item row (weights, case_size; cost present only for lead+)
let CURRENT_ITEM_ID = null;
let PARTIALS = []; // open-bottle entries for the item currently being counted
let PARTIAL_SEQ = 0;

const TIER_RANK = { no_access: 0, counter: 1, lead: 2, full_authority: 3 };
function tierAtLeast(tier, min) { return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[min] ?? 0); }

// Preview-only mirror of the server's DEFAULT_SPOUT_OFFSET_GRAMS — used
// purely to render a live fill-fraction estimate as someone types a
// weight. The server always recomputes and stores the authoritative
// value (using the owner's actual configured offset), so this being an
// approximation is fine; nothing here is ever trusted for the real number.
const CLIENT_SPOUT_OFFSET_G = 9;

const BOTTLE_ICON = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6v4l2 3v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9l2-3V2Z"/><path d="M9 2h6"/><path d="M8 12h8"/></svg>';
const AREA_ICON = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-6 9 6-9 6-9-6Z"/><path d="M3 9v6l9 6 9-6V9"/></svg>';

function showMsg(text, kind) {
  document.getElementById('msgBox').innerHTML = text ? `<div class="msg ${kind || 'info'}">${escapeHtml(text)}</div>` : '';
}

function errorCard(e) { return `<div class="card"><p class="msg error">${escapeHtml(e.message)}</p></div>`; }

function locationName(id) { const l = LOCATIONS.find((x) => x.id === id); return l ? l.name : '—'; }

function fmtMoney2(n) {
  const v = Number(n || 0);
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ---------------------------------------------------------------------
// Manager shell (lead / full_authority / owner)
// ---------------------------------------------------------------------
function renderManagerShell() {
  const isOwner = ME.role === 'owner';
  // The owner picks any bar; someone who works at more than one picks
  // among theirs (patch_033); everyone else just sees their one.
  const pickable = isOwner ? LOCATIONS : LOCATIONS.filter(l => myLocationIds(ME).includes(String(l.id)));
  const canPick = isOwner || pickable.length > 1;
  document.getElementById('panelMain').innerHTML = `
    <h1 class="page-title">Inventory</h1>
    <div class="inv-loc-row">
      ${canPick
        ? `<select id="locSelect" onchange="onLocationChange()"></select>`
        : `<span class="badge on">${escapeHtml(locationName(SELECTED_LOCATION_ID))}</span>`}
      ${isOwner ? `<a href="/inventory-access.html" class="muted">Manage access ›</a>` : ''}
    </div>
    <div class="tabs" id="tabs">
      <button data-tab="counts" onclick="setInvTab('counts')">Counts</button>
      <button data-tab="catalog" onclick="setInvTab('catalog')">Catalog</button>
      <button data-tab="areas" onclick="setInvTab('areas')">Areas</button>
    </div>
    <div id="panelCounts"></div>
    <div id="panelCatalog" style="display:none;"></div>
    <div id="panelAreas" style="display:none;"></div>
  `;
  if (canPick) {
    document.getElementById('locSelect').innerHTML =
      pickable.map((l) => `<option value="${l.id}" ${l.id === SELECTED_LOCATION_ID ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
  }
  setInvTab('counts');
}

function setInvTab(which) {
  document.getElementById('panelCounts').style.display = which === 'counts' ? '' : 'none';
  document.getElementById('panelCatalog').style.display = which === 'catalog' ? '' : 'none';
  document.getElementById('panelAreas').style.display = which === 'areas' ? '' : 'none';
  Array.from(document.querySelectorAll('#tabs button')).forEach((b) => b.classList.toggle('active', b.dataset.tab === which));
  if (which === 'counts') { COUNT_HOST = 'panelCounts'; loadCountsList('panelCounts', {}); }
  if (which === 'catalog') loadCatalog();
  if (which === 'areas') loadAreasAdmin();
}

function onLocationChange() {
  SELECTED_LOCATION_ID = document.getElementById('locSelect').value;
  AREAS_CACHE = [];
  setInvTab('counts');
}

// ---------------------------------------------------------------------
// Counter flow — no tabs, straight to the counts list.
// ---------------------------------------------------------------------
function renderCounterFlow() {
  COUNT_HOST = 'panelMain';
  loadCountsList('panelMain', { title: true });
}

// ---------------------------------------------------------------------
// Counts list — shared by both tiers.
// ---------------------------------------------------------------------
async function loadCountsList(hostId, opts) {
  const el = document.getElementById(hostId);
  const title = opts && opts.title ? '<h1 class="page-title">Inventory</h1>' : '';
  el.innerHTML = title + '<p class="muted">Loading…</p>';
  try {
    const result = await api('/api/inventory/counts' + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    el.innerHTML = title + countsListHtml(result.counts || []);
  } catch (e) {
    el.innerHTML = title + errorCard(e);
  }
}

function countsListHtml(counts) {
  const isManager = tierAtLeast(TIER, 'lead');
  let html = '';
  if (isManager) {
    html += `<div style="display:flex; justify-content:flex-end; margin-bottom:12px;"><button class="primary" style="width:auto; margin:0;" onclick="openNewCountForm()">+ New count</button></div>`;
  }
  if (!counts.length) {
    html += `<div class="card"><p class="muted">No counts ${isManager ? 'yet' : 'in progress'}.</p></div>`;
    return html;
  }
  html += `<div class="card" style="padding:0;">${counts.map((c) => `
    <div class="picker-row" onclick="openCount('${c.id}')">
      <div>
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="sub">${escapeHtml(c.location_name)} · ${c.mode === 'full' ? 'Full count' : 'Spot check'} · started ${fmtDateTime(c.started_at)} by ${escapeHtml(c.started_by_name)}</div>
      </div>
      <span class="badge ${c.status === 'submitted' ? 'on' : 'stale'}">${c.status === 'submitted' ? 'Submitted' : 'In progress'}</span>
    </div>`).join('')}</div>`;
  return html;
}

function backToCountsList() { loadCountsList(COUNT_HOST, { title: COUNT_HOST === 'panelMain' }); }

async function openCount(id) {
  showMsg('');
  try {
    const result = await api(`/api/inventory/counts/${id}`);
    CURRENT_COUNT = result.count;
    if (CURRENT_COUNT.status === 'submitted') openVarianceReport(CURRENT_COUNT);
    else openAreasProgress(CURRENT_COUNT);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// New count (Lead+) — name, Full/Spot mode, area checkboxes.
// ---------------------------------------------------------------------
async function ensureAreasLoaded() {
  if (AREAS_CACHE.length) return;
  try {
    const result = await api('/api/inventory/areas' + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    AREAS_CACHE = result.areas || [];
  } catch (e) { /* the form will just show no areas; its own submit will surface a real error */ }
}

async function openNewCountForm() {
  await ensureAreasLoaded();
  const el = document.getElementById('panelCounts');
  el.innerHTML = `
    <div class="card">
      <h2>New count</h2>
      <label>Name</label>
      <input id="newCountName" placeholder="e.g. September full count">
      <label>Mode</label>
      <select id="newCountMode">
        <option value="full">Full count — every item in the selected areas</option>
        <option value="spot">Spot check — just what gets scanned</option>
      </select>
      <label>Areas</label>
      <div class="sc-checkbox-grid">
        ${AREAS_CACHE.length ? AREAS_CACHE.map((a) => `<label class="sc-checkbox"><input type="checkbox" value="${a.id}" class="newCountArea"> ${escapeHtml(a.name)}</label>`).join('')
          : '<p class="muted">No areas yet — add one under the Areas tab first.</p>'}
      </div>
      <div style="display:flex; gap:10px; margin-top:16px;">
        <button class="secondary" onclick="setInvTab('counts')">Cancel</button>
        <button class="primary" onclick="submitNewCount()">Start count</button>
      </div>
    </div>`;
}

async function submitNewCount() {
  const name = document.getElementById('newCountName').value.trim();
  if (!name) { showMsg('Enter a name.', 'error'); return; }
  const mode = document.getElementById('newCountMode').value;
  const areaIds = Array.from(document.querySelectorAll('.newCountArea:checked')).map((el) => el.value);
  if (!areaIds.length) { showMsg('Pick at least one area.', 'error'); return; }
  try {
    const result = await api('/api/inventory/counts', { method: 'POST', body: { locationId: SELECTED_LOCATION_ID, name, mode, areaIds } });
    showMsg('Count started.', 'success');
    COUNT_HOST = 'panelCounts';
    openAreasProgress(result.count);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Areas progress
// ---------------------------------------------------------------------
async function openAreasProgress(count) {
  CURRENT_COUNT = count;
  const el = document.getElementById(COUNT_HOST);
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const result = await api(`/api/inventory/counts/${count.id}/progress`);
    CURRENT_AREA_NAMES = {};
    (result.progress.areas || []).forEach((a) => { CURRENT_AREA_NAMES[a.areaId] = a.areaName; });
    el.innerHTML = areasProgressHtml(result.progress);
  } catch (e) {
    el.innerHTML = errorCard(e);
  }
}

function backToAreasProgress() { openAreasProgress(CURRENT_COUNT); }

function areasProgressHtml(progress) {
  const c = progress.count;
  return `
    <a href="#" onclick="backToCountsList(); return false;" class="muted">‹ Back to counts</a>
    <h1 class="page-title" style="margin-top:10px;">${escapeHtml(c.name)}</h1>
    <p class="muted" style="margin-top:-10px;">${c.mode === 'full' ? 'Full count' : 'Spot check'} · ${escapeHtml(locationName(c.location_id))}</p>
    <div class="card" style="padding:0;">
      ${progress.areas.map((a) => {
        const done = a.targetCount != null ? (a.counted + a.skipped) : null;
        const complete = a.targetCount != null && a.targetCount > 0 && done >= a.targetCount;
        return `
        <div class="picker-row" onclick="openArea('${a.areaId}')">
          <div>
            <div class="name">${escapeHtml(a.areaName)}</div>
            <div class="sub">${a.counted} counted${a.skipped ? ', ' + a.skipped + ' skipped' : ''}</div>
          </div>
          <span class="badge ${complete ? 'on' : 'stale'}">${a.targetCount != null ? done + '/' + a.targetCount : a.counted + ' scanned'}</span>
        </div>`;
      }).join('')}
    </div>
    ${c.status === 'in_progress' ? `<div class="card" style="text-align:center;"><button class="primary" onclick="openReview()">Review &amp; submit</button></div>` : ''}
  `;
}

// ---------------------------------------------------------------------
// One area's counting queue — scan/search + the target/scanned list.
// ---------------------------------------------------------------------
async function openArea(areaId) {
  const el = document.getElementById(COUNT_HOST);
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const [catalogResult, queueResult] = await Promise.all([
      api(`/api/inventory/areas/${areaId}/items`),
      api(`/api/inventory/counts/${CURRENT_COUNT.id}/areas/${areaId}/items`),
    ]);
    (catalogResult.items || []).forEach((i) => { ITEM_DETAIL_CACHE[i.id] = i; });
    CURRENT_AREA = { id: areaId, name: CURRENT_AREA_NAMES[areaId] || '' };
    el.innerHTML = areaQueueHtml(queueResult.items || []);
  } catch (e) {
    el.innerHTML = errorCard(e);
  }
}

function backToArea() { openArea(CURRENT_AREA.id); }

function areaQueueHtml(rows) {
  const isFull = CURRENT_COUNT.mode === 'full';
  return `
    <a href="#" onclick="backToAreasProgress(); return false;" class="muted">‹ Back to areas</a>
    <h1 class="page-title" style="margin-top:10px;">${escapeHtml(CURRENT_AREA.name)}</h1>
    <div class="card">
      <h2>Scan or search</h2>
      <div style="display:flex; gap:8px;">
        <input id="scanInput" placeholder="Scan a barcode or type a UPC" inputmode="numeric" onkeydown="if(event.key==='Enter'){lookupUpc();}">
        <button class="secondary" style="width:auto; margin:0;" onclick="lookupUpc()">Look up</button>
      </div>
      <div style="margin-top:10px;">
        <input id="searchInput" placeholder="Or search by name" oninput="debounceSearch()">
      </div>
      <div id="searchResults"></div>
    </div>
    <div class="card" style="padding:0;">
      ${rows.length ? rows.map((r) => itemQueueRowHtml(r)).join('')
        : `<p class="muted" style="padding:16px;">${isFull ? 'Nothing assigned to this area yet.' : 'Nothing scanned yet.'}</p>`}
    </div>
  `;
}

function itemQueueRowHtml(r) {
  const meta = { pending: { cls: 'stale', label: 'Pending' }, counted: { cls: 'on', label: 'Counted' }, skipped: { cls: 'danger', label: 'Skipped' } }[r.status] || { cls: 'stale', label: r.status };
  return `<div class="picker-row" onclick="openItemEntry('${r.item_id}')">
    <div>
      <div class="name">${escapeHtml(r.name)}</div>
      <div class="sub">${escapeHtml(r.category || '')}${r.size_ml ? ' · ' + r.size_ml + 'ml' : ''}${r.upc ? ' · ' + escapeHtml(r.upc) : ''}</div>
    </div>
    <span class="badge ${meta.cls}">${meta.label}</span>
  </div>`;
}

async function lookupUpc() {
  const upcEl = document.getElementById('scanInput');
  const upc = upcEl.value.trim();
  if (!upc) return;
  try {
    const result = await api('/api/inventory/items/lookup?upc=' + encodeURIComponent(upc));
    if (result.item) {
      ITEM_DETAIL_CACHE[result.item.id] = result.item;
      openItemEntry(result.item.id);
    } else {
      openUnknownBarcodeForm(upc);
    }
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

let SEARCH_DEBOUNCE = null;
function debounceSearch() {
  clearTimeout(SEARCH_DEBOUNCE);
  SEARCH_DEBOUNCE = setTimeout(runSearch, 300);
}

async function runSearch() {
  const q = document.getElementById('searchInput').value.trim();
  const el = document.getElementById('searchResults');
  if (!q) { el.innerHTML = ''; return; }
  try {
    const result = await api('/api/inventory/items/search?q=' + encodeURIComponent(q));
    const items = result.items || [];
    items.forEach((i) => { ITEM_DETAIL_CACHE[i.id] = i; });
    el.innerHTML = items.length
      ? `<div style="margin-top:10px; border-top:1px solid var(--card-border);">${items.map((i) => `
          <div class="picker-row" onclick="openItemEntry('${i.id}')">
            <div><div class="name">${escapeHtml(i.name)}</div><div class="sub">${escapeHtml(i.category || '')}${i.upc ? ' · ' + escapeHtml(i.upc) : ''}</div></div>
          </div>`).join('')}</div>`
      : '<p class="muted" style="margin-top:8px;">No matches.</p>';
  } catch (e) {
    el.innerHTML = `<p class="msg error">${escapeHtml(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------------
// Unknown-barcode quick add — a Counter can create the item, but only
// Lead+ can price it (the server silently drops unitCost otherwise).
// ---------------------------------------------------------------------
function openUnknownBarcodeForm(upc) {
  const el = document.getElementById(COUNT_HOST);
  const canSetCost = tierAtLeast(TIER, 'lead');
  el.innerHTML = `
    <a href="#" onclick="backToArea(); return false;" class="muted">‹ Back</a>
    <div class="card" style="margin-top:10px;">
      <h2>New item</h2>
      <p class="muted">No item found for UPC ${escapeHtml(upc)} — add it to the catalog.</p>
      <label>Name</label><input id="newItemName" placeholder="e.g. Tito's Handmade Vodka 1L">
      <label>Category (optional)</label><input id="newItemCategory" placeholder="e.g. Vodka">
      <label>Size (ml, optional)</label><input id="newItemSize" type="number" inputmode="numeric">
      <label>Case size (bottles per case)</label><input id="newItemCaseSize" type="number" inputmode="numeric" value="12">
      <label>Full weight, grams (optional — enables weighing open bottles)</label><input id="newItemFullWeight" type="number" step="0.1" inputmode="decimal">
      <label>Empty weight, grams (optional)</label><input id="newItemEmptyWeight" type="number" step="0.1" inputmode="decimal">
      ${canSetCost ? `<label>Unit cost (optional)</label><div class="big-amt-wrap" style="margin:6px 0 14px;"><span class="prefix" style="font-size:18px;">$</span><input type="number" inputmode="decimal" step="0.01" id="newItemCost" style="font-size:16px; padding:11px 14px 11px 32px;"></div>` : ''}
      <button class="primary" onclick="submitUnknownItem('${upc}')">Add item</button>
    </div>`;
}

async function submitUnknownItem(upc) {
  const name = document.getElementById('newItemName').value.trim();
  if (!name) { showMsg('Enter a name.', 'error'); return; }
  const body = {
    name,
    upc,
    category: document.getElementById('newItemCategory').value.trim() || undefined,
    sizeMl: Number(document.getElementById('newItemSize').value) || undefined,
    caseSize: Number(document.getElementById('newItemCaseSize').value) || 1,
    fullWeightG: Number(document.getElementById('newItemFullWeight').value) || undefined,
    emptyWeightG: Number(document.getElementById('newItemEmptyWeight').value) || undefined,
    areaId: CURRENT_AREA.id,
  };
  const costEl = document.getElementById('newItemCost');
  if (costEl && costEl.value) body.unitCost = Number(costEl.value);
  try {
    const result = await api('/api/inventory/items', { method: 'POST', body });
    ITEM_DETAIL_CACHE[result.item.id] = result.item;
    showMsg('Item added.', 'success');
    openItemEntry(result.item.id);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Item counting entry — the one blind write, "Save & scan next." Never
// shown a previous quantity, variance, or cost; nothing above this
// function passes one in, and the reveal only happens after the whole
// count is submitted (submitCount() below).
// ---------------------------------------------------------------------
function openItemEntry(itemId) {
  const item = ITEM_DETAIL_CACHE[itemId];
  if (!item) { showMsg('Item details not loaded — try scanning or searching again.', 'error'); return; }
  CURRENT_ITEM_ID = itemId;
  PARTIALS = [];
  PARTIAL_SEQ = 0;
  const canWeigh = Number(item.full_weight_g) > 0 && Number(item.empty_weight_g) >= 0 && Number(item.full_weight_g) > Number(item.empty_weight_g);
  const el = document.getElementById(COUNT_HOST);
  el.innerHTML = `
    <a href="#" onclick="backToArea(); return false;" class="muted">‹ Back</a>
    <div class="detail-head" style="margin-top:10px;">
      <div class="detail-icon">${BOTTLE_ICON}</div>
      <div><div class="detail-title">${escapeHtml(item.name)}</div><div class="detail-loc">${escapeHtml(item.category || '')}${item.size_ml ? ' · ' + item.size_ml + 'ml' : ''}</div></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <p class="blind-note">Count it now, then enter what's here — sealed cases/units below, and each open bottle weighed separately. This is blind, same as Cash Handling: nothing is checked against the ledger until the whole count is submitted.</p>
      <h2>Sealed</h2>
      ${sealedStepperHtml('sealedStepper', item.case_size || 1)}
      <h2 style="margin-top:20px;">Open bottles</h2>
      <div id="partialsList"></div>
      <button class="secondary" onclick="addPartialBlock(${canWeigh ? 'true' : 'false'})">+ Add an open bottle</button>
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--card-border);">
        <label class="toggle-row" style="justify-content:flex-start; gap:10px;">
          <span class="switch"><input type="checkbox" id="skipToggle" onchange="onSkipToggle()"><span class="slider"></span></span>
          <span class="label">Skip this item</span>
        </label>
        <div id="skipReasonGroup" style="display:none;">
          <label>Reason</label>
          <input id="skipReason" placeholder="e.g. Not found on shelf">
        </div>
      </div>
      <button class="primary" onclick="submitItemEntry('${itemId}')">Save &amp; scan next</button>
    </div>`;
  document.getElementById('partialsList').innerHTML = '';
}

function onSkipToggle() {
  const on = document.getElementById('skipToggle').checked;
  document.getElementById('skipReasonGroup').style.display = on ? '' : 'none';
}

// ---- Sealed case/unit stepper ----
function sealedStepperHtml(idPrefix, caseSize) {
  return `
    <div class="stepper-grid">
      <div class="stepper-unit">
        <div class="stepper-label">Cases <span class="muted">(× ${caseSize})</span></div>
        <div class="stepper-row">
          <button type="button" class="stepper-btn" onclick="adjustStepper('${idPrefix}-cases', -1, '${idPrefix}', ${caseSize})">−</button>
          <input class="stepper-value" id="${idPrefix}-cases" type="number" inputmode="numeric" min="0" step="1" value="0" oninput="updateSealedTotal('${idPrefix}', ${caseSize})">
          <button type="button" class="stepper-btn" onclick="adjustStepper('${idPrefix}-cases', 1, '${idPrefix}', ${caseSize})">+</button>
        </div>
      </div>
      <div class="stepper-unit">
        <div class="stepper-label">Loose units</div>
        <div class="stepper-row">
          <button type="button" class="stepper-btn" onclick="adjustStepper('${idPrefix}-units', -1, '${idPrefix}', ${caseSize})">−</button>
          <input class="stepper-value" id="${idPrefix}-units" type="number" inputmode="numeric" min="0" step="1" value="0" oninput="updateSealedTotal('${idPrefix}', ${caseSize})">
          <button type="button" class="stepper-btn" onclick="adjustStepper('${idPrefix}-units', 1, '${idPrefix}', ${caseSize})">+</button>
        </div>
      </div>
    </div>
    <div class="stepper-total"><span>Total sealed units</span><b id="${idPrefix}-total">0</b></div>
    <input type="hidden" id="${idPrefix}-hidden" value="0">`;
}

function adjustStepper(inputId, delta, idPrefix, caseSize) {
  const el = document.getElementById(inputId);
  el.value = Math.max(0, (Math.floor(Number(el.value)) || 0) + delta);
  updateSealedTotal(idPrefix, caseSize);
}

function updateSealedTotal(idPrefix, caseSize) {
  const cases = Math.max(0, Math.floor(Number(document.getElementById(`${idPrefix}-cases`).value) || 0));
  const units = Math.max(0, Math.floor(Number(document.getElementById(`${idPrefix}-units`).value) || 0));
  const total = cases * caseSize + units;
  document.getElementById(`${idPrefix}-total`).textContent = total;
  document.getElementById(`${idPrefix}-hidden`).value = total;
}

// ---- Open-bottle partial entries ----
function addPartialBlock(canWeigh) {
  PARTIALS.push({ id: 'p' + (PARTIAL_SEQ++), entryMethod: canWeigh ? 'manual_weight' : 'manual_tenths', weightGrams: '', spoutOn: false, fraction: 0.5 });
  renderPartialsList();
}

function removePartialBlock(id) {
  PARTIALS = PARTIALS.filter((p) => p.id !== id);
  renderPartialsList();
}

function renderPartialsList() {
  document.getElementById('partialsList').innerHTML = PARTIALS.map((p) => partialEntryHtml(p)).join('');
}

function partialEntryHtml(p) {
  const isWeight = p.entryMethod === 'manual_weight';
  if (isWeight) {
    return `
      <div class="partial-block" id="block-${p.id}">
        <div class="partial-head"><span class="partial-title">Bottle</span><button type="button" class="partial-remove" onclick="removePartialBlock('${p.id}')">Remove</button></div>
        <label>Weight (grams)</label>
        <input type="number" inputmode="decimal" step="0.1" id="weight-${p.id}" value="${p.weightGrams}" oninput="onPartialWeightInput('${p.id}')">
        <label class="toggle-row" style="justify-content:flex-start; gap:10px; margin-top:10px;">
          <span class="switch"><input type="checkbox" id="spout-${p.id}" ${p.spoutOn ? 'checked' : ''} onchange="onPartialSpoutToggle('${p.id}')"><span class="slider"></span></span>
          <span class="label">Spout still on</span>
        </label>
        <div class="fill-preview">
          <div class="fill-gauge"><div class="fill-gauge-fill" id="gauge-${p.id}" style="height:0%"></div></div>
          <div class="fill-preview-label" id="fillLabel-${p.id}">—</div>
        </div>
        <a href="#" class="muted" style="font-size:12px;" onclick="switchPartialToTenths('${p.id}'); return false;">Enter by eye instead</a>
      </div>`;
  }
  return `
    <div class="partial-block" id="block-${p.id}">
      <div class="partial-head"><span class="partial-title">Bottle</span><button type="button" class="partial-remove" onclick="removePartialBlock('${p.id}')">Remove</button></div>
      <label>Estimate how full (by eye)</label>
      <input type="range" min="0" max="1" step="0.05" id="tenths-${p.id}" value="${p.fraction}" oninput="onPartialTenthsInput('${p.id}')">
      <div class="fill-preview-label" id="fillLabel-${p.id}" style="text-align:center;">${Math.round(p.fraction * 100)}% full</div>
    </div>`;
}

function onPartialWeightInput(id) {
  const p = PARTIALS.find((x) => x.id === id);
  if (!p) return;
  p.weightGrams = document.getElementById(`weight-${id}`).value;
  updateFillPreview(id);
}

function onPartialSpoutToggle(id) {
  const p = PARTIALS.find((x) => x.id === id);
  if (!p) return;
  p.spoutOn = document.getElementById(`spout-${id}`).checked;
  updateFillPreview(id);
}

function updateFillPreview(id) {
  const p = PARTIALS.find((x) => x.id === id);
  const item = ITEM_DETAIL_CACHE[CURRENT_ITEM_ID];
  if (!p || !item) return;
  const full = Number(item.full_weight_g) || 0;
  const empty = Number(item.empty_weight_g) || 0;
  const range = full - empty;
  const w = Number(p.weightGrams) || 0;
  const offset = p.spoutOn ? CLIENT_SPOUT_OFFSET_G : 0;
  const frac = range > 0 ? Math.max(0, Math.min(1, (w - offset - empty) / range)) : 0;
  const gaugeEl = document.getElementById(`gauge-${id}`);
  if (gaugeEl) gaugeEl.style.height = Math.round(frac * 100) + '%';
  const labelEl = document.getElementById(`fillLabel-${id}`);
  if (labelEl) labelEl.textContent = w ? Math.round(frac * 100) + '% full (estimate)' : '—';
}

function onPartialTenthsInput(id) {
  const p = PARTIALS.find((x) => x.id === id);
  if (!p) return;
  p.fraction = Number(document.getElementById(`tenths-${id}`).value);
  const labelEl = document.getElementById(`fillLabel-${id}`);
  if (labelEl) labelEl.textContent = Math.round(p.fraction * 100) + '% full';
}

function switchPartialToTenths(id) {
  const p = PARTIALS.find((x) => x.id === id);
  if (!p) return;
  p.entryMethod = 'manual_tenths';
  p.fraction = 0.5;
  renderPartialsList();
}

async function submitItemEntry(itemId) {
  const skipped = document.getElementById('skipToggle').checked;
  const skipReason = skipped ? document.getElementById('skipReason').value.trim() : undefined;
  if (skipped && !skipReason) { showMsg('Enter a reason for skipping.', 'error'); return; }

  let sealedUnits = 0;
  const partials = [];
  if (!skipped) {
    sealedUnits = Number(document.getElementById('sealedStepper-hidden').value) || 0;
    for (const p of PARTIALS) {
      if (p.entryMethod === 'manual_weight') {
        const w = Number(document.getElementById(`weight-${p.id}`).value);
        if (!w) continue; // an untouched weight field contributes nothing rather than erroring
        partials.push({ entryMethod: 'manual_weight', weightGrams: w, spoutOn: p.spoutOn });
      } else {
        partials.push({ entryMethod: 'manual_tenths', fraction: p.fraction });
      }
    }
  }

  try {
    await api(`/api/inventory/counts/${CURRENT_COUNT.id}/items`, {
      method: 'POST',
      body: { areaId: CURRENT_AREA.id, itemId, sealedUnits, partials, skipped, skipReason },
    });
    showMsg('Saved.', 'success');
    backToArea();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Review (blind) + Submit
// ---------------------------------------------------------------------
async function openReview() {
  const el = document.getElementById(COUNT_HOST);
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const result = await api(`/api/inventory/counts/${CURRENT_COUNT.id}/review`);
    el.innerHTML = reviewHtml(result.review);
  } catch (e) {
    el.innerHTML = errorCard(e);
  }
}

function reviewHtml(review) {
  return `
    <a href="#" onclick="backToAreasProgress(); return false;" class="muted">‹ Back to areas</a>
    <h1 class="page-title" style="margin-top:10px;">Review</h1>
    <p class="blind-note">Blind, same as Cash Handling — a plain tally, never quantities or dollars. Those only appear on the Variance report, for Lead and up.</p>
    <div class="reveal-tiles" style="grid-template-columns:1fr;">
      <div class="card"><div class="l">Items counted</div><div class="n">${review.countedCount}${review.totalTargeted != null ? ' of ' + review.totalTargeted : ''}</div></div>
    </div>
    ${review.skippedItems.length ? `
      <div class="card">
        <h2>Skipped</h2>
        ${review.skippedItems.map((s) => `<div class="list-row"><div><div class="name">${escapeHtml(s.item_name)}</div><div class="sub">${escapeHtml(s.area_name)}${s.skip_reason ? ' · ' + escapeHtml(s.skip_reason) : ''}</div></div></div>`).join('')}
      </div>` : ''}
    <div class="card" style="text-align:center;">
      <button class="primary" onclick="submitCount()">Submit count</button>
    </div>`;
}

async function submitCount() {
  try {
    const result = await api(`/api/inventory/counts/${CURRENT_COUNT.id}/submit`, { method: 'POST' });
    document.getElementById(COUNT_HOST).innerHTML = submittedConfirmationHtml(result.confirmation);
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function submittedConfirmationHtml(c) {
  return `
    <h1 class="page-title">Submitted</h1>
    <div class="card">
      <p>Count logged.</p>
      <div class="reveal-tiles">
        <div class="card"><div class="l">Items counted</div><div class="n">${c.itemsCounted}</div></div>
        <div class="card"><div class="l">Skipped</div><div class="n">${c.itemsSkipped}</div></div>
      </div>
    </div>
    <div class="card" style="text-align:center;">
      <button class="primary" onclick="backToCountsList()">Done</button>
    </div>`;
}

// ---------------------------------------------------------------------
// Variance report (Lead+) — the real numbers. Opened instead of Review
// whenever a manager taps an already-submitted count.
// ---------------------------------------------------------------------
async function openVarianceReport(count) {
  CURRENT_COUNT = count;
  const el = document.getElementById(COUNT_HOST);
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const result = await api(`/api/inventory/counts/${count.id}/variance`);
    el.innerHTML = varianceHtml(result.variance);
  } catch (e) {
    el.innerHTML = errorCard(e);
  }
}

function varianceHtml(v) {
  const items = v.items || [];
  return `
    <a href="#" onclick="backToCountsList(); return false;" class="muted">‹ Back to counts</a>
    <h1 class="page-title" style="margin-top:10px;">${escapeHtml(v.count.name)}</h1>
    <p class="muted" style="margin-top:-10px;">Submitted ${fmtDateTime(v.count.submitted_at)}</p>
    <div class="card" style="padding:0;">
      ${items.length ? items.map((i) => {
        const vq = Number(i.variance_quantity);
        const cls = vq === 0 ? 'match' : (vq < 0 ? 'short' : 'over');
        const label = vq === 0 ? 'No change' : (vq < 0 ? `${Math.abs(vq).toFixed(2)} fewer` : `${vq.toFixed(2)} more`);
        return `
        <div class="list-row">
          <div>
            <div class="name">${escapeHtml(i.item_name)}</div>
            <div class="sub">${escapeHtml(i.category || '')}${i.size_ml ? ' · ' + i.size_ml + 'ml' : ''} · counted ${Number(i.counted_quantity).toFixed(2)}${i.previous_quantity != null ? ' · was ' + Number(i.previous_quantity).toFixed(2) : ' · first count'}</div>
          </div>
          <div style="text-align:right;">
            <div class="inv-var-badge ${cls}">${label}</div>
            ${i.variance_dollars != null ? `<div class="inv-dollar" style="margin-top:4px;">${fmtMoney2(i.variance_dollars)}</div>` : ''}
          </div>
        </div>`;
      }).join('') : '<p class="muted" style="padding:16px;">Nothing counted.</p>'}
    </div>`;
}

// ---------------------------------------------------------------------
// Catalog tab (Lead+) — search/list, quick-add, edit, area assignment.
// ---------------------------------------------------------------------
async function loadCatalog(query) {
  const el = document.getElementById('panelCatalog');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await ensureAreasLoaded();
    const result = await api('/api/inventory/items/search' + (query ? `?q=${encodeURIComponent(query)}` : ''));
    const items = result.items || [];
    items.forEach((i) => { CATALOG_CACHE[i.id] = i; });

    const assignByItem = {};
    await Promise.all(AREAS_CACHE.map(async (a) => {
      try {
        const r = await api(`/api/inventory/areas/${a.id}/items`);
        (r.items || []).forEach((i) => { (assignByItem[i.id] = assignByItem[i.id] || new Set()).add(a.id); });
      } catch (e) { /* one area's list failing shouldn't blank the whole tab */ }
    }));

    el.innerHTML = catalogHtml(items, assignByItem, query);
  } catch (e) {
    el.innerHTML = errorCard(e);
  }
}

function catalogHtml(items, assignByItem, query) {
  let html = `
    <div class="card">
      <div style="display:flex; gap:8px;">
        <input id="catalogSearch" placeholder="Search the catalog" value="${escapeHtml(query || '')}" oninput="debounceCatalogSearch()">
        <button class="secondary" style="width:auto; margin:0;" onclick="openNewCatalogItemForm()">+ Add item</button>
      </div>
    </div>
    <div id="newCatalogItemForm"></div>`;
  if (!items.length) {
    html += `<div class="card"><p class="muted">No items found.</p></div>`;
    return html;
  }
  html += `<div class="card" style="padding:0;">${items.map((i) => catalogRowHtml(i, assignByItem[i.id])).join('')}</div>`;
  return html;
}

function catalogRowHtml(item, areaSet) {
  const set = areaSet || new Set();
  return `
    <div class="list-row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <div class="name">${escapeHtml(item.name)}${!item.active ? ' <span class="badge off">retired</span>' : ''}</div>
          <div class="sub">${escapeHtml(item.category || '—')}${item.size_ml ? ' · ' + item.size_ml + 'ml' : ''}${item.upc ? ' · ' + escapeHtml(item.upc) : ''}${item.unit_cost != null ? ' · ' + fmtMoney2(item.unit_cost) : ''}</div>
        </div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="openEditCatalogItemForm('${item.id}')">Edit</button>
          ${item.active ? `<button class="small ghost" onclick="retireCatalogItem('${item.id}')">Retire</button>` : ''}
        </div>
      </div>
      ${AREAS_CACHE.length ? `<div class="sc-checkbox-grid" style="margin-top:10px;">
        ${AREAS_CACHE.map((a) => `<label class="sc-checkbox"><input type="checkbox" ${set.has(a.id) ? 'checked' : ''} onchange="toggleItemArea('${item.id}','${a.id}', this.checked)"> ${escapeHtml(a.name)}</label>`).join('')}
      </div>` : ''}
    </div>`;
}

let CATALOG_SEARCH_DEBOUNCE = null;
function debounceCatalogSearch() {
  clearTimeout(CATALOG_SEARCH_DEBOUNCE);
  CATALOG_SEARCH_DEBOUNCE = setTimeout(() => loadCatalog(document.getElementById('catalogSearch').value.trim()), 300);
}

function currentCatalogQuery() {
  const el = document.getElementById('catalogSearch');
  return el ? el.value.trim() : undefined;
}

async function toggleItemArea(itemId, areaId, checked) {
  try {
    await api(`/api/inventory/items/${itemId}/assign-area`, { method: 'POST', body: { areaId, unassign: !checked } });
  } catch (e) {
    showMsg(e.message, 'error');
    loadCatalog(currentCatalogQuery());
  }
}

function openNewCatalogItemForm() {
  const el = document.getElementById('newCatalogItemForm');
  el.innerHTML = `
    <div class="card">
      <h2>Add item</h2>
      <label>Name</label><input id="ciName">
      <label>Category (optional)</label><input id="ciCategory">
      <label>UPC (optional)</label><input id="ciUpc">
      <label>Size (ml, optional)</label><input id="ciSize" type="number">
      <label>ABV % (optional)</label><input id="ciAbv" type="number" step="0.1">
      <label>Case size (bottles per case)</label><input id="ciCaseSize" type="number" value="12">
      <label>Full weight, grams (optional)</label><input id="ciFullWeight" type="number" step="0.1">
      <label>Empty weight, grams (optional)</label><input id="ciEmptyWeight" type="number" step="0.1">
      <label>Unit cost (optional)</label>
      <div class="big-amt-wrap" style="margin:6px 0 14px;"><span class="prefix" style="font-size:18px;">$</span><input type="number" step="0.01" id="ciCost" style="font-size:16px; padding:11px 14px 11px 32px;"></div>
      <div style="display:flex; gap:10px;">
        <button class="secondary" onclick="document.getElementById('newCatalogItemForm').innerHTML=''">Cancel</button>
        <button class="primary" onclick="submitNewCatalogItem()">Add item</button>
      </div>
    </div>`;
}

async function submitNewCatalogItem() {
  const name = document.getElementById('ciName').value.trim();
  if (!name) { showMsg('Enter a name.', 'error'); return; }
  const body = {
    name,
    category: document.getElementById('ciCategory').value.trim() || undefined,
    upc: document.getElementById('ciUpc').value.trim() || undefined,
    sizeMl: Number(document.getElementById('ciSize').value) || undefined,
    abvPct: Number(document.getElementById('ciAbv').value) || undefined,
    caseSize: Number(document.getElementById('ciCaseSize').value) || 1,
    fullWeightG: Number(document.getElementById('ciFullWeight').value) || undefined,
    emptyWeightG: Number(document.getElementById('ciEmptyWeight').value) || undefined,
  };
  const cost = document.getElementById('ciCost').value;
  if (cost) body.unitCost = Number(cost);
  try {
    await api('/api/inventory/items', { method: 'POST', body });
    showMsg('Item added.', 'success');
    loadCatalog(currentCatalogQuery());
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

function openEditCatalogItemForm(itemId) {
  const item = CATALOG_CACHE[itemId];
  if (!item) return;
  const el = document.getElementById('newCatalogItemForm');
  el.innerHTML = `
    <div class="card">
      <h2>Edit ${escapeHtml(item.name)}</h2>
      <label>Name</label><input id="ciName" value="${escapeHtml(item.name)}">
      <label>Category</label><input id="ciCategory" value="${escapeHtml(item.category || '')}">
      <label>UPC</label><input id="ciUpc" value="${escapeHtml(item.upc || '')}">
      <label>Size (ml)</label><input id="ciSize" type="number" value="${item.size_ml || ''}">
      <label>ABV %</label><input id="ciAbv" type="number" step="0.1" value="${item.abv_pct || ''}">
      <label>Case size</label><input id="ciCaseSize" type="number" value="${item.case_size || 1}">
      <label>Full weight, grams</label><input id="ciFullWeight" type="number" step="0.1" value="${item.full_weight_g || ''}">
      <label>Empty weight, grams</label><input id="ciEmptyWeight" type="number" step="0.1" value="${item.empty_weight_g || ''}">
      <label>Unit cost</label>
      <div class="big-amt-wrap" style="margin:6px 0 14px;"><span class="prefix" style="font-size:18px;">$</span><input type="number" step="0.01" id="ciCost" value="${item.unit_cost != null ? item.unit_cost : ''}" style="font-size:16px; padding:11px 14px 11px 32px;"></div>
      <div style="display:flex; gap:10px;">
        <button class="secondary" onclick="document.getElementById('newCatalogItemForm').innerHTML=''">Cancel</button>
        <button class="primary" onclick="submitEditCatalogItem('${itemId}')">Save changes</button>
      </div>
    </div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitEditCatalogItem(itemId) {
  const name = document.getElementById('ciName').value.trim();
  if (!name) { showMsg('Enter a name.', 'error'); return; }
  const cost = document.getElementById('ciCost').value;
  const body = {
    name,
    category: document.getElementById('ciCategory').value.trim() || null,
    upc: document.getElementById('ciUpc').value.trim() || null,
    size_ml: Number(document.getElementById('ciSize').value) || null,
    abv_pct: Number(document.getElementById('ciAbv').value) || null,
    case_size: Number(document.getElementById('ciCaseSize').value) || 1,
    full_weight_g: Number(document.getElementById('ciFullWeight').value) || null,
    empty_weight_g: Number(document.getElementById('ciEmptyWeight').value) || null,
    unit_cost: cost ? Number(cost) : null,
  };
  try {
    await api(`/api/inventory/items/${itemId}/update`, { method: 'POST', body });
    showMsg('Item updated.', 'success');
    document.getElementById('newCatalogItemForm').innerHTML = '';
    loadCatalog(currentCatalogQuery());
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function retireCatalogItem(itemId) {
  try {
    await api(`/api/inventory/items/${itemId}/retire`, { method: 'POST' });
    showMsg('Item retired.', 'success');
    loadCatalog(currentCatalogQuery());
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Areas tab (Lead+) — plain CRUD, soft-delete via active.
// ---------------------------------------------------------------------
async function loadAreasAdmin() {
  const el = document.getElementById('panelAreas');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const result = await api('/api/inventory/areas' + (SELECTED_LOCATION_ID ? `?locationId=${SELECTED_LOCATION_ID}` : ''));
    AREAS_CACHE = result.areas || [];
    el.innerHTML = areasAdminHtml(AREAS_CACHE);
  } catch (e) {
    el.innerHTML = errorCard(e);
  }
}

function areasAdminHtml(areas) {
  let html = `<div class="card" style="padding:0;">${
    areas.length ? areas.map((a) => `
      <div class="list-row">
        <div class="name"><span style="color:var(--muted); margin-right:6px;">${AREA_ICON}</span>${escapeHtml(a.name)}</div>
        <div class="stack-actions" style="margin-top:0;">
          <button class="small ghost" onclick="renameArea('${a.id}', '${escapeHtml(a.name).replace(/'/g, "\\'")}')">Rename</button>
          <button class="small ghost" onclick="retireAreaAdmin('${a.id}')">Retire</button>
        </div>
      </div>`).join('') : '<p class="muted" style="padding:16px;">No areas yet.</p>'
  }</div>`;
  html += `
    <div class="card">
      <h2>Add an area</h2>
      <label>Name</label>
      <input id="newAreaName" placeholder="e.g. Rooftop Bar">
      <button class="primary" onclick="submitNewArea()">Add area</button>
    </div>`;
  return html;
}

async function submitNewArea() {
  const name = document.getElementById('newAreaName').value.trim();
  if (!name) { showMsg('Enter a name.', 'error'); return; }
  try {
    await api('/api/inventory/areas', { method: 'POST', body: { locationId: SELECTED_LOCATION_ID, name } });
    showMsg('Area added.', 'success');
    loadAreasAdmin();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function renameArea(areaId, currentName) {
  const name = window.prompt('Rename area', currentName);
  if (!name || !name.trim() || name.trim() === currentName) return;
  try {
    await api(`/api/inventory/areas/${areaId}/update`, { method: 'POST', body: { name: name.trim() } });
    showMsg('Area renamed.', 'success');
    loadAreasAdmin();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

async function retireAreaAdmin(areaId) {
  try {
    await api(`/api/inventory/areas/${areaId}/retire`, { method: 'POST' });
    showMsg('Area retired.', 'success');
    loadAreasAdmin();
  } catch (e) {
    showMsg(e.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
(async function init() {
  ME = requireAuth();
  if (!ME) return;
  renderTopbar('Inventory');
  try {
    const accessResult = await api('/api/inventory/access');
    TIER = accessResult.tier;
    if (TIER === 'no_access') {
      document.getElementById('panelMain').innerHTML =
        '<div class="card"><p>Inventory Control isn\'t enabled for your account yet — ask your manager.</p><p><a href="/dashboard.html">Back home</a></p></div>';
      return;
    }
    LOCATIONS = await api('/api/locations');
    SELECTED_LOCATION_ID = myLocationIds(ME)[0] || (LOCATIONS[0] && LOCATIONS[0].id) || null;
    if (tierAtLeast(TIER, 'lead')) renderManagerShell();
    else renderCounterFlow();
  } catch (e) {
    showMsg(e.message, 'error');
  }
})();
