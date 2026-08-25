require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { pool, withServiceClient } = require('./db');
const auth = require('./auth');
const employees = require('./employees');
const timeclock = require('./timeclock');
const servicecalls = require('./servicecalls');
const notify = require('./notify');
const jotform = require('./jotform');
const resetRequests = require('./resetRequests');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------------- Status ----------------
app.get('/api/status', (req, res) => {
  res.json({ ok: true, emailConfigured: notify.emailConfigured(), smsConfigured: notify.smsConfigured() });
});

app.get('/api/locations', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM locations WHERE active = true ORDER BY name');
  res.json(rows);
});

// Admin view — includes archived locations too, so the owner can restore
// one. Everyday reads (apply.html, review dropdowns, etc.) use the public
// active-only route above instead.
app.get('/api/locations/admin', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
  const { rows } = await pool.query('SELECT * FROM locations ORDER BY active DESC, name');
  res.json(rows);
});

// Locations are owner-only to add/rename/archive — per Scotto: the owner
// is the one who decides what counts as a real location. Managers manage
// positions instead (below).
// Writes below go through withServiceClient (bypasses RLS via the
// barplatform_service role) rather than the plain pool. locations/positions
// only have an open SELECT policy for barplatform_app — reads work fine
// through the ordinary pool, but RLS is FORCE-enabled with no INSERT/
// UPDATE/DELETE policy, so a write on the plain app connection is silently
// rejected (or matches zero rows). Authorization is still enforced right
// here in the handler, same as everywhere else service-client writes are used.
app.post('/api/locations', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can add a location.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  try {
    const location = await withServiceClient(async (client) => {
      const { rows } = await client.query('INSERT INTO locations (name) VALUES ($1) RETURNING *', [name]);
      return rows[0];
    });
    res.json({ ok: true, location });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'A location with that name already exists.' });
    throw e;
  }
});

app.post('/api/locations/:id/update', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can rename a location.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  try {
    const location = await withServiceClient(async (client) => {
      const { rows } = await client.query('UPDATE locations SET name = $1 WHERE id = $2 RETURNING *', [name, req.params.id]);
      return rows[0];
    });
    if (!location) return res.status(404).json({ ok: false, error: 'Not found.' });
    res.json({ ok: true, location });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'A location with that name already exists.' });
    throw e;
  }
});

// Archive/restore rather than delete — a location can be referenced by
// years of time-clock and service-call history; hard-deleting it would
// either cascade-destroy that history or fail on the foreign key. Archived
// locations just drop out of the active dropdowns everywhere else.
app.post('/api/locations/:id/archive', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can archive a location.' });
  const location = await withServiceClient(async (client) => {
    const { rows } = await client.query('UPDATE locations SET active = false WHERE id = $1 RETURNING *', [req.params.id]);
    return rows[0];
  });
  if (!location) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.json({ ok: true, location });
});

app.post('/api/locations/:id/restore', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can restore a location.' });
  const location = await withServiceClient(async (client) => {
    const { rows } = await client.query('UPDATE locations SET active = true WHERE id = $1 RETURNING *', [req.params.id]);
    return rows[0];
  });
  if (!location) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.json({ ok: true, location });
});

// ---------------- Positions ----------------
// Public, active-only — used by /apply.html's "Position Applied for"
// dropdown (?excludeManagement=true, nobody self-applies to be a manager)
// and by the Review employee dropdown (no filter, managers can review
// someone straight into a management position).
app.get('/api/positions', async (req, res) => {
  const excludeManagement = req.query.excludeManagement === 'true';
  const { rows } = await pool.query(
    `SELECT * FROM positions WHERE active = true ${excludeManagement ? 'AND is_management = false' : ''} ORDER BY name`
  );
  res.json(rows);
});

// Admin view — includes archived positions too, so a manager/owner can
// restore one.
app.get('/api/positions/admin', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const { rows } = await pool.query('SELECT * FROM positions ORDER BY active DESC, name');
  res.json(rows);
});

// Positions are manager+owner — per Scotto, managers should be able to
// add positions themselves (this'll likely move into the Scheduling app
// once that exists; for now it lives here in Employees admin).
app.post('/api/positions', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  try {
    const position = await withServiceClient(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO positions (name, is_management) VALUES ($1,$2) RETURNING *',
        [name, !!req.body.isManagement]
      );
      return rows[0];
    });
    res.json({ ok: true, position });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'A position with that name already exists.' });
    throw e;
  }
});

