/**
 * Local development seed.
 *
 * Creates a clinic and one administrator so there is something to sign in as. Roles and
 * permissions are NOT here — those are reference data and ship in migration 0003, so
 * every environment including production has them.
 *
 * REFUSES TO RUN unless ALLOW_SEED_DATA=true and APP_ENV is not production. Both guards
 * matter: a seed script that can reach production is a script that will eventually create
 * a known-password administrator on a system holding patient records.
 *
 * The generated password is printed once, to this terminal, and never stored anywhere
 * else. Change it after first sign-in.
 *
 * Usage:  npm run db:seed
 */

import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

import { Pool } from 'pg';

const scrypt = promisify(scryptCb);

/* Mirrors src/server/auth/password.ts. Duplicated deliberately: this script runs as plain
   JavaScript with no build step, and a deployment should not need a TypeScript toolchain
   present in order to seed. Keep the two in step. */
const N = 65536;
const R = 8;
const P = 3;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, 32, {
    N,
    r: R,
    p: P,
    maxmem: 128 * N * R * 2,
  });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join(
    '$',
  );
}

/* ------------------------------------------------------------------ guards */

const appEnv = process.env.APP_ENV ?? 'development';

if (appEnv === 'production') {
  console.error('[seed] refusing to run with APP_ENV=production.');
  process.exit(1);
}

if (process.env.ALLOW_SEED_DATA !== 'true') {
  console.error('[seed] ALLOW_SEED_DATA is not "true". Refusing to run.');
  process.exit(1);
}

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('[seed] DATABASE_MIGRATION_URL is not set.');
  process.exit(1);
}

/* -------------------------------------------------------------------- seed */

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@cliniqo.local';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? 'Local Administrator';
const CLINIC_NAME = process.env.SEED_CLINIC_NAME ?? 'Riverside Family Practice';

/* 24 random bytes, base64url. Not a memorable password on purpose — a seeded account with
   a guessable password is the first thing an attacker tries on a forgotten staging box. */
const password = randomBytes(24).toString('base64url');

const pool = new Pool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: true },
  max: 1,
});

try {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const roles = await client.query(`SELECT count(*)::int AS n FROM "role"`);
    if (roles.rows[0].n === 0) {
      throw new Error('No roles found. Run `npm run db:migrate` first (migration 0003).');
    }

    const clinic = await client.query(
      `INSERT INTO clinic (name, timezone, mrn_prefix)
       VALUES ($1, $2, 'MRN')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [CLINIC_NAME, 'America/New_York'],
    );

    const clinicId =
      clinic.rows[0]?.id ??
      (await client.query(`SELECT id FROM clinic WHERE name = $1 LIMIT 1`, [CLINIC_NAME]))
        .rows[0].id;

    const existing = await client.query(
      `SELECT id FROM user_account WHERE email = $1 AND archived_at IS NULL`,
      [ADMIN_EMAIL],
    );

    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      console.log(`[seed] ${ADMIN_EMAIL} already exists. Nothing to do.`);
      console.log(
        '[seed] To reset the password, use `npm run db:reset` then seed again.',
      );
      process.exit(0);
    }

    const hash = await hashPassword(password);

    const user = await client.query(
      `INSERT INTO user_account (clinic_id, email, password_hash, full_name, status, must_change_password, password_changed_at)
       VALUES ($1, $2, $3, $4, 'active', true, now())
       RETURNING id`,
      [clinicId, ADMIN_EMAIL, hash, ADMIN_NAME],
    );

    // must_change_password is true above: a seeded credential is a shared secret the
    // moment it is printed, so it is valid exactly until first sign-in.

    await client.query(
      `INSERT INTO user_role (user_id, role_id)
       SELECT $1, id FROM "role" WHERE code = 'admin'`,
      [user.rows[0].id],
    );

    await client.query('COMMIT');

    console.log('');
    console.log('  Seeded local development data');
    console.log('  ─────────────────────────────');
    console.log(`  Clinic    ${CLINIC_NAME}`);
    console.log(`  Email     ${ADMIN_EMAIL}`);
    console.log(`  Password  ${password}`);
    console.log('');
    console.log('  Shown once. Not stored anywhere else. Change it after signing in.');
    console.log('');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  // Message only — a pg error can carry parameter values in its detail fields.
  console.error('[seed] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
