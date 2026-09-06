/**
 * Issue a setup link for a staff account, out of band.
 *
 * WHY THIS EXISTS
 * ---------------
 * `db:seed` prints the bootstrap administrator's password exactly once and stores only
 * its hash. That is the right design — but it means a lost password locks you out of the
 * only account that can reach the Staff screen, and the in-app remedy ("ask an
 * administrator to re-issue your link") is unreachable when the administrator IS the
 * locked-out account. Without this, recovery means `db:reset`, which destroys the
 * patients, notes, and audit log along with it.
 *
 * WHAT IT DOES
 * ------------
 * Exactly what `issueSetupToken` in src/server/data-access/staff.ts does: generates a
 * 256-bit token, stores only its SHA-256, revokes any previous live token for that
 * account, and prints the raw token once. The staff member then sets their own password
 * at /claim/<token> through the application's normal flow.
 *
 * No password is set, read, or transmitted by this script. It cannot reveal an existing
 * one — that is not recoverable by design.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It writes NO audit_event row. `auditedOperation` requires an authenticated session and
 * there isn't one here — this runs as the database owner, not as a user. That is a real
 * gap and the reason for the guards below: this is a break-glass bootstrap tool, not an
 * administrative feature. The supported path for every other account is an administrator
 * using the Staff screen, which IS audited.
 *
 * REFUSES TO RUN against production. Anyone who can run this already holds the database
 * credentials, so it grants no access they did not already have — but on a production box
 * that is exactly the action that should go through the audited path instead.
 *
 * Usage:  node --env-file-if-exists=.env scripts/issue-setup-link.js [email]
 */

import { createHash, randomBytes } from 'node:crypto';

import { Pool } from 'pg';

/** Mirrors SETUP_TOKEN_TTL_HOURS in src/server/data-access/staff.ts. */
const TTL_HOURS = 48;

const email = process.argv[2] ?? process.env.SEED_ADMIN_EMAIL ?? 'admin@cliniqo.local';

if ((process.env.APP_ENV ?? '').toLowerCase() === 'production') {
  console.error(
    'Refusing to run: APP_ENV=production.\n' +
      'Re-issue the setup link from the Staff screen instead — that path is audit-logged.',
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Did you mean to pass --env-file-if-exists=.env?');
  process.exit(1);
}

const hashToken = (t) => createHash('sha256').update(t).digest('hex');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  const found = await client.query(
    `SELECT id, clinic_id, full_name, status
       FROM user_account
      WHERE email = $1 AND archived_at IS NULL`,
    [email],
  );

  if (found.rowCount === 0) {
    throw new Error(`No live account with email ${email}.`);
  }

  const user = found.rows[0];
  if (user.status !== 'active') {
    throw new Error(
      `Account ${email} is ${user.status}, not active. Reactivate it before issuing a link.`,
    );
  }

  /* One live invitation per account — the same rule staff_setup_token_live_idx enforces.
     Revoking first keeps this script from tripping that unique index. */
  const revoked = await client.query(
    `UPDATE staff_setup_token
        SET revoked_at = now()
      WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
    [user.id],
  );

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3_600_000);

  await client.query(
    `INSERT INTO staff_setup_token (clinic_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [user.clinic_id, user.id, hashToken(token), expiresAt],
  );

  /* The account must actually be in "needs a password" state for the claim flow to be
     meaningful. Setting this also locks out the old password immediately, which is the
     behaviour you want from a recovery action. */
  await client.query(
    `UPDATE user_account SET must_change_password = true WHERE id = $1`,
    [user.id],
  );

  await client.query('COMMIT');

  const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';

  console.log('');
  console.log(`  Account   ${email} (${user.full_name})`);
  if (revoked.rowCount > 0) {
    console.log(`  Revoked   ${revoked.rowCount} previous unused setup link`);
  }
  console.log(`  Expires   ${expiresAt.toISOString()}  (${TTL_HOURS}h)`);
  console.log('');
  console.log(`  ${base}/claim/${token}`);
  console.log('');
  console.log('  Shown once. It is a bearer credential until used — treat it like a');
  console.log('  password, and open it yourself rather than forwarding it.');
  console.log('');
} catch (err) {
  await client.query('ROLLBACK');
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