app.post('/api/positions/:id/update', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  try {
    const position = await withServiceClient(async (client) => {
      const { rows } = await client.query(
        'UPDATE positions SET name = $1, is_management = $2 WHERE id = $3 RETURNING *',
        [name, !!req.body.isManagement, req.params.id]
      );
      return rows[0];
    });
    if (!position) return res.status(404).json({ ok: false, error: 'Not found.' });
    res.json({ ok: true, position });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'A position with that name already exists.' });
    throw e;
  }
});

// Archive/restore rather than delete — position is stored as plain text
// on people.position (not a foreign key), so archiving never orphans a
// historical employee record; it just drops the position out of future
// dropdowns.
app.post('/api/positions/:id/archive', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const position = await withServiceClient(async (client) => {
    const { rows } = await client.query('UPDATE positions SET active = false WHERE id = $1 RETURNING *', [req.params.id]);
    return rows[0];
  });
  if (!position) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.json({ ok: true, position });
});

app.post('/api/positions/:id/restore', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const position = await withServiceClient(async (client) => {
    const { rows } = await client.query('UPDATE positions SET active = true WHERE id = $1 RETURNING *', [req.params.id]);
    return rows[0];
  });
  if (!position) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.json({ ok: true, position });
});

// ---------------- Auth ----------------
app.post('/api/auth/login-password', async (req, res) => {
  const result = await auth.loginWithPassword(req.body);
  res.json(result);
});
app.post('/api/auth/verify-code', async (req, res) => {
  const result = await auth.verifyFirstLoginCode(req.body);
  res.json(result);
});
app.post('/api/auth/login-pin', async (req, res) => {
  const result = await auth.loginWithPin(req.body);
  res.json(result);
});
app.post('/api/auth/step-up', async (req, res) => {
  const result = await auth.stepUp(req.body);
  res.json(result);
});
app.post('/api/auth/set-pin', auth.requireSession('full'), async (req, res) => {
  const result = await auth.setPin({ personId: req.person.id, pin: req.body.pin });
  res.json(result);
});
app.get('/api/auth/me', auth.requireSession('light'), async (req, res) => {
  const access = await req.withAuthedClient(async (client) => {
    const { rows } = await client.query('SELECT app_key, enabled FROM employee_apps WHERE person_id = $1', [req.person.id]);
    return rows;
  });
  res.json({ person: req.person, appAccess: access });
});

// Public, unauthenticated — the whole point is this works for someone who
// can't log in. Owner-mediated fallback: files a request, the owner
// reviews and approves it from Employees admin, no email/SMS required.
// See server/resetRequests.js and db/patch_009 for the full reasoning.
app.post('/api/auth/request-reset', async (req, res) => {
  const result = await resetRequests.requestReset(req.body);
  res.json(result);
});

// Owner-only — same trust boundary as activation/credential issuance.
app.get('/api/reset-requests', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
  res.json(await resetRequests.listResetRequests({ status: req.query.status || 'pending' }));
});

// Full session required — approving mints a brand-new password/PIN, same
// sensitivity tier as employee activation.
app.post('/api/reset-requests/:id/decide', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
  const result = await resetRequests.decideReset({ requestId: req.params.id, approve: !!req.body.approve, decidedBy: req.person.id, note: req.body.note });
  res.json(result);
});

// ---------------- Devices (shared bar iPads) ----------------
app.post('/api/devices', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const { locationId, label } = req.body;
  const token = crypto.randomBytes(24).toString('base64url');
  // devices has RLS FORCE-enabled with no policy at all for barplatform_app,
  // so this insert has to go through the service role — same reasoning as
  // the locations/positions writes above.
  await withServiceClient((client) => client.query(
    'INSERT INTO devices (location_id, label, device_token, trusted_by) VALUES ($1,$2,$3,$4)',
    [locationId, label, token, req.person.id]
  ));
  res.json({ ok: true, deviceToken: token });
});

// ---------------- Employees (owner/manager) ----------------
app.get('/api/employees/pending', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await employees.listPending());
});

