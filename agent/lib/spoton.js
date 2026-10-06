// SpotOn's reports site (restaurantreports.spoton.com), read the way a
// manager's browser reads it: a headless Chromium on this box signs in
// through Okta, stays signed in, opens a report page and we keep the data
// the page loads in the background (JSON). Used by lib/kitchen.js every
// 5 minutes and by tools/spoton-test.js.
//
// SPOTON_USER / SPOTON_PASS in .env. The session is kept in
// .spoton-session.json so a restart doesn't sign in again. Nothing here
// is ever shown on a screen; lib/kitchen.js sends the rows to the cloud.
const fs = require('fs');
const path = require('path');

const SITE = process.env.SPOTON_SITE || 'https://restaurantreports.spoton.com';
const SESSION_FILE = path.join(process.cwd(), '.spoton-session.json');
const USER = process.env.SPOTON_USER || '';
const PASS = process.env.SPOTON_PASS || '';

function enabled() { return !!(USER && PASS); }

function findChromium() {
  for (const c of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium', '/opt/pw-browsers/chromium', '/snap/bin/chromium']) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function dateParam(when, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(when).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day}-${p.year}`;
}

function reportUrl(template, locationKey, start, end) {
  return `${SITE}/restaurant-reporting/interactive-reports/${template}/?location_key=${locationKey}&startDate=${start}&endDate=${end || start}`;
}

async function settle(page, ms) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function visible(page, selectors) {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function onSignInPage(page) {
  if (/\/login\b|okta|\/signin/i.test(page.url())) return true;
  if (/sign in/i.test(await page.title().catch(() => ''))) return true;
  return !!(await visible(page, ['input[type="password"]', 'input[name="identifier"]', '#okta-sign-in input']));
}

async function waitForForm(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const box = await visible(page, ['input[name="identifier"]', 'input[type="email"]', 'input[type="password"]', 'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="email" i]']);
    if (box) return box;
    await page.waitForTimeout(500);
  }
  return null;
}

async function clickIf(page, list) {
  for (const s of list) {
    const loc = s.startsWith('text=') ? page.getByText(new RegExp(s.slice(5), 'i')).first() : page.locator(s).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) { await loc.click().catch(() => {}); return s; }
  }
  return null;
}

async function alerts(page) {
  return page.$$eval('[role="alert"], .o-form-error-container, .infobox-error', (els) => els.map((e) => e.innerText.trim()).filter(Boolean).join(' | ')).catch(() => '');
}

