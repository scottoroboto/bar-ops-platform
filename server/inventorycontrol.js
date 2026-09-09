// Inventory Control ("Stocktake") — areas, catalog, blind counting
// sessions, and owner-editable access. Phase 1: liquor counting only.
// Structured exactly like server/cashhandling.js: gated behind
// employee_apps ('inventory_control'), writes/cross-person reads on the
// service (RLS-bypass) connection with authorization enforced in the
// Express route handlers — every table this module touches (patch_028)
// has zero RLS policies, same posture as Cash Handling's tables.
//
// Access here is NOT the coarse people.role column — it's a separate
// four-tier system (no_access / counter / lead / full_authority),
// resolved by getEffectiveInventoryTier below with the exact same
// precedence as getEffectiveCashTier: owner bypasses everything; the
// employee_apps toggle being off always wins over any override; then a
// per-person override; then the person's Position default; then
// no_access, the safe default. Access management itself (position
// defaults / per-person overrides) is owner-only, enforced entirely in
// server/index.js's routes, never here — see cashhandling.js's own note
// on why (Scotto: "Managers can not override").
//
// Blind counting is structural, not just policy: inventory_count_items
// (what a Counter actually writes to) has no previous-quantity,
// variance, or dollar column at all. That data only exists in
// inventory_count_variances, written once by submitInventoryCount, and
// nothing here ever returns those rows ahead of that call for any
// caller. Cost (inventory_items.unit_cost) is the one other field a
// Counter must never see — the catalog-read functions below stay
// tier-agnostic (they return the full row) and the ROUTE layer strips
// unit_cost for callers below 'lead', same convention cashhandling.js
// uses for getSource/getTransaction.
const { withServiceClient } = require('./db');

const TIERS = ['no_access', 'counter', 'lead', 'full_authority'];
const TIER_RANK = { no_access: 0, counter: 1, lead: 2, full_authority: 3 };

function tierAtLeast(tier, min) {
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[min] ?? 0);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// A standard bar pour spout's weight, in grams — used to offset a
// weighed bottle's tare when the counter declares "spout on" instead of
// removing it. Owner-configurable via the generic owner_notes key/value
// table (same pattern auth.js's getFullSessionMinutes already uses),
// falling back to this default if never set.
const DEFAULT_SPOUT_OFFSET_GRAMS = 9;

// ---------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------
async function getEffectiveInventoryTier(client, personId) {
  const { rows } = await client.query(
    `SELECT p.role,
            (SELECT enabled FROM employee_apps WHERE person_id = p.id AND app_key = 'inventory_control') AS app_enabled,
            ov.tier AS override_tier,
            ipd.tier AS position_tier
     FROM people p
     LEFT JOIN inventory_access_overrides ov ON ov.person_id = p.id
     LEFT JOIN positions pos ON lower(pos.name) = lower(trim(p.position))
     LEFT JOIN inventory_position_defaults ipd ON ipd.position_id = pos.id
     WHERE p.id = $1`,
    [personId]
  );
  const person = rows[0];
  if (!person) return 'no_access';
  if (person.role === 'owner') return 'full_authority'; // owner bypasses everything, every location
  if (!person.app_enabled) return 'no_access'; // the platform toggle always wins, regardless of any override
  return person.override_tier || person.position_tier || 'no_access';
}

// ---------------------------------------------------------------------
// Areas — per-location counting zones (Back Bar, Speed Rail, Cellar,
// Store Room, ...). Plain soft-delete CRUD, simpler than Cash Handling's
// source management since there's no linked-pair concept here.
// ---------------------------------------------------------------------
async function listAreas(client, locationId) {
  const { rows } = await client.query(
    `SELECT * FROM inventory_areas WHERE location_id = $1 AND active = true ORDER BY sort_order, name`,
    [locationId]
  );
  return rows;
}

async function getArea(client, areaId) {
  const { rows } = await client.query('SELECT * FROM inventory_areas WHERE id = $1', [areaId]);
  return rows[0] || null;
}

