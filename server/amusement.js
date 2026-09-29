// Diamond Amusement — coin-op route collections (patch_041).
//
// Scotto's second business: the games in the bars. Every ~2 weeks a
// collector (Scotto or Ryan) empties each game at a location, weighs the
// quarters, counts the bills, and the location total is rung into that
// bar's SpotOn POS as an "Amusement" sale. This module is the whole
// server side of that: locations, games (with QR tag codes), the
// per-visit collection sheet, weight -> dollars, the photo-of-the-scale
// reader, finalize, the POS hand-off, and the owner reports.
//
// Structured like server/cashhandling.js / inventorycontrol.js: every
// table (patch_041) has zero RLS policies and is reached only through
// withServiceClient; authorization is decided in server/index.js's
// routes with getAccess() below. Two levels only:
//   'owner'     — the owner: everything (games, locations, settings,
//                 reports, plus everything a collector can do).
//   'collector' — anyone with the 'amusement' app toggle on: run
//                 collections at any location, mark them posted.
//   'none'      — nothing.
//
// Money math, in one place (computeItem): the quarters are never
// counted, only weighed. net grams = gross - tare (both converted to
// grams if the scale was in pounds); coins = round(net / quarter_weight);
// dollars = coins x 0.25. Rounding to a whole coin is what makes the
// dollar figure land on a quarter boundary. quarter_weight_g is
// snapshotted onto the item so a settings change never rewrites an old
// collection.
const crypto = require('crypto');
const storage = require('./storage');

const GRAMS_PER_LB = 453.59237;

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode: statusCode || 400 });
}

