import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { role, staffSetupToken, userAccount, userRole } from '@/db/schema';
import type { RoleCode } from '@/lib/roles';
import { hashPassword, UNUSABLE_PASSWORD } from '@/server/auth/password';
import { revokeAllSessionsForUser } from '@/server/auth/session';

import { auditedRead, auditedWrite } from './audited';

/**
 * Staff account management. Administrator only.
 *
 * ==========================================================================
 * THE INITIAL-CREDENTIAL FLOW
 * ==========================================================================
 *
 * An administrator NEVER chooses, sees, or transmits a new staff member's password.
 *
 *   1. The administrator creates the account with `password_hash = '!'` — a value the
 *      encoder can never produce, so no input can match it. The account exists and can be
 *      assigned roles, but cannot be signed into.
 *
 *   2. The system generates a 256-bit setup token, stores only its SHA-256, and returns
 *      the raw token ONCE, to that administrator's screen. It is never stored in
 *      plaintext, never logged, and never emailed.
 *
 *   3. The administrator hands the setup link to the person — in the building, or by
 *      phone. Cliniqo sends no email, because an email vendor handling this would need a
 *      BAA, and a password-setup link in an inbox is a credential sitting in a mailbox.
 *
 *   4. The staff member opens the link and sets their own password. The token is marked
 *      used in the same transaction as the password write, so it is genuinely single-use.
 *
 * WHY THIS IS SAFE, and what it is not:
 *
 *   - No shared secret. The administrator cannot sign in as the staff member afterwards,
 *     which matters because §164.312(a)(2)(i) requires that every action be attributable
 *     to one identified human. An admin-chosen password breaks attribution the moment it
 *     is spoken aloud.
 *   - Nothing sensitive is stored recoverably: the token is hashed like a session token,
 *     so a leaked backup yields no usable invitation.
 *   - Time-limited and single-use, so an unclaimed invitation stops being a live
 *     credential. Re-inviting revokes the previous token (a partial unique index enforces
 *     one live invitation per account).
 *   - The token IS a bearer credential while it lives. That is the residual risk, and it
 *     is why the conveyance is in-person and the lifetime is short. Identity is verified
 *     face-to-face by someone who already knows the person works there — which is
 *     stronger than any automated check available to a small clinic.
 */

const SETUP_TOKEN_TTL_HOURS = 48;

export type StaffRow = {
  id: string;
  email: string;
  fullName: string;
  status: 'active' | 'suspended' | 'deactivated';
  roles: string[];
  lastLoginAt: Date | null;
  passwordSet: boolean;
  hasLiveInvitation: boolean;
  archivedAt: Date | null;
};

export type StaffWriteResult =
  | { ok: true; userId: string; setupToken?: string }
  | { ok: false; reason: 'email_taken' | 'not_found' | 'last_admin' | 'self_lockout' };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

export async function listStaff(): Promise<StaffRow[]> {
  return auditedRead(
    {
      permission: 'staff.read',
      action: 'staff.read',
      entityType: 'user_account',
      metadata: { scope: 'staff_list' },
    },
    async (tx, session) => {
      const rows = await tx
        .select({
          id: userAccount.id,
          email: userAccount.email,
          fullName: userAccount.fullName,
          status: userAccount.status,
          lastLoginAt: userAccount.lastLoginAt,
          passwordHash: userAccount.passwordHash,
          archivedAt: userAccount.archivedAt,
        })
        .from(userAccount)
        .where(eq(userAccount.clinicId, session.clinicId))
        .orderBy(asc(userAccount.fullName));

      const grants = await tx
        .select({ userId: userRole.userId, code: role.code })
        .from(userRole)
        .innerJoin(role, eq(role.id, userRole.roleId))
        .where(isNull(userRole.revokedAt));

      const live = await tx
        .select({ userId: staffSetupToken.userId })
        .from(staffSetupToken)
        .where(
          and(
            eq(staffSetupToken.clinicId, session.clinicId),
            isNull(staffSetupToken.usedAt),
            isNull(staffSetupToken.revokedAt),
            sql`${staffSetupToken.expiresAt} > now()`,
          ),
        );

      const liveSet = new Set(live.map((l) => l.userId));

      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        fullName: r.fullName,
        status: r.status as StaffRow['status'],
        roles: grants.filter((g) => g.userId === r.id).map((g) => g.code),
        lastLoginAt: r.lastLoginAt,
        // The hash itself NEVER leaves this function — only whether one is set.
        passwordSet: r.passwordHash !== UNUSABLE_PASSWORD,
        hasLiveInvitation: liveSet.has(r.id),
        archivedAt: r.archivedAt,
      }));
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

