'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { role, userAccount, userRole } from '@/db/schema';
import { formFields, type FieldErrors } from '@/lib/patient-schemas';
import { writeAuditEvent } from '@/server/audit/log';
import {
  accountEmail,
  beginEnrollment,
  clearChallenge,
  confirmEnrollment,
  disableMfa,
  readChallenge,
  verifyChallenge,
} from '@/server/auth/mfa';
import { verifyPassword } from '@/server/auth/password';
import { checkIpRateLimit, recordAttempt } from '@/server/auth/rate-limit';
import {
  createSession,
  getSession,
  requestMeta,
  safeInet,
  sessionCookieName,
  sessionCookieOptions,
} from '@/server/auth/session';

/**
 * The second factor: setting it up, and getting past it at sign-in.
 *
 * Two audiences in one file, which is the split `actions/staff.ts` was broken up to avoid —
 * so it is worth saying why this one is not the same mistake. The enrollment actions
 * require a live session and operate on the caller's OWN account; the challenge action is
 * reached with no session at all. They are not two trust levels applied to the same kind of
 * object: the challenge is the thing that CREATES the session the others require, and
 * separating them would put the two halves of one flow in two files.
 */

export type MfaFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
  /** Shown once, never retrievable again. Only hashes are stored. */
  recoveryCodes?: string[];
  /**
   * The enrollment secret, returned only from an explicit "start setup" call.
   *
   * Not rendered into the settings page for everyone who opens it: a credential that
   * arrives unasked sits in the HTML of a tab left open on a shared desk, and in the
   * browser cache of people who never enrolled.
   */
  setup?: { manualEntryKey: string; otpauthUri: string };
};

