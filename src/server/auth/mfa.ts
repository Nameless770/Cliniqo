import 'server-only';

import { cookies } from 'next/headers';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { userAccount, userRecoveryCode, userTotp } from '@/db/schema';
import { clientEnv } from '@/env/client';
import { getEnv } from '@/env/server';
import { signToken, verifyToken } from '@/lib/signed-token';
import { writeAuditEvent } from '@/server/audit/log';

import { sessionCookieOptions } from './session';
import {
  formatForManualEntry,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  openSecret,
  otpauthUri,
  sealSecret,
  verifyCode,
} from './totp';

/**
 * The second factor: enrollment, challenge, and getting back in.
 *
 * ==========================================================================
 * NO HALF-AUTHENTICATED SESSION EVER EXISTS
 * ==========================================================================
 *
 * The obvious implementation creates the session at the password step and marks it
 * "pending MFA". That means a row in `session` which is not yet a real login, and every
 * `getSession()` call in the codebase becomes responsible for remembering that — one that
 * forgets is a complete bypass, and it would look like ordinary code.
 *
 * Instead the password step creates nothing. It mints a short-lived signed token carrying
 * only "this account proved its password at this instant", and the session is created when
 * the second factor passes. There is no state in the database between the two steps and no
 * partially-authenticated object for anything to mishandle.
 *
 * The token is the same purpose-scoped HMAC construction `pending-signup` uses, so a token
 * minted for one purpose cannot verify for the other.
 */

/** Long enough to fetch a phone from a coat pocket; short enough that a shared desk forgets. */
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

const PURPOSE = 'mfa-challenge';
const COOKIE = 'cliniqo_mfa';
/* Scoped to the page that consumes it: the browser sends it nowhere else on the site. */
const COOKIE_PATH = '/login/verify';

export type PendingChallenge = {
  userId: string;
  clinicId: string;
  exp: number;
};

export function challengeCookie() {
  return {
    name: COOKIE,
    options: {
      ...sessionCookieOptions(),
      path: COOKIE_PATH,
      maxAge: MFA_CHALLENGE_TTL_SECONDS,
    },
  };
}

/**
 * Issued only after a password has actually verified.
 *
 * Carries an account id and nothing else — no roles, no permissions. Whatever this account
 * may do is resolved from live state after the session exists, exactly as it is on every
 * other request.
 */
export async function mintChallenge(userId: string, clinicId: string): Promise<void> {
  const env = getEnv();
  const token = signToken(
    {
      userId,
      clinicId,
      /*
       * MILLISECONDS. `verifyToken` compares `exp` against `Date.now()`, so a value in
       * seconds is roughly a thousand times too small and the token is born expired —
       * which locks out every enrolled account at the second step rather than failing
       * anywhere visible. Written in full here because the unit is the whole bug.
       */
      exp: Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000,
    },
    env.SESSION_SECRET,
    PURPOSE,
  );

  const { name, options } = challengeCookie();
  (await cookies()).set(name, token, options);
}

export async function readChallenge(): Promise<PendingChallenge | null> {
  const env = getEnv();
  const raw = (await cookies()).get(COOKIE)?.value;
  const payload = verifyToken(raw, env.SESSION_SECRET, PURPOSE, Date.now());
  if (!payload) return null;

  const userId = payload['userId'];
  const clinicId = payload['clinicId'];
  if (typeof userId !== 'string' || typeof clinicId !== 'string') return null;

  return { userId, clinicId, exp: Number(payload['exp']) };
}

/** Spent whichever way the challenge went. A token that survives a failure can be replayed. */
export async function clearChallenge(): Promise<void> {
  const { name, options } = challengeCookie();
  (await cookies()).set(name, '', { ...options, maxAge: 0 });
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

export type MfaStatus = {
  enrolled: boolean;
  /** An enrollment started but never proven with a working code. */
  pending: boolean;
  recoveryCodesRemaining: number;
};

export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const db = getDb();

  const [row] = await db
    .select({ confirmedAt: userTotp.confirmedAt })
    .from(userTotp)
    .where(and(eq(userTotp.userId, userId), isNull(userTotp.disabledAt)))
    .limit(1);

  const [codes] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(userRecoveryCode)
    .where(and(eq(userRecoveryCode.userId, userId), isNull(userRecoveryCode.usedAt)));

  return {
    enrolled: Boolean(row?.confirmedAt),
    pending: Boolean(row) && !row?.confirmedAt,
    recoveryCodesRemaining: codes?.value ?? 0,
  };
}

/** Whether a sign-in for this account must pass a second factor. One indexed lookup. */
export async function requiresSecondFactor(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: userTotp.id })
    .from(userTotp)
    .where(
      and(
        eq(userTotp.userId, userId),
        isNull(userTotp.disabledAt),
        sql`${userTotp.confirmedAt} is not null`,
      ),
    )
    .limit(1);

  return Boolean(row);
}

/* -------------------------------------------------------------------------- */
/* Enrollment                                                                 */
/* -------------------------------------------------------------------------- */

export type Enrollment = {
  manualEntryKey: string;
  otpauthUri: string;
};

