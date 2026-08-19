// One-time local dev helper: sets a known password + PIN for the seeded
// Owner account so there's a way into the system before any real
// activation flow has run. Prints the credentials once, to the console.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, servicePool, withServiceClient } = require('./db');

(async () => {
  const password = 'owner-dev-pass';
  const pin = '0000';
  const passwordHash = await bcrypt.hash(password, 10);
  const pinHash = await bcrypt.hash(pin, 10);
  // Uses the service (RLS-bypass) connection deliberately: at bootstrap
  // time nobody has ever logged in, so there's no app.current_person_id
  // to satisfy the normal RLS policies with.
  const person = await withServiceClient(async (client) => {
    const { rows } = await client.query(
      `UPDATE people SET password_hash = $1, pin_hash = $2, password_verified_at = now()
       WHERE username = 'owner' RETURNING id, name`,
      [passwordHash, pinHash]
    );
    return rows[0];
  });
  if (!person) {
    console.log('No seeded owner account found — run db/seed.sql first.');
  } else {
    console.log('Owner account ready.');
    console.log('  username:', 'owner');
    console.log('  password:', password, '(one-time verification skipped for local dev — password_verified_at pre-set)');
    console.log('  PIN:     ', pin);
  }
  await pool.end();
  await servicePool.end();
})();