function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toGrams(value, unit) {
  return unit === 'lb' ? value * GRAMS_PER_LB : value;
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------
async function getAccess(client, person) {
  if (!person) return 'none';
  if (person.role === 'owner') return 'owner';
  const { rows } = await client.query(
    `SELECT 1 FROM employee_apps
     WHERE person_id = $1 AND app_key = 'amusement' AND enabled = true
       AND (expires_at IS NULL OR expires_at > now())`,
    [person.id]
  );
  return rows.length ? 'collector' : 'none';
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
async function getSettings(client) {
  const { rows } = await client.query('SELECT * FROM amusement_settings WHERE id = 1');
  return rows[0];
}

async function updateSettings(client, fields, updatedBy) {
  const settable = ['quarter_weight_g', 'default_tare_g', 'weight_unit', 'scale_check_roll_g', 'scale_check_tolerance_g', 'calibration_weight_g'];
  const sets = [];
  const params = [];
  for (const key of settable) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    let v = fields[key];
    if (key === 'calibration_weight_g' && (v === null || v === undefined || v === '')) {
      v = null; // blank = check with the $10 roll instead
    } else if (key === 'weight_unit') {
      if (!['g', 'lb'].includes(v)) throw httpError('Unit must be g or lb.');
    } else {
      v = num(v, NaN);
      if (!Number.isFinite(v) || v < 0) throw httpError(`${key} must be a number.`);
      if (key === 'quarter_weight_g' && (v < 4 || v > 7)) throw httpError('Quarter weight should be between 4 and 7 grams (a US quarter is 5.670 g).');
    }
    params.push(v);
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) return getSettings(client);
  params.push(updatedBy);
  sets.push(`updated_by = $${params.length}`);
  sets.push('updated_at = now()');
  const { rows } = await client.query(`UPDATE amusement_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`, params);
  return rows[0];
}

// ---------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------
// Each active location with what the home screen needs: game count, the
// last final collection, the open draft (if any), and whether it's due.
async function listLocations(client, { includeInactive = false } = {}) {
  const { rows } = await client.query(
    `SELECT al.*,
            l.name AS bar_name,
            (SELECT count(*) FROM amusement_games g WHERE g.current_location_id = al.id AND g.status = 'active')::int AS game_count,
            lastc.id AS last_collection_id,
            lastc.finalized_at AS last_collected_at,
            lastc.total AS last_total,
            lastc.pos_status AS last_pos_status,
            draft.id AS draft_collection_id,
            draft.started_at AS draft_started_at,
            (SELECT count(*) FROM amusement_collections c WHERE c.location_id = al.id AND c.status = 'final' AND c.pos_status = 'queued')::int AS queued_pos_count
     FROM amusement_locations al
     LEFT JOIN locations l ON l.id = al.location_id
     LEFT JOIN LATERAL (
       SELECT id, finalized_at, total, pos_status FROM amusement_collections c
       WHERE c.location_id = al.id AND c.status = 'final' ORDER BY finalized_at DESC LIMIT 1
     ) lastc ON true
     LEFT JOIN LATERAL (
       SELECT id, started_at FROM amusement_collections c
       WHERE c.location_id = al.id AND c.status = 'draft' LIMIT 1
     ) draft ON true
     ${includeInactive ? '' : 'WHERE al.active = true'}
     ORDER BY al.is_storage, al.sort_order, al.name`
  );
  const now = Date.now();
  return rows.map((r) => {
    const days = r.last_collected_at ? Math.floor((now - new Date(r.last_collected_at).getTime()) / 86400000) : null;
    return { ...r, days_since: days, due: !r.is_storage && (days === null ? r.game_count > 0 : days >= r.collect_every_days) };
  });
}

async function getLocation(client, id) {
  const { rows } = await client.query('SELECT * FROM amusement_locations WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createLocation(client, { name, locationId, posDepartment, collectEveryDays, isStorage, createdBy }) {
  if (!name || !name.trim()) throw httpError('A name is required.');
  const { rows: sortRows } = await client.query('SELECT COALESCE(MAX(sort_order), 0) AS max FROM amusement_locations WHERE NOT is_storage');
  const { rows } = await client.query(
    `INSERT INTO amusement_locations (name, location_id, pos_department, collect_every_days, is_storage, sort_order, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name.trim(), locationId || null, (posDepartment || 'Amusement').trim(), Math.max(1, num(collectEveryDays, 14)), !!isStorage,
      Number(sortRows[0].max) + 1, createdBy]
  );
  return rows[0];
}

async function updateLocation(client, id, fields) {
  const sets = [];
  const params = [];
  const put = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (fields.name !== undefined) { if (!String(fields.name).trim()) throw httpError('A name is required.'); put('name', String(fields.name).trim()); }
  if (fields.locationId !== undefined) put('location_id', fields.locationId || null);
  if (fields.posDepartment !== undefined) put('pos_department', String(fields.posDepartment || 'Amusement').trim());
  if (fields.collectEveryDays !== undefined) put('collect_every_days', Math.max(1, num(fields.collectEveryDays, 14)));
  if (fields.active !== undefined) put('active', !!fields.active);
  if (fields.sortOrder !== undefined) put('sort_order', num(fields.sortOrder, 0));
  if (!sets.length) return getLocation(client, id);
  params.push(id);
  const { rows } = await client.query(`UPDATE amusement_locations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) throw httpError('Location not found.', 404);
  return rows[0];
}

// ---------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------
async function nextTagCode(client) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(substring(tag_code from 'DA-(\\d+)')::int), 0) AS max FROM amusement_games WHERE tag_code ~ '^DA-\\d+$'`
  );
  return 'DA-' + String(Number(rows[0].max) + 1).padStart(4, '0');
}

async function listGames(client, { locationId = null, includeRetired = false } = {}) {
  const params = [];
  const where = [];
  if (!includeRetired) where.push(`g.status = 'active'`);
  if (locationId) { params.push(locationId); where.push(`g.current_location_id = $${params.length}`); }
  const { rows } = await client.query(
    `SELECT g.*, al.name AS location_name, al.is_storage AS location_is_storage,
            stats.collections_90d, stats.earned_90d, stats.days_90d,
            lastw.entered_at AS last_weighed_at, lastw.total AS last_total, lastw.condition AS last_condition
     FROM amusement_games g
     LEFT JOIN amusement_locations al ON al.id = g.current_location_id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS collections_90d,
              COALESCE(sum(i.total), 0) AS earned_90d,
              GREATEST(1, EXTRACT(EPOCH FROM (max(c.finalized_at) - min(COALESCE(c.period_start, c.started_at)))) / 86400)::numeric AS days_90d
       FROM amusement_collection_items i
       JOIN amusement_collections c ON c.id = i.collection_id AND c.status = 'final'
       WHERE i.game_id = g.id AND c.finalized_at > now() - interval '90 days'
     ) stats ON true
     LEFT JOIN LATERAL (
       SELECT i.entered_at, i.total, i.condition
       FROM amusement_collection_items i JOIN amusement_collections c ON c.id = i.collection_id AND c.status = 'final'
       WHERE i.game_id = g.id ORDER BY c.finalized_at DESC LIMIT 1
     ) lastw ON true
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY g.status, al.is_storage, al.sort_order, g.sort_order, g.name`,
    params
  );
  return rows.map((g) => ({
    ...g,
    per_day_90d: g.collections_90d > 0 ? round2(Number(g.earned_90d) / Math.max(1, Number(g.days_90d))) : null,
  }));
}

async function getGame(client, id) {
  const { rows } = await client.query(
    `SELECT g.*, al.name AS location_name FROM amusement_games g
     LEFT JOIN amusement_locations al ON al.id = g.current_location_id WHERE g.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function getGameByTag(client, tagCode) {
  const { rows } = await client.query(
    `SELECT g.*, al.name AS location_name FROM amusement_games g
     LEFT JOIN amusement_locations al ON al.id = g.current_location_id WHERE upper(g.tag_code) = upper($1)`,
    [String(tagCode || '').trim()]
  );
  return rows[0] || null;
}

