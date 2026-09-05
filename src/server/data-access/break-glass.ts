import 'server-only';

import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { breakGlassGrant, patient, userAccount } from '@/db/schema';

import { auditedRead, auditedWrite } from './audited';

/**
 * Emergency access — security review finding F11, HIPAA §164.312(a)(2)(ii).
 *
 * ==========================================================================
 * WHAT BREAK-GLASS ACTUALLY DOES HERE, AND WHY IT NEEDED RETHINKING
 * ==========================================================================
 *
 * The classic emergency-access design lets a clinician reach a record they are normally
 * scoped away from. That design does not fit this application: decision 1 in the data
 * model gave clinicians access to every patient at their clinic, so there is no scope to
 * break out of. A grant modelled that way would have been ceremony that granted nothing —
 * a button that writes a log line and changes no behaviour, which is worse than no button
 * because it looks like a control.
 *
 * What DOES restrict a clinician in an emergency is the PHI read budget added for F1. A
 * mass-casualty intake, a ward round after an outage, an urgent audit of who was given
 * which medication — all of them read many records fast, and all of them would hit a
 * ceiling sized for ordinary clinic work.
 *
 * So break-glass here means: **lift the read budget for a bounded window, in exchange for
 * a stated reason and a review.** That is a real capability, it maps to what the
 * regulation asks for ("procedures for obtaining necessary ePHI during an emergency"),
 * and it degrades correctly — if patient scoping is tightened later, the same grant is
 * already the place to widen it.
 *
 * The trade is explicit and deliberately uncomfortable: the clinician gets what they need
 * immediately and unconditionally, and an administrator finds out. Emergency access that
 * can be refused in the moment is not emergency access.
 */

const GRANT_TTL_HOURS = 4;

export type BreakGlassResult =
  | { ok: true; grantId: string; expiresAt: Date }
  | { ok: false; reason: 'not_found' | 'already_active' };

export type BreakGlassRow = {
  id: string;
  patientId: string;
  patientMrn: string;
  userId: string;
  userName: string;
  reason: string;
  grantedAt: Date;
  expiresAt: Date;
  reviewOutcome: 'pending' | 'justified' | 'not_justified';
  reviewedAt: Date | null;
};

/* -------------------------------------------------------------------------- */

/**
 * Take emergency access to a patient's record.
 *
 * NEVER refused on the grounds of the reason given. The reason is recorded, not judged —
 * a clinician typing a justification during an emergency is not in a position to argue
 * with a validator, and a system that can deny them is a system that will deny the wrong
 * person at the wrong moment. Oversight happens afterwards, in the review queue.
 *
 * The only refusal is "you already have one", which is a no-op rather than a denial.
 */
