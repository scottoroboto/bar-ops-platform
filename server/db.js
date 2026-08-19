const { Pool } = require('pg');

// Two separate connections, matching the two Postgres roles created in
// db/schema.sql (see the "TWO APP-LEVEL ROLES" section there):
//
//   pool        -> barplatform_app, an ordinary role with no RLS bypass.
//                  Every logged-in request goes through this one, so the
//                  RLS policies actually mean something.
//   servicePool -> barplatform_service, BYPASSRLS — same idea as a
//                  Supabase service_role key. Used only by trusted
//                  server-side code (Jotform intake, owner activation,
//                  session/login lookups before any person context
//                  exists) where authorization is instead enforced in
//                  the Express route handlers.
//
// Using one shared DB role for both used to also be "the app's own
// owning role" with FORCE ROW LEVEL SECURITY bolted on — that meant
// there was no way to actually bypass RLS for trusted service-side
// operations, since FORCE applies to the owner too. Splitting into two
// real roles is what makes both halves (enforced vs. trusted-bypass)
// work correctly at the same time.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
    || 'postgresql://barplatform_app:barplatform_app_dev@localhost:5432/barplatform',
});

const servicePool = new Pool({
  connectionString: process.env.DATABASE_SERVICE_URL
    || 'postgresql://barplatform_service:barplatform_service_dev@localhost:5432/barplatform',
});

// Every authenticated request runs inside a transaction with three
// session-local settings set first — the same settings the RLS policies
// in db/schema.sql read. This is what makes "who is asking" enforceable
// at the database layer, not just in application code, and it works
// identically against a real Supabase Postgres connection.
async function withAuthedClient(person, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_person_id', person ? person.id : '']);
    await client.query('SELECT set_config($1, $2, true)', ['app.current_role', person ? person.role : '']);
    await client.query('SELECT set_config($1, $2, true)', ['app.current_location_id', person && person.location_id ? person.location_id : '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// For system/service operations with no authenticated person (e.g. the Jotform
// sync creating a pending record) — bypasses RLS via the barplatform_service
// role's BYPASSRLS attribute, same as a Supabase service-role key would.
// Used sparingly and only from trusted server code.
async function withServiceClient(fn) {
  const client = await servicePool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, servicePool, withAuthedClient, withServiceClient };