async function createGame(client, { name, gameType, make, model, serial, pricePerPlay, acceptsBills, locationId, notes, createdBy }) {
  if (!name || !name.trim()) throw httpError('A name is required.');
  if (!locationId) throw httpError('Pick where the game is.');
  const loc = await getLocation(client, locationId);
  if (!loc) throw httpError('That location does not exist.');
  const tag = await nextTagCode(client);
  const { rows: sortRows } = await client.query('SELECT COALESCE(MAX(sort_order), 0) AS max FROM amusement_games WHERE current_location_id = $1', [locationId]);
  const { rows } = await client.query(
    `INSERT INTO amusement_games (name, game_type, make, model, serial, price_per_play, accepts_bills, tag_code, current_location_id, notes, sort_order, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [name.trim(), (gameType || 'other').trim(), make || null, model || null, serial || null,
      Math.max(0, num(pricePerPlay, 1)), !!acceptsBills, tag, locationId, notes || null, Number(sortRows[0].max) + 1, createdBy]
  );
  await client.query('INSERT INTO amusement_game_placements (game_id, location_id, moved_by) VALUES ($1,$2,$3)', [rows[0].id, locationId, createdBy]);
  return getGame(client, rows[0].id);
}

async function updateGame(client, id, fields) {
  const sets = [];
  const params = [];
  const put = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (fields.name !== undefined) { if (!String(fields.name).trim()) throw httpError('A name is required.'); put('name', String(fields.name).trim()); }
  if (fields.gameType !== undefined) put('game_type', String(fields.gameType || 'other').trim());
  if (fields.make !== undefined) put('make', fields.make || null);
  if (fields.model !== undefined) put('model', fields.model || null);
  if (fields.serial !== undefined) put('serial', fields.serial || null);
  if (fields.pricePerPlay !== undefined) put('price_per_play', Math.max(0, num(fields.pricePerPlay, 1)));
  if (fields.acceptsBills !== undefined) put('accepts_bills', !!fields.acceptsBills);
  if (fields.notes !== undefined) put('notes', fields.notes || null);
  if (fields.sortOrder !== undefined) put('sort_order', num(fields.sortOrder, 0));
  if (!sets.length) return getGame(client, id);
  params.push(id);
  const { rows } = await client.query(`UPDATE amusement_games SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params);
  if (!rows[0]) throw httpError('Game not found.', 404);
  return getGame(client, id);
}

// Moving closes the open placement row and opens a new one, so reports
// can attribute each collection's earnings to wherever the game sat.
async function moveGame(client, id, { locationId, movedBy }) {
  const game = await getGame(client, id);
  if (!game) throw httpError('Game not found.', 404);
  if (!locationId) throw httpError('Pick a location.');
  if (String(game.current_location_id) === String(locationId)) return game;
  const loc = await getLocation(client, locationId);
  if (!loc) throw httpError('That location does not exist.');
  // A game half-way through a draft collection can't move out from
  // under the sheet.
  const { rows: openRows } = await client.query(
    `SELECT 1 FROM amusement_collection_items i JOIN amusement_collections c ON c.id = i.collection_id
     WHERE i.game_id = $1 AND c.status = 'draft'`, [id]);
  if (openRows.length) throw httpError('This game is on an open collection sheet — finalize that collection first.');
  await client.query('UPDATE amusement_game_placements SET to_at = now() WHERE game_id = $1 AND to_at IS NULL', [id]);
  await client.query('INSERT INTO amusement_game_placements (game_id, location_id, moved_by) VALUES ($1,$2,$3)', [id, locationId, movedBy]);
  await client.query('UPDATE amusement_games SET current_location_id = $2 WHERE id = $1', [id, locationId]);
  return getGame(client, id);
}

async function setGameStatus(client, id, status, by) {
  if (!['active', 'retired'].includes(status)) throw httpError('Bad status.');
  const { rows } = await client.query(
    `UPDATE amusement_games SET status = $2, retired_at = CASE WHEN $2 = 'retired' THEN now() ELSE NULL END WHERE id = $1 RETURNING id`,
    [id, status]
  );
  if (!rows[0]) throw httpError('Game not found.', 404);
  return getGame(client, id);
}

// The weight of this game's empty coin box — what gets subtracted every
// time the box is weighed with quarters in it. Stored with the photo it
// was read from, if there was one. Passing grams = null clears it back
// to the settings default.
async function setGameTare(client, id, { grams, photoPath, by }) {
  const game = await getGame(client, id);
  if (!game) throw httpError('Game not found.', 404);
  let g = null;
  if (grams !== null && grams !== undefined && grams !== '') {
    g = num(grams, NaN);
    if (!Number.isFinite(g) || g < 0 || g > 20000) throw httpError('Enter the empty coin box weight in grams.');
  }
  await client.query(
    `UPDATE amusement_games SET tare_g = $2::numeric, tare_photo_path = CASE WHEN $2::numeric IS NULL THEN NULL ELSE COALESCE($3::text, tare_photo_path) END,
       tare_set_by = CASE WHEN $2::numeric IS NULL THEN NULL ELSE $4::uuid END, tare_set_at = CASE WHEN $2::numeric IS NULL THEN NULL ELSE now() END
     WHERE id = $1`, [id, g, photoPath || null, by]);
  return getGame(client, id);
}

