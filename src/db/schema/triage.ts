/**
 * Symptom triage — the patient describes what is wrong, and gets pointed somewhere.
 *
 * EVERY ROW HERE IS PHI, and of an unusually sensitive kind: free text a patient wrote
 * about their own body, unmediated by a clinician. It is stored because it is clinically
 * useful — the receptionist booking the appointment, and the clinician seeing them, should
 * be able to read what the patient actually said rather than a specialty code inferred
 * from it — but that means it inherits every rule the chart does: audited on read and
 * write, soft-deleted, never in a log line, never in a URL.
 *
 * The conversation records WHICH ENGINE answered it. A recommendation is only
 * interpretable if you know what produced it, and this application can be configured to
 * answer either locally or through a third-party model. Six years from now, reading a row
 * that says "go to a cardiologist", the question "what decided that" has to be answerable
 * from the row itself.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { clinic } from './clinic';
import { triageMessageRole, triageStatus, triageUrgency } from './enums';
import { userAccount } from './identity';
import { patient } from './patient';
import { primaryId, softDelete, timestamps } from './shared';

/**
 * One triage conversation, owned by exactly one patient.
 *
 * There is no `created_by`: a patient starts this themselves, the way portal bookings
 * carry a null staff creator. The actor lives in the audit row.
 */
export const triageConversation = pgTable(
  'triage_conversation',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),

    status: triageStatus('status').notNull().default('open'),

    /**
     * The outcome, denormalised onto the conversation so the front desk can act on it
     * without reading the symptom text. That is minimum necessary in practice: booking
     * a "dermatology, routine" appointment needs the specialty and the urgency, not the
     * paragraph about the rash.
     */
    urgency: triageUrgency('urgency'),
    recommendedSpecialty: text('recommended_specialty'),

    /**
     * What produced the recommendation: 'local' for the in-process engine, or
     * 'openai:<model>' when a third-party model was configured. Not nullable — a
     * conversation whose author is unknown cannot be reviewed.
     */
    engine: text('engine').notNull(),

    ...timestamps(),
    ...softDelete(() => userAccount.id),
  },
  (t) => [
    /** A patient's own history, newest first — the portal's only query. */
    index('triage_conversation_patient_idx').on(t.patientId, t.createdAt.desc()),
    /**
     * The front desk's queue: emergencies and urgent cases the clinic has not closed.
     * Partial, because the routine ones are the overwhelming majority and nobody sweeps
     * them.
     */
    index('triage_conversation_clinic_open_idx')
      .on(t.clinicId, t.createdAt.desc())
      .where(sql`${t.status} = 'open' and ${t.archivedAt} is null`),
  ],
);

/**
 * One turn. `role` distinguishes what the patient wrote from what was generated, and that
 * distinction is load-bearing: assistant text must never be mistakable for something a
 * clinician said, and patient text must never be mistakable for a clinical note.
 */
export const triageMessage = pgTable(
  'triage_message',
  {
    id: primaryId(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => triageConversation.id),

    role: triageMessageRole('role').notNull(),
    body: text('body').notNull(),

    ...timestamps(),
  },
  (t) => [
    index('triage_message_conversation_idx').on(t.conversationId, t.createdAt),
    /* An empty turn is a bug, not a message; refuse it at the boundary that cannot lie. */
    check('triage_message_body_present', sql`length(btrim(${t.body})) > 0`),
  ],
);
