import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { clinic, userAccount, userIdentity } from '@/db/schema';
import { describeError } from '@/lib/pg-errors';
import { writeAuditEvent } from '@/server/audit/log';

import { UNUSABLE_PASSWORD } from './password';
import type { PendingSignup } from './pending-signup';
import { createSession } from './session';

/**
 * A staff member creating their own account.
 *
 * ==========================================================================
 * THE ACCOUNT GRANTS NOTHING
 * ==========================================================================
 *
 * Created with no roles, and roles are the only source of permissions. It can sign in and be
 * told it is waiting; every page and every server action still refuses it, because each one
 * checks a permission it does not hold. Access starts when an administrator assigns a role
 * on the Staff screen, and that assignment is audited as `role.assign` like any other.
 *
 * That is what keeps one-account-per-human (§164.312(a)(2)(i)) and least privilege
 * (§164.502(b)) with an administrator. The person asking for access never chooses what it
 * is. This file inserts into `user_account` and `user_identity` and never into `user_role`,
 * and a security invariant holds it to that.
 *
 * No password either. The account is reachable only through the Google identity that created
 * it, so there is no password to guess, reuse or phish.
 */

export type StaffSignupResult =
  | { ok: true; userId: string; token: string; expiresAt: Date }
  | { ok: false };

export async function createSelfRegisteredStaff(
  pending: PendingSignup,
  fullName: string,
  clinicId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<StaffSignupResult> {
  if (pending.aud !== 'staff') return { ok: false };

  const db = getDb();
  const now = new Date();

  try {
    return await db.transaction(async (tx): Promise<StaffSignupResult> => {
      /* A misconfigured SIGNUP_CLINIC_ID must fail closed, not insert against nothing. */
      const [target] = await tx
        .select({ id: clinic.id })
        .from(clinic)
        .where(eq(clinic.id, clinicId))
        .limit(1);
      if (!target) return { ok: false };

      /*
       * Someone else may have been given an account for this address, or linked this Google
       * subject, in the minutes since the token was issued. Either way this is not a new
       * person, and the answer is the same generic refusal as every other.
       */
      const [emailTaken] = await tx
        .select({ id: userAccount.id })
        .from(userAccount)
        .where(and(eq(userAccount.email, pending.email), isNull(userAccount.archivedAt)))
        .limit(1);
      const [subjectTaken] = await tx
        .select({ id: userIdentity.id })
        .from(userIdentity)
        .where(
          and(eq(userIdentity.provider, 'google'), eq(userIdentity.subject, pending.sub)),
        )
        .limit(1);
      if (emailTaken || subjectTaken) return { ok: false };

      const [created] = await tx
        .insert(userAccount)
        .values({
          clinicId,
          email: pending.email,
          fullName,
          passwordHash: UNUSABLE_PASSWORD,
          mustChangePassword: false,
          status: 'active',
          createdBy: null,
          lastLoginAt: now,
          selfRegisteredAt: now,
        })
        .returning({ id: userAccount.id });
      const userId = created!.id;

      await tx.insert(userIdentity).values({
        userId,
        provider: 'google',
        subject: pending.sub,
        emailAtLink: pending.email,
        lastUsedAt: now,
      });

      /*
       * The new person is the actor on all three rows: nobody else did this. `rolesGranted`
       * is written out as an empty list rather than omitted, so the row itself answers
       * "what access did this sign-up get?" without a join.
       */
      await writeAuditEvent(tx, {
        clinicId,
        actorUserId: userId,
        actorRoleCodes: [],
        actorIp: ip,
        actorUserAgent: userAgent,
        action: 'staff.create',
        outcome: 'allowed',
        entityType: 'user_account',
        entityId: userId,
        metadata: { via: 'self_signup', rolesGranted: [] },
      });

      await writeAuditEvent(tx, {
        clinicId,
        actorUserId: userId,
        actorRoleCodes: [],
        actorIp: ip,
        actorUserAgent: userAgent,
        action: 'identity.link',
        outcome: 'allowed',
        entityType: 'user_identity',
        entityId: userId,
        metadata: { provider: 'google', via: 'self_signup' },
      });

      const session = await createSession(tx, userId, ip, userAgent);

      await writeAuditEvent(tx, {
        clinicId,
        actorUserId: userId,
        actorRoleCodes: [],
        actorIp: ip,
        actorUserAgent: userAgent,
        sessionId: session.id,
        action: 'auth.login',
        outcome: 'allowed',
        entityType: 'session',
        entityId: session.id,
        metadata: { via: 'google', firstSignIn: true },
      });

      return {
        ok: true,
        userId,
        token: session.token,
        expiresAt: session.absoluteExpiresAt,
      };
    });
  } catch (error) {
    /*
     * Two sign-ups for one address racing past the checks above land here, on the unique
     * index — which is what actually guarantees one account per address; the checks only
     * make the common case tidy. So does an outage. Both are logged as a code, never a
     * message (see `describeError`): a silent catch here would repeat the bug that made a
     * database outage look like a refused Google sign-in.
     */
    console.error('[signup] staff self-registration failed:', describeError(error));
    return { ok: false };
  }
}