/**
 * Start enrolling, replacing any enrollment that was never confirmed.
 *
 * Replacing rather than resuming: an abandoned setup usually means the secret never
 * reached a phone, and handing back a secret the user may have half-entered somewhere is
 * worse than issuing a fresh one. A CONFIRMED enrollment is never touched here — turning
 * off an existing second factor is its own deliberate act, not a side effect of visiting
 * a settings page.
 */
export async function beginEnrollment(
  userId: string,
  clinicId: string,
  email: string,
  ip: string | null,
  userAgent: string | null,
): Promise<Enrollment | { alreadyEnrolled: true }> {
  const env = getEnv();
  const db = getDb();

  if (await requiresSecondFactor(userId)) return { alreadyEnrolled: true };

  const secret = generateSecret();

  await db.transaction(async (tx) => {
    await tx
      .delete(userTotp)
      .where(
        and(
          eq(userTotp.userId, userId),
          isNull(userTotp.disabledAt),
          isNull(userTotp.confirmedAt),
        ),
      );

    await tx.insert(userTotp).values({
      userId,
      secretSealed: sealSecret(secret, env.SESSION_SECRET),
    });

    await writeAuditEvent(tx, {
      clinicId,
      actorUserId: userId,
      actorIp: ip,
      actorUserAgent: userAgent,
      action: 'mfa.enroll',
      outcome: 'allowed',
      entityType: 'user_totp',
      entityId: userId,
      metadata: { step: 'started' },
    });
  });

  return {
    manualEntryKey: formatForManualEntry(secret),
    /* The issuer shown in the authenticator app: the clinic's own name, which the
       sign-in page already displays. Public by definition, so it comes from the public
       env rather than the server one. */
    otpauthUri: otpauthUri(secret, email, clientEnv.NEXT_PUBLIC_APP_NAME),
  };
}

export type ConfirmResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: 'no_enrollment' | 'bad_code' };

/**
 * Prove the enrollment works, then switch it on and issue recovery codes.
 *
 * The proof is the point. Enabling because the user pressed a button is how somebody locks
 * themselves out with a mistyped secret or a phone whose clock is wrong, and the recovery
 * path for that is an administrator — which in a small clinic is often the same person.
 *
 * The recovery codes are returned ONCE and never again. Only their hashes are stored, so
 * there is nothing to show a second time; the alternative is a column that can hand an
 * attacker ten permanent bypasses out of a database read.
 */
