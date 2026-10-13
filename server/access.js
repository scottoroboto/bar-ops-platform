// One page per employee for everything the owner switches on or off
// (Oct 2026): apps, cash and inventory tiers, home widgets, morning
// summary, alert routes and per-category alert modes, scheduling
// qualifications, department, and the person's own settings read-only.
// Nothing here is new behavior; it gathers what the other modules already
// store and writes through their own functions, so every rule they
// enforce (owner-only, last-owner guard, SMS consent) still applies.
const { withServiceClient } = require('./db');
const employees = require('./employees');
const home = require('./home');
const summary = require('./summary');
const monitoring = require('./monitoring');
const cashhandling = require('./cashhandling');
const inventorycontrol = require('./inventorycontrol');
const scheduling = require('./scheduling');

const APPS = [
  ['time_clock', 'Time Clock'], ['scheduling', 'Scheduling'], ['service_calls', 'Service Calls'], ['monitoring', 'Systems Monitoring'],
  ['cash_handling', 'Cash Handling'], ['inventory_control', 'Inventory'], ['tv_staff', 'TV Staff'], ['amusement', 'Games'], ['employees', 'Employees (managers only)'],
];
const WIDGETS = [
  ['alerts', 'Alerts button'], ['network', 'Network'], ['bar_sales', 'Bar sales'], ['bar_labor', 'Bar labor %'], ['bar_staff', 'Bar staff on'], ['bar_coolers', 'Bar coolers'],
  ['kitchen_sales', 'Kitchen sales'], ['kitchen_labor', 'Kitchen labor %'], ['kitchen_staff', 'Kitchen staff on'], ['kitchen_coolers', 'Kitchen coolers'],
  ['applicants', 'Applicants'], ['games', 'Games not in SpotOn'], ['service_calls', 'Service calls open'],
];
const CASH_TIERS = [['no_access', 'No access'], ['own_drawer', 'Own drawer'], ['drawers_bags', 'Drawers and bags'], ['full_authority', 'Full authority']];
const INV_TIERS = [['no_access', 'No access'], ['counter', 'Counter'], ['lead', 'Lead'], ['full_authority', 'Full authority']];
const ALERT_CATEGORIES = [['network', 'Network'], ['av', 'TVs and AV'], ['refrigeration', 'Refrigeration'], ['freezer', 'Freezer'], ['ice_machine', 'Ice machine'], ['hvac', 'HVAC'], ['power', 'Power'], ['other', 'Other']];
const REACH = { staff: 'themselves only', manager: 'their own bar', maintenance: 'equipment and service calls at every bar', owner: 'everything' };

