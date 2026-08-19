// Headless-browser walkthrough of the new frontend, against the running
// dev server (node server/index.js on :3001) and the local Postgres DB
// already seeded/activated by the earlier curl smoke test (owner /
// jamie.test / alex.new all exist).
const { chromium } = require('playwright');

const BASE = 'http://localhost:3001';

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const results = [];

  async function withPage(label, fn) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() === 404) errors.push(`[${label}] 404: ${r.url()}`); });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      errors.push(`[${label}] console.error: ${msg.text()}`);
    });
    try {
      await fn(page);
      results.push(`PASS ${label}`);
    } catch (e) {
      results.push(`FAIL ${label}: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  // ---- 1. Staff (Jamie) — PIN login, dashboard, Time Clock punch ----
  await withPage('staff PIN login -> dashboard -> time clock', async (page) => {
    await page.goto(`${BASE}/index.html`);
    await page.fill('#pinUsername', 'jamie.test');
    await page.fill('#pinPin', '4643');
    await page.click('#panelPin button.primary');
    await page.waitForURL('**/dashboard.html', { timeout: 5000 });

    const tile = await page.locator('.app-tile:has-text("Time Clock")');
    if (!(await tile.count())) throw new Error('Time Clock tile missing on dashboard');

    await tile.click();
    await page.waitForURL('**/timeclock.html');
    await page.waitForSelector('#panelMine .card');

    const bodyText = await page.textContent('#panelMine');
    const clockedIn = bodyText.includes('Clocked in since');
    if (clockedIn) {
      await page.click('button:has-text("Clock Out")');
    } else {
      await page.click('button:has-text("Clock In")');
    }
    await page.waitForTimeout(500);
    const afterText = await page.textContent('#panelMine');
    if (clockedIn && !afterText.includes('Not currently clocked in')) throw new Error('Clock out did not register');
    if (!clockedIn && !afterText.includes('Clocked in since')) throw new Error('Clock in did not register');

    // toggle back so the account is left in a clean "clocked out" state
    if (!clockedIn) {
      await page.click('button:has-text("Clock Out")');
      await page.waitForTimeout(500);
    }
  });

  // ---- 2. Owner — full login, employees screen, pending review, roster ----
  await withPage('owner login -> employees screen', async (page) => {
    // Seed a fresh pending employee for this run (earlier curl testing already
    // activated the previous "Alex New" test record, so the pending queue may
    // otherwise be empty).
    const locRes = await page.request.get(`${BASE}/api/locations`);
    const locs = await locRes.json();
    await page.request.post(`${BASE}/api/employees/pending`, {
      data: { name: 'Smoke Test Pending', email: 'smoke.pending@example.com', requestedLocationId: locs[0].id },
    });

    await page.goto(`${BASE}/index.html`);
    await page.click('text=Username & password');
    await page.fill('#fullUsername', 'owner');
    await page.fill('#fullPassword', 'owner-dev-pass');
    await page.click('#panelFull >> text=Continue');
    await page.waitForURL('**/dashboard.html', { timeout: 5000 });

    await page.click('button:has-text("Employees")');
    await page.waitForURL('**/employees.html');
    await page.waitForFunction(() => !document.getElementById('pendingList').textContent.includes('Loading'));
    const pendingText = await page.textContent('#pendingList');
    if (!pendingText.includes('Smoke Test Pending')) throw new Error('Expected freshly-seeded pending employee not shown');

    // Owner-only "All employees" table with toggles should be visible
    await page.waitForSelector('#allEmployeesCard:visible');
    await page.waitForFunction(() => !document.getElementById('employeeList').textContent.includes('Loading'));
    const allText = await page.textContent('#employeeList');
    if (!allText.includes('Jamie Test')) throw new Error('All-employees table missing Jamie Test');

    // Flip the Service Calls toggle for Jamie and confirm the API call round-trips.
    // Click the visible slider (the checkbox itself is visually hidden — a
    // real user clicks the switch graphic, which toggles the input via the
    // wrapping <label>, same as this does).
    const jamieRow = page.locator('.list-row', { hasText: 'Jamie Test' });
    const scLabel = jamieRow.locator('label:has-text("Service Calls")');
    page.once('dialog', (d) => d.accept('reset-from-smoke-test')); // in case step-up prompt appears
    await scLabel.locator('.slider').click();
    await page.waitForTimeout(600);
    const msg = await page.textContent('#msgBox');
    if (!msg.includes('Updated service calls access')) throw new Error(`Expected toggle success message, got: ${msg}`);
  });

  // ---- 3. The owner-gate itself, through the real UI: create -> review ->
  //         activate with toggles -> credential box -> new hire's first
  //         login requires 2FA -> dashboard reflects exactly what was granted.
  await withPage('full activation gate walkthrough', async (page) => {
    const locRes = await page.request.get(`${BASE}/api/locations`);
    const locs = await locRes.json();
    const uniqueName = 'Gate Walkthrough ' + Math.floor(Math.random() * 100000);
    await page.request.post(`${BASE}/api/employees/pending`, {
      data: { name: uniqueName, email: 'gate.walkthrough@example.com', requestedLocationId: locs[0].id },
    });

    await page.goto(`${BASE}/index.html`);
    await page.click('text=Username & password');
    await page.fill('#fullUsername', 'owner');
    await page.fill('#fullPassword', 'owner-dev-pass');
    await page.click('#panelFull >> text=Continue');
    await page.waitForURL('**/dashboard.html', { timeout: 5000 });
    await page.goto(`${BASE}/employees.html`);
    await page.waitForFunction(() => !document.getElementById('pendingList').textContent.includes('Loading'));

    const row = page.locator('.list-row', { hasText: uniqueName });
    if (!(await row.count())) throw new Error('Newly-seeded pending employee not found in list');

    // Before activation: confirm this person truly cannot log in yet.
    const preCheck = await page.request.post(`${BASE}/api/auth/login-pin`, { data: { username: uniqueName.toLowerCase().replace(/[^a-z0-9]+/g, '.'), pin: '0000' } });
    const preCheckBody = await preCheck.json();
    if (preCheckBody.ok) throw new Error('Employee could log in before owner activation — the gate is broken');

    await row.locator('button:has-text("Activate")').click();
    await page.waitForSelector('#activateModal:visible');
    // Leave Time Clock on (default), Service Calls on, Scheduling off — a
    // deliberately mixed grant so we can check the dashboard reflects it exactly.
    await page.locator('#accessServiceCalls + .slider').click();
    await page.click('#activateModal >> text=Activate — go live');
    await page.waitForSelector('#activateResult .credential-box', { timeout: 5000 });
    const credText = await page.textContent('#activateResult');
    const userMatch = credText.match(/Username:\s*([\w.]+)/);
    const passMatch = credText.match(/Temp password:\s*(\S+)/);
    const pinMatch = credText.match(/PIN:\s*(\d+)/);
    if (!userMatch || !passMatch || !pinMatch) throw new Error('Credential box missing username/password/PIN: ' + credText);
    const [newUsername, tempPassword, newPin] = [userMatch[1], passMatch[1], pinMatch[1]];

    // Confirm they're no longer in the pending queue.
    await page.waitForFunction((name) => !document.getElementById('pendingList').textContent.includes(name), uniqueName);

    // Now walk through the new hire's actual first login as they would experience it.
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/index.html`);
    await page.click('text=Username & password');
    await page.fill('#fullUsername', newUsername);
    await page.fill('#fullPassword', tempPassword);
    await page.click('#panelFull >> text=Continue');
    await page.waitForSelector('#codeStep:visible', { timeout: 5000 });

    // Pull the simulated code from the server's own log (stands in for the
    // real email/SMS delivery — see server/notify.js's SIMULATED branch).
    const logTail = require('fs').readFileSync('/tmp/bar-platform-server.log', 'utf8').split('\n').slice(-40).join('\n');
    const codeMatch = logTail.match(/verification code is (\d{6})/g);
    if (!codeMatch) throw new Error('Could not find simulated verification code in server log');
    const lastCode = codeMatch[codeMatch.length - 1].match(/(\d{6})/)[1];

    await page.fill('#codeInput', lastCode);
    await page.click('#codeStep >> text=Verify & sign in');
    await page.waitForURL('**/dashboard.html', { timeout: 5000 });

    // Time Clock and Service Calls both have real frontends now — their
    // dashboard tile state should reflect exactly what the owner granted.
    // Scheduling doesn't exist yet, so it always shows "coming soon"
    // regardless of the access toggle.
    const tcTile = page.locator('.app-tile:has-text("Time Clock")');
    const scTile = page.locator('.app-tile:has-text("Service Calls")');
    if ((await tcTile.getAttribute('class')).includes('disabled')) throw new Error('Time Clock should be enabled but shows disabled');
    if ((await scTile.getAttribute('class')).includes('disabled')) throw new Error('Service Calls should be enabled but shows disabled');

    // Confirm the actual per-app grant data (not just the one visible tile)
    // came through correctly from /api/auth/me after the 2FA login.
    const storedAccess = await page.evaluate(() => JSON.parse(localStorage.getItem('bp_appAccess') || '[]'));
    const byKey = Object.fromEntries(storedAccess.map(a => [a.app_key, a.enabled]));
    if (byKey.time_clock !== true) throw new Error('Expected time_clock=true in appAccess, got ' + JSON.stringify(byKey));
    if (byKey.service_calls !== true) throw new Error('Expected service_calls=true in appAccess, got ' + JSON.stringify(byKey));
    if (byKey.scheduling !== false) throw new Error('Expected scheduling=false in appAccess, got ' + JSON.stringify(byKey));

    // And confirm the PIN this person was issued now works (2FA has been completed).
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/index.html`);
    await page.fill('#pinUsername', newUsername);
    await page.fill('#pinPin', newPin);
    await page.click('#panelPin button.primary');
    await page.waitForURL('**/dashboard.html', { timeout: 5000 });
  });

  // ---- 4. Manager-level view isn't shown to a plain owner-employee mismatch: verify roster/time clock nav ----
  await withPage('owner -> time clock roster', async (page) => {
    await page.goto(`${BASE}/index.html`);
    await page.click('text=Username & password');
    await page.fill('#fullUsername', 'owner');
    await page.fill('#fullPassword', 'owner-dev-pass');
    await page.click('#panelFull >> text=Continue');
    await page.waitForURL('**/dashboard.html', { timeout: 5000 });
    await page.goto(`${BASE}/timeclock.html?view=roster`);
    await page.waitForSelector('#panelRoster:visible');
    const text = await page.textContent('#panelRoster');
    if (!text.includes('Jamie Test')) throw new Error('Roster does not list Jamie Test');
  });

  // ---- 5. Service Calls, through the real UI: report -> shows in list ->
  //         close with a remedy -> shows in owner's report as closed.
  // Uses its own freshly-activated employee (rather than jamie.test) so this
  // test isn't coupled to the app-access toggle state left behind by other
  // tests/manual runs in this same shared dev database.
  await withPage('service calls: report -> close -> report', async (page) => {
    const locRes = await page.request.get(`${BASE}/api/locations`);
    const locs = await locRes.json();
    const uniqueName = 'SC Reporter ' + Math.floor(Math.random() * 100000);
    const pendingRes = await page.request.post(`${BASE}/api/employees/pending`, {
      data: { name: uniqueName, email: 'sc.reporter@example.com', requestedLocationId: locs[0].id },
    });
    const pending = (await pendingRes.json()).person;

    const ownerLoginRes = await page.request.post(`${BASE}/api/auth/login-password`, { data: { username: 'owner', password: 'owner-dev-pass' } });
    const ownerToken = (await ownerLoginRes.json()).token;
    const activateRes = await page.request.post(`${BASE}/api/employees/${pending.id}/activate`, {
      headers: { Authorization: 'Bearer ' + ownerToken },
      data: { appAccess: { service_calls: true } },
    });
    const activated = await activateRes.json();

    await page.goto(`${BASE}/index.html`);
    await page.click('text=Username & password');
    await page.fill('#fullUsername', activated.username);
    await page.fill('#fullPassword', activated.tempPassword);
    await page.click('#panelFull >> text=Continue');
    await page.waitForSelector('#codeStep:visible', { timeout: 5000 });
    const logTail = require('fs').readFileSync('/tmp/bar-platform-server.log', 'utf8').split('\n').slice(-40).join('\n');
    const codeMatches = logTail.match(/verification code is (\d{6})/g);
    const lastCode = codeMatches[codeMatches.length - 1].match(/(\d{6})/)[1];
    await page.fill('#codeInput', lastCode);
    await page.click('#codeStep >> text=Verify & sign in');
    await page.waitForURL('**/dashboard.html', { timeout: 5000 });

    await page.click('.app-tile:has-text("Service Calls")');
    await page.waitForURL('**/servicecalls.html');
    await page.click('button[data-tab="new"]');
    await page.waitForSelector('#ncDescription');
    const uniqueDesc = 'Smoke test: draft beer line #' + Math.floor(Math.random() * 100000);
    await page.selectOption('#ncEquipment', { label: 'Draft System' });
    await page.fill('#ncDescription', uniqueDesc);
    await page.selectOption('#ncAssigned', 'manager');
    await page.click('button:has-text("Submit")');
    await page.waitForURL('**/servicecalls.html'); // stays on page, tab switches back to Calls
    await page.waitForFunction((d) => document.getElementById('panelOpen').textContent.includes(d), uniqueDesc, { timeout: 5000 });

    // Close it.
    const card = page.locator('.card', { hasText: uniqueDesc });
    await card.locator('button:has-text("Close")').click();
    await page.waitForSelector('#closeModal:visible');
    await page.fill('#closeRemedy', 'Swapped the coupler and cleared the line — smoke test.');
    await page.click('#closeModal >> text=Mark closed');
    await page.waitForFunction((d) => {
      const card = Array.from(document.querySelectorAll('.card')).find(c => c.textContent.includes(d));
      return card && card.textContent.includes('Closed by');
    }, uniqueDesc, { timeout: 5000 });

    // Confirm it shows correctly in the owner's report view.
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/index.html`);
    await page.click('text=Username & password');
    await page.fill('#fullUsername', 'owner');
    await page.fill('#fullPassword', 'owner-dev-pass');
    await page.click('#panelFull >> text=Continue');
    await page.waitForURL('**/dashboard.html', { timeout: 5000 });
    await page.goto(`${BASE}/servicecalls.html`);
    await page.click('button[data-tab="reports"]');
    await page.waitForFunction((d) => document.getElementById('reportTable').textContent.includes(d), uniqueDesc.split('#')[0], { timeout: 5000 }).catch(() => {});
    const reportText = await page.textContent('#reportTable');
    if (!reportText.includes('Draft System')) throw new Error('Report table missing the closed call');
    if (!reportText.includes(uniqueName)) throw new Error('Report table missing reporter name');
  });

  await browser.close();

  console.log(results.join('\n'));
  if (errors.length) {
    console.log('\n--- console/page errors seen ---');
    console.log(errors.join('\n'));
  } else {
    console.log('\n(no console or page errors observed)');
  }
  if (results.some(r => r.startsWith('FAIL')) || errors.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
