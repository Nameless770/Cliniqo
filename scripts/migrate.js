/**
 * Migration runner.
 *
 * Connects as the schema OWNER (DATABASE_MIGRATION_URL), not as the application role.
 * The application role deliberately lacks DDL rights and lacks UPDATE/DELETE on
 * audit_event; if migrations ran as that role the immutability guarantee would be
 * decorative.
 *
 * Plain JavaScript so it runs under `node` with no build step — a deployment should not
 * need a TypeScript toolchain present to migrate a database.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

if (!url) {
  console.error('[migrate] DATABASE_MIGRATION_URL is not set.');
  process.exit(1);
}

const sslMode = process.env.DATABASE_SSL ?? 'verify';

if (sslMode === 'disable' && process.env.NODE_ENV === 'production') {
  console.error('[migrate] DATABASE_SSL=disable is not permitted in production.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: url,
  ssl:
    sslMode === 'disable'
      ? false
      : {
          rejectUnauthorized: true,
          ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT } : {}),
        },
  max: 1,
  // Migrations legitimately take longer than a request. The client-side cap is removed;
  // lock_timeout below is what protects a live database.
  statement_timeout: 0,
});

try {
  const client = await pool.connect();

  /**
   * Never queue behind a long-running transaction holding a conflicting lock. Waiting
   * on an ACCESS EXCLUSIVE lock behind an open transaction blocks every query on the
   * table — a migration should fail fast and be retried, not take the clinic down.
   */
  await client.query("SET lock_timeout = '10s'");
  client.release();

  console.log('[migrate] applying migrations…');
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  console.log('[migrate] done.');
  process.exitCode = 0;
} catch (error) {
  // Message only. A pg error can carry parameter values in its detail fields, and in
  // this application those parameters are patient data.
  console.error('[migrate] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
