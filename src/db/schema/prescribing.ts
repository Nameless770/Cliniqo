/**
 * Medications, prescriptions, and prescription lines.
 *
 * Scope: record-and-print only. No electronic transmission to pharmacies, and no
 * controlled substances — both were deferred in docs/01-requirements-analysis.md (M1).
 * E-prescribing would require NCPDP SCRIPT and a Surescripts-type network; controlled
 * substances would additionally require DEA EPCS identity proofing and hard two-factor
 * at signing.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { clinic } from './clinic';
import { prescriptionStatus } from './enums';
import { visitNote } from './clinical';
import { userAccount } from './identity';
import { patient } from './patient';
import { primaryId, rowVersion, softDelete, timestamps } from './shared';

/* -------------------------------------------------------------------------- */

/**
 * Formulary reference data. Global, not clinic-scoped, and NOT PHI.
 *
 * A reference table rather than free-text drug names, so that the controlled-substance
 * exclusion is enforced by data rather than by memory.
 */
export const medication = pgTable(
  'medication',
  {
    id: primaryId(),
    name: text('name').notNull(),
    genericName: text('generic_name'),
    form: text('form'),
    strength: text('strength'),
    /** RxNorm slot, reserved for later coding work. */
    rxnormCode: text('rxnorm_code'),

    /**
     * The MVP scope guard. A trigger in migration 0001 rejects any prescription line
     * referencing a controlled medication — enforcement in data, not in a code review
     * comment.
     */
    isControlled: boolean('is_controlled').notNull().default(false),
    deaSchedule: text('dea_schedule'),

    isActive: boolean('is_active').notNull().default(true),

    ...timestamps(),
  },
  (t) => [
    index('medication_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
    index('medication_generic_trgm_idx').using('gin', sql`${t.genericName} gin_trgm_ops`),
    uniqueIndex('medication_rxnorm_idx')
      .on(t.rxnormCode)
      .where(sql`${t.rxnormCode} is not null`),
  ],
);

/* -------------------------------------------------------------------------- */

/**
 * Order header. The signature lives here, where it belongs legally — one prescribing
 * event routinely carries several medications.
 */
export const prescription = pgTable(
  'prescription',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),
    /** Nullable: a repeat can be issued outside a documented visit. */
    visitNoteId: uuid('visit_note_id').references(() => visitNote.id),

    prescriberUserId: uuid('prescriber_user_id')
      .notNull()
      .references(() => userAccount.id),

    status: prescriptionStatus('status').notNull().default('draft'),

    signedAt: timestamp('signed_at', { withTimezone: true }),
    printedAt: timestamp('printed_at', { withTimezone: true }),

    /**
     * The prescription this one replaces.
     *
     * A signed prescription is never edited. A correction is a NEW prescription pointing
     * back at the original, and the original is cancelled with a reason — which is how
     * paper prescribing works, and what makes "what was actually prescribed, and when did
     * it change" answerable from the record rather than from memory.
     */
    supersedesPrescriptionId: uuid('supersedes_prescription_id').references(
      (): AnyPgColumn => prescription.id,
    ),

    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => userAccount.id),
    cancellationReason: text('cancellation_reason'),

    ...timestamps(),
    ...rowVersion(),
    ...softDelete(() => userAccount.id),
  },
  (t) => [
    index('prescription_patient_signed_idx').on(t.patientId, t.signedAt.desc()),
    /** Walking a correction chain: "what replaced this?" */
    index('prescription_supersedes_idx')
      .on(t.supersedesPrescriptionId)
      .where(sql`${t.supersedesPrescriptionId} is not null`),
    index('prescription_prescriber_draft_idx')
      .on(t.prescriberUserId)
      .where(sql`${t.status} = 'draft'`),
  ],
);

/* -------------------------------------------------------------------------- */

/**
 * Order line. Clinical PHI throughout.
 *
 * No soft-delete columns: once the parent prescription is signed these are immutable.
 * Correction means cancelling the prescription and issuing a new one — which is how
 * paper prescriptions work and what the legal record expects.
 */
export const prescriptionItem = pgTable(
  'prescription_item',
  {
    id: primaryId(),
    prescriptionId: uuid('prescription_id')
      .notNull()
      .references(() => prescription.id),
    medicationId: uuid('medication_id')
      .notNull()
      .references(() => medication.id),

    sequence: integer('sequence').notNull().default(1),

    dose: text('dose'),
    route: text('route'),
    frequency: text('frequency'),
    durationDays: integer('duration_days'),
    quantity: numeric('quantity'),
    quantityUnit: text('quantity_unit'),
    refills: integer('refills').notNull().default(0),
    /** The sig — patient-facing directions. */
    instructions: text('instructions'),
    /** Why it was prescribed. Clinical. */
    indication: text('indication'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('prescription_item_seq_idx').on(t.prescriptionId, t.sequence)],
);