async function getGamePlacements(client, id) {
  const { rows } = await client.query(
    `SELECT p.*, al.name AS location_name FROM amusement_game_placements p
     JOIN amusement_locations al ON al.id = p.location_id WHERE p.game_id = $1 ORDER BY p.from_at DESC`, [id]);
  return rows;
}

// Per-game earnings history: every final collection line, newest first.
async function getGameHistory(client, id, limit = 26) {
  const { rows } = await client.query(
    `SELECT i.*, c.finalized_at, c.period_start, c.started_at, al.name AS location_name,
            GREATEST(1, EXTRACT(EPOCH FROM (c.finalized_at - COALESCE(c.period_start, c.started_at))) / 86400)::numeric(8,2) AS period_days
     FROM amusement_collection_items i
     JOIN amusement_collections c ON c.id = i.collection_id AND c.status = 'final'
     JOIN amusement_locations al ON al.id = c.location_id
     WHERE i.game_id = $1 ORDER BY c.finalized_at DESC LIMIT $2`, [id, limit]);
  return rows.map((r) => ({ ...r, per_day: round2(Number(r.total) / Math.max(1, Number(r.period_days))) }));
}

// ---------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------
async function getCollection(client, id) {
  const { rows } = await client.query(
    `SELECT c.*, al.name AS location_name, al.pos_department, al.location_id AS bar_location_id,
            sb.name AS started_by_name, fb.name AS finalized_by_name, pb.name AS pos_posted_by_name
     FROM amusement_collections c
     JOIN amusement_locations al ON al.id = c.location_id
     LEFT JOIN people sb ON sb.id = c.started_by
     LEFT JOIN people fb ON fb.id = c.finalized_by
     LEFT JOIN people pb ON pb.id = c.pos_posted_by
     WHERE c.id = $1`, [id]);
  return rows[0] || null;
}

// The sheet: the collection plus one line per active game at the
// location (weighed or not yet), plus any weighed game that has since
// been moved away (kept so the sheet still adds up).
async function getCollectionSheet(client, id) {
  const collection = await getCollection(client, id);
  if (!collection) return null;
  const { rows: games } = await client.query(
    `SELECT g.id, g.name, g.game_type, g.make, g.model, g.tag_code, g.price_per_play, g.accepts_bills, g.sort_order, g.tare_g,
            i.id AS item_id, i.gross_weight, i.tare_weight, i.weight_unit, i.net_weight_g, i.quarter_count, i.quarters_amount,
            i.bills_1, i.bills_5, i.bills_10, i.bills_20, i.bills_flat_amount, i.bills_amount, i.total, i.meter_reading,
            i.condition, i.note, i.weight_photo_path, i.weight_read_value, i.weight_read_unit, i.entered_at, i.updated_at,
            eb.name AS entered_by_name
     FROM amusement_games g
     LEFT JOIN amusement_collection_items i ON i.game_id = g.id AND i.collection_id = $1
     LEFT JOIN people eb ON eb.id = i.entered_by
     WHERE (g.current_location_id = $2 AND g.status = 'active') OR i.id IS NOT NULL
     ORDER BY g.sort_order, g.name`,
    [id, collection.location_id]
  );
  const settings = await getSettings(client);
  const done = games.filter((g) => g.item_id);
  return {
    collection,
    games,
    settings,
    progress: { done: done.length, total: games.length },
    totals: {
      quarters: round2(done.reduce((s, g) => s + Number(g.quarters_amount || 0), 0)),
      bills: round2(done.reduce((s, g) => s + Number(g.bills_amount || 0), 0)),
      total: round2(done.reduce((s, g) => s + Number(g.total || 0), 0)),
    },
  };
}

// Start a visit at a location, or pick the open draft back up.
async function startOrResumeCollection(client, { locationId, startedBy }) {
  const loc = await getLocation(client, locationId);
  if (!loc || !loc.active) throw httpError('That location is not active.');
  if (loc.is_storage) throw httpError('Storage is not collected.');
  const { rows: drafts } = await client.query(`SELECT id FROM amusement_collections WHERE location_id = $1 AND status = 'draft'`, [locationId]);
  if (drafts.length) return { collectionId: drafts[0].id, resumed: true };
  const { rows: prev } = await client.query(
    `SELECT finalized_at FROM amusement_collections WHERE location_id = $1 AND status = 'final' ORDER BY finalized_at DESC LIMIT 1`, [locationId]);
  const { rows } = await client.query(
    `INSERT INTO amusement_collections (location_id, started_by, period_start) VALUES ($1,$2,$3) RETURNING id`,
    [locationId, startedBy, prev[0] ? prev[0].finalized_at : null]
  );
  return { collectionId: rows[0].id, resumed: false };
}

