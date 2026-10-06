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
//   node tools/spoton-test.js --sales none     skip the Daily Sales Recap
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

// SpotOn's reports site signs in through Okta: the form loads a moment
// after the page, and asks for the email first, then the password, then
// maybe a code. "Signed in" = not on a sign-in page.
async function onSignInPage(page) {
  if (/\/login\b|okta|\/signin/i.test(page.url())) return true;
  if (/sign in/i.test(await page.title().catch(() => ''))) return true;
  return !!(await visibleInput(page, ['input[type="password"]', 'input[name="identifier"]', '#okta-sign-in input']));
}

async function waitForForm(page, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const box = await visibleInput(page, ['input[name="identifier"]', 'input[type="email"]', 'input[type="password"]', 'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="email" i]']);
    if (box) return box;
    await page.waitForTimeout(500);
  }
  return null;
}

async function inputsSeen(page) {
  return page.$$eval('input', (els) => els.filter((e) => e.type !== 'hidden').map((e) => `${e.type || 'text'}${e.name ? ' name=' + e.name : ''}${e.placeholder ? ' "' + e.placeholder + '"' : ''}`).join(' | ')).catch(() => '');
}

async function clickIf(page, selectorsOrText) {
  for (const s of selectorsOrText) {
    const loc = s.startsWith('text=') ? page.getByText(new RegExp(s.slice(5), 'i')).first() : page.locator(s).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) { await loc.click().catch(() => {}); return s; }
  }
  return null;
}

// What Okta answered (its IDX replies name the next step and any error).
function oktaHints(list) {
  const out = [];
  for (const c of list) {
    const b = c.body || {};
    if (!/\/idp\/idx|\/oauth2|\/api\/v1\/authn/.test(c.url)) continue;
    const bits = [];
    if (b.remediation && Array.isArray(b.remediation.value)) bits.push(`next: ${b.remediation.value.map((r) => r.name).join(', ')}`);
    if (b.messages && Array.isArray(b.messages.value)) bits.push(`says: ${b.messages.value.map((m) => m.message).join(' / ')}`);
    if (b.currentAuthenticator && b.currentAuthenticator.value) bits.push(`authenticator: ${b.currentAuthenticator.value.displayName || b.currentAuthenticator.value.type}`);
    if (b.authenticators && Array.isArray(b.authenticators.value)) bits.push(`choices: ${b.authenticators.value.map((a) => a.displayName || a.type).join(', ')}`);
    if (b.success || b.successWithInteractionCode) bits.push('success');
    if (b.errorSummary) bits.push(`error: ${b.errorSummary}`);
    if (bits.length) out.push(`   #${c.n} ${c.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]} -> ${bits.join('; ')}`);
  }
  return out;
}

async function alerts(page) {
  return page.$$eval('[role="alert"], .o-form-error-container, .infobox-error, .okta-form-infobox-error', (els) => els.map((e) => e.innerText.trim()).filter(Boolean).join(' | ')).catch(() => '');
}

