import 'server-only';

import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';

import { auditEvent, auditReview, patient, userAccount } from '@/db/schema';
import { getEnv } from '@/env/server';

import { auditedRead, auditedWrite } from './audited';

/**
 * The periodic review of system activity — §164.308(a)(1)(ii)(D), security review F17.
 *
 * ==========================================================================
 * WHAT WAS ACTUALLY MISSING
 * ==========================================================================
 *
 * Not a viewer. `readAuditLog` has been filterable since phase 7. What was missing is that
 * nothing in the system could answer "when was this log last read, by whom, and what did
 * they conclude" — and a safeguard that leaves no trace of having operated is one the
 * clinic cannot demonstrate on the day somebody asks. §164.316(b)(1) wants it documented.
 *
 * So this module does two things: it assembles the handful of patterns worth a human's
 * attention, and it records that a human gave it.
 *
 * ==========================================================================
 * THE FLAGS ARE PROMPTS, NOT ACCUSATIONS
 * ==========================================================================
 *
 * Every category below is a REASON TO LOOK, not a finding. Most will have an ordinary
 * explanation — the administrator opened a chart because the patient rang the front desk;
 * the surname matched because it is a common one. That framing matters in the UI and it
 * matters here: a review tool that reads as an indictment is one staff learn to dismiss,
 * and the dismissed tool catches nothing.
 */

/* -------------------------------------------------------------------------- */

/** Reads of clinical content — what an administrator holding `admin` should rarely need. */
const CLINICAL_READ_ACTIONS = [
  'patient.read',
  'note.read',
  'prescription.read',
  'triage.read',
  'allergy.read',
  'flag.read',
] as const;

export type FlaggedRead = {
  occurredAt: Date;
  actorName: string;
  patientName: string;
  patientId: string;
  action: string;
  purpose: string | null;
};

export type ReviewDigest = {
  periodStart: Date;
  periodEnd: Date;
  /** Counts per category — this is what gets frozen into the review record. */
  counts: Record<string, number>;
  /**
   * An employee opened a chart belonging to someone who shares their surname — or their
   * own. M13 calls this the most common real-world HIPAA violation, and it is invisible to
   * permission checks because every one of these reads was authorized.
   */
  sameSurname: FlaggedRead[];
  /** Emergency access taken. Loud by design; this is where it gets read. */
  breakGlass: FlaggedRead[];
  /** Clinical reads by an administrator — F17's specific concern. */
  adminClinicalReads: FlaggedRead[];
  /** Actors whose read volume in the period stands out. */
  bulkReaders: { actorUserId: string; actorName: string; reads: number }[];
  /** Whether this window already carries a recorded review. */
  alreadyReviewed: { reviewedAt: Date; reviewerName: string; notes: string }[];
};

/**
 * Assemble the digest for a window.
 *
 * Gated on `audit.read`, and audited as an `audit.read` — reading this IS reading the log,
 * and the accounting-of-disclosures report set that precedent in migration 0013. It names
 * patients, so the read is recorded like any other.
 *
 * Every list is capped. A reviewer facing four hundred rows reads none of them, and the
 * counts (which are not capped) are what the record is built from.
 */