// Pure: the money math for one game line.
function computeItem(input, settings, game) {
  const unit = input.weightUnit === 'lb' ? 'lb' : 'g';
  const gross = input.grossWeight === null || input.grossWeight === undefined || input.grossWeight === '' ? null : num(input.grossWeight, NaN);
  if (gross !== null && (!Number.isFinite(gross) || gross < 0)) throw httpError('Enter the weight the scale shows.');
  // The tare, when not typed: this game's own coin box if it's been
  // weighed, else the settings default.
  const defaultTareG = game && game.tare_g !== null && game.tare_g !== undefined ? num(game.tare_g) : num(settings.default_tare_g);
  const tare = Math.max(0, num(input.tareWeight, unit === 'lb' ? defaultTareG / GRAMS_PER_LB : defaultTareG));
  const quarterG = num(settings.quarter_weight_g, 5.67);
  let netG = null;
  let coins = 0;
  if (gross !== null) {
    netG = Math.max(0, toGrams(gross, unit) - toGrams(tare, unit));
    coins = Math.round(netG / quarterG);
  }
  const quarters = round2(coins * 0.25);
  const b1 = Math.max(0, Math.floor(num(input.bills1)));
  const b5 = Math.max(0, Math.floor(num(input.bills5)));
  const b10 = Math.max(0, Math.floor(num(input.bills10)));
  const b20 = Math.max(0, Math.floor(num(input.bills20)));
  const counted = b1 * 1 + b5 * 5 + b10 * 10 + b20 * 20;
  const flat = input.billsFlatAmount === null || input.billsFlatAmount === undefined || input.billsFlatAmount === '' ? null : Math.max(0, num(input.billsFlatAmount));
  const bills = round2(counted > 0 ? counted : (flat || 0));
  return {
    unit, gross, tare, netG: netG === null ? null : round2(netG), quarterG, coins, quarters,
    b1, b5, b10, b20, flat, bills, total: round2(quarters + bills),
  };
}

// Write (insert or replace) one game's line on a draft sheet.
async function upsertItem(client, collectionId, gameId, input, personId) {
  const collection = await getCollection(client, collectionId);
  if (!collection) throw httpError('Collection not found.', 404);
  if (collection.status !== 'draft') throw httpError('This collection is finalized — it can no longer be edited.');
  const game = await getGame(client, gameId);
  if (!game || game.status !== 'active') throw httpError('Game not found.', 404);
  const settings = await getSettings(client);
  const m = computeItem(input, settings, game);
  const condition = input.condition === 'issue' ? 'issue' : 'ok';
  const meter = input.meterReading === null || input.meterReading === undefined || input.meterReading === '' ? null : Math.max(0, Math.floor(num(input.meterReading)));
  const readValue = input.weightReadValue === null || input.weightReadValue === undefined || input.weightReadValue === '' ? null : num(input.weightReadValue, null);
  const { rows } = await client.query(
    `INSERT INTO amusement_collection_items
       (collection_id, game_id, gross_weight, tare_weight, weight_unit, net_weight_g, quarter_weight_g, quarter_count, quarters_amount,
        bills_1, bills_5, bills_10, bills_20, bills_flat_amount, bills_amount, total, meter_reading, condition, note,
        weight_photo_path, weight_read_value, weight_read_unit, weight_confirmed_by, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (collection_id, game_id) DO UPDATE SET
       gross_weight = EXCLUDED.gross_weight, tare_weight = EXCLUDED.tare_weight, weight_unit = EXCLUDED.weight_unit,
       net_weight_g = EXCLUDED.net_weight_g, quarter_weight_g = EXCLUDED.quarter_weight_g, quarter_count = EXCLUDED.quarter_count,
       quarters_amount = EXCLUDED.quarters_amount, bills_1 = EXCLUDED.bills_1, bills_5 = EXCLUDED.bills_5, bills_10 = EXCLUDED.bills_10,
       bills_20 = EXCLUDED.bills_20, bills_flat_amount = EXCLUDED.bills_flat_amount, bills_amount = EXCLUDED.bills_amount,
       total = EXCLUDED.total, meter_reading = EXCLUDED.meter_reading, condition = EXCLUDED.condition, note = EXCLUDED.note,
       weight_photo_path = COALESCE(EXCLUDED.weight_photo_path, amusement_collection_items.weight_photo_path),
       weight_read_value = EXCLUDED.weight_read_value, weight_read_unit = EXCLUDED.weight_read_unit,
       weight_confirmed_by = EXCLUDED.weight_confirmed_by, entered_by = EXCLUDED.entered_by, updated_at = now()
     RETURNING *`,
    [collectionId, gameId, m.gross, m.tare, m.unit, m.netG, m.quarterG, m.coins, m.quarters,
      m.b1, m.b5, m.b10, m.b20, m.flat, m.bills, m.total, meter, condition, input.note || null,
      input.weightPhotoPath || null, readValue, input.weightReadUnit || null, personId, personId]
  );
  await refreshTotals(client, collectionId);
  return rows[0];
}