/** Issue a setup token inside an existing transaction. Returns the RAW token. */
async function issueSetupToken(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  clinicId: string,
  userId: string,
  createdBy: string,
): Promise<string> {
  // Any previous invitation is revoked — one live token per account, enforced by index.
  await tx
    .update(staffSetupToken)
    .set({ revokedAt: new Date(), revokedBy: createdBy })
    .where(
      and(
        eq(staffSetupToken.userId, userId),
        isNull(staffSetupToken.usedAt),
        isNull(staffSetupToken.revokedAt),
      ),
    );

  const token = randomBytes(32).toString('base64url');

  await tx.insert(staffSetupToken).values({
    clinicId,
    userId,
    tokenHash: hashToken(token),
    createdBy,
    expiresAt: new Date(Date.now() + SETUP_TOKEN_TTL_HOURS * 3_600_000),
  });

  return token;
}

export async function createStaffAccount(
  email: string,
  fullName: string,
  roles: RoleCode[],
): Promise<StaffWriteResult> {
  return auditedWrite(
    {
      permission: 'staff.create',
      action: 'staff.create',
      entityType: 'user_account',
      metadata: { rolesGranted: roles },
    },
    async (tx, session): Promise<StaffWriteResult> => {
      const [existing] = await tx
        .select({ id: userAccount.id })
        .from(userAccount)
        .where(and(eq(userAccount.email, email), isNull(userAccount.archivedAt)))
        .limit(1);

      if (existing) return { ok: false, reason: 'email_taken' };

      const [created] = await tx
        .insert(userAccount)
        .values({
          clinicId: session.clinicId,
          email,
          fullName,
          // No password. The account cannot be signed into until it is claimed.
          passwordHash: UNUSABLE_PASSWORD,
          mustChangePassword: false,
          status: 'active',
          createdBy: session.userId,
        })
        .returning({ id: userAccount.id });

      for (const code of roles) {
        await tx.insert(userRole).values({
          userId: created!.id,
          roleId: sql`(select id from "role" where code = ${code})`,
          grantedBy: session.userId,
        });
      }

      const token = await issueSetupToken(
        tx,
        session.clinicId,
        created!.id,
        session.userId,
      );

      return { ok: true, userId: created!.id, setupToken: token };
    },
  );
}

/** Re-issue an invitation — for an expired one, or a link that went astray. */
export async function reissueSetupToken(userId: string): Promise<StaffWriteResult> {
  return auditedWrite(
    {
      permission: 'staff.update',
      action: 'staff.update',
      entityType: 'user_account',
      entityId: userId,
      metadata: { operation: 'reissue_setup_token' },
    },
    async (tx, session): Promise<StaffWriteResult> => {
      const [target] = await tx
        .select({ id: userAccount.id })
        .from(userAccount)
        .where(
          and(eq(userAccount.id, userId), eq(userAccount.clinicId, session.clinicId)),
        )
        .limit(1);

      if (!target) return { ok: false, reason: 'not_found' };

      const token = await issueSetupToken(tx, session.clinicId, userId, session.userId);
      return { ok: true, userId, setupToken: token };
    },
  );
}

