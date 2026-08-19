// Captures real screenshots of the running app (localhost:3001) for a
// visual walkthrough, since this sandbox can't expose a public URL.
const { chromium } = require('playwright');
const path = require('path');

const BASE = 'http://localhost:3001';
const DIR = path.join(__dirname, 'screenshots');

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });

  const shot = async (name) => page.screenshot({ path: path.join(DIR, name), fullPage: true });

  // Fresh pending employee for this run, so re-running the script doesn't
  // depend on a specific name still being unactivated from a prior run.
  const locRes = await page.request.get(`${BASE}/api/locations`);
  const locs = await locRes.json();
  const bar2 = locs.find((l) => l.name === 'Bar Two') || locs[0];
  const demoName = 'Morgan Rivera ' + Math.floor(Math.random() * 10000);
  await page.request.post(`${BASE}/api/employees/pending`, {
    data: { name: demoName, email: 'morgan.rivera@example.com', requestedLocationId: bar2.id },
  });

  // 1. Login
  await page.goto(`${BASE}/index.html`);
  await shot('01-login-pin.png');
  await page.click('text=Username & password');
  await shot('02-login-full.png');

  // 2. Owner login -> dashboard
  await page.fill('#fullUsername', 'owner');
  await page.fill('#fullPassword', 'owner-dev-pass');
  await page.click('#panelFull >> text=Continue');
  await page.waitForURL('**/dashboard.html');
  await page.waitForTimeout(300);
  await shot('03-dashboard-owner.png');

  // 3. Employees screen — pending queue
  await page.goto(`${BASE}/employees.html`);
  await page.waitForFunction(() => !document.getElementById('pendingList').textContent.includes('Loading'));
  await page.waitForFunction(() => !document.getElementById('employeeList').textContent.includes('Loading'));
  await shot('04-employees-pending.png');

  // 4. Activate modal open — the per-app toggle grid
  const row = page.locator('.list-row', { hasText: demoName });
  if (await row.count()) {
    await row.locator('button:has-text("Activate")').click();
    await page.waitForSelector('#activateModal:visible');
    await page.locator('#accessTimeClock + .slider').click(); // demonstrate flipping a toggle
    await shot('05-activate-toggles.png');
    await page.click('#activateModal >> text=Activate — go live');
    await page.waitForSelector('#activateResult .credential-box', { timeout: 5000 });
    await shot('06-activate-credentials.png');
    await page.evaluate(() => closeAllModals());
  }

  // 5. Scroll to the all-employees toggle table
  await page.evaluate(() => document.getElementById('allEmployeesCard').scrollIntoView());
  await shot('07-employees-toggle-table.png');

  // 6. Staff dashboard (Jamie — PIN login)
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/index.html`);
  await page.fill('#pinUsername', 'jamie.test');
  await page.fill('#pinPin', '4643');
  await page.click('#panelPin button.primary');
  await page.waitForURL('**/dashboard.html');
  await page.waitForTimeout(300);
  await shot('08-dashboard-staff.png');

  // 7. Time Clock — staff view (clocked in)
  await page.click('.app-tile:has-text("Time Clock")');
  await page.waitForURL('**/timeclock.html');
  await page.waitForSelector('#panelMine .card');
  await shot('09-timeclock-staff.png');

  // 8. Service Calls — open call list
  await page.goto(`${BASE}/servicecalls.html`);
  await page.waitForSelector('#panelOpen .card');
  await shot('10-servicecalls-list.png');

  // 9. Service Calls — new call form
  await page.click('button[data-tab="new"]');
  await page.waitForSelector('#ncDescription');
  await shot('11-servicecalls-new.png');

  // 10. Owner view — Time Clock roster + Service Calls reports
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/index.html`);
  await page.click('text=Username & password');
  await page.fill('#fullUsername', 'owner');
  await page.fill('#fullPassword', 'owner-dev-pass');
  await page.click('#panelFull >> text=Continue');
  await page.waitForURL('**/dashboard.html');
  await page.goto(`${BASE}/timeclock.html?view=roster`);
  await page.waitForSelector('#panelRoster:visible');
  await shot('12-timeclock-roster.png');

  await page.goto(`${BASE}/servicecalls.html`);
  await page.click('button[data-tab="reports"]');
  await page.waitForTimeout(600);
  await shot('13-servicecalls-reports.png');

  await browser.close();
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
