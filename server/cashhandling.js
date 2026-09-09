// Cash Handling — sources registry, blind-count ledger, transactions
// (Phase 2), and owner-editable access + source management (Phase 3).
// Structured like server/monitoring.js: gated behind employee_apps
// ('cash_handling'), writes/cross-person reads on the service (RLS-bypass)
// connection with authorization enforced in the Express route handlers —
// every table this module touches (patch_023/024/025) has zero RLS
// policies, same posture as scheduling's tables.
//
// Access here is NOT the coarse people.role column (staff/manager/
// maintenance/owner) — it's a separate four-tier system. Phase 1 shipped
// with a hardcoded POSITION_DEFAULT_TIER map as a placeholder; patch_025
// (Phase 3) replaced it with two real tables — cash_position_defaults
// (what a Position gets by default, owner-editable) and
// cash_access_overrides (a specific person bumped up or down from their
// position's default, owner-only, per Scotto's original ask: "I need the
// ability to allow bar managers to handle the cash flow... elevate and
// lower permissions... Managers can not override"). Precedence in
// getEffectiveCashTier below: an override always wins over the position
// default; no override and no matching position default both resolve to
// 'no_access', the safe direction for a cash app.
const crypto = require('crypto');
const { withServiceClient } = require('./db');
const storage = require('./storage');

const TIERS = ['no_access', 'own_drawer', 'drawers_bags', 'full_authority'];
const TIER_RANK = { no_access: 0, own_drawer: 1, drawers_bags: 2, full_authority: 3 };

function tierAtLeast(tier, min) {
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[min] ?? 0);
}

// ---------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------
async function getEffectiveCashTier(client, personId) {
  const { rows } = await client.query(
    `SELECT p.role,
            (SELECT enabled FROM employee_apps WHERE person_id = p.id AND app_key = 'cash_handling') AS app_enabled,
            ov.tier AS override_tier,
            cpd.tier AS position_tier
     FROM people p
     LEFT JOIN cash_access_overrides ov ON ov.person_id = p.id
     LEFT JOIN positions pos ON lower(pos.name) = lower(trim(p.position))
     LEFT JOIN cash_position_defaults cpd ON cpd.position_id = pos.id
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
// Sources
// ---------------------------------------------------------------------
// Full registry + each source's last count, for the dashboard. Callers
// must already have confirmed the requesting person's tier is
// 'drawers_bags' or 'full_authority' (own_drawer has no dashboard, per
// spec) before calling this — it is not itself tier-aware.
async function getDashboard(client, { locationId, tierScope } = {}) {
  const clauses = ['cs.active = true'];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`cs.location_id = $${params.length}`); }
  // drawers_bags tier never sees Fixed Cash Points (no access to them at all)
  if (tierScope === 'drawers_bags') clauses.push(`cs.kind != 'fixed_point'`);
  const { rows } = await client.query(
    `SELECT cs.*, l.name AS location_name,
            ap.name AS assigned_person_name,
            lc.counted_amount AS last_counted_amount,
            lc.variance AS last_variance,
            lc.counted_at AS last_counted_at,
            cp.name AS last_counted_by_name
     FROM cash_sources cs
     JOIN locations l ON l.id = cs.location_id
     LEFT JOIN people ap ON ap.id = cs.assigned_person_id
     LEFT JOIN LATERAL (
       SELECT counted_amount, variance, counted_at, counted_by
       FROM cash_counts WHERE source_id = cs.id ORDER BY counted_at DESC LIMIT 1
     ) lc ON true
     LEFT JOIN people cp ON cp.id = lc.counted_by
     WHERE ${clauses.join(' AND ')}
     ORDER BY l.name, cs.sort_order, cs.name`,
    params
  );
  return rows;
}

// A person's own drawer(s) — own_drawer tier's entire world. Deliberately
// thin (id/name/location only, no amounts) since this feeds the "pick
// which drawer" step ahead of a blind count, never a status view.
async function listOwnDrawers(client, personId) {
  const { rows } = await client.query(
    `SELECT cs.id, cs.name, cs.location_id, l.name AS location_name
     FROM cash_sources cs JOIN locations l ON l.id = cs.location_id
     WHERE cs.assigned_person_id = $1 AND cs.kind = 'drawer' AND cs.active = true
     ORDER BY cs.sort_order, cs.name`,
    [personId]
  );
  return rows;
}

async function getSource(client, sourceId) {
  const { rows } = await client.query(
    `SELECT cs.*, l.name AS location_name FROM cash_sources cs JOIN locations l ON l.id = cs.location_id WHERE cs.id = $1`,
    [sourceId]
  );
  return rows[0] || null;
}

// Can `personId` (at the given tier) count this specific source blind?
// own_drawer: only their own assigned drawer. drawers_bags: any
// drawer/backup_bag at their own location, never a fixed point.
// full_authority/owner: anything at their own location (owner: anywhere).
function canCountSource({ tier, personId, personLocationId, isOwner, source }) {
  if (!source || !source.active) return false;
  if (!isOwner && source.location_id !== personLocationId) return false;
  if (tier === 'own_drawer') return source.kind === 'drawer' && source.assigned_person_id === personId;
  if (tier === 'drawers_bags') return source.kind !== 'fixed_point';
  if (tier === 'full_authority') return true;
  return false;
}

// ---------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------
// Checkpoint model (patch_023's header): expected = the last logged
// count (or the source's target_amount baseline if it's never been
// counted), plus every cash_transactions row crediting this source and
// minus every one debiting it, both strictly since that checkpoint. A
// count submission becomes the new checkpoint (see submitCount below),
// so this never re-walks the full transaction history — only whatever
// has happened since the last time someone actually counted the drawer.
async function computeExpectedAmount(client, sourceId) {
  const { rows } = await client.query(
    `SELECT counted_amount, counted_at FROM cash_counts WHERE source_id = $1 ORDER BY counted_at DESC LIMIT 1`,
    [sourceId]
  );
  let base;
  let since;
  if (rows[0]) {
    base = Number(rows[0].counted_amount);
    since = rows[0].counted_at;
  } else {
    const src = await getSource(client, sourceId);
    base = src ? Number(src.target_amount) : 0;
    since = new Date(0); // never counted — every transaction ever logged for this source counts
  }
  const { rows: txRows } = await client.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE to_source_id = $1), 0)   AS credited,
       COALESCE(SUM(amount) FILTER (WHERE from_source_id = $1), 0) AS debited
     FROM cash_transactions
     WHERE (to_source_id = $1 OR from_source_id = $1) AND performed_at > $2`,
    [sourceId, since]
  );
  return base + Number(txRows[0].credited) - Number(txRows[0].debited);
}