/**
 * Replace a user's roles.
 *
 * Grants are revoked, not deleted — "this person held admin between March and July" is
 * exactly the question an audit asks. Live sessions are then killed so the change takes
 * effect on the user's next request rather than whenever their token expires.
 */
export async function setStaffRoles(
  userId: string,
  roles: RoleCode[],
): Promise<StaffWriteResult> {
  const result = await auditedWrite(
    {
      permission: 'role.assign',
      action: 'role.assign',
      entityType: 'user_account',
      entityId: userId,
      metadata: { rolesGranted: roles },
    },
    async (tx, session): Promise<StaffWriteResult> => {
      const [target] = await tx
        .select({ id: userAccount.id })
        .from(userAccount)
        .where(
          and(eq(userAccount.id, userId), eq(userAccount.clinicId, session.clinicId)),
        )
        .limit(1);

      if (!target) return { ok: false, reason: 'not_found' };

      // Removing your own admin role locks you — and possibly the clinic — out.
      if (userId === session.userId && !roles.includes('admin')) {
        return { ok: false, reason: 'self_lockout' };
      }

      if (!roles.includes('admin')) {
        const [{ remaining } = { remaining: 0 }] = await tx
          .select({ remaining: sql<number>`count(*)::int` })
          .from(userRole)
          .innerJoin(role, eq(role.id, userRole.roleId))
          .innerJoin(userAccount, eq(userAccount.id, userRole.userId))
          .where(
            and(
              eq(role.code, 'admin'),
              isNull(userRole.revokedAt),
              eq(userAccount.status, 'active'),
              isNull(userAccount.archivedAt),
              eq(userAccount.clinicId, session.clinicId),
              sql`${userRole.userId} <> ${userId}`,
            ),
          );

        if (remaining === 0) return { ok: false, reason: 'last_admin' };
      }

      await tx
        .update(userRole)
        .set({ revokedAt: new Date(), revokedBy: session.userId })
        .where(and(eq(userRole.userId, userId), isNull(userRole.revokedAt)));

      for (const code of roles) {
        await tx.insert(userRole).values({
          userId,
          roleId: sql`(select id from "role" where code = ${code})`,
          grantedBy: session.userId,
        });
      }

      return { ok: true, userId };
    },
  );

  if (result.ok) await revokeAllSessionsForUser(userId, 'role_change');
  return result;
}

/**
 * Deactivate or reactivate.
 *
 * Never a delete: a staff account is referenced by every note they signed and every audit
 * row they generated, and that history has to stay coherent.
 */
