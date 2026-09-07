import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { patient, patientAccount, patientSetupToken } from '@/db/schema';
import { hashPassword, verifyPassword, decoyHash } from '@/server/auth/password';
import { writeAuditEvent } from '@/server/audit/log';
import { auditedWrite } from '@/server/data-access/audited';
import { createPatientSession } from './session';

/**
 * Patient portal accounts: invitation (staff), redemption (the patient), and login.
 *
 * The invitation mirrors the staff setup-token flow exactly — a 256-bit token stored only
 * as its SHA-256, shown to staff once, redeemed by the patient to set their own password.
 * There is no public signup, so the portal cannot be used to enumerate which patients or
 * emails exist.
 */

const SETUP_TOKEN_TTL_HOURS = 72;

function hashSetupToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type InviteResult =
  | { ok: true; token: string; email: string }
  | { ok: false; reason: 'no_email' | 'not_found' };

/**
 * Staff invites a patient to the portal.
 *
 * Goes through the STAFF audited layer: it is a staff action on a patient record, gated on
 * `patient.update` (front desk), and it writes a `patient.portal_invite` audit row naming
 * the patient. Returns the raw token for the staff member to hand over — shown once, never
 * stored in the clear.
 */
export async function invitePatient(patientId: string): Promise<InviteResult> {
  return auditedWrite<InviteResult>(
    {
      permission: 'patient.update',
      action: 'patient.portal_invite',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
    },
    async (tx, session): Promise<InviteResult> => {
      const [p] = await tx
        .select({ email: patient.email, clinicId: patient.clinicId })
        .from(patient)
        .where(
          and(
            eq(patient.id, patientId),
            eq(patient.clinicId, session.clinicId),
            isNull(patient.archivedAt),
          ),
        )
        .limit(1);

      if (!p) return { ok: false, reason: 'not_found' };
      // The invite is sent to the patient's own email; without one there is nowhere to
      // send it and no address to key the account on.
      if (!p.email) return { ok: false, reason: 'no_email' };

      // One live invite per patient — revoke any earlier unused one first.
      await tx
        .update(patientSetupToken)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(patientSetupToken.patientId, patientId),
            isNull(patientSetupToken.usedAt),
            isNull(patientSetupToken.revokedAt),
          ),
        );

      const token = randomBytes(32).toString('base64url');
      await tx.insert(patientSetupToken).values({
        clinicId: session.clinicId,
        patientId,
        tokenHash: hashSetupToken(token),
        email: p.email,
        createdBy: session.userId,
        expiresAt: new Date(Date.now() + SETUP_TOKEN_TTL_HOURS * 3_600_000),
      });

      return { ok: true, token, email: p.email };
    },
  );
}

export type RedeemResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid_or_expired' };

/**
 * The patient redeems an invite and sets their password.
 *
 * Unauthenticated by necessity — they have no account yet — so it does its own validation
 * rather than going through the staff audited layer, exactly like staff `redeemSetupToken`:
 * token looked up by hash; unused, unrevoked and unexpired all checked in the query;
 * account upsert, token consumption, and the audit row committed in one transaction, with
 * the "mark used" conditional on it still being unused so two redemptions cannot race.
 */
export async function redeemPatientSetupToken(
  token: string,
  newPassword: string,
  ip: string | null,
): Promise<RedeemResult> {
  const db = getDb();
  const now = new Date();

  const [found] = await db
    .select({
      tokenId: patientSetupToken.id,
      clinicId: patientSetupToken.clinicId,
      patientId: patientSetupToken.patientId,
      email: patientSetupToken.email,
      existingAccountId: patientAccount.id,
      patientArchivedAt: patient.archivedAt,
    })
    .from(patientSetupToken)
    .innerJoin(patient, eq(patient.id, patientSetupToken.patientId))
    .leftJoin(
      patientAccount,
      and(
        eq(patientAccount.patientId, patientSetupToken.patientId),
        isNull(patientAccount.archivedAt),
      ),
    )
    .where(
      and(
        eq(patientSetupToken.tokenHash, hashSetupToken(token)),
        isNull(patientSetupToken.usedAt),
        isNull(patientSetupToken.revokedAt),
        sql`${patientSetupToken.expiresAt} > now()`,
      ),
    )
    .limit(1);

  if (!found || found.patientArchivedAt !== null) {
    return { ok: false, reason: 'invalid_or_expired' };
  }

  const passwordHash = await hashPassword(newPassword);

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(patientSetupToken)
      .set({ usedAt: now, usedIp: ip })
      .where(
        and(eq(patientSetupToken.id, found.tokenId), isNull(patientSetupToken.usedAt)),
      )
      .returning({ id: patientSetupToken.id });

    if (claimed.length === 0) return { ok: false, reason: 'invalid_or_expired' };

    let accountId = found.existingAccountId;
    if (accountId) {
      await tx
        .update(patientAccount)
        .set({ passwordHash, passwordChangedAt: now })
        .where(eq(patientAccount.id, accountId));
    } else {
      const [created] = await tx
        .insert(patientAccount)
        .values({
          clinicId: found.clinicId,
          patientId: found.patientId,
          email: found.email,
          passwordHash,
          passwordChangedAt: now,
        })
        .returning({ id: patientAccount.id });
      accountId = created!.id;
    }

    await writeAuditEvent(tx, {
      clinicId: found.clinicId,
      actorPatientAccountId: accountId,
      actorIp: ip,
      action: 'auth.password_change',
      outcome: 'allowed',
      subjectPatientId: found.patientId,
      entityType: 'patient_account',
      entityId: accountId,
      metadata: { via: 'portal_setup_token' },
    });

    return { ok: true, email: found.email };
  });
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false };

/**
 * Verify a patient login and open a session.
 *
 * Constant-time-ish: a missing account still pays for a full hash derivation (`decoyHash`)
 * so the form cannot be used to tell a registered address from an unregistered one. The
 * successful login is audited with the patient as actor.
 */
export async function verifyPatientLogin(
  email: string,
  password: string,
  ip: string | null,
  userAgent: string | null,
): Promise<LoginResult> {
  const db = getDb();

  const [account] = await db
    .select({
      id: patientAccount.id,
      clinicId: patientAccount.clinicId,
      patientId: patientAccount.patientId,
      passwordHash: patientAccount.passwordHash,
      status: patientAccount.status,
    })
    .from(patientAccount)
    .where(and(eq(patientAccount.email, email), isNull(patientAccount.archivedAt)))
    .limit(1);

  if (!account) {
    await decoyHash();
    return { ok: false };
  }

  const valid = await verifyPassword(password, account.passwordHash);
  if (!valid || account.status !== 'active') {
    return { ok: false };
  }

  return db.transaction(async (tx) => {
    const created = await createPatientSession(tx, account.id, userAgent);

    await tx
      .update(patientAccount)
      .set({ lastLoginAt: new Date() })
      .where(eq(patientAccount.id, account.id));

    await writeAuditEvent(tx, {
      clinicId: account.clinicId,
      actorPatientAccountId: account.id,
      actorIp: ip,
      actorUserAgent: userAgent,
      sessionId: created.id,
      action: 'auth.login',
      outcome: 'allowed',
      subjectPatientId: account.patientId,
      metadata: { via: 'portal' },
    });

    return { ok: true, token: created.token, expiresAt: created.absoluteExpiresAt };
  });
}
