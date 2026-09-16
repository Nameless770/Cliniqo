import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  appPool,
  closePools,
  ownerPool,
  seedBaseline,
  type Baseline,
} from '../helpers/db';

vi.mock('@/db/client', async () => {
  const { testDb } = await import('../helpers/actions');
  const schema = await import('@/db/schema');
  return { getDb: () => testDb, schema };
});

/* The MFA service reads cookies only through mintChallenge/readChallenge, which these
   tests do not exercise — the cookie half is covered end-to-end in the journeys. */
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Map()),
}));

import {
  beginEnrollment,
  confirmEnrollment,
  disableMfa,
  mfaStatus,
  requiresSecondFactor,
  verifyChallenge,
} from '@/server/auth/mfa';
import { codeFor, openSecret, stepFor } from '@/server/auth/totp';

/**
 * The second factor, against the real database.
 *
 * The properties that matter are not "a row was written". They are: an unconfirmed
 * enrollment must not gate anything, a confirmed one must, a code must not work twice, and
 * losing the phone must not mean losing the account.
 */
describe('the second factor', () => {
  let base: Baseline;
  const SESSION_SECRET = process.env['SESSION_SECRET']!;

  /** A staff account of its own, so tests cannot interfere with each other's enrollment. */
  async function makeUser() {
    const t = randomUUID().slice(0, 8);
    const row = await ownerPool.query<{ id: string }>(
      `INSERT INTO user_account (clinic_id, email, password_hash, full_name)
       VALUES ($1, $2, '!', $3) RETURNING id`,
      [base.clinicId, `mfa-${t}@test.local`, `MFA Test ${t}`],
    );
    return row.rows[0]!.id;
  }

  /** The secret as the server stored it, so a test can produce a genuine code. */
  async function secretFor(userId: string) {
    const row = await appPool.query<{ secret_sealed: string }>(
      `SELECT secret_sealed FROM user_totp
        WHERE user_id = $1 AND disabled_at IS NULL LIMIT 1`,
      [userId],
    );
    const secret = openSecret(row.rows[0]!.secret_sealed, SESSION_SECRET);
    if (!secret) throw new Error('could not open the stored secret');
    return secret;
  }

  const enroll = async (userId: string) => {
    const started = await beginEnrollment(
      userId,
      base.clinicId,
      'mfa@test.local',
      null,
      'integration-test',
    );
    expect('manualEntryKey' in started).toBe(true);

    const secret = await secretFor(userId);
    const confirmed = await confirmEnrollment(
      userId,
      base.clinicId,
      codeFor(secret, stepFor(Date.now())),
      null,
      'integration-test',
    );
    if (!confirmed.ok) throw new Error('enrollment did not confirm');
    return { secret, recoveryCodes: confirmed.recoveryCodes };
  };

  beforeAll(async () => {
    base = await seedBaseline();
  });

  afterAll(async () => {
    await closePools();
  });

  it('does not gate sign-in until the enrollment is confirmed', async () => {
    const userId = await makeUser();

    await beginEnrollment(
      userId,
      base.clinicId,
      'mfa@test.local',
      null,
      'integration-test',
    );

    /*
     * The property that keeps people from locking themselves out: starting setup and
     * wandering off must not leave an account demanding a code nobody can produce.
     */
    expect(await requiresSecondFactor(userId)).toBe(false);
    expect((await mfaStatus(userId)).pending).toBe(true);
  });

  it('gates sign-in once a working code has been produced', async () => {
    const userId = await makeUser();
    await enroll(userId);

    expect(await requiresSecondFactor(userId)).toBe(true);
    expect((await mfaStatus(userId)).enrolled).toBe(true);
  });

  it('refuses to confirm on a wrong code', async () => {
    const userId = await makeUser();
    await beginEnrollment(
      userId,
      base.clinicId,
      'mfa@test.local',
      null,
      'integration-test',
    );

    const result = await confirmEnrollment(
      userId,
      base.clinicId,
      '000000',
      null,
      'integration-test',
    );

    expect(result).toEqual({ ok: false, reason: 'bad_code' });
    expect(await requiresSecondFactor(userId)).toBe(false);
  });

  it('never stores the secret in a readable form', async () => {
    const userId = await makeUser();
    const { secret } = await enroll(userId);

    const row = await appPool.query<{ secret_sealed: string }>(
      `SELECT secret_sealed FROM user_totp WHERE user_id = $1`,
      [userId],
    );

    /* A database dump must not be a permanent second factor for everyone in it. */
    expect(row.rows[0]!.secret_sealed).not.toContain(secret.toString('base64'));
    expect(row.rows[0]!.secret_sealed).not.toContain(secret.toString('hex'));
  });

  it('accepts a real code at sign-in, and refuses the same code twice', async () => {
    const userId = await makeUser();
    const { secret } = await enroll(userId);

    /* A step beyond the one enrollment spent, so this is a fresh code. */
    const step = stepFor(Date.now()) + 1;
    const code = codeFor(secret, step);
    const at = step * 30_000;

    vi.setSystemTime(at);
    const first = await verifyChallenge(
      userId,
      base.clinicId,
      code,
      null,
      'integration-test',
    );
    expect(first.ok).toBe(true);

    /*
     * THE property that makes this a second FACTOR rather than a second field. A code is
     * valid for thirty seconds, so without spending the counter anyone who watches it
     * being typed — or phishes it — can replay it inside the window.
     */
    const replay = await verifyChallenge(
      userId,
      base.clinicId,
      code,
      null,
      'integration-test',
    );
    expect(replay.ok).toBe(false);
    vi.useRealTimers();
  });

  it('refuses another account’s code', async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    await enroll(mine);
    const { secret: theirSecret } = await enroll(theirs);

    const result = await verifyChallenge(
      mine,
      base.clinicId,
      codeFor(theirSecret, stepFor(Date.now()) + 1),
      null,
      'integration-test',
    );
    expect(result.ok).toBe(false);
  });

  it('lets a recovery code in, exactly once', async () => {
    const userId = await makeUser();
    const { recoveryCodes } = await enroll(userId);
    const [code] = recoveryCodes as [string];

    const first = await verifyChallenge(
      userId,
      base.clinicId,
      code,
      null,
      'integration-test',
    );
    expect(first).toMatchObject({ ok: true, usedRecoveryCode: true });
    expect(first.ok && first.recoveryCodesRemaining).toBe(recoveryCodes.length - 1);

    const second = await verifyChallenge(
      userId,
      base.clinicId,
      code,
      null,
      'integration-test',
    );
    expect(second.ok).toBe(false);
  });

  it('stores recovery codes hashed, and records when one is spent', async () => {
    const userId = await makeUser();
    const { recoveryCodes } = await enroll(userId);
    const [code] = recoveryCodes as [string];

    const stored = await appPool.query<{ code_hash: string }>(
      `SELECT code_hash FROM user_recovery_code WHERE user_id = $1`,
      [userId],
    );
    for (const row of stored.rows) {
      expect(row.code_hash).not.toContain(code.replace('-', ''));
    }

    await verifyChallenge(userId, base.clinicId, code, null, 'integration-test');

    /* Spent, not deleted: a used code is evidence that recovery happened, and when. */
    const spent = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM user_recovery_code
        WHERE user_id = $1 AND used_at IS NOT NULL`,
      [userId],
    );
    expect(Number(spent.rows[0]!.n)).toBe(1);
  });

  it('refuses everything once the factor is disabled, and voids the recovery codes', async () => {
    const userId = await makeUser();
    const { secret, recoveryCodes } = await enroll(userId);

    await disableMfa(userId, base.clinicId, userId, null, 'integration-test');

    expect(await requiresSecondFactor(userId)).toBe(false);
    /* Codes minted against a secret that no longer governs the account must not survive it. */
    const remaining = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM user_recovery_code WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    expect(Number(remaining.rows[0]!.n)).toBe(0);

    const afterTotp = await verifyChallenge(
      userId,
      base.clinicId,
      codeFor(secret, stepFor(Date.now()) + 1),
      null,
      'integration-test',
    );
    expect(afterTotp.ok).toBe(false);

    const afterRecovery = await verifyChallenge(
      userId,
      base.clinicId,
      recoveryCodes[0]!,
      null,
      'integration-test',
    );
    expect(afterRecovery.ok).toBe(false);
  });

  it('records who removed the factor, which is the question an investigation asks', async () => {
    const userId = await makeUser();
    const adminId = base.providerId;
    await enroll(userId);

    await disableMfa(userId, base.clinicId, adminId, null, 'integration-test');

    const audit = await appPool.query<{
      actor_user_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, metadata FROM audit_event
        WHERE action = 'mfa.disable' AND outcome = 'allowed'
          AND metadata->>'targetUserId' = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [userId],
    );

    /* "An administrator removed this person's second factor" and "this person removed
       their own" are different events, and only one of them is routine. */
    expect(audit.rows[0]!.actor_user_id).toBe(adminId);
    expect(audit.rows[0]!.metadata['bySelf']).toBe(false);
  });

  it('lets an account enroll again after being disabled', async () => {
    const userId = await makeUser();
    await enroll(userId);
    await disableMfa(userId, base.clinicId, userId, null, 'integration-test');

    /* The partial unique index is on live rows only, so a disabled enrollment must not
       block a new one — otherwise a lost phone locks the account out of 2FA permanently. */
    await enroll(userId);
    expect(await requiresSecondFactor(userId)).toBe(true);
  });

  it('audits enrollment, confirmation and use as separate events', async () => {
    const userId = await makeUser();
    const { secret } = await enroll(userId);
    await verifyChallenge(
      userId,
      base.clinicId,
      codeFor(secret, stepFor(Date.now()) + 1),
      null,
      'integration-test',
    );

    const actions = await appPool.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_event
        WHERE entity_id = $1 AND action LIKE 'mfa.%' ORDER BY action`,
      [userId],
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      'mfa.challenge',
      'mfa.confirm',
      'mfa.enroll',
    ]);
  });

  it('never writes a code or a secret into the audit log', async () => {
    const userId = await makeUser();
    const { secret, recoveryCodes } = await enroll(userId);
    const code = codeFor(secret, stepFor(Date.now()) + 1);
    await verifyChallenge(userId, base.clinicId, code, null, 'integration-test');
    await verifyChallenge(
      userId,
      base.clinicId,
      recoveryCodes[0]!,
      null,
      'integration-test',
    );

    const rows = await appPool.query<{ metadata: string }>(
      `SELECT metadata::text AS metadata FROM audit_event
        WHERE entity_id = $1 AND action LIKE 'mfa.%'`,
      [userId],
    );

    for (const row of rows.rows) {
      expect(row.metadata ?? '').not.toContain(code);
      expect(row.metadata ?? '').not.toContain(recoveryCodes[0]!);
    }
  });
});