async function removeItem(client, collectionId, gameId) {
  const collection = await getCollection(client, collectionId);
  if (!collection) throw httpError('Collection not found.', 404);
  if (collection.status !== 'draft') throw httpError('This collection is finalized.');
  await client.query('DELETE FROM amusement_collection_items WHERE collection_id = $1 AND game_id = $2', [collectionId, gameId]);
  await refreshTotals(client, collectionId);
}

async function refreshTotals(client, collectionId) {
  await client.query(
    `UPDATE amusement_collections c SET
       quarters_total = s.q, bills_total = s.b, total = s.t
     FROM (SELECT COALESCE(sum(quarters_amount),0) AS q, COALESCE(sum(bills_amount),0) AS b, COALESCE(sum(total),0) AS t
           FROM amusement_collection_items WHERE collection_id = $1) s
     WHERE c.id = $1`, [collectionId]);
}

async function recordScaleCheck(client, collectionId, { grams, photoPath }) {
  const collection = await getCollection(client, collectionId);
  if (!collection) throw httpError('Collection not found.', 404);
  if (collection.status !== 'draft') throw httpError('This collection is finalized.');
  const settings = await getSettings(client);
  const g = num(grams, NaN);
  if (!Number.isFinite(g) || g <= 0) throw httpError('Enter what the check weight read, in grams.');
  const expected = settings.calibration_weight_g !== null && settings.calibration_weight_g !== undefined
    ? num(settings.calibration_weight_g) : num(settings.scale_check_roll_g);
  const ok = Math.abs(g - expected) <= num(settings.scale_check_tolerance_g);
  const { rows } = await client.query(
    `UPDATE amusement_collections SET scale_check_g = $2, scale_check_ok = $3, scale_check_expected_g = $5,
       scale_check_photo_path = COALESCE($4, scale_check_photo_path)
     WHERE id = $1 RETURNING *`, [collectionId, g, ok, photoPath || null, expected]);
  return { collection: rows[0], ok, expected, tolerance: num(settings.scale_check_tolerance_g) };
}

async function updateCollectionNote(client, collectionId, note) {
  await client.query('UPDATE amusement_collections SET note = $2 WHERE id = $1', [collectionId, note || null]);
}

// Lock the sheet. Every active game at the location must have a line —
// a game that genuinely produced nothing is recorded as $0 (weigh the
// empty bucket, or type 0), not skipped, so the history is honest.
async function finalizeCollection(client, collectionId, { finalizedBy, allowMissing = false }) {
  const sheet = await getCollectionSheet(client, collectionId);
  if (!sheet) throw httpError('Collection not found.', 404);
  if (sheet.collection.status !== 'draft') return sheet.collection;
  const missing = sheet.games.filter((g) => !g.item_id);
  if (missing.length && !allowMissing) {
    throw Object.assign(httpError(`${missing.length} game${missing.length === 1 ? '' : 's'} not weighed yet: ${missing.map((g) => g.name).join(', ')}.`), { missing: missing.map((g) => g.name) });
  }
  if (!sheet.games.some((g) => g.item_id)) throw httpError('Nothing has been weighed on this sheet.');
  await refreshTotals(client, collectionId);
  const { rows } = await client.query(
    `UPDATE amusement_collections SET status = 'final', finalized_by = $2, finalized_at = now(), pos_status = 'queued'
     WHERE id = $1 AND status = 'draft' RETURNING *`, [collectionId, finalizedBy]);
  return rows[0];
}

async function markPosted(client, collectionId, { postedBy, reference, photoPath = null, undo = false }) {
  const collection = await getCollection(client, collectionId);
  if (!collection) throw httpError('Collection not found.', 404);
  if (collection.status !== 'final') throw httpError('Finalize the collection first.');
  const { rows } = undo
    ? await client.query(`UPDATE amusement_collections SET pos_status = 'queued', pos_posted_by = NULL, pos_posted_at = NULL, pos_reference = NULL WHERE id = $1 RETURNING *`, [collectionId])
    : await client.query(`UPDATE amusement_collections SET pos_status = 'posted', pos_posted_by = $2, pos_posted_at = now(), pos_reference = $3,
                            pos_photo_path = COALESCE($4, pos_photo_path) WHERE id = $1 RETURNING *`, [collectionId, postedBy, reference || null, photoPath]);
  return rows[0];
}

// A draft that was started by mistake (nothing weighed) can be thrown
// away; anything with lines on it stays until it's finalized.
async function discardDraft(client, collectionId) {
  const collection = await getCollection(client, collectionId);
  if (!collection) throw httpError('Collection not found.', 404);
  if (collection.status !== 'draft') throw httpError('Only a draft can be discarded.');
  await client.query('DELETE FROM amusement_collections WHERE id = $1', [collectionId]);
}

