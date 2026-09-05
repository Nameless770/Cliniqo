'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { role, userAccount, userRole } from '@/db/schema';
import { getEnv } from '@/env/server';
import { writeAuditEvent } from '@/server/audit/log';
import {
  decoyHash,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '@/server/auth/password';
import { checkIpRateLimit, recordAttempt } from '@/server/auth/rate-limit';
import {
  createSession,
  getSession,
  requestMeta,
  revokeSession,
  safeInet,
  sessionCookieName,
  sessionCookieOptions,
} from '@/server/auth/session';

/**
 * Authentication actions.
 *
 * Every exported function here is a PUBLIC HTTP ENDPOINT. Anyone who can reach the app
 * can call it with any arguments, so input is validated before it is used and no caller
 * is trusted to have checked anything first.
 */

const loginSchema = z.object({
  // Deliberately permissive: this is a lookup key, not a new address being registered.
  // Rejecting an unusual-but-valid address at the login form locks a real user out.
  email: z.string().trim().toLowerCase().min(3).max(254),
  // No complexity rules on the way IN. Composition requirements belong at the point a
  // password is set, never at verification, where they only leak policy to an attacker.
  password: z.string().min(1).max(1024),
});

export type LoginState = {
  error?: string;
  /** Echoed so a failed attempt does not make the user retype. Never the password. */
  email?: string;
};

/**
 * One message for every failure.
 *
 * "No such account", "wrong password", and "account locked" are three different facts,
 * and telling them apart turns the login form into an account-enumeration oracle — which
 * for a clinic reveals who works there. The real reason is recorded in the audit log,
 * where only an administrator can read it.
 *
 * The cost is a locked-out user who cannot tell why. That is a phone call to an
 * administrator, and it is the right trade for PHI.
 */
const GENERIC_FAILURE = 'Invalid email or password.';

export async function login(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return { error: GENERIC_FAILURE };
  }

  const { email, password } = parsed.data;
  const { ip: rawIp, userAgent } = await requestMeta();
  const ip = safeInet(rawIp);
  const db = getDb();
  const env = getEnv();

  /* 1. Per-IP limiter first — before any database lookup or hashing, so a flood costs
        one indexed count() rather than a 67 MB scrypt derivation each. */
  const ipVerdict = await checkIpRateLimit(ip);
  if (!ipVerdict.allowed) {
    await recordAttempt({ email, ip, succeeded: false });
    return {
      email,
      error: `Too many attempts. Try again in ${ipVerdict.retryAfterMinutes} minutes.`,
    };
  }

  /* 2. Look the account up. Email is globally unique among live accounts. */
  const [account] = await db
    .select({
      id: userAccount.id,
      clinicId: userAccount.clinicId,
      passwordHash: userAccount.passwordHash,
      status: userAccount.status,
      failedLoginCount: userAccount.failedLoginCount,
      lockedUntil: userAccount.lockedUntil,
    })
    .from(userAccount)
    .where(and(eq(userAccount.email, email), isNull(userAccount.archivedAt)))
    .limit(1);

  /* 3. Unknown account: still perform a real verification against a decoy hash, so this
        branch costs the same wall-clock time as a wrong password. Returning early here
        is what makes login timing a working enumeration oracle. */
  if (!account) {
    await verifyPassword(password, await decoyHash());
    await recordAttempt({ email, ip, succeeded: false });
    return { email, error: GENERIC_FAILURE };
  }

  const now = new Date();
  const locked = account.lockedUntil !== null && account.lockedUntil > now;

  /* 4. Locked or not active. Verify anyway — same reasoning as above: skipping the work
        here would make a locked account measurably faster to probe. */
  if (locked || account.status !== 'active') {
    await verifyPassword(password, account.passwordHash);
    await recordAttempt({
      email,
      ip,
      userId: account.id,
      clinicId: account.clinicId,
      succeeded: false,
    });

    await db.transaction(async (tx) => {
      await writeAuditEvent(tx, {
        clinicId: account.clinicId,
        actorUserId: account.id,
        actorIp: ip,
        actorUserAgent: userAgent,
        action: 'auth.login',
        outcome: 'denied',
        entityType: 'user_account',
        entityId: account.id,
        metadata: { reason: locked ? 'locked' : `status:${account.status}` },
      });
    });

    return { email, error: GENERIC_FAILURE };
  }

  /* 5. Verify. */
  const valid = await verifyPassword(password, account.passwordHash);

  if (!valid) {
    const failures = account.failedLoginCount + 1;
    const shouldLock = failures >= env.AUTH_RATE_LIMIT_MAX_ATTEMPTS;

    await db.transaction(async (tx) => {
      await tx
        .update(userAccount)
        .set({
          failedLoginCount: failures,
          lockedUntil: shouldLock
            ? new Date(Date.now() + env.AUTH_LOCKOUT_MINUTES * 60_000)
            : account.lockedUntil,
        })
        .where(eq(userAccount.id, account.id));

      await writeAuditEvent(tx, {
        clinicId: account.clinicId,
        actorUserId: account.id,
        actorIp: ip,
        actorUserAgent: userAgent,
        action: 'auth.login',
        outcome: 'denied',
        entityType: 'user_account',
        entityId: account.id,
        // Counts, never the attempted password.
        metadata: { reason: 'bad_password', failureCount: failures, locked: shouldLock },
      });
    });

    await recordAttempt({
      email,
      ip,
      userId: account.id,
      clinicId: account.clinicId,
      succeeded: false,
    });

    return { email, error: GENERIC_FAILURE };
  }

  /* 6. Success. Session row and audit entry commit together — a session that exists
        without a corresponding log line is exactly what the audit is meant to prevent. */
  const roleCodes = await db
    .select({ code: role.code })
    .from(userRole)
    .innerJoin(role, eq(role.id, userRole.roleId))
    .where(and(eq(userRole.userId, account.id), isNull(userRole.revokedAt)));

  // Transparent upgrade if the stored hash predates the current cost parameters. This is
  // the only moment the plaintext is available to re-derive from.
  const rehashed = needsRehash(account.passwordHash)
    ? await hashPassword(password)
    : null;

  const created = await db.transaction(async (tx) => {
    await tx
      .update(userAccount)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
        ...(rehashed ? { passwordHash: rehashed } : {}),
      })
      .where(eq(userAccount.id, account.id));

    const newSession = await createSession(tx, account.id, ip, userAgent);

    await writeAuditEvent(tx, {
      clinicId: account.clinicId,
      actorUserId: account.id,
      actorRoleCodes: roleCodes.map((r) => r.code),
      actorIp: ip,
      actorUserAgent: userAgent,
      sessionId: newSession.id,
      action: 'auth.login',
      outcome: 'allowed',
      entityType: 'session',
      entityId: newSession.id,
    });

    return newSession;
  });

  await recordAttempt({
    email,
    ip,
    userId: account.id,
    clinicId: account.clinicId,
    succeeded: true,
  });

  const jar = await cookies();
  jar.set(sessionCookieName(), created.token, {
    ...sessionCookieOptions(),
    expires: created.absoluteExpiresAt,
  });

  redirect('/dashboard');
}

/**
 * Log out.
 *
 * Revokes the row server-side as well as clearing the cookie. Clearing the cookie alone
 * would leave a live session that anyone holding a copy of the token — a shared
 * workstation, a proxy log — could keep using.
 */
export async function logout(): Promise<void> {
  const active = await getSession();

  if (active) {
    await revokeSession(active.sessionId, 'logout');

    await getDb().transaction(async (tx) => {
      await writeAuditEvent(tx, {
        clinicId: active.clinicId,
        actorUserId: active.userId,
        actorRoleCodes: active.roles,
        sessionId: active.sessionId,
        action: 'auth.logout',
        outcome: 'allowed',
        entityType: 'session',
        entityId: active.sessionId,
      });
    });
  }

  const jar = await cookies();
  jar.delete(sessionCookieName());

  redirect('/login');
}
