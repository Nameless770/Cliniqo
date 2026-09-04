/**
 * Visit notes.
 *
 * Split into a stable container (`visit_note`) and immutable content versions
 * (`visit_note_version`). All content columns are clinical PHI — the most restricted
 * data in the system.
 *
 * Lifecycle: draft (mutable in place) -> signed (frozen forever) -> addendum (appended).
 * See docs/02-data-model.md §9 for why drafts are mutable and signed versions are not.
 */

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { clinic } from './clinic';
import { visitNoteStatus, visitNoteVersionKind } from './enums';
import { userAccount } from './identity';
import { patient } from './patient';
import { appointment } from './scheduling';
import { primaryId, rowVersion, softDelete, timestamps } from './shared';

/* -------------------------------------------------------------------------- */

export const visitNote = pgTable(
  'visit_note',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),

    /** Nullable: walk-ins are seen without a prior booking. */
    appointmentId: uuid('appointment_id').references(() => appointment.id),

    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => userAccount.id),

    status: visitNoteStatus('status').notNull().default('draft'),

    /**
     * Denormalized pointer to the newest version. Avoids a MAX(version_number)
     * correlated subquery on every chart open. Nullable only between the two inserts
     * that create a note, and maintained inside that same transaction so the pointer and
     * the version row commit together or not at all.
     */
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => visitNoteVersion.id,
    ),

    signedAt: timestamp('signed_at', { withTimezone: true }),
    signedBy: uuid('signed_by').references(() => userAccount.id),

    ...timestamps(),
    ...rowVersion(),
    ...softDelete(() => userAccount.id),
  },
  (t) => [
    /** The chart timeline. */
    index('visit_note_patient_time_idx').on(t.patientId, t.createdAt.desc()),
    /** One note per appointment. */
    uniqueIndex('visit_note_appointment_idx')
      .on(t.appointmentId)
      .where(sql`${t.archivedAt} is null and ${t.appointmentId} is not null`),
    /**
     * "Your unsigned notes" queue — the thing that stops notes being silently forgotten,
     * which is both a care-quality and a billing problem in real clinics.
     */
    index('visit_note_author_draft_idx')
      .on(t.authorUserId)
      .where(sql`${t.status} = 'draft'`),
  ],
);

/* -------------------------------------------------------------------------- */

/**
 * Append-only. There are deliberately NO soft-delete columns here: versions are never
 * deleted or archived, because preserving them is the entire point of the table.
 */
export const visitNoteVersion = pgTable(
  'visit_note_version',
  {
    id: primaryId(),
    visitNoteId: uuid('visit_note_id')
      .notNull()
      .references((): AnyPgColumn => visitNote.id),

    /** 1-based, monotonic within a note. */
    versionNumber: integer('version_number').notNull(),
    kind: visitNoteVersionKind('kind').notNull().default('draft'),

    /**
     * SOAP structure rather than one text blob: it matches how clinicians are trained to
     * document, lets `assessment` be pulled independently for history summaries, and
     * means a later structured-data requirement is not a text-parsing migration.
     */
    chiefComplaint: text('chief_complaint'),
    subjective: text('subjective'),
    objective: text('objective'),
    assessment: text('assessment'),
    plan: text('plan'),

    /** May differ from the note's original author — a covering clinician can add an addendum. */
    authoredByUserId: uuid('authored_by_user_id')
      .notNull()
      .references(() => userAccount.id),
    authoredAt: timestamp('authored_at', { withTimezone: true }).notNull().defaultNow(),

    /** NULL while the draft is still mutable. Set once, at signing. Never cleared. */
    frozenAt: timestamp('frozen_at', { withTimezone: true }),

    supersedesVersionId: uuid('supersedes_version_id').references(
      (): AnyPgColumn => visitNoteVersion.id,
    ),

    /**
     * Hash over this version's content AND the previous version's hash, forming a chain
     * per note. A silent post-hoc edit at the database level breaks the chain and becomes
     * detectable, which turns "signed on the 3rd" into something verifiable rather than
     * merely asserted.
     */
    contentHash: text('content_hash'),
  },
  (t) => [
    uniqueIndex('visit_note_version_number_idx').on(t.visitNoteId, t.versionNumber),
    index('visit_note_version_history_idx').on(t.visitNoteId, t.versionNumber.desc()),
  ],
);