export async function buildReviewDigest(
  periodStart: Date,
  periodEnd: Date,
): Promise<ReviewDigest> {
  return auditedRead(
    {
      permission: 'audit.read',
      action: 'audit.read',
      entityType: 'audit_event',
      metadata: {
        scope: 'compliance_digest',
        periodDays: Math.round(
          (periodEnd.getTime() - periodStart.getTime()) / 86_400_000,
        ),
      },
    },
    async (tx, session) => {
      const env = getEnv();
      const inPeriod = and(
        eq(auditEvent.clinicId, session.clinicId),
        gte(auditEvent.occurredAt, periodStart),
        lt(auditEvent.occurredAt, periodEnd),
      );

      const actor = userAccount;
      const scalar = async (q: Promise<{ value: number }[]>) => (await q)[0]?.value ?? 0;

      /*
       * The surname heuristic, and its limits, stated plainly.
       *
       * Staff carry a single `full_name`, so this compares the patient's surname against
       * the words of that name. It over-reports common surnames and UNDER-reports the case
       * it most wants — a married name that no longer matches a relative's. It is a prompt
       * to look, and it is the only automated signal available for a class of access that
       * is fully authorized and therefore invisible to every other control here.
       *
       * Word-array comparison rather than a regex: a surname is user-supplied text, and
       * building a pattern out of it would break on the first O'Brien or hyphenated name.
       */
      const surnameMatches = sql`lower(${patient.legalLastName}) = any(string_to_array(lower(${actor.fullName}), ' '))`;

      const flaggedColumns = {
        occurredAt: auditEvent.occurredAt,
        actorName: actor.fullName,
        patientId: patient.id,
        legalFirstName: patient.legalFirstName,
        legalLastName: patient.legalLastName,
        action: auditEvent.action,
        purpose: auditEvent.purpose,
      };

      const shape = (r: {
        occurredAt: Date;
        actorName: string | null;
        patientId: string;
        legalFirstName: string;
        legalLastName: string;
        action: string;
        purpose: string | null;
      }): FlaggedRead => ({
        occurredAt: r.occurredAt,
        actorName: r.actorName ?? 'Unknown',
        patientId: r.patientId,
        patientName: `${r.legalLastName}, ${r.legalFirstName}`,
        action: r.action,
        purpose: r.purpose,
      });

      const sameSurnameRows = await tx
        .select(flaggedColumns)
        .from(auditEvent)
        .innerJoin(actor, eq(actor.id, auditEvent.actorUserId))
        .innerJoin(patient, eq(patient.id, auditEvent.subjectPatientId))
        .where(and(inPeriod, eq(auditEvent.outcome, 'allowed'), surnameMatches))
        .orderBy(desc(auditEvent.occurredAt))
        .limit(50);

      const breakGlassRows = await tx
        .select(flaggedColumns)
        .from(auditEvent)
        .innerJoin(actor, eq(actor.id, auditEvent.actorUserId))
        .innerJoin(patient, eq(patient.id, auditEvent.subjectPatientId))
        .where(and(inPeriod, sql`${auditEvent.breakGlassGrantId} is not null`))
        .orderBy(desc(auditEvent.occurredAt))
        .limit(50);

      /*
       * `actor_role_codes` is a snapshot of the roles held AT THE MOMENT of the event, so
       * this stays correct for someone whose roles changed since — which is precisely when
       * the question is interesting.
       */
      const adminClinicalRows = await tx
        .select(flaggedColumns)
        .from(auditEvent)
        .innerJoin(actor, eq(actor.id, auditEvent.actorUserId))
        .innerJoin(patient, eq(patient.id, auditEvent.subjectPatientId))
        .where(
          and(
            inPeriod,
            eq(auditEvent.outcome, 'allowed'),
            sql`'admin' = any(${auditEvent.actorRoleCodes})`,
            sql`${auditEvent.action} = any(${sql.param(CLINICAL_READ_ACTIONS as unknown as string[])})`,
          ),
        )
        .orderBy(desc(auditEvent.occurredAt))
        .limit(50);

      const bulkRows = await tx
        .select({
          actorUserId: auditEvent.actorUserId,
          actorName: actor.fullName,
          reads: count(),
        })
        .from(auditEvent)
        .innerJoin(actor, eq(actor.id, auditEvent.actorUserId))
        .where(and(inPeriod, eq(auditEvent.outcome, 'allowed')))
        .groupBy(auditEvent.actorUserId, actor.fullName)
        .having(sql`count(*) >= ${env.PHI_READ_ALERT_PER_HOUR}`)
        .orderBy(desc(count()));

      const denied = await scalar(
        tx
          .select({ value: count() })
          .from(auditEvent)
          .where(and(inPeriod, eq(auditEvent.outcome, 'denied'))),
      );

      const exports = await scalar(
        tx
          .select({ value: count() })
          .from(auditEvent)
          .where(and(inPeriod, eq(auditEvent.action, 'patient.export'))),
      );

      const total = await scalar(
        tx.select({ value: count() }).from(auditEvent).where(inPeriod),
      );

      const existing = await tx
        .select({
          reviewedAt: auditReview.reviewedAt,
          reviewerName: actor.fullName,
          notes: auditReview.notes,
        })
        .from(auditReview)
        .innerJoin(actor, eq(actor.id, auditReview.reviewedBy))
        .where(
          and(
            eq(auditReview.clinicId, session.clinicId),
            eq(auditReview.periodStart, periodStart),
            eq(auditReview.periodEnd, periodEnd),
          ),
        )
        .orderBy(desc(auditReview.reviewedAt));

      return {
        periodStart,
        periodEnd,
        counts: {
          totalEvents: total,
          sameSurname: sameSurnameRows.length,
          breakGlass: breakGlassRows.length,
          adminClinicalReads: adminClinicalRows.length,
          bulkReaders: bulkRows.length,
          denied,
          exports,
        },
        sameSurname: sameSurnameRows.map(shape),
        breakGlass: breakGlassRows.map(shape),
        adminClinicalReads: adminClinicalRows.map(shape),
        bulkReaders: bulkRows
          .filter((r): r is typeof r & { actorUserId: string } => r.actorUserId !== null)
          .map((r) => ({
            actorUserId: r.actorUserId,
            actorName: r.actorName ?? 'Unknown',
            reads: r.reads,
          })),
        alreadyReviewed: existing.map((e) => ({
          reviewedAt: e.reviewedAt,
          reviewerName: e.reviewerName ?? 'Unknown',
          notes: e.notes,
        })),
      };
    },
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Record that a window was reviewed.
 *
 * `audit.review`, not `audit.read`: attesting to something is a different act from looking
 * at it, and this row is the compliance artifact. The application role holds INSERT and
 * SELECT on the table and nothing else (migration 0023), so an attestation cannot be
 * rewritten afterwards — an editable record of having reviewed something is not evidence
 * that it was reviewed.
 *
 * THE COUNTS ARE NOT AN ARGUMENT, and that is a security property rather than a style
 * choice. If `findings` arrived from the form, whoever files the review could submit
 * "0 flagged reads" for a week that had fifty — and the row that says so is precisely the
 * artifact an auditor would be shown. So the digest is rebuilt here, server-side, for the
 * period being attested to, and those counts are what get stored. The caller supplies the
 * window and the conclusion; the system supplies the evidence.
 *
 * Rebuilding also writes its own `audit.read` row, which is correct: filing this review
 * did involve reading the log.
 *
 * Counts only, never identifiers. The detail belongs in `audit_event`, where it is already
 * protected; copying patient names into a second table would create a small parallel PHI
 * store with its own six-year retention duty.
 */
export async function recordReview(
  periodStart: Date,
  periodEnd: Date,
  notes: string,
): Promise<{ id: string }> {
  const digest = await buildReviewDigest(periodStart, periodEnd);
  const findings = digest.counts;

  return auditedWrite(
    {
      permission: 'audit.review',
      action: 'audit.review',
      entityType: 'audit_review',
      purpose: notes,
      metadata: {
        periodDays: Math.round(
          (periodEnd.getTime() - periodStart.getTime()) / 86_400_000,
        ),
        findings,
      },
    },
    async (tx, session) => {
      const [created] = await tx
        .insert(auditReview)
        .values({
          clinicId: session.clinicId,
          periodStart,
          periodEnd,
          reviewedBy: session.userId,
          notes,
          findings,
        })
        .returning({ id: auditReview.id });

      return { id: created!.id };
    },
  );
}

export type ReviewRecord = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  reviewedAt: Date;
  reviewerName: string;
  notes: string;
  findings: Record<string, number>;
};

/**
 * The review history — the answer to "show me that you review this".
 *
 * Carries no patient identifiers, so it is the part of this feature that can be handed to
 * an auditor as-is.
 */
export async function listReviews(limit = 24): Promise<ReviewRecord[]> {
  return auditedRead(
    {
      permission: 'audit.read',
      action: 'audit.read',
      entityType: 'audit_review',
      metadata: { scope: 'review_history' },
    },
    async (tx, session) => {
      const rows = await tx
        .select({
          id: auditReview.id,
          periodStart: auditReview.periodStart,
          periodEnd: auditReview.periodEnd,
          reviewedAt: auditReview.reviewedAt,
          reviewerName: userAccount.fullName,
          notes: auditReview.notes,
          findings: auditReview.findings,
        })
        .from(auditReview)
        .innerJoin(userAccount, eq(userAccount.id, auditReview.reviewedBy))
        .where(eq(auditReview.clinicId, session.clinicId))
        .orderBy(desc(auditReview.periodStart))
        .limit(limit);

      return rows.map((r) => ({
        ...r,
        reviewerName: r.reviewerName ?? 'Unknown',
        findings: r.findings ?? {},
      }));
    },
  );
}
