/**
 * PostgreSQL client.
 *
 * SERVER ONLY. This module must never be reachable from a Client Component — importing
 * it there would pull connection credentials into the browser bundle. `server-only` turns
 * that mistake into a build error.
 *
 * Configuration comes from the validated `env` object, never from `process.env` directly,
 * so a malformed value fails at startup rather than at the first patient lookup.
 */

import 'server-only';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';

import { getEnv, type ServerEnv } from '@/env/server';

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

/**
 * TLS to the database.
 *
 * `rejectUnauthorized: true` is the whole point — accepting any certificate would reduce
 * TLS to obfuscation. The production guard lives in the env schema, which refuses to
 * start with DATABASE_SSL=disable when APP_ENV=production.
 */
function sslConfig(env: ServerEnv) {
  if (env.DATABASE_SSL === 'disable') return false;

  return {
    rejectUnauthorized: true,
    ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT } : {}),
  };
}

function createPool(env: ServerEnv): Pool {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: sslConfig(env),

    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,

    /**
     * Server-side caps. A runaway query holding a connection open is an availability
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
   * detail fields, and in this application those parameters are patient data.
   */
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });

  return pool;
}

/* -------------------------------------------------------------------------- */
/* Drizzle                                                                    */
/* -------------------------------------------------------------------------- */

function createDb() {
  const env = getEnv();

  return drizzle(createPool(env), {
    schema,
    // Query text would be safe to log; bound parameters are not — they are patient data,
    // and Drizzle's logger prints both. Diagnose slow queries with pg_stat_statements,
    // which normalises parameters out.
    logger: false,
  });
}

export type Db = ReturnType<typeof createDb>;

/**
 * Cached on globalThis across hot reloads. Next.js dev re-evaluates modules on every
 * change; without this, each reload leaks a pool until the database refuses connections.
 */
const globalForDb = globalThis as unknown as { cliniqoDb?: Db };

/**
 * The database handle.
 *
 * A function rather than a module-scope constant, so that importing this module does not
 * open a connection or read configuration. `next build` imports route modules to collect
 * page data, and a build must not need a reachable database or a production secret.
 *
 * The connection is established on first real use, and reused thereafter.
 */
export function getDb(): Db {
  globalForDb.cliniqoDb ??= createDb();
  return globalForDb.cliniqoDb;
}

export { schema };
