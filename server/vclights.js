// =====================================================================
// Venue Control — Lights (patch_049): Kasa plugs on the neon signs and the
// routines that switch them. The Pi does the talking to plugs and runs the
// schedules; the cloud keeps the list (names, groups, schedules) and hands
// it down in the agent config, like every other Venue Control table.
// =====================================================================

const KINDS = ['time', 'sunrise', 'sunset', 'dawn', 'dusk', 'none'];

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }

function normalizeMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.length === 12 ? hex.match(/../g).join(':') : null;
}

function cleanText(v, max = 60) {
  const s = String(v === undefined || v === null ? '' : v).trim().slice(0, max);
  return s || null;
}

function parseTime(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw fail(`${label} needs a time like 18:30.`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function parseOffset(v) {
  const n = Math.round(Number(v || 0));
  if (!Number.isFinite(n) || n < -240 || n > 240) throw fail('Offsets are minutes, between -240 and 240.');
  return n;
}

function parseDays(v) {
  if (!Array.isArray(v)) throw fail('Pick the days.');
  const days = [...new Set(v.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!days.length) throw fail('Pick at least one day.');
  return days;
}

// { days, onKind, onTime, onOffset, offKind, offTime, offOffset } -> column
// values, checked. Used by routines and by a plug's own schedule.
function parseSchedule(b) {
  const onKind = KINDS.includes(b.onKind) ? b.onKind : null;
  const offKind = KINDS.includes(b.offKind) ? b.offKind : null;
  if (!onKind || !offKind) throw fail('Pick when the lights turn on and off.');
  if (onKind === 'none' && offKind === 'none') throw fail('A schedule needs an on time, an off time, or both.');
  const onTime = onKind === 'time' ? parseTime(b.onTime, 'ON') : null;
  const offTime = offKind === 'time' ? parseTime(b.offTime, 'OFF') : null;
  if (onKind === 'time' && !onTime) throw fail('Enter the ON time.');
  if (offKind === 'time' && !offTime) throw fail('Enter the OFF time.');
  return {
    days: parseDays(b.days),
    on_kind: onKind, on_time: onTime, on_offset_min: onKind === 'time' || onKind === 'none' ? 0 : parseOffset(b.onOffset),
    off_kind: offKind, off_time: offTime, off_offset_min: offKind === 'time' || offKind === 'none' ? 0 : parseOffset(b.offOffset),
  };
}

const fmtTime = (t) => (t ? String(t).slice(0, 5) : null);

function routineOut(r) {
  return {
    id: Number(r.id), name: r.name, days: r.days || [], enabled: r.enabled, sort_order: r.sort_order,
    on_kind: r.on_kind, on_time: fmtTime(r.on_time), on_offset_min: r.on_offset_min,
    off_kind: r.off_kind, off_time: fmtTime(r.off_time), off_offset_min: r.off_offset_min,
  };
}

// What the Pi needs about a plug. Live status (last_on/watts/seen) is left
// out so a status report doesn't change the config ETag every minute.
function plugConfigOut(p) {
  return {
    id: Number(p.id), tag: p.tag || null, mac: p.mac, name: p.name, group_name: p.group_name, ip: p.ip, model: p.model,
    protocol: p.protocol, http_port: p.http_port, sort_order: p.sort_order,
    schedule_mode: p.schedule_mode, routine_id: p.routine_id === null ? null : Number(p.routine_id),
    own: {
      days: p.own_days || [], on_kind: p.own_on_kind, on_time: fmtTime(p.own_on_time), on_offset_min: p.own_on_offset_min,
      off_kind: p.own_off_kind, off_time: fmtTime(p.own_off_time), off_offset_min: p.own_off_offset_min,
    },
  };
}

async function configRows(client, siteId) {
  const { rows: plugs } = await client.query(
    'SELECT * FROM vc_plugs WHERE site_id = $1 AND archived_at IS NULL ORDER BY group_name NULLS LAST, sort_order, tag NULLS LAST, name NULLS LAST, id',
    [siteId]
  );
  const { rows: routines } = await client.query(
    'SELECT * FROM vc_light_routines WHERE site_id = $1 ORDER BY sort_order, name',
    [siteId]
  );
  const { rows: site } = await client.query('SELECT latitude, longitude FROM vc_sites WHERE id = $1', [siteId]);
  return {
    plugs: plugs.map(plugConfigOut),
    light_routines: routines.map(routineOut),
    location: site[0] && site[0].latitude !== null ? { latitude: site[0].latitude, longitude: site[0].longitude } : null,
  };
}

// The Pi found these on the network: new MACs become unnamed plugs, known
// ones get their current address. Archived plugs keep their address fresh
// but stay archived.
async function recordSeen(client, siteId, list) {
  let added = 0;
  let moved = 0;
  for (const d of (Array.isArray(list) ? list : []).slice(0, 500)) {
    const mac = normalizeMac(d.mac);
    if (!mac) continue;
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(String(d.ip || '')) ? String(d.ip) : null;
    const protocol = d.protocol === 'klap' || d.protocol === 'xor' ? d.protocol : null;
    const httpPort = Number.isInteger(Number(d.http_port)) && Number(d.http_port) > 0 ? Number(d.http_port) : null;
    const { rows } = await client.query(
      `INSERT INTO vc_plugs (site_id, mac, ip, model, protocol, http_port, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (site_id, mac) DO UPDATE SET
         ip = COALESCE(EXCLUDED.ip, vc_plugs.ip),
         model = COALESCE(EXCLUDED.model, vc_plugs.model),
         protocol = COALESCE(EXCLUDED.protocol, vc_plugs.protocol),
         http_port = COALESCE(EXCLUDED.http_port, vc_plugs.http_port),
         last_seen_at = now(),
         updated_at = CASE WHEN vc_plugs.ip IS DISTINCT FROM COALESCE(EXCLUDED.ip, vc_plugs.ip) THEN now() ELSE vc_plugs.updated_at END
       RETURNING (xmax = 0) AS inserted, ip`,
      [siteId, mac, ip, cleanText(d.model, 40), protocol, httpPort]
    );
    if (rows[0] && rows[0].inserted) added += 1;
    else if (ip) moved += 1;
  }
  return { added, seen: moved };
}

async function recordStatus(client, siteId, states) {
  for (const s of (Array.isArray(states) ? states : []).slice(0, 500)) {
    if (!Number.isInteger(Number(s.id)) || !s.reachable) continue;
    await client.query(
      `UPDATE vc_plugs SET last_on = $3, last_watts = $4, last_seen_at = now() WHERE id = $1 AND site_id = $2`,
      [Number(s.id), siteId, !!s.on, s.watts === null || s.watts === undefined || !Number.isFinite(Number(s.watts)) ? null : Number(s.watts)]
    );
  }
}

// A group used on a plug is kept on the bar's list to pick from next time.
// Matching ignores case, so "main bar" lands on "Main Bar".
async function rememberGroup(client, siteId, group) {
  if (!group) return group;
  const { rows } = await client.query('SELECT light_groups FROM vc_sites WHERE id = $1 FOR UPDATE', [siteId]);
  const saved = (rows[0] && rows[0].light_groups) || [];
  const same = saved.find((g) => g.toLowerCase() === group.toLowerCase());
  if (same) return same;
  await client.query('UPDATE vc_sites SET light_groups = array_append(light_groups, $2) WHERE id = $1', [siteId, group]);
  return group;
}

async function groupsFor(client, siteId) {
  const { rows } = await client.query(
    `SELECT g AS name,
            (SELECT count(*)::int FROM vc_plugs p WHERE p.site_id = $1 AND p.archived_at IS NULL AND p.group_name = g) AS plugs
       FROM (SELECT unnest(light_groups) AS g FROM vc_sites WHERE id = $1
             UNION
             SELECT group_name FROM vc_plugs WHERE site_id = $1 AND group_name IS NOT NULL) x
      ORDER BY lower(g)`,
    [siteId]
  );
  return rows;
}

// Take a group off the list to pick from. One with plugs still in it stays.
async function forgetGroup(client, siteId, name) {
  const group = cleanText(name);
  if (!group) throw fail('Which group?');
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM vc_plugs WHERE site_id = $1 AND archived_at IS NULL AND group_name = $2', [siteId, group]
  );
  if (rows[0].n) throw fail(`${rows[0].n} plug${rows[0].n === 1 ? ' is' : 's are'} still in ${group}. Move ${rows[0].n === 1 ? 'it' : 'them'} first.`);
  await client.query('UPDATE vc_sites SET light_groups = array_remove(light_groups, $2) WHERE id = $1', [siteId, group]);
  await client.query('UPDATE vc_plugs SET group_name = NULL, updated_at = now() WHERE site_id = $1 AND group_name = $2', [siteId, group]);
}

async function listForAdmin(client, siteId) {
  const { rows: plugs } = await client.query(
    `SELECT * FROM vc_plugs WHERE site_id = $1
     ORDER BY archived_at IS NOT NULL, name IS NOT NULL, group_name NULLS LAST, sort_order, tag NULLS LAST, name, id`,
    [siteId]
  );
  const { rows: routines } = await client.query(
    'SELECT * FROM vc_light_routines WHERE site_id = $1 ORDER BY sort_order, name',
    [siteId]
  );
  const { rows: site } = await client.query('SELECT latitude, longitude FROM vc_sites WHERE id = $1', [siteId]);
  return {
    plugs: plugs.map((p) => ({
      ...plugConfigOut(p), last_on: p.last_on, last_watts: p.last_watts === null ? null : Number(p.last_watts),
      last_seen_at: p.last_seen_at, archived_at: p.archived_at, created_at: p.created_at,
    })),
    routines: routines.map(routineOut),
    groups: await groupsFor(client, siteId),
    location: site[0] || null,
  };
}

async function plugAt(client, siteId, plugId) {
  const { rows } = await client.query('SELECT * FROM vc_plugs WHERE id = $1 AND site_id = $2', [plugId, siteId]);
  return rows[0] || null;
}

async function routineAt(client, siteId, routineId) {
  const { rows } = await client.query('SELECT * FROM vc_light_routines WHERE id = $1 AND site_id = $2', [routineId, siteId]);
  return rows[0] || null;
}

// The plug's ID number for its sticker: the bar's prefix and the next number
// (T1-001, T1-002, ...). Handed out when a plug is named. Locking the site row
// keeps two at once from getting the same number; one the owner typed by hand
// is skipped over.
async function assignTag(client, siteId, plugId) {
  const { rows: [site] } = await client.query(
    'SELECT plug_tag_prefix, plug_tag_next FROM vc_sites WHERE id = $1 FOR UPDATE', [siteId]
  );
  const prefix = (site && site.plug_tag_prefix) || 'P';
  const { rows: taken } = await client.query('SELECT tag FROM vc_plugs WHERE site_id = $1 AND tag IS NOT NULL', [siteId]);
  const used = new Set(taken.map((r) => r.tag));
  let n = Math.max(1, Number(site && site.plug_tag_next) || 1);
  const tagFor = (k) => `${prefix}-${String(k).padStart(3, '0')}`;
  while (used.has(tagFor(n))) n += 1;
  await client.query('UPDATE vc_sites SET plug_tag_next = $2 WHERE id = $1', [siteId, n + 1]);
  const { rows } = await client.query(
    'UPDATE vc_plugs SET tag = $3, updated_at = now() WHERE id = $1 AND site_id = $2 AND tag IS NULL RETURNING *',
    [plugId, siteId, tagFor(n)]
  );
  return rows[0] || plugAt(client, siteId, plugId);
}

function parseTag(v) {
  const t = String(v || '').trim().toUpperCase().replace(/\s+/g, '-');
  if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(t)) throw fail('An ID is letters, numbers and dashes, like T1-004.');
  return t;
}

// Pre-register by MAC (from the Kasa app's Device Info), named up front.
async function addByMac(client, siteId, b) {
  const mac = normalizeMac(b.mac);
  if (!mac) throw fail('That MAC address doesn’t look right. It’s 12 characters, like A8:42:A1:12:34:56.');
  const name = cleanText(b.name);
  if (!name) throw fail('Give the plug a name.');
  const { rows } = await client.query(
    `INSERT INTO vc_plugs (site_id, mac, name, group_name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, mac) DO UPDATE SET name = EXCLUDED.name, group_name = COALESCE(EXCLUDED.group_name, vc_plugs.group_name),
       archived_at = NULL, updated_at = now()
     RETURNING *`,
    [siteId, mac, name, await rememberGroup(client, siteId, cleanText(b.group))]
  );
  return rows[0].tag ? rows[0] : assignTag(client, siteId, rows[0].id);
}

// Name, group, order, and/or schedule. Schedule: { mode: 'routine' |
// 'own' | 'none', routineId, ...own schedule fields }.
async function updatePlug(client, siteId, plugId, b) {
  const plug = await plugAt(client, siteId, plugId);
  if (!plug) throw fail('Not found.', 404);
  const sets = [];
  const vals = [];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length + 2}`); };
  if (b.name !== undefined) { const n = cleanText(b.name); if (!n) throw fail('Give the plug a name.'); set('name', n); }
  if (b.group !== undefined) set('group_name', await rememberGroup(client, siteId, cleanText(b.group)));
  if (b.tag !== undefined && b.tag !== null && String(b.tag).trim() !== (plug.tag || '')) {
    const tag = parseTag(b.tag);
    const { rows: dup } = await client.query(
      'SELECT name FROM vc_plugs WHERE site_id = $1 AND tag = $2 AND id <> $3', [siteId, tag, plugId]
    );
    if (dup[0]) throw fail(`${tag} is already ${dup[0].name || 'another plug'}.`);
    set('tag', tag);
  }
  if (b.sortOrder !== undefined && Number.isInteger(Number(b.sortOrder))) set('sort_order', Number(b.sortOrder));
  if (b.schedule !== undefined) {
    const s = b.schedule || {};
    if (s.mode === 'routine') {
      const r = await routineAt(client, siteId, Number(s.routineId));
      if (!r) throw fail('Pick a routine.');
      set('schedule_mode', 'routine'); set('routine_id', r.id);
    } else if (s.mode === 'own') {
      const p = parseSchedule(s);
      set('schedule_mode', 'own'); set('routine_id', null);
      set('own_days', p.days); set('own_on_kind', p.on_kind); set('own_on_time', p.on_time); set('own_on_offset_min', p.on_offset_min);
      set('own_off_kind', p.off_kind); set('own_off_time', p.off_time); set('own_off_offset_min', p.off_offset_min);
    } else if (s.mode === 'none') {
      set('schedule_mode', 'none'); set('routine_id', null);
    } else {
      throw fail('Pick how this plug is scheduled.');
    }
  }
  let row = plug;
  if (sets.length) {
    const { rows } = await client.query(
      `UPDATE vc_plugs SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND site_id = $2 RETURNING *`,
      [plugId, siteId, ...vals]
    );
    row = rows[0];
  }
  return row.name && !row.tag ? assignTag(client, siteId, plugId) : row;
}

async function setArchived(client, siteId, plugId, archived) {
  const { rows } = await client.query(
    `UPDATE vc_plugs SET archived_at = ${archived ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1 AND site_id = $2 RETURNING *`,
    [plugId, siteId]
  );
  if (!rows[0]) throw fail('Not found.', 404);
  return rows[0];
}

async function deletePlug(client, siteId, plugId) {
  const { rows } = await client.query('DELETE FROM vc_plugs WHERE id = $1 AND site_id = $2 RETURNING id', [plugId, siteId]);
  if (!rows[0]) throw fail('Not found.', 404);
}

// A routine and which plugs follow it (plugIds replaces the list).
async function saveRoutine(client, siteId, routineId, b) {
  const name = cleanText(b.name);
  if (!name) throw fail('Give the routine a name.');
  const s = parseSchedule(b);
  let row;
  if (routineId) {
    const { rows } = await client.query(
      `UPDATE vc_light_routines SET name = $3, days = $4, on_kind = $5, on_time = $6, on_offset_min = $7,
         off_kind = $8, off_time = $9, off_offset_min = $10, enabled = $11, updated_at = now()
       WHERE id = $1 AND site_id = $2 RETURNING *`,
      [routineId, siteId, name, s.days, s.on_kind, s.on_time, s.on_offset_min, s.off_kind, s.off_time, s.off_offset_min, b.enabled !== false]
    );
    if (!rows[0]) throw fail('Not found.', 404);
    row = rows[0];
  } else {
    const { rows } = await client.query(
      `INSERT INTO vc_light_routines (site_id, name, days, on_kind, on_time, on_offset_min, off_kind, off_time, off_offset_min, enabled, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         COALESCE((SELECT max(sort_order) + 1 FROM vc_light_routines WHERE site_id = $1), 0))
       RETURNING *`,
      [siteId, name, s.days, s.on_kind, s.on_time, s.on_offset_min, s.off_kind, s.off_time, s.off_offset_min, b.enabled !== false]
    );
    row = rows[0];
  }
  if (Array.isArray(b.plugIds)) {
    const ids = b.plugIds.map(Number).filter(Number.isInteger);
    await client.query(
      `UPDATE vc_plugs SET schedule_mode = 'none', routine_id = NULL, updated_at = now()
       WHERE site_id = $1 AND routine_id = $2 AND NOT (id = ANY($3::bigint[]))`,
      [siteId, row.id, ids]
    );
    await client.query(
      `UPDATE vc_plugs SET schedule_mode = 'routine', routine_id = $2, updated_at = now()
       WHERE site_id = $1 AND id = ANY($3::bigint[])`,
      [siteId, row.id, ids]
    );
  }
  return routineOut(row);
}

async function deleteRoutine(client, siteId, routineId) {
  await client.query(
    `UPDATE vc_plugs SET schedule_mode = 'none', routine_id = NULL, updated_at = now() WHERE site_id = $1 AND routine_id = $2`,
    [siteId, routineId]
  );
  const { rows } = await client.query('DELETE FROM vc_light_routines WHERE id = $1 AND site_id = $2 RETURNING id', [routineId, siteId]);
  if (!rows[0]) throw fail('Not found.', 404);
}

module.exports = {
  normalizeMac, assignTag, forgetGroup, configRows, recordSeen, recordStatus, listForAdmin, plugAt, addByMac, updatePlug,
  setArchived, deletePlug, saveRoutine, deleteRoutine,
};