async function createArea(client, { locationId, name, createdBy }) {
  if (!locationId) throw Object.assign(new Error('A location is required.'), { statusCode: 400 });
  if (!name || !name.trim()) throw Object.assign(new Error('A name is required.'), { statusCode: 400 });
  const { rows: sortRows } = await client.query(
    'SELECT COALESCE(MAX(sort_order), 0) AS max FROM inventory_areas WHERE location_id = $1',
    [locationId]
  );
  const nextSort = Number(sortRows[0].max) + 1;
  const { rows } = await client.query(
    `INSERT INTO inventory_areas (location_id, name, sort_order, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [locationId, name.trim(), nextSort, createdBy]
  );
  return rows[0];
}

async function updateArea(client, areaId, fields) {
  const settable = ['name', 'sort_order'];
  const sets = [];
  const params = [];
  for (const key of settable) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      params.push(fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (!sets.length) return getArea(client, areaId);
  params.push(areaId);
  const { rows } = await client.query(
    `UPDATE inventory_areas SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function retireArea(client, areaId) {
  const { rows } = await client.query('UPDATE inventory_areas SET active = false WHERE id = $1 RETURNING *', [areaId]);
  return rows[0] || null;
}

async function reactivateArea(client, areaId) {
  const { rows } = await client.query('UPDATE inventory_areas SET active = true WHERE id = $1 RETURNING *', [areaId]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------
// Catalog. Deliberately tier-agnostic — every function here returns the
// full row, unit_cost included. The route layer strips unit_cost for
// callers below 'lead' tier (see server/index.js), the same convention
// getSource/getTransaction use in cashhandling.js.
// ---------------------------------------------------------------------
async function getItem(client, itemId) {
  const { rows } = await client.query('SELECT * FROM inventory_items WHERE id = $1', [itemId]);
  return rows[0] || null;
}

async function getItemByUpc(client, upc) {
  const { rows } = await client.query('SELECT * FROM inventory_items WHERE upc = $1 AND active = true', [upc]);
  return rows[0] || null;
}

async function searchItems(client, { query, activeOnly = true } = {}) {
  const clauses = [];
  const params = [];
  if (query) { params.push(`%${query}%`); clauses.push(`name ILIKE $${params.length}`); }
  if (activeOnly) clauses.push('active = true');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await client.query(`SELECT * FROM inventory_items ${where} ORDER BY name LIMIT 50`, params);
  return rows;
}

// The unknown-barcode quick-add. Immediately links the new item into
// whichever area was being counted when the barcode was hit, so it's in
// that area's target list going forward without a second step.
async function createItem(client, {
  name, category, upc, sizeMl, abvPct, caseSize, unitCost,
  fullWeightG, emptyWeightG, createdBy, areaId,
}) {
  if (!name || !name.trim()) throw Object.assign(new Error('A name is required.'), { statusCode: 400 });
  const { rows } = await client.query(
    `INSERT INTO inventory_items
       (name, category, upc, size_ml, abv_pct, case_size, unit_cost, full_weight_g, empty_weight_g, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [name.trim(), category || null, upc || null, sizeMl || null, abvPct || null, caseSize || 1,
      unitCost ?? null, fullWeightG || null, emptyWeightG || null, createdBy]
  );
  const item = rows[0];
  if (areaId) {
    await client.query(
      `INSERT INTO inventory_item_areas (item_id, area_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [item.id, areaId]
    );
  }
  return item;
}

async function updateItem(client, itemId, fields) {
  const settable = ['name', 'category', 'upc', 'size_ml', 'abv_pct', 'case_size', 'unit_cost', 'full_weight_g', 'empty_weight_g'];
  const sets = [];
  const params = [];
  for (const key of settable) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      params.push(fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (!sets.length) return getItem(client, itemId);
  params.push(itemId);
  const { rows } = await client.query(
    `UPDATE inventory_items SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function retireItem(client, itemId) {
  const { rows } = await client.query('UPDATE inventory_items SET active = false WHERE id = $1 RETURNING *', [itemId]);
  return rows[0] || null;
}

async function assignItemToArea(client, { itemId, areaId }) {
  await client.query('INSERT INTO inventory_item_areas (item_id, area_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [itemId, areaId]);
  return { itemId, areaId };
}

async function unassignItemFromArea(client, { itemId, areaId }) {
  await client.query('DELETE FROM inventory_item_areas WHERE item_id = $1 AND area_id = $2', [itemId, areaId]);
  return { itemId, areaId };
}

// The Counting screen's target list for one area. Deliberately never
// selects unit_cost at all — there's nothing for the route layer to
// even forget to strip.
async function listItemsForArea(client, areaId) {
  const { rows } = await client.query(
    `SELECT i.id, i.name, i.upc, i.category, i.size_ml, i.full_weight_g, i.empty_weight_g, i.case_size
     FROM inventory_item_areas ia
     JOIN inventory_items i ON i.id = ia.item_id AND i.active = true
     WHERE ia.area_id = $1
     ORDER BY i.name`,
    [areaId]
  );
  return rows;
}

// ---------------------------------------------------------------------
// Count sessions
// ---------------------------------------------------------------------
async function listCounts(client, { locationId, statusFilter, limit } = {}) {
  const clauses = [];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`c.location_id = $${params.length}`); }
  if (statusFilter) { params.push(statusFilter); clauses.push(`c.status = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit || 50);
  const { rows } = await client.query(
    `SELECT c.*, l.name AS location_name, sb.name AS started_by_name, ub.name AS submitted_by_name
     FROM inventory_counts c
     JOIN locations l ON l.id = c.location_id
     JOIN people sb ON sb.id = c.started_by
     LEFT JOIN people ub ON ub.id = c.submitted_by
     ${where}
     ORDER BY c.started_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function startCount(client, { locationId, name, mode, areaIds, startedBy }) {
  if (!locationId) throw Object.assign(new Error('A location is required.'), { statusCode: 400 });
  if (!name || !name.trim()) throw Object.assign(new Error('A name is required.'), { statusCode: 400 });
  if (!['full', 'spot'].includes(mode)) throw Object.assign(new Error('Unknown count mode.'), { statusCode: 400 });
  if (!areaIds || !areaIds.length) throw Object.assign(new Error('Pick at least one area.'), { statusCode: 400 });
  const { rows } = await client.query(
    `INSERT INTO inventory_counts (location_id, name, mode, started_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [locationId, name.trim(), mode, startedBy]
  );
  const count = rows[0];
  for (const areaId of areaIds) {
    await client.query('INSERT INTO inventory_count_areas (count_id, area_id) VALUES ($1,$2)', [count.id, areaId]);
  }
  return count;
}

async function getCount(client, countId) {
  const { rows } = await client.query('SELECT * FROM inventory_counts WHERE id = $1', [countId]);
  return rows[0] || null;
}

// Areas-progress screen. targetCount is null for a 'spot' count — spot
// checks have no fixed target list, just a running tally of whatever's
// actually been scanned.
async function getCountProgress(client, countId) {
  const count = await getCount(client, countId);
  if (!count) return null;
  const { rows: areas } = await client.query(
    `SELECT a.id AS area_id, a.name AS area_name
     FROM inventory_count_areas ca JOIN inventory_areas a ON a.id = ca.area_id
     WHERE ca.count_id = $1 ORDER BY a.sort_order, a.name`,
    [countId]
  );
  const { rows: statusRows } = await client.query(
    `SELECT area_id, status, COUNT(*)::int AS n FROM inventory_count_items WHERE count_id = $1 GROUP BY area_id, status`,
    [countId]
  );
  const byArea = new Map();
  for (const r of statusRows) {
    if (!byArea.has(r.area_id)) byArea.set(r.area_id, { counted: 0, skipped: 0 });
    byArea.get(r.area_id)[r.status === 'skipped' ? 'skipped' : 'counted'] = r.n;
  }
  let targetByArea = new Map();
  if (count.mode === 'full') {
    const { rows: targetRows } = await client.query(
      `SELECT ia.area_id, COUNT(*)::int AS n
       FROM inventory_count_areas ca
       JOIN inventory_item_areas ia ON ia.area_id = ca.area_id
       WHERE ca.count_id = $1 GROUP BY ia.area_id`,
      [countId]
    );
    targetByArea = new Map(targetRows.map((r) => [r.area_id, r.n]));
  }
  return {
    count,
    areas: areas.map((a) => ({
      areaId: a.area_id,
      areaName: a.area_name,
      targetCount: count.mode === 'full' ? (targetByArea.get(a.area_id) || 0) : null,
      counted: (byArea.get(a.area_id) || {}).counted || 0,
      skipped: (byArea.get(a.area_id) || {}).skipped || 0,
    })),
  };
}

// The Counting screen's queue for one area. 'full' mode: every target
// item (inventory_item_areas), LEFT JOINed against whatever's already
// counted/skipped this session — an item with no matching row is
// 'pending'. 'spot' mode has no fixed target list, so this is just
// whatever's actually been scanned so far. Neither branch selects
// unit_cost.
async function listCountItemsForArea(client, { countId, areaId }) {
  const count = await getCount(client, countId);
  if (!count) return [];
  if (count.mode === 'full') {
    const { rows } = await client.query(
      `SELECT i.id AS item_id, i.name, i.upc, i.category, i.size_ml,
              COALESCE(ci.status, 'pending') AS status, ci.sealed_units, ci.skip_reason
       FROM inventory_item_areas ia
       JOIN inventory_items i ON i.id = ia.item_id AND i.active = true
       LEFT JOIN inventory_count_items ci ON ci.count_id = $1 AND ci.area_id = $2 AND ci.item_id = i.id
       WHERE ia.area_id = $2
       ORDER BY i.name`,
      [countId, areaId]
    );
    return rows;
  }
  const { rows } = await client.query(
    `SELECT i.id AS item_id, i.name, i.upc, i.category, i.size_ml,
            ci.status, ci.sealed_units, ci.skip_reason
     FROM inventory_count_items ci
     JOIN inventory_items i ON i.id = ci.item_id
     WHERE ci.count_id = $1 AND ci.area_id = $2
     ORDER BY i.name`,
    [countId, areaId]
  );
  return rows;
}

async function getSpoutOffsetGrams(client) {
  const { rows } = await client.query("SELECT body FROM owner_notes WHERE note_key = 'inventory_spout_weight_grams'");
  const n = rows[0] ? Number(rows[0].body) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SPOUT_OFFSET_GRAMS;
}

async function getCountItemWithPartials(client, countItemId) {
  const { rows } = await client.query('SELECT * FROM inventory_count_items WHERE id = $1', [countItemId]);
  const countItem = rows[0];
  if (!countItem) return null;
  const { rows: partials } = await client.query(
    'SELECT id, weight_grams, spout_on, entry_method, fill_fraction FROM inventory_count_item_partials WHERE count_item_id = $1 ORDER BY created_at',
    [countItemId]
  );
  return { ...countItem, partials };
}

// The one and only blind write — "Save & scan next." Upserts the
// count-item row (re-opening an already-saved item mid-session is
// normal), then wholesale-replaces its partials (delete-then-reinsert,
// the simplest correct approach for a small per-item list — same
// complexity class as updateSource's field-list rebuild). Each
// manual_weight partial's fill_fraction is computed here, once, from
// the item's reference weights AT THIS MOMENT and stored — see
// patch_028's header on why that's a snapshot, never recomputed live.
async function submitItemCount(client, {
  countId, areaId, itemId, sealedUnits, partials, skipped, skipReason, countedBy,
}) {
  const count = await getCount(client, countId);
  if (!count) throw Object.assign(new Error('Count session not found.'), { statusCode: 404 });
  if (count.status !== 'in_progress') throw Object.assign(new Error('This count has already been submitted.'), { statusCode: 400 });

  const status = skipped ? 'skipped' : 'counted';
  const { rows } = await client.query(
    `INSERT INTO inventory_count_items (count_id, area_id, item_id, sealed_units, status, skip_reason, counted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (count_id, area_id, item_id) DO UPDATE
       SET sealed_units = $4, status = $5, skip_reason = $6, counted_by = $7, counted_at = now()
     RETURNING *`,
    [countId, areaId, itemId, skipped ? 0 : (sealedUnits || 0), status, skipped ? (skipReason || null) : null, countedBy]
  );
  const countItem = rows[0];

  await client.query('DELETE FROM inventory_count_item_partials WHERE count_item_id = $1', [countItem.id]);

  if (!skipped && partials && partials.length) {
    const item = await getItem(client, itemId);
    const spoutOffsetG = await getSpoutOffsetGrams(client);
    for (const p of partials) {
      const entryMethod = p.entryMethod === 'manual_tenths' ? 'manual_tenths' : 'manual_weight';
      let weightGrams = null;
      let fillFraction;
      if (entryMethod === 'manual_tenths') {
        fillFraction = clamp(Number(p.fraction) || 0, 0, 1);
      } else {
        weightGrams = Number(p.weightGrams) || 0;
        const full = item ? Number(item.full_weight_g) || 0 : 0;
        const empty = item ? Number(item.empty_weight_g) || 0 : 0;
        const range = full - empty;
        const spoutOffset = p.spoutOn ? spoutOffsetG : 0;
        fillFraction = range > 0 ? clamp((weightGrams - spoutOffset - empty) / range, 0, 1) : 0;
      }
      await client.query(
        `INSERT INTO inventory_count_item_partials (count_item_id, weight_grams, spout_on, entry_method, fill_fraction)
         VALUES ($1,$2,$3,$4,$5)`,
        [countItem.id, weightGrams, !!p.spoutOn, entryMethod, fillFraction]
      );
    }
  }
  return getCountItemWithPartials(client, countItem.id);
}

// Blind tally for the Review screen — counts and names only, never a
// quantity or cost.
async function getReviewTally(client, countId) {
  const count = await getCount(client, countId);
  if (!count) return null;
  const { rows: countedRows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM inventory_count_items WHERE count_id = $1 AND status = 'counted'`,
    [countId]
  );
  const { rows: skippedItems } = await client.query(
    `SELECT ci.item_id, i.name AS item_name, a.name AS area_name, ci.skip_reason
     FROM inventory_count_items ci
     JOIN inventory_items i ON i.id = ci.item_id
     JOIN inventory_areas a ON a.id = ci.area_id
     WHERE ci.count_id = $1 AND ci.status = 'skipped'
     ORDER BY a.name, i.name`,
    [countId]
  );
  let totalTargeted = null;
  if (count.mode === 'full') {
    const { rows: targetRows } = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM inventory_count_areas ca
       JOIN inventory_item_areas ia ON ia.area_id = ca.area_id
       WHERE ca.count_id = $1`,
      [countId]
    );
    totalTargeted = targetRows[0].n;
  }
  return { countedCount: countedRows[0].n, skippedItems, totalTargeted };
}

// The checkpoint lookup, directly modeled on cashhandling.js's
// computeExpectedAmount: the most recent OTHER, SUBMITTED count at this
// location that touched this item, summed across whatever areas it
// appeared in that session. Returns quantity: null if this item has
// never been counted before — there's no baseline, same role
// cash_sources.target_amount plays for a never-counted source.
async function computePreviousQuantity(client, { itemId, locationId, excludeCountId }) {
  const { rows } = await client.query(
    `SELECT ci.count_id,
            SUM(ci.sealed_units) + COALESCE((
              SELECT SUM(p.fill_fraction)
              FROM inventory_count_item_partials p
              JOIN inventory_count_items ci2 ON ci2.id = p.count_item_id
              WHERE ci2.count_id = ci.count_id AND ci2.item_id = $1 AND ci2.status = 'counted'
            ), 0) AS quantity,
            c.submitted_at
     FROM inventory_count_items ci
     JOIN inventory_counts c ON c.id = ci.count_id
     WHERE ci.item_id = $1 AND c.location_id = $2 AND c.status = 'submitted' AND c.id != $3 AND ci.status = 'counted'
     GROUP BY ci.count_id, c.submitted_at
     ORDER BY c.submitted_at DESC
     LIMIT 1`,
    [itemId, locationId, excludeCountId]
  );
  if (!rows[0]) return { quantity: null, sourceCountId: null };
  return { quantity: Number(rows[0].quantity), sourceCountId: rows[0].count_id };
}

// The reveal-computation step. Marks the session submitted; for every
// distinct item actually counted, computes its live counted_quantity,
// looks up the previous checkpoint, snapshots unit_cost, and inserts one
// inventory_count_variances row. Returns ONLY a blind confirmation shape
// — never the variance rows it just wrote, for any caller regardless of
// tier, matching the mockup's own screen order (a blind Submitted
// confirmation, then a separate Variance report for whoever can see it).
async function submitInventoryCount(client, { countId, submittedBy }) {
  const count = await getCount(client, countId);
  if (!count) throw Object.assign(new Error('Count session not found.'), { statusCode: 404 });
  if (count.status !== 'in_progress') throw Object.assign(new Error('This count has already been submitted.'), { statusCode: 400 });

  const { rows: sealedRows } = await client.query(
    `SELECT item_id, SUM(sealed_units) AS sealed_total
     FROM inventory_count_items WHERE count_id = $1 AND status = 'counted' GROUP BY item_id`,
    [countId]
  );
  const { rows: partialRows } = await client.query(
    `SELECT ci.item_id, SUM(p.fill_fraction) AS partial_total
     FROM inventory_count_item_partials p
     JOIN inventory_count_items ci ON ci.id = p.count_item_id
     WHERE ci.count_id = $1 AND ci.status = 'counted'
     GROUP BY ci.item_id`,
    [countId]
  );
  const partialByItem = new Map(partialRows.map((r) => [r.item_id, Number(r.partial_total)]));

  let itemsCounted = 0;
  for (const row of sealedRows) {
    itemsCounted += 1;
    const countedQuantity = Number(row.sealed_total) + (partialByItem.get(row.item_id) || 0);
    const { quantity: previousQuantity, sourceCountId: previousCountId } = await computePreviousQuantity(client, {
      itemId: row.item_id, locationId: count.location_id, excludeCountId: countId,
    });
    const item = await getItem(client, row.item_id);
    const unitCostAtSubmit = item ? item.unit_cost : null;
    await client.query(
      `INSERT INTO inventory_count_variances (count_id, item_id, counted_quantity, previous_quantity, previous_count_id, unit_cost_at_submit)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (count_id, item_id) DO UPDATE
         SET counted_quantity = $3, previous_quantity = $4, previous_count_id = $5, unit_cost_at_submit = $6`,
      [countId, row.item_id, countedQuantity, previousQuantity, previousCountId, unitCostAtSubmit]
    );
  }

  const { rows: skippedCountRows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM inventory_count_items WHERE count_id = $1 AND status = 'skipped'`,
    [countId]
  );

  const { rows: updated } = await client.query(
    `UPDATE inventory_counts SET status = 'submitted', submitted_by = $2, submitted_at = now() WHERE id = $1 RETURNING *`,
    [countId, submittedBy]
  );

  return { count: updated[0], itemsCounted, itemsSkipped: skippedCountRows[0].n };
}

// The real numbers. This function does no gating itself — only ever
// called from a route gated tierAtLeast('lead'), same convention every
// read function in cashhandling.js uses.
async function getVarianceReport(client, countId) {
  const count = await getCount(client, countId);
  if (!count) return null;
  const { rows } = await client.query(
    `SELECT v.*, i.name AS item_name, i.category, i.size_ml
     FROM inventory_count_variances v
     JOIN inventory_items i ON i.id = v.item_id
     WHERE v.count_id = $1
     ORDER BY v.variance_dollars ASC NULLS LAST, i.name`,
    [countId]
  );
  return { count, items: rows };
}

// ---------------------------------------------------------------------
// Access management — owner-only, enforced entirely in server/index.js's
// routes (requireSession('full') + role !== 'owner' check), never here.
// Line-for-line ports of Cash Handling's Phase 3 functions.
// ---------------------------------------------------------------------
async function getPositionDefaults(client) {
  const { rows } = await client.query(
    `SELECT pos.id AS position_id, pos.name AS position_name, ipd.tier, ipd.updated_at
     FROM positions pos
     LEFT JOIN inventory_position_defaults ipd ON ipd.position_id = pos.id
     WHERE pos.active = true
     ORDER BY pos.name`
  );
  return rows;
}

async function setPositionDefault(client, { positionId, tier, updatedBy }) {
  const { rows } = await client.query(
    `INSERT INTO inventory_position_defaults (position_id, tier, updated_by)
     VALUES ($1,$2,$3)
     ON CONFLICT (position_id) DO UPDATE SET tier = $2, updated_by = $3, updated_at = now()
     RETURNING *`,
    [positionId, tier, updatedBy]
  );
  return rows[0];
}

async function getAccessOverride(client, personId) {
  const { rows } = await client.query('SELECT * FROM inventory_access_overrides WHERE person_id = $1', [personId]);
  return rows[0] || null;
}

async function setAccessOverride(client, { personId, tier, setBy, note }) {
  const oldTier = await getEffectiveInventoryTier(client, personId);
  const { rows } = await client.query(
    `INSERT INTO inventory_access_overrides (person_id, tier, set_by, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (person_id) DO UPDATE SET tier = $2, set_by = $3, note = $4, set_at = now()
     RETURNING *`,
    [personId, tier, setBy, note || null]
  );
  await client.query(
    `INSERT INTO inventory_access_change_log (person_id, old_tier, new_tier, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
    [personId, oldTier, tier, setBy, note || null]
  );
  return rows[0];
}

async function revertAccessOverride(client, { personId, revertedBy, note }) {
  const existing = await getAccessOverride(client, personId);
  if (!existing) return { reverted: false };
  await client.query('DELETE FROM inventory_access_overrides WHERE person_id = $1', [personId]);
  const newTier = await getEffectiveInventoryTier(client, personId);
  await client.query(
    `INSERT INTO inventory_access_change_log (person_id, old_tier, new_tier, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
    [personId, existing.tier, newTier, revertedBy, note || 'Reverted to position default']
  );
  return { reverted: true, newTier };
}

async function listAccessChangeLog(client, { personId, limit } = {}) {
  const clauses = [];
  const params = [];
  if (personId) { params.push(personId); clauses.push(`l.person_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit || 100);
  const { rows } = await client.query(
    `SELECT l.*, p.name AS person_name, cb.name AS changed_by_name
     FROM inventory_access_change_log l
     JOIN people p ON p.id = l.person_id
     JOIN people cb ON cb.id = l.changed_by
     ${where}
     ORDER BY l.changed_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

// Every active person, their position's default, any override, and the
// resulting effective tier — computed with the exact same precedence
// getEffectiveInventoryTier itself uses, so the Manage Access table can
// never show something route-level authorization would disagree with.
async function listAllEffectiveAccess(client, { locationId } = {}) {
  const clauses = [`p.status = 'active'`];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`p.location_id = $${params.length}`); }
  const { rows } = await client.query(
    `SELECT p.id, p.name, p.role, p.position, p.location_id, loc.name AS location_name,
            COALESCE(ea.enabled, false) AS app_enabled,
            ov.tier AS override_tier, ov.note AS override_note, ov.set_at AS override_set_at,
            ipd.tier AS position_tier,
            CASE
              WHEN p.role = 'owner' THEN 'full_authority'
              WHEN COALESCE(ea.enabled, false) = false THEN 'no_access'
              ELSE COALESCE(ov.tier, ipd.tier, 'no_access')
            END AS effective_tier
     FROM people p
     LEFT JOIN locations loc ON loc.id = p.location_id
     LEFT JOIN employee_apps ea ON ea.person_id = p.id AND ea.app_key = 'inventory_control'
     LEFT JOIN positions pos ON lower(pos.name) = lower(trim(p.position))
     LEFT JOIN inventory_position_defaults ipd ON ipd.position_id = pos.id
     LEFT JOIN inventory_access_overrides ov ON ov.person_id = p.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY p.name`,
    params
  );
  return rows;
}

module.exports = {
  TIERS,
  TIER_RANK,
  tierAtLeast,
  getEffectiveInventoryTier,
  listAreas,
  getArea,
  createArea,
  updateArea,
  retireArea,
  reactivateArea,
  getItem,
  getItemByUpc,
  searchItems,
  createItem,
  updateItem,
  retireItem,
  assignItemToArea,
  unassignItemFromArea,
  listItemsForArea,
  listCounts,
  startCount,
  getCount,
  getCountProgress,
  listCountItemsForArea,
  submitItemCount,
  getReviewTally,
  computePreviousQuantity,
  submitInventoryCount,
  getVarianceReport,
  getSpoutOffsetGrams,
  getPositionDefaults,
  setPositionDefault,
  getAccessOverride,
  setAccessOverride,
  revertAccessOverride,
  listAccessChangeLog,
  listAllEffectiveAccess,
};