export async function confirmEnrollment(
  userId: string,
  clinicId: string,
  code: string,
  ip: string | null,
  userAgent: string | null,
): Promise<ConfirmResult> {
  const env = getEnv();
  const db = getDb();

  const [row] = await db
    .select({ id: userTotp.id, secretSealed: userTotp.secretSealed })
    .from(userTotp)
    .where(
      and(
        eq(userTotp.userId, userId),
        isNull(userTotp.disabledAt),
        isNull(userTotp.confirmedAt),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: 'no_enrollment' };

  const secret = openSecret(row.secretSealed, env.SESSION_SECRET);
  if (!secret) return { ok: false, reason: 'no_enrollment' };

  const verdict = verifyCode(secret, code, Date.now(), null);
  if (!verdict.ok) {
    await db.transaction(async (tx) => {
      await writeAuditEvent(tx, {
        clinicId,
        actorUserId: userId,
        actorIp: ip,
        actorUserAgent: userAgent,
        action: 'mfa.confirm',
        outcome: 'denied',
        entityType: 'user_totp',
        entityId: userId,
        metadata: { reason: 'bad_code' },
      });
    });
    return { ok: false, reason: 'bad_code' };
  }

  const codes = generateRecoveryCodes();

  await db.transaction(async (tx) => {
    await tx
      .update(userTotp)
      .set({ confirmedAt: new Date(), lastUsedStep: verdict.step })
      .where(eq(userTotp.id, row.id));

    /* Any codes from a previous enrollment are void: they were minted against a secret
       that no longer governs this account. */
    await tx.delete(userRecoveryCode).where(eq(userRecoveryCode.userId, userId));

    await tx.insert(userRecoveryCode).values(
      codes.map((c) => ({
        userId,
        codeHash: hashRecoveryCode(c, env.SESSION_SECRET),
      })),
    );

    await writeAuditEvent(tx, {
      clinicId,
      actorUserId: userId,
      actorIp: ip,
      actorUserAgent: userAgent,
      action: 'mfa.confirm',
      outcome: 'allowed',
      entityType: 'user_totp',
      entityId: userId,
      metadata: { recoveryCodesIssued: codes.length },
    });
  });

  return { ok: true, recoveryCodes: codes };
}

/* -------------------------------------------------------------------------- */
/* The challenge                                                              */
/* -------------------------------------------------------------------------- */

export type ChallengeResult =
  { ok: true; usedRecoveryCode: boolean; recoveryCodesRemaining: number } | { ok: false };

/**
 * Check a code at sign-in — an authenticator code, or one recovery code.
 *
 * ONE OPAQUE FAILURE for every reason: wrong code, replayed code, spent recovery code, no
 * enrollment at all. The caller has already proved the password, so there is nothing here
 * worth telling them apart, and distinguishing them would say whether an account has a
 * second factor and which kind — which is what someone probing wants to know.
 *
 * A successful TOTP spends its counter in the same statement that checks it, under a row
 * lock, so two requests racing the same code cannot both win.
 */
export async function verifyChallenge(
  userId: string,
  clinicId: string,
  code: string,
  ip: string | null,
  userAgent: string | null,
): Promise<ChallengeResult> {
  const env = getEnv();
  const db = getDb();

  const result = await db.transaction(async (tx): Promise<ChallengeResult> => {
    const [row] = await tx
      .select({
        id: userTotp.id,
        secretSealed: userTotp.secretSealed,
        lastUsedStep: userTotp.lastUsedStep,
      })
      .from(userTotp)
      .where(
        and(
          eq(userTotp.userId, userId),
          isNull(userTotp.disabledAt),
          sql`${userTotp.confirmedAt} is not null`,
        ),
      )
      .limit(1)
      .for('update');

    if (!row) return { ok: false };

    const secret = openSecret(row.secretSealed, env.SESSION_SECRET);
    if (secret) {
      const verdict = verifyCode(secret, code, Date.now(), row.lastUsedStep);
      if (verdict.ok) {
        await tx
          .update(userTotp)
          .set({ lastUsedStep: verdict.step })
          .where(eq(userTotp.id, row.id));

        const [remaining] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(userRecoveryCode)
          .where(
            and(eq(userRecoveryCode.userId, userId), isNull(userRecoveryCode.usedAt)),
          );

        return {
          ok: true,
          usedRecoveryCode: false,
          recoveryCodesRemaining: remaining?.value ?? 0,
        };
      }
    }

    /*
     * Not a TOTP code — try the recovery codes. Spending is an UPDATE guarded on
     * `used_at IS NULL`, so the database decides who gets a code that two requests
     * present at once rather than a read-then-write in application code.
     */
    const spent = await tx
      .update(userRecoveryCode)
      .set({ usedAt: new Date(), usedIp: ip })
      .where(
        and(
          eq(userRecoveryCode.userId, userId),
          eq(userRecoveryCode.codeHash, hashRecoveryCode(code, env.SESSION_SECRET)),
          isNull(userRecoveryCode.usedAt),
        ),
      )
      .returning({ id: userRecoveryCode.id });

    if (spent.length === 0) return { ok: false };

    const [remaining] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(userRecoveryCode)
      .where(and(eq(userRecoveryCode.userId, userId), isNull(userRecoveryCode.usedAt)));

    return {
      ok: true,
      usedRecoveryCode: true,
      recoveryCodesRemaining: remaining?.value ?? 0,
    };
  });

  await db.transaction(async (tx) => {
    await writeAuditEvent(tx, {
      clinicId,
      actorUserId: userId,
      actorIp: ip,
      actorUserAgent: userAgent,
      action: 'mfa.challenge',
      outcome: result.ok ? 'allowed' : 'denied',
      entityType: 'user_totp',
      entityId: userId,
      /* Which factor was used, and how close the account is to having no way back in.
         Never the code itself. */
      metadata: result.ok
        ? {
            factor: result.usedRecoveryCode ? 'recovery_code' : 'totp',
            recoveryCodesRemaining: result.recoveryCodesRemaining,
          }
        : { reason: 'bad_code' },
    });
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/* Removal                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Turn the second factor off — the account's own choice, or an administrator unlocking
 * somebody whose phone is gone.
 *
 * `actorUserId` is recorded separately from the account it affects, because "an
 * administrator removed this person's second factor" and "this person removed their own"
 * are different events and only one of them is routine. An administrator doing it is the
 * lost-phone path, and it is deliberately loud rather than silent.
 *
 * The row is disabled, not deleted, and recovery codes are spent along with it: codes
 * minted against a secret that no longer governs the account must not survive it.
 */
export async function disableMfa(
  userId: string,
  clinicId: string,
  actorUserId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<{ disabled: boolean }> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(userTotp)
      .set({ disabledAt: new Date(), disabledBy: actorUserId })
      .where(and(eq(userTotp.userId, userId), isNull(userTotp.disabledAt)))
      .returning({ id: userTotp.id });

    if (updated.length === 0) return { disabled: false };

    await tx
      .delete(userRecoveryCode)
      .where(and(eq(userRecoveryCode.userId, userId), isNull(userRecoveryCode.usedAt)));

    await writeAuditEvent(tx, {
      clinicId,
      actorUserId,
      actorIp: ip,
      actorUserAgent: userAgent,
      action: 'mfa.disable',
      outcome: 'allowed',
      entityType: 'user_totp',
      entityId: userId,
      metadata: {
        /* The distinction an investigation asks about first. */
        bySelf: actorUserId === userId,
        targetUserId: userId,
      },
    });

    return { disabled: true };
  });
}

/** The email an enrollment URI is labelled with. Read separately so callers pass no PII around. */
export async function accountEmail(userId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ email: userAccount.email })
    .from(userAccount)
    .where(eq(userAccount.id, userId))
    .limit(1);
  return row?.email ?? null;
}
