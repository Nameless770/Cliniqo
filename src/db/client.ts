/**
 * PostgreSQL client.
 *
 * SERVER ONLY. This module must never be reachable from a Client Component — importing
 * it there would pull connection credentials into the browser bundle.
 */

import 'server-only';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';

import * as schema from './schema';

/* -------------------------------------------------------------------------- */
/* Type parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Return DATE as a plain string, not a JS Date.
 *
 * `date_of_birth` is a calendar date, not an instant. Letting node-postgres construct a
 * Date applies the server's local timezone and can shift a birth date by a day — which
 * then silently breaks patient matching and any age-based clinical rule.
 */
types.setTypeParser(1082, (value) => value);

/** NUMERIC as string. Prescription quantities must not round-trip through a float. */
types.setTypeParser(1700, (value) => value);

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Fail at startup rather than on the first patient lookup.
    throw new Error('DATABASE_URL is not set.');
  }
  return url;
}

/**
 * TLS to the database.
 *
 * Encryption in transit is required, and "in transit" includes the application-to-
 * database hop, which is the one people forget. In production we verify the server
 * certificate against a pinned CA; `rejectUnauthorized: false` would accept any
 * certificate and reduce TLS to obfuscation.
 *
 * Local Docker Compose runs without TLS on a private network — set DATABASE_SSL=disable
 * there, and nowhere else.
 */
function sslConfig() {
  const mode = process.env.DATABASE_SSL ?? 'verify';

  if (mode === 'disable') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_SSL=disable is not permitted in production.');
    }
    return false;
  }

  const ca = process.env.DATABASE_CA_CERT;
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
  };
}

const pool = new Pool({
  connectionString: connectionString(),
  ssl: sslConfig(),

  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,

  /**
   * Server-side caps. A runaway query holding a connection open is a availability
   * problem; one holding a transaction open also blocks the audit writes that share it.
   */
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,

  application_name: 'cliniqo',
});

/**
 * Pool errors arrive on idle clients and are otherwise unhandled — an unhandled 'error'
 * event on a Pool crashes the process.
 *
 * Deliberately logs only the message. A pg error can carry parameter values in its
 * detail fields, and those parameters are patient data.
 */
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/* -------------------------------------------------------------------------- */
/* Drizzle                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cached across hot reloads. Next.js dev re-evaluates modules on every change; without
 * this, each reload leaks a pool and the database runs out of connections.
 */
const globalForDb = globalThis as unknown as {
  cliniqoDb?: ReturnType<typeof createDb>;
};

function createDb() {
  return drizzle(pool, {
    schema,
    // Query text is safe to log; bound parameters are not — they are patient data.
    // Leave this off. Diagnose slow queries with pg_stat_statements, which normalises
    // parameters out, rather than by logging them here.
    logger: false,
  });
}

export const db = globalForDb.cliniqoDb ?? createDb();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.cliniqoDb = db;
}

export type Db = typeof db;
export { schema };