const codeInput = z
  .object({
    /* Wide enough for a 6-digit code or a formatted recovery code; validated for real by
       the verifier, which must not be able to tell a caller which kind they typed. */
    code: z.string().trim().min(6).max(20),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* The sign-in challenge                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Finish a sign-in whose password already verified.
 *
 * ==========================================================================
 * WHAT MAKES THIS SAFE TO REACH WITHOUT A SESSION
 * ==========================================================================
 *
 * The signed challenge token, and nothing else. It is minted only after a password
 * verified, carries an account id and an expiry, is scoped to this path, and is spent
 * whichever way the attempt goes. Without one this action does nothing at all.
 *
 * Rate limited per IP like the login form it continues — a six-digit code is a million
 * guesses, which is a weekend of unthrottled requests and minutes with a botnet.
 */
export async function verifyMfaAction(
  _previous: MfaFormState,
  formData: FormData,
): Promise<MfaFormState> {
  const pending = await readChallenge();
  if (!pending) redirect('/login?error=expired');

  const parsed = codeInput.safeParse(formFields(formData));
  if (!parsed.success) return { message: 'Enter the 6-digit code from your app.' };

  const { ip: rawIp, userAgent } = await requestMeta();
  const ip = safeInet(rawIp);

  const verdict = await checkIpRateLimit(ip);
  if (!verdict.allowed) {
    return {
      message: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.`,
    };
  }

  const result = await verifyChallenge(
    pending.userId,
    pending.clinicId,
    parsed.data.code,
    ip,
    userAgent,
  );

  if (!result.ok) {
    await recordAttempt({ email: 'mfa-challenge', ip, succeeded: false });
    /* One message for a wrong code, a replayed code and a spent recovery code. The caller
       has already proved the password; nothing here is worth telling them apart. */
    return { message: 'That code is not valid. Try the next one your app shows.' };
  }

  const db = getDb();
  const roleCodes = await db
    .select({ code: role.code })
    .from(userRole)
    .innerJoin(role, eq(role.id, userRole.roleId))
    .where(and(eq(userRole.userId, pending.userId), isNull(userRole.revokedAt)));

  /* Only now does a session exist, and the `auth.login` row is written with it — so the
     log never shows a sign-in that did not finish. */
  const created = await db.transaction(async (tx) => {
    await tx
      .update(userAccount)
      .set({ lastLoginAt: new Date() })
      .where(eq(userAccount.id, pending.userId));

    const newSession = await createSession(tx, pending.userId, ip, userAgent);

    await writeAuditEvent(tx, {
      clinicId: pending.clinicId,
      actorUserId: pending.userId,
      actorRoleCodes: roleCodes.map((r) => r.code),
      actorIp: ip,
      actorUserAgent: userAgent,
      sessionId: newSession.id,
      action: 'auth.login',
      outcome: 'allowed',
      entityType: 'session',
      entityId: newSession.id,
      metadata: {
        secondFactor: result.usedRecoveryCode ? 'recovery_code' : 'totp',
      },
    });

    return newSession;
  });

  await clearChallenge();

  const jar = await cookies();
  jar.set(sessionCookieName(), created.token, {
    ...sessionCookieOptions(),
    expires: created.absoluteExpiresAt,
  });

  redirect('/dashboard');
}

/* -------------------------------------------------------------------------- */
/* Enrollment, on your own account                                            */
/* -------------------------------------------------------------------------- */

export async function beginEnrollmentAction(): Promise<MfaFormState> {
  const session = await getSession();
  if (!session) redirect('/login');

  const email = await accountEmail(session.userId);
  if (!email) return { message: 'Could not start setup.' };

  const { ip: rawIp, userAgent } = await requestMeta();
  const result = await beginEnrollment(
    session.userId,
    session.clinicId,
    email,
    safeInet(rawIp),
    userAgent,
  );

  if ('alreadyEnrolled' in result) {
    return { message: 'Two-step sign-in is already on for this account.' };
  }

  return {
    ok: true,
    setup: { manualEntryKey: result.manualEntryKey, otpauthUri: result.otpauthUri },
  };
}

export async function confirmEnrollmentAction(
  _previous: MfaFormState,
  formData: FormData,
): Promise<MfaFormState> {
  const session = await getSession();
  if (!session) redirect('/login');

  const parsed = codeInput.safeParse(formFields(formData));
  if (!parsed.success) return { message: 'Enter the 6-digit code from your app.' };

  const { ip: rawIp, userAgent } = await requestMeta();
  const result = await confirmEnrollment(
    session.userId,
    session.clinicId,
    parsed.data.code,
    safeInet(rawIp),
    userAgent,
  );

  if (!result.ok) {
    return {
      message:
        result.reason === 'no_enrollment'
          ? 'Start the setup again — that enrollment is no longer pending.'
          : 'That code did not match. Check your phone’s clock is right and try the next one.',
    };
  }

  return {
    ok: true,
    message: 'Two-step sign-in is on. Save these recovery codes somewhere safe.',
    recoveryCodes: result.recoveryCodes,
  };
}

const disableInput = z.object({ password: z.string().min(1).max(1024) }).strict();

/**
 * Turn your own second factor off — and prove it is you first.
 *
 * The password is re-checked here even though the caller already holds a session. An
 * unattended unlocked workstation is the threat this whole feature exists for, and letting
 * a passer-by remove the second factor with one click would make it a speed bump rather
 * than a control.
 */
export async function disableMfaAction(
  _previous: MfaFormState,
  formData: FormData,
): Promise<MfaFormState> {
  const session = await getSession();
  if (!session) redirect('/login');

  const parsed = disableInput.safeParse(formFields(formData));
  if (!parsed.success) return { message: 'Enter your password to confirm.' };

  const { ip: rawIp, userAgent } = await requestMeta();
  const ip = safeInet(rawIp);

  const verdict = await checkIpRateLimit(ip);
  if (!verdict.allowed) {
    return {
      message: `Too many attempts. Try again in ${verdict.retryAfterMinutes} minutes.`,
    };
  }

  const [account] = await getDb()
    .select({ passwordHash: userAccount.passwordHash })
    .from(userAccount)
    .where(eq(userAccount.id, session.userId))
    .limit(1);

  const valid = account
    ? await verifyPassword(parsed.data.password, account.passwordHash)
    : false;

  if (!valid) {
    await recordAttempt({ email: session.email, ip, succeeded: false });
    await getDb().transaction(async (tx) => {
      await writeAuditEvent(tx, {
        clinicId: session.clinicId,
        actorUserId: session.userId,
        actorRoleCodes: session.roles,
        actorIp: ip,
        actorUserAgent: userAgent,
        sessionId: session.sessionId,
        action: 'mfa.disable',
        outcome: 'denied',
        entityType: 'user_totp',
        entityId: session.userId,
        metadata: { reason: 'wrong_password' },
      });
    });
    return { message: 'That password is not correct.' };
  }

  await disableMfa(session.userId, session.clinicId, session.userId, ip, userAgent);
  return { ok: true, message: 'Two-step sign-in is off for your account.' };
}