export async function requestBreakGlass(
  patientId: string,
  reason: string,
): Promise<BreakGlassResult> {
  return auditedWrite(
    {
      permission: 'breakglass.use',
      action: 'breakglass.grant',
      entityType: 'break_glass_grant',
      subjectPatientId: patientId,
      // The stated reason belongs in `purpose`, which is what a reviewer reads.
      purpose: reason,
      metadata: { ttlHours: GRANT_TTL_HOURS },
    },
    async (tx, session): Promise<BreakGlassResult> => {
      const [target] = await tx
        .select({ id: patient.id })
        .from(patient)
        .where(and(eq(patient.id, patientId), eq(patient.clinicId, session.clinicId)))
        .limit(1);

      if (!target) return { ok: false, reason: 'not_found' };

      const [existing] = await tx
        .select({ id: breakGlassGrant.id, expiresAt: breakGlassGrant.expiresAt })
        .from(breakGlassGrant)
        .where(
          and(
            eq(breakGlassGrant.userId, session.userId),
            eq(breakGlassGrant.patientId, patientId),
            isNull(breakGlassGrant.revokedAt),
            gt(breakGlassGrant.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (existing) {
        return { ok: true, grantId: existing.id, expiresAt: existing.expiresAt };
      }

      const expiresAt = new Date(Date.now() + GRANT_TTL_HOURS * 3_600_000);

      const [created] = await tx
        .insert(breakGlassGrant)
        .values({
          clinicId: session.clinicId,
          userId: session.userId,
          patientId,
          reason,
          expiresAt,
          reviewOutcome: 'pending',
        })
        .returning({ id: breakGlassGrant.id });

      return { ok: true, grantId: created!.id, expiresAt };
    },
  );
}

/**
 * Does this actor hold live emergency access right now?
 *
 * Consumed by the read budget. Deliberately NOT wrapped in the audited layer: it runs
 * inside the budget check on the read path, and auditing a check that happens before
 * every read would double the log for no information — the read itself is already
 * recorded, and the grant that permitted it was recorded when it was taken.
 */
export async function hasActiveBreakGlass(userId: string): Promise<boolean> {
  try {
    const [row] = await getDb()
      .select({ id: breakGlassGrant.id })
      .from(breakGlassGrant)
      .where(
        and(
          eq(breakGlassGrant.userId, userId),
          isNull(breakGlassGrant.revokedAt),
          gt(breakGlassGrant.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return Boolean(row);
  } catch {
    // Fail CLOSED here: an unreadable grant table means no exemption, so the ordinary
    // budget applies. That is the safe direction — the alternative would let a database
    // blip silently disable the throttle.
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Review                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The review queue.
 *
 * This is the control that makes break-glass acceptable. Access is never blocked in the
 * moment, so the entire safeguard is that somebody reads this list afterwards —
 * §164.308(a)(1)(ii)(D) information system activity review.
 */
export async function listBreakGlassGrants(
  onlyPending: boolean,
): Promise<BreakGlassRow[]> {
  return auditedRead(
    {
      permission: 'audit.read',
      action: 'audit.read',
      entityType: 'break_glass_grant',
      metadata: { scope: 'break_glass_review', onlyPending },
    },
    async (tx, session) => {
      const filters = [eq(breakGlassGrant.clinicId, session.clinicId)];
      if (onlyPending) {
        filters.push(eq(breakGlassGrant.reviewOutcome, 'pending'));
      }

      const rows = await tx
        .select({
          id: breakGlassGrant.id,
          patientId: breakGlassGrant.patientId,
          patientMrn: patient.mrn,
          userId: breakGlassGrant.userId,
          userName: userAccount.fullName,
          reason: breakGlassGrant.reason,
          grantedAt: breakGlassGrant.grantedAt,
          expiresAt: breakGlassGrant.expiresAt,
          reviewOutcome: breakGlassGrant.reviewOutcome,
          reviewedAt: breakGlassGrant.reviewedAt,
        })
        .from(breakGlassGrant)
        .innerJoin(patient, eq(patient.id, breakGlassGrant.patientId))
        .innerJoin(userAccount, eq(userAccount.id, breakGlassGrant.userId))
        .where(and(...filters))
        .orderBy(desc(breakGlassGrant.grantedAt))
        .limit(200);

      return rows as BreakGlassRow[];
    },
  );
}

export async function reviewBreakGlass(
  grantId: string,
  outcome: 'justified' | 'not_justified',
  note: string,
): Promise<{ ok: boolean }> {
  return auditedWrite(
    {
      permission: 'audit.read',
      action: 'audit.read',
      entityType: 'break_glass_grant',
      entityId: grantId,
      purpose: note,
      metadata: { operation: 'break_glass_review', outcome },
    },
    async (tx, session) => {
      const updated = await tx
        .update(breakGlassGrant)
        .set({
          reviewOutcome: outcome,
          reviewedAt: new Date(),
          reviewedBy: session.userId,
        })
        .where(
          and(
            eq(breakGlassGrant.id, grantId),
            eq(breakGlassGrant.clinicId, session.clinicId),
          ),
        )
        .returning({ id: breakGlassGrant.id });

      return { ok: updated.length > 0 };
    },
  );
}

/** Count for the dashboard tile. */
export async function pendingBreakGlassCount(clinicId: string): Promise<number> {
  const [row] = await getDb()
    .select({ value: sql<number>`count(*)::int` })
    .from(breakGlassGrant)
    .where(
      and(
        eq(breakGlassGrant.clinicId, clinicId),
        eq(breakGlassGrant.reviewOutcome, 'pending'),
      ),
    );

  return row?.value ?? 0;
}