// Okta: email and password (together or one after the other), then maybe
// a code. `askCode` (optional) is asked for a code when Okta wants one;
// without it a code request is a failure (the collector can't type one).
async function signIn(page, { askCode, log = () => {} } = {}) {
  log(`sign-in page: ${page.url().split('?')[0]}`);
  const box = await waitForForm(page, 25000);
  if (!box) throw new Error('SpotOn sign-in form did not appear.');
  const passNow = await visible(page, ['input[type="password"]']);
  if (!passNow || (await box.getAttribute('type')) !== 'password') {
    await box.fill(USER);
    if (passNow) {
      await passNow.fill(PASS);
      const remember = await visible(page, ['input[name="rememberMe"]', 'input[type="checkbox"]']);
      if (remember && !(await remember.isChecked().catch(() => true))) await remember.check().catch(() => {});
    }
    if (!(await clickIf(page, ['input[type="submit"]', 'button[type="submit"]', 'text=^next$', 'text=^sign in$']))) await (passNow || box).press('Enter');
    await settle(page, 8000);
    for (let i = 0; i < 30 && (await visible(page, ['input[type="password"]'])) && !(await alerts(page)); i += 1) await page.waitForTimeout(1000);
    const a = await alerts(page);
    if (a) log(`Okta says: ${a}`);
  }
  if (!passNow) {
    const pb = await waitForForm(page, 15000);
    const pw = pb && (await pb.getAttribute('type')) === 'password' ? pb : await visible(page, ['input[type="password"]']);
    if (pw) {
      await pw.fill(PASS);
      if (!(await clickIf(page, ['input[type="submit"]', 'button[type="submit"]', 'text=^verify$', 'text=^sign in$']))) await pw.press('Enter');
      await settle(page, 10000);
    }
  }
  for (let round = 0; round < 2; round += 1) {
    let code = await visible(page, ['input[autocomplete="one-time-code"]', 'input[name*="passcode" i]', 'input[name*="code" i]', 'input[inputmode="numeric"]']);
    if (code && (await visible(page, ['input[type="password"]']))) code = null;
    if (!code) {
      if (await visible(page, ['input[type="password"]'])) break;
      const picked = await clickIf(page, ['text=^email$|^email\\b|verify with your email|email me', 'text=text message|sms|phone']);
      if (!picked) break;
      await settle(page, 6000);
      await clickIf(page, ['text=send me|send code|send an email|send']);
      await settle(page, 6000);
      code = await visible(page, ['input[autocomplete="one-time-code"]', 'input[name*="passcode" i]', 'input[name*="code" i]', 'input[inputmode="numeric"]']);
      if (!code) break;
    }
    if (!askCode) throw new Error('SpotOn asked for a sign-in code; the box cannot answer one. Sign in once with tools/spoton-test.js.');
    const c = await askCode();
    await code.fill(c);
    if (!(await clickIf(page, ['input[type="submit"]', 'button[type="submit"]', 'text=^verify$']))) await code.press('Enter');
    await settle(page, 10000);
    if (!(await onSignInPage(page))) break;
  }
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await settle(page, 8000);
  if (await onSignInPage(page)) {
    const msg = ((await page.evaluate(() => document.body.innerText).catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`SpotOn sign-in did not go through: ${msg || page.url().split('?')[0]}`);
  }
}

// A signed-in browser session. open() once; fetchReport() as often as
// needed; close() on shutdown. Signs in again by itself when bounced.
class Session {
  constructor({ log = () => {}, askCode = null } = {}) { this.log = log; this.askCode = askCode; this.browser = null; this.ctx = null; this.page = null; this.captured = []; }

  async open() {
    if (!enabled()) throw new Error('SPOTON_USER / SPOTON_PASS are not set in agent/.env.');
    const exe = findChromium();
    if (!exe) throw new Error('No Chromium on this box (sudo apt-get install -y chromium).');
    const { chromium } = require('playwright-core');
    this.browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    this.ctx = await this.browser.newContext({
      storageState: fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined,
      viewport: { width: 1400, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    });
    this.page = await this.ctx.newPage();
    this.page.on('response', async (res) => {
      try {
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        const url = res.url();
        if (!/json/.test(ct) && !/\/api\/|\/graphql/.test(url)) return;
        const text = await res.text().catch(() => '');
        if (!text || text.length > 8 * 1024 * 1024) return;
        let body;
        try { body = JSON.parse(text); } catch (e) { return; }
        this.captured.push({ url, status: res.status(), size: text.length, body, at: Date.now() });
      } catch (e) { /* ignore */ }
    });
    this.browser.on('disconnected', () => { this.browser = null; });
    return this;
  }

  async ensureSignedIn() {
    if (!this.browser) await this.open();
    await this.page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(this.page, 6000);
    if (await onSignInPage(this.page)) {
      this.log('signing in to SpotOn');
      await signIn(this.page, { askCode: this.askCode, log: this.log });
    }
    await this.ctx.storageState({ path: SESSION_FILE });
  }

  // Opens one report page and returns the JSON responses it loaded.
  // start/end: MM-DD-YYYY (end defaults to start).
  async fetchReport(template, locationKey, start, end, { retrySignIn = true } = {}) {
    if (!this.browser) await this.open();
    this.captured = [];
    await this.page.goto(reportUrl(template, locationKey, start, end), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(this.page, 12000);
    if (await onSignInPage(this.page)) {
      if (!retrySignIn) throw new Error('SpotOn bounced the report page to sign-in.');
      await this.ensureSignedIn();
      return this.fetchReport(template, locationKey, start, end, { retrySignIn: false });
    }
    return this.captured.slice();
  }

  async close() {
    try { if (this.ctx) await this.ctx.storageState({ path: SESSION_FILE }); } catch (e) { /* ignore */ }
    try { if (this.browser) await this.browser.close(); } catch (e) { /* ignore */ }
    this.browser = null;
  }
}

// ---- Picking the numbers out of what the pages loaded -------------------

// Employee Time rows: the /api/reports/... reply, [{ query, data: [rows] }].
function employeeTimeRows(captured) {
  for (const c of captured) {
    if (!/\/api\/reports\//.test(c.url) || !Array.isArray(c.body)) continue;
    const part = c.body.find((p) => p && Array.isArray(p.data) && (!p.query || /employeetime|time-clock/i.test(p.query.templateName || '')));
    if (part) return part.data;
  }
  return null;
}

// Daily Sales Recap: the graphql reply with data.reports.data[0].
function dsrData(captured) {
  for (const c of captured) {
    const d = c.body && c.body.data && c.body.data.reports;
    if (d && Array.isArray(d.data) && d.data[0]) return d.data[0];
  }
  return null;
}

// Hourly Sales: whichever reply carries rows with an hour in them.
function hourlyRows(captured) {
  for (const c of captured) {
    const b = c.body;
    const parts = Array.isArray(b) ? b : (b && b.data && b.data.reports && Array.isArray(b.data.reports.data)) ? b.data.reports.data : null;
    if (!parts) continue;
    for (const p of parts) {
      const rows = Array.isArray(p.data) ? p.data : Array.isArray(p) ? p : null;
      if (rows && rows.length && Object.keys(rows[0]).some((k) => /hour/i.test(k))) return rows;
    }
  }
  return null;
}

module.exports = { enabled, Session, signIn, settle, onSignInPage, dateParam, reportUrl, LOCATION_KEY: process.env.SPOTON_LOCATION_KEY || '1215273229887737856', employeeTimeRows, dsrData, hourlyRows, SITE, SESSION_FILE, findChromium };