async function codePrompt(page) {
  const sel = ['input[autocomplete="one-time-code"]', 'input[name*="passcode" i]', 'input[name*="code" i]', 'input[id*="code" i]', 'input[placeholder*="code" i]', 'input[name*="otp" i]', 'input[inputmode="numeric"]'];
  const input = await visibleInput(page, sel);
  if (input && !(await visibleInput(page, ['input[type="password"]']))) return input;
  return null;
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

  if (await onSignInPage(page)) {
    console.log(`Sign-in page: ${page.url()}`);
    let box = await waitForForm(page);
    if (!box) {
      await page.screenshot({ path: path.join(CAPTURE_DIR, 'login.png') });
      console.log(`Could not find the sign-in form after 25s. Inputs seen: ${await inputsSeen(page) || 'none'}. Picture: spoton-capture/login.png`);
      await browser.close(); rl.close(); process.exit(1);
    }
    console.log(`   form inputs: ${await inputsSeen(page)}`);
    // Step 1: email (Okta asks for it first, with a Next button).
    const passNow = await visibleInput(page, ['input[type="password"]']);
    if (!passNow || (await box.getAttribute('type')) !== 'password') {
      await box.fill(user);
      if (passNow) {
        await passNow.fill(pass);
        const remember = await visibleInput(page, ['input[name="rememberMe"]', 'input[type="checkbox"]']);
        if (remember && !(await remember.isChecked().catch(() => true))) await remember.check().catch(() => {});
      }
      if (!(await clickIf(page, ['input[type="submit"]', 'button[type="submit"]', 'text=^next$', 'text=^sign in$']))) await (passNow || box).press('Enter');
      await settle(page, 8000);
      // Give Okta up to 30s to move on (or to show an error).
      for (let i = 0; i < 30 && (await visibleInput(page, ['input[type="password"]'])) && !(await alerts(page)); i += 1) await page.waitForTimeout(1000);
      const a = await alerts(page);
      if (a) console.log(`   Okta says: ${a}`);
    }
    // Step 2: password, if it wasn't on the first screen.
    if (!passNow) {
      const pb = await waitForForm(page, 15000);
      const pw = pb && (await pb.getAttribute('type')) === 'password' ? pb : await visibleInput(page, ['input[type="password"]']);
      if (pw) {
        console.log(`   password step: ${await inputsSeen(page)}`);
        await pw.fill(pass);
        if (!(await clickIf(page, ['input[type="submit"]', 'button[type="submit"]', 'text=^verify$', 'text=^sign in$']))) await pw.press('Enter');
        await settle(page, 10000);
      } else {
        console.log(`   no password box appeared. Inputs seen: ${await inputsSeen(page) || 'none'}`);
      }
    }
    // Step 3: a second factor. If Okta offers a choice, pick email (or text).
    for (let round = 0; round < 2; round += 1) {
      let code = await codePrompt(page);
      if (!code) {
        if (await visibleInput(page, ['input[type="password"]'])) break; // still the password form: nothing to pick
        console.log(`   after sign-in: ${page.url().split('?')[0]}  text: ${((await page.evaluate(() => document.body.innerText).catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 200)}`);
        const picked = await clickIf(page, ['text=^email$|^email\\b|verify with your email|email me', 'text=text message|sms|phone']);
        if (!picked) break;
        console.log(`   picked a verification method: ${picked.replace('text=', '')}`);
        await settle(page, 6000);
        await clickIf(page, ['text=send me|send code|send an email|send']);
        await settle(page, 6000);
        code = await codePrompt(page);
        if (!code) break;
      }
      askedForCode = true;
      console.log('\nSpotOn asked for a sign-in code (text or email).');
      const c = await ask('Type the code here: ');
      await code.fill(c);
      if (!(await clickIf(page, ['input[type="submit"]', 'button[type="submit"]', 'text=^verify$']))) await code.press('Enter');
      await settle(page, 10000);
      if (!(await onSignInPage(page))) break;
    }
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await settle(page, 8000);
    if (await onSignInPage(page)) {
      await page.screenshot({ path: path.join(CAPTURE_DIR, 'login-failed.png') });
      const msg = ((await page.evaluate(() => document.body.innerText).catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 400);
      console.log(`\nStill on a sign-in page: ${page.url().split('?')[0]}\nInputs: ${await inputsSeen(page) || 'none'}\nPage says: ${msg}\nPicture saved: spoton-capture/login-failed.png`);
      const hints = oktaHints(captured);
      console.log(hints.length ? `What Okta answered:\n${hints.join('\n')}` : 'No Okta answers were captured (the form may not have submitted).');
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
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
  if (await onSignInPage(page)) console.log('   !! the report page bounced to a sign-in page -- the session did not stick');
  const onClock = ((await page.textContent('body').catch(() => '')) || '').match(/(\d+) on the Clock/i);
  console.log(`   page title: ${await page.title()}   ${onClock ? `(${onClock[1]} on the clock)` : ''}   ${captured.length - before} data responses`);

  // Daily Sales Recap (address from Scotto's browser, 2026-10-06).
  const salesUrl = opt('--sales') || `${SITE}/restaurant-reporting/interactive-reports/dsr/?location_key=${LOCATION_KEY}&startDate=${day}&endDate=${day}`;
  if (salesUrl !== 'none') {
    phase = 'sales';
    console.log('\nOpening the Daily Sales Recap ...');
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