async function listCollections(client, { locationId = null, limit = 40, status = null } = {}) {
  const params = [];
  const where = [];
  if (locationId) { params.push(locationId); where.push(`c.location_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`c.status = $${params.length}`); }
  params.push(limit);
  const { rows } = await client.query(
    `SELECT c.*, al.name AS location_name, sb.name AS started_by_name, fb.name AS finalized_by_name, pb.name AS pos_posted_by_name,
            (SELECT count(*) FROM amusement_collection_items i WHERE i.collection_id = c.id)::int AS item_count,
            (SELECT count(*) FROM amusement_collection_items i WHERE i.collection_id = c.id AND i.condition = 'issue')::int AS issue_count
     FROM amusement_collections c
     JOIN amusement_locations al ON al.id = c.location_id
     LEFT JOIN people sb ON sb.id = c.started_by
     LEFT JOIN people fb ON fb.id = c.finalized_by
     LEFT JOIN people pb ON pb.id = c.pos_posted_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (c.status = 'draft') DESC, COALESCE(c.finalized_at, c.started_at) DESC
     LIMIT $${params.length}`, params);
  return rows;
}

// ---------------------------------------------------------------------
// Reports (owner)
// ---------------------------------------------------------------------
async function report(client, { days = 90 } = {}) {
  const d = Math.max(7, Math.min(730, num(days, 90)));
  const { rows: byGame } = await client.query(
    `SELECT g.id, g.name, g.game_type, g.status, al.name AS location_name,
            count(i.id)::int AS collections, COALESCE(sum(i.total),0) AS earned,
            COALESCE(sum(i.quarters_amount),0) AS quarters, COALESCE(sum(i.bills_amount),0) AS bills,
            COALESCE(sum(GREATEST(1, EXTRACT(EPOCH FROM (c.finalized_at - COALESCE(c.period_start, c.started_at))) / 86400)),0) AS days_covered,
            count(*) FILTER (WHERE i.condition = 'issue')::int AS issues
     FROM amusement_games g
     LEFT JOIN amusement_locations al ON al.id = g.current_location_id
     LEFT JOIN amusement_collection_items i ON i.game_id = g.id
     LEFT JOIN amusement_collections c ON c.id = i.collection_id AND c.status = 'final' AND c.finalized_at > now() - ($1 || ' days')::interval
     WHERE g.status = 'active' OR i.id IS NOT NULL
     GROUP BY g.id, g.name, g.game_type, g.status, al.name
     ORDER BY earned DESC, g.name`, [String(d)]);
  const { rows: byLocation } = await client.query(
    `SELECT al.id, al.name, count(c.id)::int AS collections, COALESCE(sum(c.total),0) AS earned,
            COALESCE(sum(c.quarters_total),0) AS quarters, COALESCE(sum(c.bills_total),0) AS bills,
            COALESCE(sum(GREATEST(1, EXTRACT(EPOCH FROM (c.finalized_at - COALESCE(c.period_start, c.started_at))) / 86400)),0) AS days_covered,
            count(*) FILTER (WHERE c.pos_status = 'queued')::int AS queued_pos
     FROM amusement_locations al
     LEFT JOIN amusement_collections c ON c.location_id = al.id AND c.status = 'final' AND c.finalized_at > now() - ($1 || ' days')::interval
     WHERE al.active = true AND NOT al.is_storage
     GROUP BY al.id, al.name ORDER BY al.sort_order, al.name`, [String(d)]);
  const gameRows = byGame.map((g) => ({
    ...g, earned: round2(Number(g.earned)), quarters: round2(Number(g.quarters)), bills: round2(Number(g.bills)),
    per_day: g.collections > 0 ? round2(Number(g.earned) / Math.max(1, Number(g.days_covered))) : null,
  }));
  const withEarnings = gameRows.filter((g) => g.per_day !== null);
  const avgPerDay = withEarnings.length ? round2(withEarnings.reduce((s, g) => s + g.per_day, 0) / withEarnings.length) : null;
  const totalEarned = round2(byLocation.reduce((s, l) => s + Number(l.earned), 0));
  const totalQuarters = round2(byLocation.reduce((s, l) => s + Number(l.quarters), 0));
  return {
    days: d,
    summary: {
      earned: totalEarned,
      collections: byLocation.reduce((s, l) => s + l.collections, 0),
      quarters_share: totalEarned > 0 ? Math.round((totalQuarters / totalEarned) * 100) : null,
      games_with_issues: gameRows.filter((g) => g.issues > 0).length,
      avg_per_day_per_game: avgPerDay,
      queued_pos: byLocation.reduce((s, l) => s + l.queued_pos, 0),
    },
    byGame: gameRows,
    byLocation: byLocation.map((l) => ({
      ...l, earned: round2(Number(l.earned)), quarters: round2(Number(l.quarters)), bills: round2(Number(l.bills)),
      per_day: l.collections > 0 ? round2(Number(l.earned) / Math.max(1, Number(l.days_covered))) : null,
    })),
    log: await listCollections(client, { limit: 60, status: 'final' }),
    scaleChecks: await listScaleChecks(client, 40),
  };
}

// Every start-of-visit check, newest first — the "is the scale drifting"
// view on the Admin page.
async function listScaleChecks(client, limit = 40) {
  const { rows } = await client.query(
    `SELECT c.id, c.started_at, c.scale_check_g, c.scale_check_expected_g, c.scale_check_ok, c.scale_check_photo_path,
            al.name AS location_name, p.name AS by_name
     FROM amusement_collections c
     JOIN amusement_locations al ON al.id = c.location_id
     LEFT JOIN people p ON p.id = c.started_by
     WHERE c.scale_check_g IS NOT NULL ORDER BY c.started_at DESC LIMIT $1`, [limit]);
  return rows.map((r) => ({ ...r, drift_g: r.scale_check_expected_g === null ? null : round2(num(r.scale_check_g) - num(r.scale_check_expected_g)) }));
}

// ---------------------------------------------------------------------
// Reading the scale display from a photo.
//
// The collector photographs the scale's readout; this asks Claude to
// read the digits and the unit and hands back a number the collector
// then confirms on screen (the confirmation, not this reading, is what
// gets stored as the weight — see upsertItem's weight_read_value vs
// gross_weight). Fails soft: any API/network problem returns
// { value: null } and the client falls back to typing the number.
// ---------------------------------------------------------------------
let anthropicClient = null;
function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

function readerConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

const READ_PROMPT = `This photo shows the display of a digital weighing scale used to weigh a bucket of coins.
Read the number on the display exactly as shown, including the decimal point, and the unit (g, kg, lb, or oz) if visible.
If the display shows "lb" with a colon or space (pounds and ounces, e.g. "1lb 3.2oz" or "1:3.2"), report unit "lb_oz" and value as the pounds and the ounces separated by a colon.
If no readable number is visible, set value to null.
Respond with JSON only, no prose: {"value": <number or "p:o" string or null>, "unit": "g"|"kg"|"lb"|"oz"|"lb_oz"|null, "confidence": "high"|"medium"|"low", "raw": "<the characters you saw>"}`;

async function readScalePhoto({ buffer, mimetype }) {
  const client = getAnthropic();
  if (!client) return { value: null, unit: null, confidence: 'low', raw: '', error: 'Photo reading is not configured (ANTHROPIC_API_KEY).' };
  try {
    const response = await client.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 300,
      output_config: { effort: 'low' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } },
          { type: 'text', text: READ_PROMPT },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') return { value: null, unit: null, confidence: 'low', raw: '', error: 'The photo could not be read.' };
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { value: null, unit: null, confidence: 'low', raw: text.slice(0, 80) };
    const parsed = JSON.parse(match[0]);
    return normalizeReading(parsed);
  } catch (e) {
    console.error('[amusement] scale photo read failed', e.message);
    return { value: null, unit: null, confidence: 'low', raw: '', error: 'Could not read the photo — type the number instead.' };
  }
}

// Whatever unit the scale was in, hand the client grams or pounds (the
// two units the sheet stores) plus what was literally seen.
function normalizeReading(parsed) {
  const out = { value: null, unit: null, confidence: parsed.confidence || 'medium', raw: String(parsed.raw || '') };
  let unit = parsed.unit ? String(parsed.unit).toLowerCase() : null;
  let value = parsed.value;
  if (value === null || value === undefined) return out;
  if (unit === 'lb_oz' && typeof value === 'string' && value.includes(':')) {
    const [p, o] = value.split(':').map((x) => num(x, 0));
    out.value = round2((p * 16 + o) * 28.349523125);
    out.unit = 'g';
    return out;
  }
  const n = num(value, NaN);
  if (!Number.isFinite(n)) return out;
  if (unit === 'kg') { out.value = round2(n * 1000); out.unit = 'g'; }
  else if (unit === 'oz') { out.value = round2(n * 28.349523125); out.unit = 'g'; }
  else if (unit === 'lb') { out.value = n; out.unit = 'lb'; }
  else { out.value = n; out.unit = 'g'; }
  return out;
}

// ---------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------
async function storePhoto({ buffer, mimetype, collectionId, folder }) {
  if (!storage.isConfigured()) return null;
  try {
    return await storage.uploadAmusementPhoto({ buffer, mimetype, collectionId: folder || collectionId });
  } catch (e) {
    console.error('[amusement] photo upload failed', e.message);
    return null;
  }
}

async function photoUrl(path) {
  if (!path) return null;
  return storage.getSignedAmusementPhotoUrl(path);
}

module.exports = {
  getAccess, getSettings, updateSettings,
  listLocations, getLocation, createLocation, updateLocation,
  listGames, getGame, getGameByTag, createGame, updateGame, moveGame, setGameStatus, setGameTare, getGamePlacements, getGameHistory, listScaleChecks,
  getCollection, getCollectionSheet, startOrResumeCollection, computeItem, upsertItem, removeItem, recordScaleCheck,
  updateCollectionNote, finalizeCollection, markPosted, discardDraft, listCollections,
  report, readScalePhoto, readerConfigured, storePhoto, photoUrl, GRAMS_PER_LB,
};
