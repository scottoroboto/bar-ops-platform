require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { pool } = require('./db');
const auth = require('./auth');
const employees = require('./employees');
const timeclock = require('./timeclock');
const servicecalls = require('./servicecalls');
const notify = require('./notify');
const jotform = require('./jotform');

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

// ---------------- Devices (shared bar iPads) ----------------
app.post('/api/devices', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const { locationId, label } = req.body;
  const token = crypto.randomBytes(24).toString('base64url');
  await pool.query(
    'INSERT INTO devices (location_id, label, device_token, trusted_by) VALUES ($1,$2,$3,$4)',
    [locationId, label, token, req.person.id]
  );
  res.json({ ok: true, deviceToken: token });
});

// ---------------- Employees (owner/manager) ----------------
app.get('/api/employees/pending', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  res.json(await employees.listPending());
});

app.post('/api/employees/pending', async (req, res) => {
  // Manual fallback for adding someone to pending review without going
  // through Jotform (e.g. testing, or a hire that comes in some other way).
  // The real path is the webhook below, which Jotform calls on every New
  // Hire Information submission.
  const person = await employees.createPendingEmployee(req.body);
  res.json({ ok: true, person });
});

// Jotform calls this on every submission of the "Ticket Sports Bar New Hire
// Information" form. See server/jotform.js for what is (and very much is
// not) read out of the submission.
app.post('/api/webhooks/jotform-new-hire', jotform.parseBody, jotform.handleWebhook);

app.post('/api/employees/:id/manager-review', auth.requireSession('full'), async (req, res) => {
  if (req.person.role !== 'manager' && req.person.role !== 'owner') return res.status(403).json({ error: 'Managers/owners only.' });
  const result = await employees.managerReview({ personId: req.params.id, ...req.body, reviewedBy: req.person.id });
  res.json(result);
});

app.get('/api/employees', auth.requireSession('light'), async (req, res) => {
  if (req.person.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
  res.json(await employees.listAllWithAccess());
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
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() < 5) {
    const client = await pool.connect();
    try {
      const n = await timeclock.autoClockOutStale(client);
      if (n > 0) console.log(`Auto clocked out ${n} stale shift(s).`);
    } finally {
      client.release();
    }
  }
}, 4 * 60 * 1000);
