#!/usr/bin/env node
// Kitchen board, step 1 (T2 Kitchen Display spec, Oct 2026): prove this box
// can read SpotOn's reports site. Signs in like a manager would, opens the
// Employee Time report for today (and the Daily Sales Recap if you give its
// link), and saves what the pages load in the background. Prints only the
// SHAPE of that data (field names and row counts) -- never names or pay --
// so the summary can be pasted into a chat.
//
//   sudo apt-get install -y chromium        (once; the browser it drives)
//   node tools/spoton-test.js               sign in, pull today's Employee Time
//   node tools/spoton-test.js --sales "https://restaurantreports.spoton.com/...recap..."
//   node tools/spoton-test.js --show        also print the first row's VALUES on this screen (don't paste)
//   node tools/spoton-test.js --fresh       forget the saved sign-in and log in again
//
// SPOTON_USER / SPOTON_PASS in agent/.env (asked for and saved if missing).
// The sign-in is kept in agent/.spoton-session.json; captures go to
// agent/spoton-capture/. Both stay on this box (gitignored).
process.chdir(require('path').join(__dirname, '..'));
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

const SITE = process.env.SPOTON_SITE || 'https://restaurantreports.spoton.com';
// From the report address on Scotto's screen (T2). Override with
// SPOTON_LOCATION_KEY in .env if this box is another bar.
const LOCATION_KEY = process.env.SPOTON_LOCATION_KEY || '1215273229887737856';
const SESSION_FILE = path.join(process.cwd(), '.spoton-session.json');
const CAPTURE_DIR = path.join(process.cwd(), 'spoton-capture');
const TZ = 'America/Chicago';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, hidden) => new Promise((resolve) => {
  if (hidden) {
    const orig = rl._writeToOutput;
    rl._writeToOutput = (s) => { if (/\n/.test(s)) orig.call(rl, s); else if (!rl.line) orig.call(rl, s); };
    rl.question(q, (a) => { rl._writeToOutput = orig; process.stdout.write('\n'); resolve(a.trim()); });
  } else rl.question(q, (a) => resolve(a.trim()));
});

