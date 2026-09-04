/**
 * Audit log and break-glass access.
 *
 * `audit_event` is append-only and immutable. That is enforced at the DATABASE PRIVILEGE
 * level in migration 0001 — the application role holds INSERT and SELECT and nothing
 * else — rather than by application discipline, so that compromising an admin account
 * does not let anyone rewrite the log.
 *
 * The table is range-partitioned monthly on `occurred_at`, which is why its primary key
 * is composite: PostgreSQL requires the partition key to be part of any unique or
 * primary key. Partitioning is applied in migration 0001; drizzle-kit cannot express it.
 */

import { sql } from 'drizzle-orm';
import {
  index,
  inet,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { clinic } from './clinic';
import { auditEntityType, auditOutcome, breakGlassReviewOutcome } from './enums';
import { userAccount } from './identity';
import { patient } from './patient';
import { primaryId, timestamps } from './shared';

/* -------------------------------------------------------------------------- */

export const breakGlassGrant = pgTable(
  'break_glass_grant',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),

    /** Required. A break-glass grant with no stated reason is not a procedure. */
    reason: text('reason').notNull(),

    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Short-lived — hours, not days. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => userAccount.id),

    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => userAccount.id),
    reviewOutcome: breakGlassReviewOutcome('review_outcome').notNull().default('pending'),

    ...timestamps(),
  },
  (t) => [
    /**
     * The review queue. This index is what makes §164.312(a)(2)(ii) emergency access an
     * actual procedure rather than a checkbox — someone has to look at these.
     */
    index('break_glass_pending_idx')
      .on(t.clinicId, t.grantedAt.desc())
      .where(sql`${t.reviewOutcome} = 'pending'`),
    index('break_glass_patient_idx').on(t.patientId),
    index('break_glass_user_idx').on(t.userId),
  ],
);

/* -------------------------------------------------------------------------- */

export const auditEvent = pgTable(
  'audit_event',
  {
    /**
     * Supplied by the application as a UUIDv7, not defaulted in the database.
     *
     * v7 is time-ordered, so inserts stay at the right-hand edge of the B-tree. v4 keys
     * scatter writes across the whole index, and this table takes a write on every PHI
     * read — it is the highest-insert table in the system.
     */
    id: uuid('id').notNull(),

    /** Partition key. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    clinicId: uuid('clinic_id').notNull(),

    // --- Actor dimension: strong FK plus a point-in-time snapshot ------------
    actorUserId: uuid('actor_user_id').references(() => userAccount.id),

    /**
     * The roles the actor actually held at this moment.
     *
     * Not redundancy — point-in-time truth. Roles change, and reconstructing an actor's
     * permissions from `user_role` later would produce a confident, wrong answer about
     * what they were allowed to do at the time.
     */
    actorRoleCodes: text('actor_role_codes').array(),

    actorIp: inet('actor_ip'),
    actorUserAgent: text('actor_user_agent'),
    /** Ties a run of actions to one login — one long session vs. twelve suspicious ones. */
    sessionId: uuid('session_id'),

    // --- What happened ------------------------------------------------------
    /** Dotted verb: `patient.search`, `patient.read`, `note.sign`, `prescription.create`. */
    action: text('action').notNull(),
    outcome: auditOutcome('outcome').notNull(),

    // --- Subject dimension: strong FK, always populated ----------------------
    /**
     * Whose PHI was touched — populated on EVERY event that touches PHI, regardless of
     * which object was read. Opening a prescription records the prescription in
     * `entity_id` AND the patient here.
     *
     * This redundancy is the most important choice in the table. It turns the two
     * questions that carry statutory deadlines into single-index lookups:
     *   - "Who accessed this patient's record?" (§164.528, six years back)
     *   - "This account was compromised — whose records did it touch?" (60-day breach clock)
     */
    subjectPatientId: uuid('subject_patient_id').references(() => patient.id),

    // --- Object dimension: polymorphic, deliberately no FK -------------------
    entityType: auditEntityType('entity_type'),
    /**
     * No foreign key, on purpose. It points at a dozen tables; audit rows are evidence
     * and should not be constrained by the current state of what they describe; and FK
     * checks would add per-insert cost to the hottest-writing table in the system.
     *
     * The cost is that nothing guarantees this resolves. Mitigated by `entity_type` being
     * a constrained enum, by all writes going through the single audited-access layer,
     * and by a scheduled orphan check.
     */
    entityId: uuid('entity_id'),

    /** Stated reason. Required for break-glass access. */
    purpose: text('purpose'),
    breakGlassGrantId: uuid('break_glass_grant_id').references(() => breakGlassGrant.id),

    /** Correlates this row to application logs for the same request. */
    requestId: text('request_id'),

    /**
     * Which fields were accessed, how many results a search returned.
     *
     * NEVER field values, search terms, or note content. An audit log full of PHI is a
     * second copy of the database with a six-year retention requirement and weaker
     * access controls than the original.
     */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (t) => [
    /** Composite: PostgreSQL requires the partition key in the primary key. */
    primaryKey({ columns: [t.id, t.occurredAt] }),

    /** Accounting of disclosures — §164.528. */
    index('audit_event_subject_time_idx').on(t.subjectPatientId, t.occurredAt.desc()),
    /** Breach scoping. This is the query that runs against the 60-day clock. */
    index('audit_event_actor_time_idx').on(t.actorUserId, t.occurredAt.desc()),
    /** History of one record. */
    index('audit_event_entity_idx').on(t.entityType, t.entityId, t.occurredAt.desc()),
    index('audit_event_clinic_time_idx').on(t.clinicId, t.occurredAt.desc()),

    /** Emergency-access review queue. */
    index('audit_event_break_glass_idx')
      .on(t.occurredAt.desc())
      .where(sql`${t.breakGlassGrantId} is not null`),
    /**
     * Attempted boundary violations. Small, and the most interesting index in the
     * schema — a denied read is usually the first visible sign of a problem.
     */
    index('audit_event_denied_idx')
      .on(t.occurredAt.desc())
      .where(sql`${t.outcome} = 'denied'`),
  ],
);