async function view(personId) {
  return withServiceClient(async (svc) => {
    const { rows: pr } = await svc.query(
      `SELECT p.id, p.name, p.role, p.status, p.position, p.pay_rate, p.location_id, p.email, p.phone, p.department,
              p.pin_hash IS NOT NULL AS has_pin, p.pin_locked_at, p.payroll_on_file, p.password_verified_at, p.password_locked_at, p.activated_at, p.created_at,
              ARRAY(SELECT el.location_id FROM employee_locations el WHERE el.person_id = p.id) AS location_ids
       FROM people p WHERE p.id = $1`, [personId]);
    const p = pr[0];
    if (!p) return null;
    const [{ rows: locs }, { rows: apps }, { rows: positions }, { rows: schedules }] = await Promise.all([
      svc.query('SELECT id, name FROM locations WHERE active = true ORDER BY name'),
      svc.query('SELECT app_key, enabled, expires_at FROM employee_apps WHERE person_id = $1', [personId]),
      svc.query('SELECT id, name, is_management FROM positions WHERE active = true ORDER BY name'),
      svc.query('SELECT s.id, s.name, s.location_id, l.name AS location_name FROM schedules s JOIN locations l ON l.id = s.location_id WHERE s.active = true ORDER BY l.name, s.name'),
    ]);
    const appMap = {};
    for (const [k] of APPS) { const a = apps.find((x) => x.app_key === k); appMap[k] = { enabled: !!(a && a.enabled && (!a.expires_at || new Date(a.expires_at) > new Date())), expiresAt: a && a.expires_at ? a.expires_at : null }; }

    // tiers: position default plus any override
    const cashDefaults = await cashhandling.getPositionDefaults(svc);
    const invDefaults = await inventorycontrol.getPositionDefaults(svc);
    const posRow = positions.find((x) => String(x.name).toLowerCase() === String(p.position || '').trim().toLowerCase()) || null;
    const cashDefault = posRow ? (cashDefaults.find((d) => d.position_id === posRow.id) || {}).tier || null : null;
    const invDefault = posRow ? (invDefaults.find((d) => d.position_id === posRow.id) || {}).tier || null : null;
    const cashOverride = await cashhandling.getAccessOverride(svc, personId);
    const invOverride = await inventorycontrol.getAccessOverride(svc, personId);
    const cashEffective = await cashhandling.getEffectiveCashTier(svc, personId);
    const invEffective = await inventorycontrol.getEffectiveInventoryTier(svc, personId);

    const lines = await home.getLines(personId);
    const summarySettings = await summary.settingsFor(personId);
    const { rows: lastSend } = await svc.query('SELECT created_at, email_status, sms_status, is_test FROM morning_summary_sends WHERE person_id = $1 ORDER BY created_at DESC LIMIT 1', [personId]);
    const notify = await monitoring.getNotifySettings(personId);
    const { rows: routes } = await svc.query('SELECT r.id, r.location_id, r.category, l.name AS location_name FROM monitoring_alert_routes r LEFT JOIN locations l ON l.id = r.location_id WHERE r.person_id = $1', [personId]);

    const [{ rows: es }, { rows: ep }, { rows: ms }, { rows: avail }, { rows: timeOff }, { rows: rem }, { rows: lastSession }] = await Promise.all([
      svc.query('SELECT schedule_id FROM employee_schedules WHERE person_id = $1', [personId]),
      svc.query('SELECT position_id FROM employee_positions WHERE person_id = $1', [personId]),
      svc.query('SELECT schedule_id FROM manager_schedules WHERE person_id = $1', [personId]),
      svc.query('SELECT day_of_week, start_time, end_time, note FROM availability WHERE person_id = $1 ORDER BY array_position(ARRAY[\'Sun\',\'Mon\',\'Tue\',\'Wed\',\'Thu\',\'Fri\',\'Sat\'], day_of_week), start_time', [personId]),
      svc.query(`SELECT start_date, end_date, status FROM time_off_requests WHERE person_id = $1 AND end_date >= current_date AND status <> 'denied' ORDER BY start_date LIMIT 5`, [personId]),
      svc.query('SELECT notify_channel, clock_in_enabled, clock_out_enabled FROM reminder_settings WHERE person_id = $1', [personId]),
      svc.query('SELECT created_at, session_tier, device_id FROM auth_sessions WHERE person_id = $1 ORDER BY created_at DESC LIMIT 1', [personId]),
    ]);

    return {
      person: { id: p.id, name: p.name, role: p.role, reach: REACH[p.role] || p.role, status: p.status, position: p.position, payRate: p.pay_rate, department: p.department, payrollOnFile: !!p.payroll_on_file, locationIds: (p.location_ids && p.location_ids.length ? p.location_ids : [p.location_id]).filter(Boolean), since: p.activated_at || p.created_at },
      locations: locs,
      apps: APPS.map(([key, label]) => ({ key, label, ...appMap[key], managerOnly: key === 'employees' })),
      tiers: {
        cash: { options: CASH_TIERS, positionDefault: cashDefault, override: cashOverride ? cashOverride.tier : null, effective: cashEffective },
        inventory: { options: INV_TIERS, positionDefault: invDefault, override: invOverride ? invOverride.tier : null, effective: invEffective },
      },
      widgets: WIDGETS.map(([key, label]) => ({ key, label, on: !!lines[key] })),
      summary: { enabled: summarySettings.enabled, sections: summarySettings.sections, sectionList: summarySettings.sectionList, dayNightCutoff: summarySettings.dayNightCutoff, lateAfterMin: summarySettings.lateAfterMin, channel: summarySettings.channel, sendHour: summarySettings.sendHour, last: lastSend[0] || null },
      alerts: {
        categories: ALERT_CATEGORIES.map(([key, label]) => ({ key, label, mode: notify.effective[key] })),
        routes: routes.map((r) => ({ id: r.id, locationId: r.location_id, locationName: r.location_name || 'Every bar', category: r.category })),
      },
      scheduling: {
        schedules: schedules.map((s) => ({ id: s.id, name: s.name, locationId: s.location_id, locationName: s.location_name, qualified: es.some((x) => x.schedule_id === s.id), manages: ms.some((x) => x.schedule_id === s.id) })),
        positions: positions.map((x) => ({ id: x.id, name: x.name, qualified: ep.some((y) => y.position_id === x.id) })),
        schedulingOn: appMap.scheduling.enabled,
      },
      own: {
        phone: p.phone || null, email: p.email || null,
        pin: p.pin_locked_at ? 'locked' : p.has_pin ? 'set' : 'not set',
        password: p.password_locked_at ? 'locked' : p.password_verified_at ? `verified ${p.password_verified_at}` : 'never signed in',
        lastSignIn: lastSession[0] ? { at: lastSession[0].created_at, tier: lastSession[0].session_tier, sharedDevice: !!lastSession[0].device_id } : null,
        notifyChannel: notify.notify_channel || 'email', smsConsentAt: notify.sms_consent_at || null, smsConsentPhone: notify.sms_consent_phone || null,
        reminders: rem[0] ? { clockIn: rem[0].clock_in_enabled, clockOut: rem[0].clock_out_enabled, channel: rem[0].notify_channel } : null,
        availability: avail.map((a) => ({ day: a.day_of_week, start: String(a.start_time).slice(0, 5), end: String(a.end_time).slice(0, 5), note: a.note })),
        timeOff: timeOff.map((t) => ({ start: t.start_date, end: t.end_date, status: t.status })),
      },
    };
  });
}

// Department for an active person (the applicant review sets it for
// pending ones).
async function setDepartment(personId, department) {
  if (department != null && !['bar', 'kitchen', 'both'].includes(department)) return { ok: false, error: 'Department is Bar, Kitchen or Both.' };
  return withServiceClient(async (svc) => {
    const { rowCount } = await svc.query('UPDATE people SET department = $2, updated_at = now() WHERE id = $1', [personId, department]);
    return rowCount ? { ok: true } : { ok: false, error: 'Not found.' };
  });
}

async function setPayrollOnFile(personId, onFile) {
  return withServiceClient(async (svc) => {
    const { rowCount } = await svc.query('UPDATE people SET payroll_on_file = $2, updated_at = now() WHERE id = $1', [personId, !!onFile]);
    return rowCount ? { ok: true } : { ok: false, error: 'Not found.' };
  });
}

module.exports = { view, setDepartment, setPayrollOnFile, APPS, WIDGETS };