// The one and only place a count gets written — and the one and only
// place expected_amount/variance become knowable, always strictly after
// the INSERT. No route may compute or return this ahead of a submit.
// The three audit FK params (Phase 4) are how a count row says which
// checklist/assignment produced it; all three stay null for an ordinary
// cash_out.
async function submitCount(client, {
  sourceId, countedBy, onBehalfOf, countedAmount, note, context,
  weeklyAuditId, manualAuditId, randomAssignmentId,
}) {
  const expected = await computeExpectedAmount(client, sourceId);
  const { rows } = await client.query(
    `INSERT INTO cash_counts
       (source_id, counted_by, on_behalf_of, context, counted_amount, expected_amount, note,
        weekly_audit_id, manual_audit_id, random_assignment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [sourceId, countedBy, onBehalfOf || null, context || 'cash_out', countedAmount, expected, note || null,
      weeklyAuditId || null, manualAuditId || null, randomAssignmentId || null]
  );
  return rows[0];
}

// Count history for review screens — kept separate from anything a
// mid-count screen touches, so a prior variance can never leak into a
// blind count in progress (see patch_023 header / plan's blind-counting
// convention).
async function listRecentCounts(client, { locationId, sourceId, limit } = {}) {
  const clauses = [];
  const params = [];
  if (sourceId) { params.push(sourceId); clauses.push(`cc.source_id = $${params.length}`); }
  if (locationId) { params.push(locationId); clauses.push(`cs.location_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit || 25);
  const { rows } = await client.query(
    `SELECT cc.*, cs.name AS source_name, cs.kind AS source_kind, cs.location_id,
            cb.name AS counted_by_name, ob.name AS on_behalf_of_name
     FROM cash_counts cc
     JOIN cash_sources cs ON cs.id = cc.source_id
     JOIN people cb ON cb.id = cc.counted_by
     LEFT JOIN people ob ON ob.id = cc.on_behalf_of
     ${where}
     ORDER BY cc.counted_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

// ---------------------------------------------------------------------
// Transactions (Phase 2) — deposits, bank change, transfers, cash drops,
// adjustments, with an optional receipt/deposit-slip photo in Supabase
// Storage. full_authority-only (enforced in the route, not here).
// ---------------------------------------------------------------------
const TRANSACTION_TYPES = ['deposit', 'bank_change', 'transfer', 'cash_drop', 'adjustment'];

// Structural + business-shape validation for a transaction, kept here in
// JS rather than as DB CHECKs (see patch_024's header) since the rules
// are about what each type MEANS, not just column shape. Every branch
// below is deliberately explicit rather than a clever generic rule, so a
// future 6th type doesn't silently inherit the wrong shape from whatever
// case happens to fall through.
function validateTransactionShape({ type, fromSourceId, fromExternal, toSourceId, toExternal, reason }) {
  if (!TRANSACTION_TYPES.includes(type)) return 'Unknown transaction type.';
  const hasFrom = !!(fromSourceId || fromExternal);
  const hasTo = !!(toSourceId || toExternal);

  if (type === 'deposit') {
    if (!fromSourceId || fromExternal) return 'A deposit needs a source it came out of.';
    if (toExternal !== 'bank' || toSourceId) return 'A deposit always goes to the bank.';
    return null;
  }
  if (type === 'bank_change') {
    if (fromExternal !== 'bank' || fromSourceId) return 'Bank change always comes from the bank.';
    if (!toSourceId || toExternal) return 'Bank change needs a source it went into.';
    return null;
  }
  if (type === 'transfer' || type === 'cash_drop') {
    if (!fromSourceId || fromExternal) return `A ${type === 'cash_drop' ? 'cash drop' : 'transfer'} needs a source it came out of.`;
    if (!toSourceId || toExternal) return `A ${type === 'cash_drop' ? 'cash drop' : 'transfer'} needs a source it went into.`;
    if (fromSourceId === toSourceId) return "A source can't transfer into itself.";
    return null;
  }
  if (type === 'adjustment') {
    if (fromExternal || toExternal) return "An adjustment corrects a source's own count — it doesn't touch the bank.";
    if (!hasFrom && !hasTo) return 'An adjustment needs the source being corrected.';
    if (hasFrom && hasTo) return 'An adjustment corrects one source at a time.';
    if (!reason || !reason.trim()) return 'An adjustment needs a reason.';
    return null;
  }
  return 'Unknown transaction type.';
}

// Generates the row's id up front (rather than letting the DB default it)
// so a receipt, if any, can be uploaded to Supabase Storage under that id
// BEFORE the INSERT — one clean write with receipt_path already populated,
// no orphaned row if the upload throws partway through.
async function createTransaction(client, {
  locationId, type, fromSourceId, fromExternal, toSourceId, toExternal,
  amount, reason, performedBy, receiptFile,
}) {
  const shapeError = validateTransactionShape({ type, fromSourceId, fromExternal, toSourceId, toExternal, reason });
  if (shapeError) throw Object.assign(new Error(shapeError), { statusCode: 400 });
  if (!(amount > 0)) throw Object.assign(new Error('Amount must be greater than zero.'), { statusCode: 400 });

  // Both real sources involved (transfer/cash_drop, or either side of an
  // adjustment/deposit/bank_change) must actually belong to this
  // location — a location-scoped full_authority manager should never be
  // able to move money in or out of a source at a bar they don't run,
  // and even the owner picks one location per transaction (see the
  // route-level comment on why this data model is single-location).
  for (const sourceId of [fromSourceId, toSourceId].filter(Boolean)) {
    const src = await getSource(client, sourceId);
    if (!src || !src.active) throw Object.assign(new Error('That cash source was not found.'), { statusCode: 400 });
    if (src.location_id !== locationId) throw Object.assign(new Error('Both sides of a transaction must be at the same location.'), { statusCode: 400 });
  }

  const id = crypto.randomUUID();
  let receiptPath = null;
  if (receiptFile) {
    receiptPath = await storage.uploadReceipt({
      buffer: receiptFile.buffer,
      mimetype: receiptFile.mimetype,
      transactionId: id,
      locationId,
    });
  }

  const { rows } = await client.query(
    `INSERT INTO cash_transactions
       (id, location_id, type, from_source_id, from_external, to_source_id, to_external, amount, reason, receipt_path, performed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [id, locationId, type, fromSourceId || null, fromExternal || null, toSourceId || null, toExternal || null, amount, reason || null, receiptPath, performedBy]
  );
  return rows[0];
}

async function getTransaction(client, id) {
  const { rows } = await client.query('SELECT * FROM cash_transactions WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listTransactions(client, { locationId, limit } = {}) {
  const clauses = [];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`ct.location_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit || 50);
  const { rows } = await client.query(
    `SELECT ct.*, l.name AS location_name,
            fs.name AS from_source_name, ts.name AS to_source_name,
            pb.name AS performed_by_name
     FROM cash_transactions ct
     JOIN locations l ON l.id = ct.location_id
     LEFT JOIN cash_sources fs ON fs.id = ct.from_source_id
     LEFT JOIN cash_sources ts ON ts.id = ct.to_source_id
     JOIN people pb ON pb.id = ct.performed_by
     ${where}
     ORDER BY ct.performed_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function getTransactionReceiptUrl(client, transactionId) {
  const txn = await getTransaction(client, transactionId);
  if (!txn || !txn.receipt_path) return null;
  return storage.getSignedReceiptUrl(txn.receipt_path);
}

// ---------------------------------------------------------------------
// Access management (Phase 3) — owner-only, enforced entirely in
// server/index.js's routes (requireSession('full') + role !== 'owner'
// check), never here. Every function below is called with the SAME
// `client` the route's withServiceClient callback received, so multiple
// queries in one function (e.g. setAccessOverride's upsert + change-log
// insert) are already one atomic transaction for free — withServiceClient
// wraps the whole route callback in BEGIN/COMMIT, no nested transaction
// needed in this module.
// ---------------------------------------------------------------------

// Every active Position, left-joined to its default (a Position with no
// row here has no default at all — resolves to no_access, same as Phase
// 1's hardcoded map treated anything unlisted).
async function getPositionDefaults(client) {
  const { rows } = await client.query(
    `SELECT pos.id AS position_id, pos.name AS position_name, cpd.tier, cpd.updated_at
     FROM positions pos
     LEFT JOIN cash_position_defaults cpd ON cpd.position_id = pos.id
     WHERE pos.active = true
     ORDER BY pos.name`
  );
  return rows;
}

async function setPositionDefault(client, { positionId, tier, updatedBy }) {
  const { rows } = await client.query(
    `INSERT INTO cash_position_defaults (position_id, tier, updated_by)
     VALUES ($1,$2,$3)
     ON CONFLICT (position_id) DO UPDATE SET tier = $2, updated_by = $3, updated_at = now()
     RETURNING *`,
    [positionId, tier, updatedBy]
  );
  return rows[0];
}

async function getAccessOverride(client, personId) {
  const { rows } = await client.query('SELECT * FROM cash_access_overrides WHERE person_id = $1', [personId]);
  return rows[0] || null;
}

// Sets (or replaces) a per-person override and appends one change-log
// row. old_tier is the person's EFFECTIVE tier right before this write
// (so the log reads as a real before/after of what the person could
// actually do, not just "there was no override row before this one").
async function setAccessOverride(client, { personId, tier, setBy, note }) {
  const oldTier = await getEffectiveCashTier(client, personId);
  const { rows } = await client.query(
    `INSERT INTO cash_access_overrides (person_id, tier, set_by, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (person_id) DO UPDATE SET tier = $2, set_by = $3, note = $4, set_at = now()
     RETURNING *`,
    [personId, tier, setBy, note || null]
  );
  await client.query(
    `INSERT INTO cash_access_change_log (person_id, old_tier, new_tier, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
    [personId, oldTier, tier, setBy, note || null]
  );
  return rows[0];
}

// Deletes the override row, falling back to the position default (or
// no_access). Idempotent — reverting someone with no override is a no-op,
// not an error, since "already at the default" is a fine end state.
async function revertAccessOverride(client, { personId, revertedBy, note }) {
  const existing = await getAccessOverride(client, personId);
  if (!existing) return { reverted: false };
  await client.query('DELETE FROM cash_access_overrides WHERE person_id = $1', [personId]);
  const newTier = await getEffectiveCashTier(client, personId);
  await client.query(
    `INSERT INTO cash_access_change_log (person_id, old_tier, new_tier, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
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
     FROM cash_access_change_log l
     JOIN people p ON p.id = l.person_id
     JOIN people cb ON cb.id = l.changed_by
     ${where}
     ORDER BY l.changed_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

// The Manage Access table — every active person, their position's
// default, any override, and the resulting effective tier, computed in
// one query with the exact same precedence as getEffectiveCashTier
// (owner bypass > app-toggle-off > override > position default >
// no_access) so the table can never show something that route-level
// authorization would actually disagree with.
async function listAllEffectiveAccess(client, { locationId } = {}) {
  const clauses = [`p.status = 'active'`];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`p.location_id = $${params.length}`); }
  const { rows } = await client.query(
    `SELECT p.id, p.name, p.role, p.position, p.location_id, loc.name AS location_name,
            COALESCE(ea.enabled, false) AS app_enabled,
            ov.tier AS override_tier, ov.note AS override_note, ov.set_at AS override_set_at,
            cpd.tier AS position_tier,
            CASE
              WHEN p.role = 'owner' THEN 'full_authority'
              WHEN COALESCE(ea.enabled, false) = false THEN 'no_access'
              ELSE COALESCE(ov.tier, cpd.tier, 'no_access')
            END AS effective_tier
     FROM people p
     LEFT JOIN locations loc ON loc.id = p.location_id
     LEFT JOIN employee_apps ea ON ea.person_id = p.id AND ea.app_key = 'cash_handling'
     LEFT JOIN positions pos ON lower(pos.name) = lower(trim(p.position))
     LEFT JOIN cash_position_defaults cpd ON cpd.position_id = pos.id
     LEFT JOIN cash_access_overrides ov ON ov.person_id = p.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY p.name`,
    params
  );
  return rows;
}

// ---------------------------------------------------------------------
// Manage Cash Sources (Phase 3) — owner-only, same enforcement posture
// as access management above.
// ---------------------------------------------------------------------
async function createSource(client, { locationId, kind, name, bagName, targetAmount, assignedPersonId, createdBy }) {
  if (!locationId) throw Object.assign(new Error('A location is required.'), { statusCode: 400 });
  if (!name || !name.trim()) throw Object.assign(new Error('A name is required.'), { statusCode: 400 });

  const { rows: sortRows } = await client.query('SELECT COALESCE(MAX(sort_order), 0) AS max FROM cash_sources WHERE location_id = $1', [locationId]);
  const nextSort = Number(sortRows[0].max) + 1;

  if (kind === 'fixed_point') {
    const { rows } = await client.query(
      `INSERT INTO cash_sources (location_id, name, kind, target_amount, assigned_person_id, sort_order, include_weekly_audit, include_random_audit, created_by)
       VALUES ($1,$2,'fixed_point',$3,$4,$5,false,false,$6) RETURNING *`,
      [locationId, name.trim(), targetAmount || 0, assignedPersonId || null, nextSort, createdBy]
    );
    return { source: rows[0] };
  }

  if (kind === 'drawer') {
    // Audit-inclusion flags are always created false, regardless of
    // whatever the request body says — a brand-new source has no history
    // to weigh in on the weekly/random audit pools yet; the owner opts it
    // in later from Manage Cash Sources once it's actually in use (Phase
    // 4's audit generator reads these same two columns).
    const { rows: drawerRows } = await client.query(
      `INSERT INTO cash_sources (location_id, name, kind, target_amount, assigned_person_id, sort_order, include_weekly_audit, include_random_audit, created_by)
       VALUES ($1,$2,'drawer',$3,$4,$5,false,false,$6) RETURNING *`,
      [locationId, name.trim(), targetAmount || 0, assignedPersonId || null, nextSort, createdBy]
    );
    const drawer = drawerRows[0];
    const { rows: bagRows } = await client.query(
      `INSERT INTO cash_sources (location_id, name, kind, linked_source_id, sort_order, include_weekly_audit, include_random_audit, created_by)
       VALUES ($1,$2,'backup_bag',$3,$4,false,false,$5) RETURNING *`,
      [locationId, (bagName && bagName.trim()) || `${name.trim()} Backup Bag`, drawer.id, nextSort + 1, createdBy]
    );
    const bag = bagRows[0];
    const { rows: updatedDrawerRows } = await client.query(
      `UPDATE cash_sources SET linked_source_id = $1 WHERE id = $2 RETURNING *`,
      [bag.id, drawer.id]
    );
    return { source: updatedDrawerRows[0], bag };
  }

  throw Object.assign(new Error('A new cash source must be a Fixed Point or a Drawer (with its paired Backup Bag).'), { statusCode: 400 });
}

// Soft-delete only (active = false), same pattern as locations/positions
// elsewhere in this codebase — a retired source's history (cash_counts,
// cash_transactions) stays intact and queryable, it just drops out of the
// dashboard/count-entry/audit pools going forward. Retiring a drawer also
// retires its paired backup bag (they're always created and thought of
// together); retiring a bag on its own does NOT retire its drawer — a
// register can legitimately keep running without a separate backup bag.
async function retireSource(client, sourceId) {
  const source = await getSource(client, sourceId);
  if (!source) return null;
  const { rows } = await client.query('UPDATE cash_sources SET active = false WHERE id = $1 RETURNING *', [sourceId]);
  let bag = null;
  if (source.kind === 'drawer' && source.linked_source_id) {
    const { rows: bagRows } = await client.query('UPDATE cash_sources SET active = false WHERE id = $1 RETURNING *', [source.linked_source_id]);
    bag = bagRows[0] || null;
  }
  return { source: rows[0], bag };
}

// Retired-sources pool for the "Reactivate a source" panel on the Manage
// Cash Sources page — same shape as getDashboard's query but active =
// false, and never tier-scoped (this is an owner-only route, not a
// counting screen). Includes each source's last count, if it has one, so
// the owner has some context before deciding to bring it back.
async function listRetiredSources(client, locationId) {
  const clauses = ['cs.active = false'];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`cs.location_id = $${params.length}`); }
  const { rows } = await client.query(
    `SELECT cs.*, l.name AS location_name,
            lc.counted_amount AS last_counted_amount,
            lc.counted_at AS last_counted_at
     FROM cash_sources cs
     JOIN locations l ON l.id = cs.location_id
     LEFT JOIN LATERAL (
       SELECT counted_amount, counted_at FROM cash_counts WHERE source_id = cs.id ORDER BY counted_at DESC LIMIT 1
     ) lc ON true
     WHERE ${clauses.join(' AND ')}
     ORDER BY l.name, cs.name`,
    params
  );
  return rows;
}

// Reverses retireSource — flips active back to true. Mirrors retireSource's
// own drawer+bag pairing: reactivating a drawer also reactivates its
// paired backup bag (they're retired together, so they come back
// together too). Reactivating a bag on its own does not reactivate its
// drawer, the same asymmetry retireSource has.
async function reactivateSource(client, sourceId) {
  const source = await getSource(client, sourceId);
  if (!source) return null;
  const { rows } = await client.query('UPDATE cash_sources SET active = true WHERE id = $1 RETURNING *', [sourceId]);
  let bag = null;
  if (source.kind === 'drawer' && source.linked_source_id) {
    const { rows: bagRows } = await client.query('UPDATE cash_sources SET active = true WHERE id = $1 RETURNING *', [source.linked_source_id]);
    bag = bagRows[0] || null;
  }
  return { source: rows[0], bag };
}

async function updateSource(client, sourceId, fields) {
  const settable = ['name', 'target_amount', 'assigned_person_id', 'include_weekly_audit', 'include_random_audit'];
  const sets = [];
  const params = [];
  for (const key of settable) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      params.push(fields[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (!sets.length) return getSource(client, sourceId);
  params.push(sourceId);
  const { rows } = await client.query(
    `UPDATE cash_sources SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------
// Weekly Audit + Manual Random Audit (Phase 4) — near-identical
// checklist flows, gated drawers_bags-or-above in the route layer. Both
// share one shape: start -> a target list of sources -> blind-count
// each one (no reveal) -> a final "submit the audit" call that marks it
// submitted and hands back every item's amounts/variance together, all
// at once. The only difference between the two is which sources belong
// on the checklist (target functions below); everything else is one
// set of shared helpers parameterized by `kind`.
// ---------------------------------------------------------------------
const AUDIT_KINDS = {
  weekly: {
    table: 'weekly_audits',
    fkColumn: 'weekly_audit_id',
    context: 'weekly_audit',
    targetFilterColumn: 'include_weekly_audit',
  },
  manual: {
    table: 'manual_random_audits',
    fkColumn: 'manual_audit_id',
    context: 'manual_random_audit',
    targetFilterColumn: 'include_random_audit',
  },
};

async function targetSourcesForAudit(client, kindDef, locationId) {
  const { rows } = await client.query(
    `SELECT * FROM cash_sources WHERE location_id = $1 AND active = true AND ${kindDef.targetFilterColumn} = true ORDER BY sort_order, name`,
    [locationId]
  );
  return rows;
}

// Starting an audit when one is already in_progress at this location
// just hands back the existing one, rather than spawning a duplicate
// checklist someone could get confused running two of at once.
async function startAudit(kind, client, { locationId, runBy }) {
  const kindDef = AUDIT_KINDS[kind];
  const { rows: existingRows } = await client.query(
    `SELECT * FROM ${kindDef.table} WHERE location_id = $1 AND status = 'in_progress' ORDER BY started_at DESC LIMIT 1`,
    [locationId]
  );
  const audit = existingRows[0] || (await client.query(
    `INSERT INTO ${kindDef.table} (location_id, run_by) VALUES ($1,$2) RETURNING *`,
    [locationId, runBy]
  )).rows[0];
  return audit;
}

async function getAudit(kind, client, auditId) {
  const kindDef = AUDIT_KINDS[kind];
  const { rows } = await client.query(`SELECT * FROM ${kindDef.table} WHERE id = $1`, [auditId]);
  return rows[0] || null;
}

// Blind checklist status: which target sources still need counting and
// which are already done — never an amount or variance, since the audit
// may still be in_progress. Safe to poll/refresh mid-audit.
async function getAuditChecklist(kind, client, auditId) {
  const kindDef = AUDIT_KINDS[kind];
  const audit = await getAudit(kind, client, auditId);
  if (!audit) return null;
  const targets = await targetSourcesForAudit(client, kindDef, audit.location_id);
  const { rows: countedRows } = await client.query(
    `SELECT source_id FROM cash_counts WHERE ${kindDef.fkColumn} = $1`,
    [auditId]
  );
  const countedIds = new Set(countedRows.map((r) => r.source_id));
  return {
    audit,
    items: targets.map((s) => ({ source: s, counted: countedIds.has(s.id) })),
  };
}

// One blind item. Rejects a source that isn't on this audit's target
// list, a source already counted this session, and anything once the
// audit itself has been submitted (no re-opening a revealed audit to
// sneak in a late count).
async function submitAuditItem(kind, client, { auditId, sourceId, countedAmount, note, countedBy }) {
  const kindDef = AUDIT_KINDS[kind];
  const audit = await getAudit(kind, client, auditId);
  if (!audit) throw Object.assign(new Error('Audit not found.'), { statusCode: 404 });
  if (audit.status !== 'in_progress') throw Object.assign(new Error('This audit has already been submitted.'), { statusCode: 400 });
  const source = await getSource(client, sourceId);
  if (!source || source.location_id !== audit.location_id || !source[kindDef.targetFilterColumn]) {
    throw Object.assign(new Error('That source is not on this audit.'), { statusCode: 400 });
  }
  const { rows: existing } = await client.query(
    `SELECT id FROM cash_counts WHERE ${kindDef.fkColumn} = $1 AND source_id = $2`,
    [auditId, sourceId]
  );
  if (existing[0]) throw Object.assign(new Error('That source is already counted for this audit.'), { statusCode: 400 });
  const count = await submitCount(client, {
    sourceId, countedBy, countedAmount, note, context: kindDef.context,
    [kind === 'weekly' ? 'weeklyAuditId' : 'manualAuditId']: auditId,
  });
  return { counted: true, sourceId: count.source_id };
}

// The single reveal moment: marks the audit submitted and returns every
// item counted this session with its amount/expected/variance together.
// Any target source never actually counted just doesn't appear — the
// checklist UI already knows (via getAuditChecklist) whether everything
// was covered before letting someone call this.
async function submitAudit(kind, client, { auditId }) {
  const kindDef = AUDIT_KINDS[kind];
  const audit = await getAudit(kind, client, auditId);
  if (!audit) throw Object.assign(new Error('Audit not found.'), { statusCode: 404 });
  if (audit.status !== 'in_progress') throw Object.assign(new Error('This audit has already been submitted.'), { statusCode: 400 });
  const { rows } = await client.query(
    `UPDATE ${kindDef.table} SET status = 'submitted', submitted_at = now() WHERE id = $1 RETURNING *`,
    [auditId]
  );
  const { rows: items } = await client.query(
    `SELECT cc.*, cs.name AS source_name, cs.kind AS source_kind
     FROM cash_counts cc JOIN cash_sources cs ON cs.id = cc.source_id
     WHERE cc.${kindDef.fkColumn} = $1 ORDER BY cs.sort_order, cs.name`,
    [auditId]
  );
  return { audit: rows[0], items };
}

// History — already-submitted audits, full detail (safe to reveal,
// since submission is exactly what makes an audit's amounts visible).
async function listAuditHistory(kind, client, { locationId, limit } = {}) {
  const kindDef = AUDIT_KINDS[kind];
  const { rows: audits } = await client.query(
    `SELECT a.*, l.name AS location_name, p.name AS run_by_name
     FROM ${kindDef.table} a
     JOIN locations l ON l.id = a.location_id
     JOIN people p ON p.id = a.run_by
     WHERE a.location_id = $1 AND a.status = 'submitted'
     ORDER BY a.submitted_at DESC LIMIT $2`,
    [locationId, limit || 25]
  );
  for (const audit of audits) {
    const { rows: items } = await client.query(
      `SELECT cc.*, cs.name AS source_name, cs.kind AS source_kind
       FROM cash_counts cc JOIN cash_sources cs ON cs.id = cc.source_id
       WHERE cc.${kindDef.fkColumn} = $1 ORDER BY cs.sort_order, cs.name`,
      [audit.id]
    );
    audit.items = items;
  }
  return audits;
}

// ---------------------------------------------------------------------
// System-Assigned Random Audit (Phase 4) — one auto-generated
// assignment per location per week, naming a single random source from
// the include_random_audit pool and a single eligible, on-schedule
// person who is NOT that source's regular handler. Meant to be driven
// by a Render Cron Job hitting POST /random-audit/generate weekly (see
// server/index.js), not a session route.
// ---------------------------------------------------------------------

// "Regular handler" for exclusion purposes (design note in patch_023's
// header on cash_sources.assigned_person_id): the source's own
// assigned_person_id when set; otherwise whoever most recently logged
// an ordinary cash_out count on it, so a source with no formally
// assigned person still excludes whoever's actually been counting it.
async function regularHandlerFor(client, source) {
  if (source.assigned_person_id) return source.assigned_person_id;
  const { rows } = await client.query(
    `SELECT counted_by FROM cash_counts WHERE source_id = $1 AND context = 'cash_out' ORDER BY counted_at DESC LIMIT 1`,
    [source.id]
  );
  return rows[0] ? rows[0].counted_by : null;
}

// Everyone at this location whose effective tier qualifies to count
// `source` (fixed_point needs full_authority; drawer/backup_bag needs
// drawers_bags or better), minus the regular handler, minus anyone
// without a non-cancelled shift at this location on `dueDate`.
async function eligiblePoolFor(client, { source, locationId, dueDate }) {
  const excludePersonId = await regularHandlerFor(client, source);
  const minTier = source.kind === 'fixed_point' ? 'full_authority' : 'drawers_bags';
  const access = await listAllEffectiveAccess(client, { locationId });
  const tierOk = access.filter((p) => tierAtLeast(p.effective_tier, minTier) && p.id !== excludePersonId);
  if (!tierOk.length) return [];
  const ids = tierOk.map((p) => p.id);
  const { rows: onShift } = await client.query(
    `SELECT DISTINCT sh.person_id
     FROM shifts sh JOIN schedules s ON s.id = sh.schedule_id
     WHERE s.location_id = $1 AND sh.shift_date = $2 AND sh.status != 'cancelled' AND sh.person_id = ANY($3)`,
    [locationId, dueDate, ids]
  );
  const onShiftIds = new Set(onShift.map((r) => r.person_id));
  return tierOk.filter((p) => onShiftIds.has(p.id));
}

// The due date this function picks for a given week is the LAST day of
// that week (weekStart + 6 — Friday, on this app's Saturday-start
// week) — the assigned person needs to actually be on-site that day to
// count something, so eligibility is checked against a shift on that
// exact date rather than "sometime this week."
function weekEndDateStr(weekStartISO) {
  const d = new Date(weekStartISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

// Idempotent per (location, week): ON CONFLICT DO NOTHING means calling
// this twice for the same week never double-assigns or re-rolls an
// existing pick. Returns one result entry per active location so the
// cron-triggered route (or a manual re-run) can report what happened,
// including locations skipped for having no eligible on-schedule person.
async function generateSystemRandomAudits(client, weekStartISO) {
  const dueDate = weekEndDateStr(weekStartISO);
  const { rows: locations } = await client.query('SELECT id, name FROM locations WHERE active = true ORDER BY name');
  const results = [];
  for (const loc of locations) {
    const { rows: existing } = await client.query(
      `SELECT * FROM system_random_audit_assignments WHERE location_id = $1 AND week_start = $2`,
      [loc.id, weekStartISO]
    );
    if (existing[0]) { results.push({ locationId: loc.id, locationName: loc.name, skipped: false, alreadyAssigned: true, assignment: existing[0] }); continue; }

    const { rows: pool } = await client.query(
      `SELECT * FROM cash_sources WHERE location_id = $1 AND active = true AND include_random_audit = true`,
      [loc.id]
    );
    if (!pool.length) { results.push({ locationId: loc.id, locationName: loc.name, skipped: true, reason: 'No sources are flagged for random audit at this location.' }); continue; }

    // Try sources in random order until one has an eligible on-schedule
    // person, rather than committing to the first pick and giving up —
    // a location with several random-audit sources shouldn't skip the
    // week just because the unlucky first draw has nobody scheduled.
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    let picked = null;
    let eligible = [];
    for (const source of shuffled) {
      const pool2 = await eligiblePoolFor(client, { source, locationId: loc.id, dueDate });
      if (pool2.length) { picked = source; eligible = pool2; break; }
    }
    if (!picked) { results.push({ locationId: loc.id, locationName: loc.name, skipped: true, reason: 'No eligible, on-schedule person for any random-audit source this week.' }); continue; }

    const assignedPerson = eligible[Math.floor(Math.random() * eligible.length)];
    const { rows: inserted } = await client.query(
      `INSERT INTO system_random_audit_assignments (location_id, source_id, assigned_person_id, week_start, due_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (location_id, week_start) DO NOTHING RETURNING *`,
      [loc.id, picked.id, assignedPerson.id, weekStartISO, dueDate]
    );
    if (inserted[0]) results.push({ locationId: loc.id, locationName: loc.name, skipped: false, assignment: inserted[0] });
    else results.push({ locationId: loc.id, locationName: loc.name, skipped: false, alreadyAssigned: true });
  }
  return results;
}

async function markMissedAssignments(client) {
  const { rows } = await client.query(
    `UPDATE system_random_audit_assignments SET status = 'missed' WHERE status = 'assigned' AND due_at < CURRENT_DATE RETURNING *`
  );
  return rows;
}

async function getMySystemAuditAssignment(client, personId) {
  const { rows } = await client.query(
    `SELECT a.*, cs.name AS source_name, cs.kind AS source_kind, l.name AS location_name
     FROM system_random_audit_assignments a
     JOIN cash_sources cs ON cs.id = a.source_id
     JOIN locations l ON l.id = a.location_id
     WHERE a.assigned_person_id = $1 AND a.status = 'assigned'
     ORDER BY a.due_at LIMIT 1`,
    [personId]
  );
  return rows[0] || null;
}

async function listSystemAuditAssignments(client, { locationId, limit } = {}) {
  const clauses = [];
  const params = [];
  if (locationId) { params.push(locationId); clauses.push(`a.location_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit || 50);
  const { rows } = await client.query(
    `SELECT a.*, cs.name AS source_name, cs.kind AS source_kind, l.name AS location_name, p.name AS assigned_person_name
     FROM system_random_audit_assignments a
     JOIN cash_sources cs ON cs.id = a.source_id
     JOIN locations l ON l.id = a.location_id
     JOIN people p ON p.id = a.assigned_person_id
     ${where}
     ORDER BY a.week_start DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

// Only the assigned person may submit their own assignment — no
// on-behalf-of, since the whole point is someone other than the
// regular handler independently verifying the count. One blind entry,
// immediately revealed in the response (same single-shot pattern as
// the original blind cash-out), since there's no multi-item checklist
// to hold the reveal back for.
async function submitSystemAuditCount(client, { assignmentId, countedBy, countedAmount, note }) {
  const { rows } = await client.query('SELECT * FROM system_random_audit_assignments WHERE id = $1', [assignmentId]);
  const assignment = rows[0];
  if (!assignment) throw Object.assign(new Error('Assignment not found.'), { statusCode: 404 });
  if (assignment.status !== 'assigned') throw Object.assign(new Error('This assignment is no longer open.'), { statusCode: 400 });
  if (assignment.assigned_person_id !== countedBy) throw Object.assign(new Error("This isn't your assignment to count."), { statusCode: 403 });
  const count = await submitCount(client, {
    sourceId: assignment.source_id, countedBy, countedAmount, note,
    context: 'system_random_audit', randomAssignmentId: assignmentId,
  });
  const { rows: updatedRows } = await client.query(
    `UPDATE system_random_audit_assignments SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING *`,
    [assignmentId]
  );
  return { count, assignment: updatedRows[0] };
}

module.exports = {
  TIERS,
  TIER_RANK,
  tierAtLeast,
  getEffectiveCashTier,
  getDashboard,
  listOwnDrawers,
  getSource,
  canCountSource,
  computeExpectedAmount,
  submitCount,
  listRecentCounts,
  TRANSACTION_TYPES,
  validateTransactionShape,
  createTransaction,
  getTransaction,
  listTransactions,
  getTransactionReceiptUrl,
  getPositionDefaults,
  setPositionDefault,
  getAccessOverride,
  setAccessOverride,
  revertAccessOverride,
  listAccessChangeLog,
  listAllEffectiveAccess,
  createSource,
  retireSource,
  listRetiredSources,  
  reactivateSource,
  updateSource,
  startAudit,
  getAudit,
  getAuditChecklist,
  submitAuditItem,
  submitAudit,
  listAuditHistory,
  generateSystemRandomAudits,
  markMissedAssignments,
  getMySystemAuditAssignment,
  listSystemAuditAssignments,
  submitSystemAuditCount,
  weekEndDateStr,
};