// Public, unauthenticated — this is what /apply.html submits to. New hires
// enter their basic info here, right in the app, then get sent to the
// separate Jotform "hire pack" for the sensitive tax/banking half. The
// Jotform webhook below is a secondary/optional intake path, not the
// primary one.
app.post('/api/employees/pending', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  const position = (req.body.position || '').trim() || null;
  const person = await employees.createPendingEmployee({ ...req.body, name, position });
  res.json({ ok: true, person });
});

// Jotform calls this on every submission of the "Ticket Sports Bar New Hire
// Information" form, if/when that gets wired up as a secondary intake path.
// See server/jotform.js for what is (and very much is not) read out of the
// submission.
app.post('/api/webhooks/jotform-new-hire', jotform.parseBody, jotform.handleWebhook);

// Self-service profile edit — any logged-in person, any time, for their own
// row only (req.person.id, never a client-supplied id). Sensitive fields
// (tax/banking/SSN) aren't here; those stay in Jotform's hire-pack form.
app.post('/api/me/profile', auth.requireSession('light'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  const person = await employees.updateOwnProfile({ personId: req.person.id, name, email: req.body.email, phone: req.body.phone });
  res.json({ ok: true, person });
});

app.post('/api/employees/:id/manager-review', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const result = await employees.managerReview({ personId: req.params.id, ...req.body, reviewedBy: req.person.id });
  res.json(result);
});

// Discard/reject a still-pending applicant — never touches anyone already
// activated (see discardPending's own WHERE clause).
app.post('/api/employees/:id/discard', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const result = await employees.discardPending({ personId: req.params.id });
  res.json(result);
});

// Emails a link to /apply.html to someone who hasn't applied yet.
app.post('/api/employees/invite', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const toEmail = (req.body.email || '').trim();
  if (!toEmail) return res.status(400).json({ ok: false, error: 'Email is required.' });
  const result = await employees.sendOnboardingInvite({ toEmail, toName: (req.body.name || '').trim() || null, sentBy: req.person.id });
  res.json(result);
});

// A manager sees only their own location's roster; the owner sees everyone.
app.get('/api/employees', auth.requireSession('light'), async (req, res) => {
  if (req.person.role === 'owner') return res.json(await employees.listAllWithAccess());
  if (req.person.role === 'manager') return res.json(await employees.listAllWithAccess(req.person.location_id));
  return res.status(403).json({ error: 'Managers/owners only.' });
});

app.post('/api/employees/:id/activate', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can activate an employee.' });
  const result = await employees.activateEmployee({ personId: req.params.id, appAccess: req.body.appAccess, activatedBy: req.person.id });
  res.json(result);
});

app.post('/api/employees/:id/app-access', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change app access.' });
  const result = await employees.setAppAccess({ personId: req.params.id, appKey: req.body.appKey, enabled: req.body.enabled, updatedBy: req.person.id });
  res.json(result);
});

// Owner-only full edit — position/location/pay rate, any time, any employee.
app.post('/api/employees/:id/update', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can edit an employee directly.' });
  const { position, locationId, payRate } = req.body;
  const result = await employees.ownerUpdateEmployee({ personId: req.params.id, position, locationId, payRate: payRate === '' || payRate == null ? null : Number(payRate) });
  res.json(result);
});

// A manager can't set pay directly — this files a request the owner decides.
app.post('/api/employees/:id/request-raise', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const requestedRate = Number(req.body.requestedRate);
  if (!requestedRate || requestedRate <= 0) return res.status(400).json({ ok: false, error: 'Enter a valid pay rate.' });
  const result = await employees.requestPayRaise({ personId: req.params.id, requestedRate, requestedBy: req.person.id });
  res.json(result);
});

// A manager sees only pending requests for their own location; the owner
// sees every pending request, across locations.
app.get('/api/pay-rate-requests', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const locationFilter = req.person.role === 'manager' ? req.person.location_id : undefined;
  res.json(await employees.listPayRateRequests({ status: req.query.status || 'pending', locationFilter }));
});

app.post('/api/pay-rate-requests/:id/decide', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Only the owner can decide pay rate requests.' });
  const result = await employees.decidePayRateRequest({ requestId: req.params.id, approve: !!req.body.approve, decidedBy: req.person.id, note: req.body.note });
  res.json(result);
});

