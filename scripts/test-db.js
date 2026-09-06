/**
 * Create and migrate the test database.
 *
 * A SEPARATE database from `cliniqo`, dropped and rebuilt on every run. Tests assert
 * things like "this DELETE is rejected" and seed rows to do it; pointing them at the
 * development database would mix synthetic test rows into data a developer is reading as
 * if it were real, and one careless test would truncate it.
 *
 * The schema comes from the real migrations, not from a hand-written fixture. That is the
 * whole point: the guarantees under test — the exclusion constraint, the audit REVOKEs,
 * the freeze triggers — ARE migration artefacts. A fixture schema would test a copy of
 * the thing that ships rather than the thing that ships.
 *
 * Roles are cluster-wide in PostgreSQL, and migration 0001 guards its CREATE ROLE with
 * IF NOT EXISTS, so rebuilding this database alongside the development one is safe.
 *
 * Usage:  node --env-file-if-exists=.env scripts/test-db.js
 */

import { execFileSync } from 'node:child_process';

import { Pool } from 'pg';

const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'cliniqo_test';

const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) {
  console.error('[test-db] DATABASE_MIGRATION_URL is not set.');
  process.exit(1);
}

if ((process.env.APP_ENV ?? '').toLowerCase() === 'production') {
  console.error('[test-db] Refusing to run against a production environment.');
  process.exit(1);
}

/** Swap the database name on a connection URL, leaving credentials and host alone. */
function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const adminUrl = withDatabase(ownerUrl, 'postgres');
const testOwnerUrl = withDatabase(ownerUrl, TEST_DB);
const testAppUrl = withDatabase(
  process.env.DATABASE_URL ?? ownerUrl,
  TEST_DB,
);

const admin = new Pool({ connectionString: adminUrl, ssl: false, max: 1 });

try {
  /* Terminate stragglers first: DROP DATABASE fails while any session is attached, and a
     leftover connection from a crashed test run would otherwise wedge every future run. */
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB],
  );

  // Identifier, not a value, so it cannot be parameterised — hence the strict name check.
  if (!/^[a-z_][a-z0-9_]*$/.test(TEST_DB)) {
    throw new Error(`Unsafe test database name: ${TEST_DB}`);
  }

  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  console.log(`[test-db] recreated ${TEST_DB}`);
} finally {
  await admin.end();
}

/* Reuse the real migration runner rather than reimplementing it. Passing the URL through
   the environment keeps the credentials out of the process argument list, where they
   would be visible to anyone running `ps`. */
execFileSync(process.execPath, ['scripts/migrate.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_MIGRATION_URL: testOwnerUrl,
    DATABASE_URL: testAppUrl,
    DATABASE_SSL: 'disable',
  },
});

/*
 * Give the application role the password the tests will connect with.
 *
 * Migration 0001 creates `cliniqo_app` with LOGIN and no password, because a migration
 * has no business inventing a credential — locally `db:setup` sets one afterwards. CI has
 * no such step, and roles are cluster-wide, so without this the tests authenticate as a
 * role that has no password and fail with a confusing "password authentication failed"
 * that looks like a bad connection string.
 *
 * Done here rather than in a CI `psql` step so the runner needs no PostgreSQL client, and
 * so local and CI setup are the same path. Guarded to non-production, and it only ever
 * touches a role used by a database this script just dropped and recreated.
 */
{
  const appPassword = new URL(testAppUrl).password;
  if (appPassword) {
    const owner = new Pool({ connectionString: testOwnerUrl, ssl: false, max: 1 });
    const client = await owner.connect();
    try {
      const appUser = decodeURIComponent(new URL(testAppUrl).username);
      if (!/^[a-z_][a-z0-9_]*$/.test(appUser)) {
        throw new Error(`Unsafe role name: ${appUser}`);
      }
      /* ALTER ROLE is a utility statement and accepts no bind parameters, so the password
         has to be a literal in the SQL text. `escapeLiteral` is libpq's own quoting, which
         is the correct tool here — string concatenation would be an injection. */
      const literal = client.escapeLiteral(decodeURIComponent(appPassword));
      await client.query(`ALTER ROLE ${appUser} WITH PASSWORD ${literal}`);
      console.log(`[test-db] aligned ${appUser} password`);
    } finally {
      client.release();
      await owner.end();
    }
  }
}

console.log(`[test-db] ${TEST_DB} ready`);
