import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { clinic, userAccount } from '@/db/schema';
import { describeError } from '@/lib/pg-errors';
import { writeAuditEvent } from '@/server/audit/log';

import { hashPassword } from './password';

/**
 * A staff member creating an account with an email address and a password.
 *
 * ==========================================================================
 * WEAKER THAN GOOGLE, SO IT GRANTS LESS
 * ==========================================================================
 *
 * Nothing proves the person owns the address they typed. So the account:
 *
 *   - gets NO roles, and roles are the only source of permissions — an administrator
 *     granting one on the Staff screen is the approval, and that screen warns them the
 *     address was never confirmed;
 *   - does NOT sign anyone in. The person signs in afterwards on the ordinary sign-in page,
 *     through the ordinary rate limit, lockout and second-factor checks;
 *   - is never linked to a Google identity by email (see the staff Google callback), so
 *     registering a colleague's address cannot put the registrant inside the colleague's
 *     Google sign-in.
 *
 * ==========================================================================
 * THE SAME ANSWER WHETHER OR NOT THE ADDRESS WAS FREE
 * ==========================================================================
 *
 * The caller responds identically either way, so this function must not give the answer
 * away through timing either: the password is hashed BEFORE the address is looked up, on
 * every call. scrypt dominates the cost of this function, and a taken address that skipped
 * it would answer in a fraction of the time.
 *
 * A taken address changes nothing — in particular it never replaces the existing account's
 * password, which would turn "create an account" into "take over any account".
 */

export type PasswordSignupInput = {
  email: string;
  fullName: string;
  password: string;
};

export async function requestStaffAccessWithPassword(
  input: PasswordSignupInput,
  clinicId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<{ created: boolean }> {
  /* First, unconditionally. See the header. */
  const passwordHash = await hashPassword(input.password);

  try {
    return await getDb().transaction(async (tx) => {
      const [target] = await tx
        .select({ id: clinic.id })
        .from(clinic)
        .where(eq(clinic.id, clinicId))
        .limit(1);
      if (!target) return { created: false };

      const [taken] = await tx
        .select({ id: userAccount.id })
        .from(userAccount)
        .where(and(eq(userAccount.email, input.email), isNull(userAccount.archivedAt)))
        .limit(1);
      if (taken) return { created: false };

      const now = new Date();
      const [account] = await tx
        .insert(userAccount)
        .values({
          clinicId,
          email: input.email,
          fullName: input.fullName,
          passwordHash,
          passwordChangedAt: now,
          mustChangePassword: false,
          status: 'active',
          createdBy: null,
          selfRegisteredAt: now,
        })
        .returning({ id: userAccount.id });

      await writeAuditEvent(tx, {
        clinicId,
        actorUserId: account!.id,
        actorRoleCodes: [],
        actorIp: ip,
        actorUserAgent: userAgent,
        action: 'staff.create',
        outcome: 'allowed',
        entityType: 'user_account',
        entityId: account!.id,
        metadata: {
          via: 'self_signup_password',
          rolesGranted: [],
          emailConfirmed: false,
        },
      });

      return { created: true };
    });
  } catch (error) {
    /* A race on the unique address index lands here, and is simply "not created". */
    console.error('[signup] staff password registration failed:', describeError(error));
    return { created: false };
  }
}