export async function setStaffStatus(
  userId: string,
  status: 'active' | 'suspended' | 'deactivated',
): Promise<StaffWriteResult> {
  const result = await auditedWrite(
    {
      permission: 'staff.update',
      action: 'staff.update',
      entityType: 'user_account',
      entityId: userId,
      metadata: { toStatus: status },
    },
    async (tx, session): Promise<StaffWriteResult> => {
      if (userId === session.userId && status !== 'active') {
        return { ok: false, reason: 'self_lockout' };
      }

      if (status !== 'active') {
        const [{ remaining } = { remaining: 0 }] = await tx
          .select({ remaining: sql<number>`count(*)::int` })
          .from(userRole)
          .innerJoin(role, eq(role.id, userRole.roleId))
          .innerJoin(userAccount, eq(userAccount.id, userRole.userId))
          .where(
            and(
              eq(role.code, 'admin'),
              isNull(userRole.revokedAt),
              eq(userAccount.status, 'active'),
              isNull(userAccount.archivedAt),
              eq(userAccount.clinicId, session.clinicId),
              sql`${userRole.userId} <> ${userId}`,
            ),
          );

        if (remaining === 0) return { ok: false, reason: 'last_admin' };
      }

      const updated = await tx
        .update(userAccount)
        .set({ status })
        .where(
          and(eq(userAccount.id, userId), eq(userAccount.clinicId, session.clinicId)),
        )
        .returning({ id: userAccount.id });

      return updated.length > 0
        ? { ok: true, userId }
        : { ok: false, reason: 'not_found' };
    },
  );

  // Deactivation must take effect NOW, not at token expiry.
  if (result.ok && status !== 'active') {
    await revokeAllSessionsForUser(userId, 'deactivated');
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Setup token redemption — UNAUTHENTICATED                                   */
/* -------------------------------------------------------------------------- */

export type RedeemResult =
  { ok: true; email: string } | { ok: false; reason: 'invalid_or_expired' };

/**
 * Claim an account with a setup token.
 *
 * The ONE write path in the application that runs without a session — necessarily, since
 * the person has no account to sign into yet. It therefore does its own validation rather
 * than going through the audited layer, which requires an actor:
 *
 *   - The token is looked up BY HASH, so a database read yields nothing usable.
 *   - Unused, unrevoked, and unexpired are all checked in the WHERE clause.
 *   - Marking it used and writing the password happen in ONE transaction, and the update
 *     is conditional on it still being unused — so two simultaneous redemptions cannot
 *     both succeed.
 *   - The audit row is written in that same transaction, attributed to the claiming user
 *     themselves, which is the only honest attribution available.
 *
 * Deliberately returns the same failure for wrong, used, revoked, and expired tokens.
 */
export async function redeemSetupToken(
  token: string,
  newPassword: string,
  ip: string | null,
): Promise<RedeemResult> {
  const db = getDb();
  const now = new Date();

  const [found] = await db
    .select({
      tokenId: staffSetupToken.id,
      userId: staffSetupToken.userId,
      clinicId: staffSetupToken.clinicId,
      email: userAccount.email,
      status: userAccount.status,
      archivedAt: userAccount.archivedAt,
    })
    .from(staffSetupToken)
    .innerJoin(userAccount, eq(userAccount.id, staffSetupToken.userId))
    .where(
      and(
        eq(staffSetupToken.tokenHash, hashToken(token)),
        isNull(staffSetupToken.usedAt),
        isNull(staffSetupToken.revokedAt),
        sql`${staffSetupToken.expiresAt} > now()`,
      ),
    )
    .limit(1);

  if (!found || found.status !== 'active' || found.archivedAt !== null) {
    return { ok: false, reason: 'invalid_or_expired' };
  }

  const passwordHash = await hashPassword(newPassword);
  const { writeAuditEvent } = await import('@/server/audit/log');

  return db.transaction(async (tx) => {
    // Conditional on still being unused: the loser of a race changes zero rows.
    const claimed = await tx
      .update(staffSetupToken)
      .set({ usedAt: now, usedIp: ip })
      .where(and(eq(staffSetupToken.id, found.tokenId), isNull(staffSetupToken.usedAt)))
      .returning({ id: staffSetupToken.id });

    if (claimed.length === 0) return { ok: false, reason: 'invalid_or_expired' };

    await tx
      .update(userAccount)
      .set({ passwordHash, passwordChangedAt: now, mustChangePassword: false })
      .where(eq(userAccount.id, found.userId));

    await writeAuditEvent(tx, {
      clinicId: found.clinicId,
      actorUserId: found.userId,
      actorIp: ip,
      action: 'auth.password_change',
      outcome: 'allowed',
      entityType: 'user_account',
      entityId: found.userId,
      metadata: { via: 'setup_token' },
    });

    return { ok: true, email: found.email };
  });
}

/* -------------------------------------------------------------------------- */
/* Self-service password change — AUTHENTICATED, no permission required        */
/* -------------------------------------------------------------------------- */

export type PasswordChangeResult =
  | { ok: true }
  | { ok: false; reason: 'wrong_password' | 'reused_password' | 'no_password_set' };

/**
 * Change your own password.
 *
 * WHY THIS IS NOT BEHIND A PERMISSION
 * -----------------------------------
 * Every account may change its own password; gating that on a grant would mean an
 * administrator could lock someone out of their own credentials, and would break the
 * forced-change path below — the account with an expired credential is exactly the one
 * least able to satisfy an extra check. So it runs outside `auditedOperation`, which
 * requires a permission, and writes its own audit row instead. Same precedent as
 * `redeemSetupToken` above. It touches no patient table, so the PHI choke point does not
 * apply; `user_account` is identity, not a chart.
 *
 * THE CURRENT PASSWORD IS REQUIRED EVEN THOUGH THE CALLER IS SIGNED IN
 * --------------------------------------------------------------------
 * A live session is not proof of identity at the keyboard — an unattended terminal or a
 * stolen cookie is a session too. Without this check, a few seconds at someone's desk is
 * enough to take their account permanently. Re-authenticating turns that into an attack
 * needing the password, which is the thing being changed.
 *
 * The one exception is an account whose password is unusable (`UNUSABLE_PASSWORD`) — a
 * staff member who was issued a setup link and never redeemed it has no current password
 * to prove. That path is refused here rather than waved through: they must use the setup
 * link, which is a single-use token an administrator issued, not a self-service reset.
 *
 * EVERY SESSION IS REVOKED, INCLUDING THIS ONE
 * --------------------------------------------
 * If the password is being changed because it may be known to someone else, leaving any
 * session alive defeats the change — and we cannot tell the owner's other sessions from
 * an intruder's. Signing everyone out is the only safe reading, so the caller is returned
 * to the login form.
 */
export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<PasswordChangeResult> {
  const { requireSession } = await import('@/server/auth/session');
  const { verifyPassword } = await import('@/server/auth/password');
  const { writeAuditEvent } = await import('@/server/audit/log');
  const { requestMeta, safeInet } = await import('@/server/auth/session');

  const active = await requireSession();
  const db = getDb();

  const [account] = await db
    .select({ passwordHash: userAccount.passwordHash })
    .from(userAccount)
    .where(and(eq(userAccount.id, active.userId), isNull(userAccount.archivedAt)))
    .limit(1);

  if (!account || account.passwordHash === UNUSABLE_PASSWORD) {
    return { ok: false, reason: 'no_password_set' };
  }

  const { ip: rawIp } = await requestMeta();
  const ip = safeInet(rawIp);

  const currentValid = await verifyPassword(currentPassword, account.passwordHash);
  if (!currentValid) {
    /* A failed re-authentication is a security event: it is what an attempted account
       takeover from an open session looks like. Recorded with no password material. */
    await db.transaction(async (tx) => {
      await writeAuditEvent(tx, {
        clinicId: active.clinicId,
        actorUserId: active.userId,
        actorIp: ip,
        action: 'auth.password_change',
        outcome: 'denied',
        entityType: 'user_account',
        entityId: active.userId,
        metadata: { reason: 'wrong_current_password' },
      });
    });
    return { ok: false, reason: 'wrong_password' };
  }

  // Reusing the same password would clear must_change_password without changing anything.
  const reused = await verifyPassword(newPassword, account.passwordHash);
  if (reused) return { ok: false, reason: 'reused_password' };

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(userAccount)
      .set({ passwordHash, passwordChangedAt: now, mustChangePassword: false })
      .where(eq(userAccount.id, active.userId));

    await writeAuditEvent(tx, {
      clinicId: active.clinicId,
      actorUserId: active.userId,
      actorIp: ip,
      action: 'auth.password_change',
      outcome: 'allowed',
      entityType: 'user_account',
      entityId: active.userId,
      metadata: { via: 'self_service' },
    });
  });

  /* After the commit: a revocation that ran inside the transaction and then rolled back
     would sign everyone out without changing the password. */
  await revokeAllSessionsForUser(active.userId, 'admin_revoke');

  return { ok: true };
}