function todayMMDDYYYY() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day}-${p.year}`;
}

function findChromium() {
  for (const c of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium', '/opt/pw-browsers/chromium', '/snap/bin/chromium']) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// Field names and types only -- no values.
function shape(v, depth = 0) {
  if (Array.isArray(v)) {
    if (!v.length) return 'array[0]';
    const first = v[0];
    return `array[${v.length}] of ${typeof first === 'object' && first ? shape(first, depth + 1) : typeof first}`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (depth >= 2) return `{${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', ...' : ''}}`;
    return `{ ${keys.slice(0, 25).map((k) => {
      const x = v[k];
      const t = Array.isArray(x) ? shape(x, depth + 1) : x && typeof x === 'object' ? shape(x, depth + 1) : typeof x;
      return `${k}: ${t}`;
    }).join(', ')}${keys.length > 25 ? ', ...' : ''} }`;
  }
  return typeof v;
}

function firstRow(v) {
  if (Array.isArray(v)) return v[0];
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { const r = firstRow(v[k]); if (r && typeof r === 'object') return r; }
  return null;
}

async function settle(page, ms = 6000) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function visibleInput(page, selectors) {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function looksSignedOut(page) {
  return !!(await visibleInput(page, ['input[type="password"]']));
}

async function codePrompt(page) {
  const sel = ['input[autocomplete="one-time-code"]', 'input[name*="code" i]', 'input[id*="code" i]', 'input[placeholder*="code" i]', 'input[name*="otp" i]', 'input[inputmode="numeric"]'];
  const input = await visibleInput(page, sel);
  if (input) return input;
  const text = (await page.textContent('body').catch(() => '')) || '';
  return /verification code|enter the code|sent (you )?a code|one-time|security code/i.test(text) ? (await visibleInput(page, ['input:not([type="hidden"])'])) : null;
}

(async () => {
  let user = process.env.SPOTON_USER || '';
  let pass = process.env.SPOTON_PASS || '';
  if (!user || !pass) {
    console.log('SpotOn reports login for this box (a reports-only login if SpotOn allows it, not the owner login).');
    user = user || await ask('SpotOn email/username: ');
    pass = pass || await ask('SpotOn password (hidden): ', true);
    if (!user || !pass) { console.log('Both are needed.'); process.exit(1); }
    fs.appendFileSync('.env', `\n# SpotOn reports site, for the kitchen board (tools/spoton-test.js)\nSPOTON_USER=${user}\nSPOTON_PASS=${pass}\n`);
    console.log('Saved to agent/.env.');
  }

  const exe = findChromium();
  if (!exe) { console.log('No Chromium on this box. Run:  sudo apt-get install -y chromium   then try again.'); process.exit(1); }
  const { chromium } = require('playwright-core');
  if (flag('--fresh') && fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const f of fs.readdirSync(CAPTURE_DIR)) fs.unlinkSync(path.join(CAPTURE_DIR, f));

  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    storageState: fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined,
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  const captured = []; // { n, method, url, status, type, body }
  let phase = 'login';
  page.on('response', async (res) => {
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      const url = res.url();
      if (!/json/.test(ct) && !/\/api\//.test(url)) return;
      const text = await res.text().catch(() => '');
      if (!text || text.length > 8 * 1024 * 1024) return;
      let body;
      try { body = JSON.parse(text); } catch (e) { return; }
      const n = captured.length + 1;
      captured.push({ n, phase, method: res.request().method(), url, status: res.status(), size: text.length, body });
      fs.writeFileSync(path.join(CAPTURE_DIR, `${String(n).padStart(2, '0')}-${phase}.json`), JSON.stringify({ url, status: res.status(), body }, null, 1));
    } catch (e) { /* ignore */ }
  });

  console.log(`Chromium: ${exe}`);
  console.log(`Opening ${SITE} ...`);
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page);
  let askedForCode = false;

  if (await looksSignedOut(page)) {
    console.log(`Sign-in page: ${page.url()}`);
    const userBox = await visibleInput(page, ['input[type="email"]', 'input[name*="user" i]', 'input[name*="email" i]', 'input[id*="user" i]', 'input[id*="email" i]', 'input[type="text"]']);
    const passBox = await visibleInput(page, ['input[type="password"]']);
    if (!userBox) { console.log('Could not find the username box. Saving a picture: spoton-capture/login.png'); await page.screenshot({ path: path.join(CAPTURE_DIR, 'login.png') }); }
    else {
      await userBox.fill(user);
      // Some sign-ins ask for the email first, then show the password box.
      if (!(await passBox.isVisible().catch(() => false))) { await userBox.press('Enter'); await settle(page, 4000); }
      const pb = await visibleInput(page, ['input[type="password"]']);
      if (pb) { await pb.fill(pass); await pb.press('Enter'); }
    }
    await settle(page, 10000);

    const code = await codePrompt(page);
    if (code) {
      askedForCode = true;
      console.log('\nSpotOn asked for a sign-in code (text or email).');
      const c = await ask('Type the code here: ');
      await code.fill(c);
      await code.press('Enter');
      await settle(page, 10000);
    }
    if (await looksSignedOut(page)) {
      await page.screenshot({ path: path.join(CAPTURE_DIR, 'login-failed.png') });
      const msg = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 300);
      console.log(`\nStill on the sign-in page: ${page.url()}\nPage says: ${msg}\nPicture saved: spoton-capture/login-failed.png`);
      await browser.close(); rl.close(); process.exit(1);
    }
    console.log(`Signed in. Now at ${page.url()}`);
  } else {
    console.log(`Already signed in (saved session). At ${page.url()}`);
  }
  await ctx.storageState({ path: SESSION_FILE });

  // Report links the site offers (paths only), for finding the Daily Sales Recap.
  const links = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')).filter(Boolean));
  const reportLinks = [...new Set(links.filter((h) => /report|recap|sales|labor|time/i.test(h)).map((h) => h.replace(/^https?:\/\/[^/]+/, '').replace(/location_key=\d+/, 'location_key=…')))];
  fs.writeFileSync(path.join(CAPTURE_DIR, 'links.txt'), links.join('\n'));

  phase = 'employee-time';
  const day = todayMMDDYYYY();
  const etUrl = `${SITE}/restaurant-reporting/interactive-reports/employeetime/?location_key=${LOCATION_KEY}&startDate=${day}&endDate=${day}`;
  console.log(`\nOpening Employee Time for ${day} ...`);
  const before = captured.length;
  await page.goto(etUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page, 12000);
  await page.screenshot({ path: path.join(CAPTURE_DIR, 'employee-time.png'), fullPage: true });
  const onClock = ((await page.textContent('body').catch(() => '')) || '').match(/(\d+) on the Clock/i);
  console.log(`   page title: ${await page.title()}   ${onClock ? `(${onClock[1]} on the clock)` : ''}   ${captured.length - before} data responses`);

  const salesUrl = opt('--sales');
  if (salesUrl) {
    phase = 'sales';
    console.log('\nOpening the sales report you gave ...');
    const b2 = captured.length;
    await page.goto(salesUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page, 12000);
    await page.screenshot({ path: path.join(CAPTURE_DIR, 'sales.png'), fullPage: true });
    console.log(`   page title: ${await page.title()}   ${captured.length - b2} data responses`);
  }

  await browser.close();

  console.log('\n================ PASTE FROM HERE ================');
  console.log(`SpotOn test ${new Date().toISOString()}  asked for code: ${askedForCode ? 'YES' : 'no'}  location_key: ${LOCATION_KEY === '1215273229887737856' ? 'default' : 'custom'}`);
  console.log(`Report links seen (${reportLinks.length}):`);
  for (const l of reportLinks.slice(0, 40)) console.log(`  ${l}`);
  console.log(`\nData responses (${captured.length}):`);
  for (const c of captured) {
    const p = c.url.replace(/^https?:\/\/[^/]+/, '').replace(/location_key=\d+/, 'location_key=…').replace(/([?&](token|key|auth)[^&]*)/gi, '…');
    console.log(`\n#${c.n} [${c.phase}] ${c.method} ${p.slice(0, 160)} -> ${c.status}, ${(c.size / 1024).toFixed(1)} KB`);
    console.log(`   ${shape(c.body).slice(0, 900)}`);
  }
  console.log('================= PASTE TO HERE =================');
  console.log(`\nFull captures saved in agent/spoton-capture/ (${captured.length} files + screenshots). Those have names and pay -- keep them on this box.`);
  if (flag('--show')) {
    console.log('\n--show: first row of each response (for your eyes on this screen):');
    for (const c of captured) { const r = firstRow(c.body); if (r) console.log(`#${c.n}: ${JSON.stringify(r).slice(0, 600)}`); }
  }
  rl.close();
  process.exit(0);
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