// ---------------- Time Clock ----------------
app.get('/api/timeclock/status', auth.requireSession('light'), async (req, res) => {
  const result = await req.withAuthedClient((client) => timeclock.getStatus(client, req.person.id));
  res.json(result);
});
app.post('/api/timeclock/punch', auth.requireSession('light'), async (req, res) => {
  const result = await req.withAuthedClient((client) => timeclock.clockAction(client, req.person, req.body.action, req.body.memo, req.body.deviceId));
  res.json(result);
});
app.get('/api/timeclock/roster', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const result = await req.withAuthedClient((client) => timeclock.getRosterStatus(client));
  res.json(result);
});
app.get('/api/timeclock/pay-period', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const idx = req.query.periodIndex !== undefined ? Number(req.query.periodIndex) : undefined;
  const result = await req.withAuthedClient((client) => timeclock.getPayPeriod(client, idx));
  res.json(result);
});
app.post('/api/timeclock/punch/:id/edit', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const result = await req.withAuthedClient((client) => timeclock.editPunch(client, { id: req.params.id, ...req.body, editedBy: req.person.id }));
  res.json(result);
});
app.post('/api/timeclock/punch/:id/delete', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const result = await req.withAuthedClient((client) => timeclock.deletePunch(client, { id: req.params.id, reason: req.body.reason, editedBy: req.person.id }));
  res.json(result);
});

// ---------------- Service Calls ----------------
app.get('/api/servicecalls/equipment-types', auth.requireSession('light'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM equipment_types WHERE active = true ORDER BY name');
  res.json(rows);
});

app.get('/api/servicecalls', auth.requireSession('light'), async (req, res) => {
  const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
  const result = await req.withAuthedClient(async (client) => {
    if (!isManagerOrOwner) {
      const hasAccess = await servicecalls.requireServiceCallsAccess(client, req.person.id);
      if (!hasAccess) return { error: 'Service Calls isn’t turned on for your account yet — ask your manager.' };
    }
    const filters = {
      status: req.query.status, locationId: req.query.locationId, equipmentTypeId: req.query.equipmentTypeId,
      createdBy: req.query.createdBy, closedBy: req.query.closedBy, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
    };
    return servicecalls.listCalls(client, filters);
  });
  if (result && result.error) return res.status(403).json(result);
  res.json(result);
});

app.get('/api/servicecalls/report.csv', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const rows = await req.withAuthedClient((client) => servicecalls.listCalls(client, {
    status: req.query.status, locationId: req.query.locationId, equipmentTypeId: req.query.equipmentTypeId,
    createdBy: req.query.createdBy, closedBy: req.query.closedBy, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
  }));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="service_calls.csv"');
  res.send(servicecalls.toCsv(rows));
});

app.post('/api/servicecalls', auth.requireSession('light'), async (req, res) => {
  const result = await req.withAuthedClient((client) => servicecalls.createCall(client, req.person, req.body));
  res.json(result);
});

app.post('/api/servicecalls/:id/close', auth.requireSession('light'), async (req, res) => {
  const isManagerOrOwner = req.person.role === 'manager' || req.person.role === 'owner';
  const result = await req.withAuthedClient(async (client) => {
    if (!isManagerOrOwner) {
      const hasAccess = await servicecalls.requireServiceCallsAccess(client, req.person.id);
      if (!hasAccess) return { ok: false, error: 'Service Calls isn’t turned on for your account yet — ask your manager.' };
    }
    return servicecalls.closeCall(client, { id: req.params.id, closedBy: req.person.id, remedy: req.body.remedy });
  });
  res.json(result);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Bar platform listening on http://localhost:${PORT}`));

// Daily safety net, same idea as the Apps Script midnight trigger.
// Runs with no logged-in person, so it has to use the service client —
// a plain pool.connect() here (barplatform_app, no session vars set)
// silently matches zero rows under time_entries' RLS policies, which
// are scoped to current_person_id()/current_role_name(). That made this
// job a silent no-op: it looked fine (no errors, no crash), it just never
// actually closed out any stale shifts.
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() < 5) {
    await withServiceClient(async (client) => {
      const n = await timeclock.autoClockOutStale(client);
      if (n > 0) console.log(`Auto clocked out ${n} stale shift(s).`);
    });
  }
}, 4 * 60 * 1000);
