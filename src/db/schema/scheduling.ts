/**
 * Appointment types, provider availability, closures, and appointments.
 *
 * The appointment row is PHI: it links an identifiable person to a clinic and a
 * clinician, and the appointment type implies clinical content.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { clinic } from './clinic';
import { appointmentStatus, scheduleExceptionKind } from './enums';
import { userAccount } from './identity';
import { patient } from './patient';
import { primaryId, rowVersion, softDelete, timestamps, tstzrange } from './shared';

/* -------------------------------------------------------------------------- */

/**
 * Coded appointment reasons.
 *
 * This table exists to close a PHI leak: receptionists book appointments but must not
 * see clinical data, and a free-text reason field fills up with clinical detail. Staff
 * pick a code from this list instead.
 */
export const appointmentType = pgTable(
  'appointment_type',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),

    code: text('code').notNull(),
    displayName: text('display_name').notNull(),
    defaultDurationMinutes: integer('default_duration_minutes').notNull().default(20),
    /** Schedule-view colour. Presentation only. */
    color: text('color'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    ...timestamps(),
  },
  (t) => [uniqueIndex('appointment_type_clinic_code_idx').on(t.clinicId, t.code)],
);

/* -------------------------------------------------------------------------- */

/** A clinician's normal working pattern. */
export const providerAvailability = pgTable(
  'provider_availability',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    providerUserId: uuid('provider_user_id')
      .notNull()
      .references(() => userAccount.id),

    dayOfWeek: smallint('day_of_week').notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),

    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),

    ...timestamps(),
  },
  (t) => [
    index('provider_availability_provider_day_idx').on(t.providerUserId, t.dayOfWeek),
    check('provider_availability_day_range', sql`${t.dayOfWeek} between 0 and 6`),
    check('provider_availability_time_order', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

/* -------------------------------------------------------------------------- */

/**
 * Clinic closures and provider time off in one table, distinguished by whether
 * `provider_user_id` is null. Two near-identical tables would mean availability
 * calculation reconciles two result sets instead of scanning one.
 */
export const scheduleException = pgTable(
  'schedule_exception',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    /** NULL = clinic-wide closure. Set = one provider's time off. */
    providerUserId: uuid('provider_user_id').references(() => userAccount.id),

    during: tstzrange('during').notNull(),
    kind: scheduleExceptionKind('kind').notNull(),
    reason: text('reason'),

    createdBy: uuid('created_by').references(() => userAccount.id),
    ...timestamps(),
  },
  (t) => [
    // GiST indexes on the range column are added in migration 0001 — drizzle-kit cannot
    // emit an operator class for a custom type here.
    index('schedule_exception_clinic_idx').on(t.clinicId),
    index('schedule_exception_provider_idx').on(t.providerUserId),
  ],
);

/* -------------------------------------------------------------------------- */

export const appointment = pgTable(
  'appointment',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),
    providerUserId: uuid('provider_user_id')
      .notNull()
      .references(() => userAccount.id),
    appointmentTypeId: uuid('appointment_type_id')
      .notNull()
      .references(() => appointmentType.id),

    /**
     * Authoritative time span. A range column rather than two timestamps because it is
     * what makes the GiST exclusion constraint possible — see migration 0001. Two
     * receptionists booking the same slot concurrently cannot be stopped in application
     * code: both read "free" before either writes.
     */
    during: tstzrange('during').notNull(),

    /**
     * Generated from `during`. The range is for the constraint; these are for ordinary
     * sorting, display, and B-tree range scans. Generated, so they cannot drift.
     */
    startsAt: timestamp('starts_at', { withTimezone: true }).generatedAlwaysAs(
      sql`lower("during")`,
    ),
    endsAt: timestamp('ends_at', { withTimezone: true }).generatedAlwaysAs(
      sql`upper("during")`,
    ),

    status: appointmentStatus('status').notNull().default('booked'),

    /**
     * Front-desk visible. Logistics only ("needs wheelchair access").
     *
     * The schema cannot stop staff typing clinical detail here. Mitigation is
     * operational: label it as logistics-only in the UI and sample it during audit review.
     */
    bookingNote: text('booking_note'),
    /** Clinician-only projection. Never returned to a receptionist. */
    clinicalNoteForProvider: text('clinical_note_for_provider'),

    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    checkedInBy: uuid('checked_in_by').references(() => userAccount.id),

    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => userAccount.id),
    cancellationReason: text('cancellation_reason'),

    /** Preserves the reschedule chain rather than mutating times in place. */
    rescheduledFromAppointmentId: uuid('rescheduled_from_appointment_id').references(
      (): AnyPgColumn => appointment.id,
    ),

    createdBy: uuid('created_by').references(() => userAccount.id),

    ...timestamps(),
    ...rowVersion(),
    ...softDelete(() => userAccount.id),
  },
  (t) => [
    /** Patient appointment history. */
    index('appointment_patient_time_idx').on(t.patientId, t.startsAt.desc()),
    /** Today's arrivals board. */
    index('appointment_clinic_active_idx')
      .on(t.clinicId, t.startsAt)
      .where(sql`${t.status} in ('booked', 'checked_in', 'in_progress')`),
    index('appointment_provider_time_idx').on(t.providerUserId, t.startsAt),

    check('appointment_range_order', sql`upper("during") > lower("during")`),
    // The GiST exclusion constraint that actually prevents double-booking, and the
    // clinic-wide GiST range index, are in migration 0001.
  ],
);
