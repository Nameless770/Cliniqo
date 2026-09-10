import 'server-only';

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';

import {
  appointment,
  appointmentType,
  patient,
  scheduleException,
  userAccount,
} from '@/db/schema';
import {
  canTransition,
  type AppointmentStatus,
  type BookAppointmentInput,
} from '@/lib/appointment-schemas';
import { zonedWallClock } from '@/lib/clinic-time';
import { isSlotContention } from '@/lib/pg-errors';
import type { Tx } from '@/server/audit/log';
import { AuthorizationError } from '@/server/auth/authorize';

import { auditedRead, auditedSearch, auditedWrite } from './audited';

/**
 * Appointment data access.
 *
 * ==========================================================================
 * HOW OVERLAPPING BOOKINGS ARE PREVENTED UNDER CONCURRENCY
 * ==========================================================================
 *
 * THE NAIVE APPROACH IS BROKEN, and it fails exactly when it matters.
 *
 *     SELECT ... WHERE provider = X AND during && newSlot   -- "is it free?"
 *     -- ... nothing found ...
 *     INSERT INTO appointment ...                           -- "book it"
 *
 * Two receptionists booking the same 09:00 slot at the same moment BOTH run the SELECT
 * before either runs the INSERT. Both see an empty result. Both insert. The clinic now
 * has two patients in one slot, and nobody finds out until they are both in the waiting
 * room. Wrapping the pair in a transaction does not help: under READ COMMITTED, neither
 * transaction can see the other's uncommitted row. The window is small, which is why this
 * bug reaches production — it is invisible in testing and shows up on the busiest morning.
 *
 * WHAT THIS CODE DOES INSTEAD. The database refuses the second write, using a GiST
 * exclusion constraint declared in migration 0001:
 *
 *     EXCLUDE USING gist (provider_user_id WITH =, during WITH &&)
 *       WHERE (status NOT IN ('cancelled','no_show') AND archived_at IS NULL)
 *
 * Read as: no two live rows may share a provider AND have overlapping time ranges. The
 * check happens inside the index, at write time, under the same lock discipline as a
 * unique constraint. The second INSERT blocks until the first transaction commits, then
 * fails with SQLSTATE 23P01. There is no window, because there is no gap between the
 * check and the write — they are the same operation.
 *
 * Three details that matter:
 *
 *   The constraint is PARTIAL. Cancelled and no-show appointments are excluded, so a
 *   cancelled 09:00 releases the slot. Without the WHERE clause a cancellation would
 *   block that time forever.
 *
 *   `btree_gist` is what allows equality on a scalar (provider_user_id) to sit in the
 *   same GiST constraint as range overlap. Plain GiST cannot index scalar equality.
 *
 *   Rescheduling is an UPDATE of `during`, and the constraint covers UPDATEs too — so
 *   moving an appointment onto an occupied slot fails the same way as booking one.
 *
 * The alternative — SERIALIZABLE isolation — would also catch this, but by aborting one
 * transaction with a serialisation failure that the application must detect and retry.
 * The constraint gives a precise, immediate, self-describing error instead, and costs
 * nothing on the reads.
 */

/*
 * Slot contention is not always exclusion_violation.
 *
 * This originally matched 23P01 alone, which is what two competing clients produce and
 * what the comment above still describes. Under REAL contention it is wrong: with twenty
 * simultaneous bookings, transactions queue on the GiST index in differing orders and
 * PostgreSQL kills some as deadlock victims (40P01) instead. Exactly one appointment is
 * still created — the constraint does its job — but the losers carried a code this
 * function did not recognise, so they were rethrown and surfaced as a server error rather
 * than "that slot just went". Found by tests/db/double-booking.test.ts.
 *
 * The predicate lives in @/lib/pg-errors so the test asserts against this exact function
 * rather than a copy of the code list that can drift from it.
 */
const isSlotConflict = isSlotContention;

/** A `tstzrange` literal, half-open: start inclusive, end exclusive. */
function rangeLiteral(start: Date, end: Date): string {
  return `[${start.toISOString()},${end.toISOString()})`;
}

export type BookingResult =
  | { ok: true; appointmentId: string }
  /* `invalid_time` should be unreachable — the zod schema requires the same
     'YYYY-MM-DDTHH:mm' shape the converter parses. It is a named result rather than a
     throw because a malformed time is a bad request, not a server fault, and because a
     silent NaN would otherwise become a tstzrange error deep in the insert. */
  | { ok: false; reason: 'slot_taken' | 'closed' | 'patient_missing' | 'invalid_time' };

export type ScheduleEntry = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  patientId: string;
  patientName: string;
  patientMrn: string;
  providerUserId: string;
  providerName: string;
  typeName: string;
  bookingNote: string | null;
  checkedInAt: Date | null;
};

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Appointments overlapping a window.
 *
 * The projection is identifying-only: patient name and MRN, never a diagnosis. A schedule
 * is a surface that gets displayed on shared screens at a front desk, so it carries the
 * minimum needed to run the day. The coded appointment type is included because it is
 * what receptionists schedule against; free-text clinical notes are not.
 */
export async function getSchedule(
  from: Date,
  to: Date,
  providerUserId?: string,
): Promise<ScheduleEntry[]> {
  return auditedSearch(
    {
      permission: 'appointment.read',
      // A window spans many patients, so there is no single subject. Audited as a
      // collection read with a count; opening a chart writes the per-patient row.
      action: 'appointment.search',
      entityType: 'appointment',
      metadata: {
        window: { from: from.toISOString(), to: to.toISOString() },
        scopedToProvider: Boolean(providerUserId),
      },
    },
    async (tx, session) => {
      const filters = [
        eq(appointment.clinicId, session.clinicId),
        isNull(appointment.archivedAt),
        // Range overlap, using the GiST index on (clinic_id, during).
        sql`${appointment.during} && ${rangeLiteral(from, to)}::tstzrange`,
      ];

      if (providerUserId) {
        filters.push(eq(appointment.providerUserId, providerUserId));
      }

      const rows = await tx
        .select({
          id: appointment.id,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          status: appointment.status,
          patientId: appointment.patientId,
          patientFirst: patient.legalFirstName,
          patientLast: patient.legalLastName,
          patientMrn: patient.mrn,
          providerUserId: appointment.providerUserId,
          providerName: userAccount.fullName,
          typeName: appointmentType.displayName,
          bookingNote: appointment.bookingNote,
          checkedInAt: appointment.checkedInAt,
        })
        .from(appointment)
        .innerJoin(patient, eq(patient.id, appointment.patientId))
        .innerJoin(userAccount, eq(userAccount.id, appointment.providerUserId))
        .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
        .where(and(...filters))
        .orderBy(asc(appointment.startsAt));

      return rows.map((r) => ({
        id: r.id,
        startsAt: r.startsAt!,
        endsAt: r.endsAt!,
        status: r.status as AppointmentStatus,
        patientId: r.patientId,
        patientName: `${r.patientLast}, ${r.patientFirst}`,
        patientMrn: r.patientMrn,
        providerUserId: r.providerUserId,
        providerName: r.providerName,
        typeName: r.typeName,
        bookingNote: r.bookingNote,
        checkedInAt: r.checkedInAt,
      }));
    },
    (rows) => ({ resultCount: rows.length }),
  );
}

/** A patient's appointments, newest first. Used on the patient profile. */
export async function getPatientAppointments(
  patientId: string,
  limit = 20,
): Promise<ScheduleEntry[]> {
  return auditedRead(
    {
      permission: 'appointment.read',
      action: 'appointment.read',
      entityType: 'appointment',
      subjectPatientId: patientId,
      metadata: { scope: 'patient_history' },
    },
    async (tx, session) => {
      const rows = await tx
        .select({
          id: appointment.id,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          status: appointment.status,
          patientId: appointment.patientId,
          patientFirst: patient.legalFirstName,
          patientLast: patient.legalLastName,
          patientMrn: patient.mrn,
          providerUserId: appointment.providerUserId,
          providerName: userAccount.fullName,
          typeName: appointmentType.displayName,
          bookingNote: appointment.bookingNote,
          checkedInAt: appointment.checkedInAt,
        })
        .from(appointment)
        .innerJoin(patient, eq(patient.id, appointment.patientId))
        .innerJoin(userAccount, eq(userAccount.id, appointment.providerUserId))
        .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
        .where(
          and(
            eq(appointment.patientId, patientId),
            eq(appointment.clinicId, session.clinicId),
            isNull(appointment.archivedAt),
          ),
        )
        .orderBy(sql`${appointment.startsAt} desc`)
        .limit(limit);

      return rows.map((r) => ({
        id: r.id,
        startsAt: r.startsAt!,
        endsAt: r.endsAt!,
        status: r.status as AppointmentStatus,
        patientId: r.patientId,
        patientName: `${r.patientLast}, ${r.patientFirst}`,
        patientMrn: r.patientMrn,
        providerUserId: r.providerUserId,
        providerName: r.providerName,
        typeName: r.typeName,
        bookingNote: r.bookingNote,
        checkedInAt: r.checkedInAt,
      }));
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Write: book                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Closures and provider time off overlapping a slot.
 *
 * Distinct from the overlap constraint: this is a business rule about when the clinic is
 * open, checked before the write. It is NOT a concurrency guard — a closure created in the
 * same instant is a vanishingly rare race with a trivial consequence, unlike double-booking
 * a patient.
 */
async function findBlockingException(
  tx: Tx,
  clinicId: string,
  providerUserId: string,
  range: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: scheduleException.id })
    .from(scheduleException)
    .where(
      and(
        eq(scheduleException.clinicId, clinicId),
        sql`${scheduleException.during} && ${range}::tstzrange`,
        // NULL provider = clinic-wide closure; matching provider = their time off.
        or(
          isNull(scheduleException.providerUserId),
          eq(scheduleException.providerUserId, providerUserId),
        )!,
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export async function bookAppointment(
  input: BookAppointmentInput,
): Promise<BookingResult> {
  try {
    return await auditedWrite(
      {
        permission: 'appointment.create',
        action: 'appointment.create',
        entityType: 'appointment',
        subjectPatientId: input.patientId,
        metadata: {
          durationMinutes: input.durationMinutes,
          hasBookingNote: Boolean(input.bookingNote),
        },
      },
      async (tx, session): Promise<BookingResult> => {
        /*
         * The wall-clock string becomes an instant HERE, using the CLINIC's timezone.
         *
         * It used to be `new Date(input.startsAt)` before this callback, which parses an
         * offset-less string in the SERVER's timezone — so a New York clinic booked on a
         * UTC container landed five hours out, and on the developer's machine
         * (Africa/Cairo) seven. The clinic timezone only exists on `session`, so the
         * conversion has to happen inside the audited block; doing it here also makes the
         * mistake unrepresentable, because there is no Date to pass in wrongly.
         */
        const start = zonedWallClock(input.startsAt, session.clinicTimeZone);
        if (Number.isNaN(start.getTime())) return { ok: false, reason: 'invalid_time' };
        const end = new Date(start.getTime() + input.durationMinutes * 60_000);
        const range = rangeLiteral(start, end);

        if (
          await findBlockingException(tx, session.clinicId, input.providerUserId, range)
        ) {
          return { ok: false, reason: 'closed' };
        }

        /*
         * No availability SELECT before this INSERT — deliberately. Checking first would
         * be the broken pattern described at the top of this file: it reads stale and
         * gives false confidence. The constraint decides, atomically.
         */
        const [row] = await tx
          .insert(appointment)
          .values({
            clinicId: session.clinicId,
            patientId: input.patientId,
            providerUserId: input.providerUserId,
            appointmentTypeId: input.appointmentTypeId,
            during: range,
            bookingNote: input.bookingNote ?? null,
            createdBy: session.userId,
          })
          .returning({ id: appointment.id });

        return { ok: true, appointmentId: row!.id };
      },
    );
  } catch (error) {
    /*
     * The losing side of a genuine race lands here. A conflict is an expected outcome of
     * a booking attempt, not a fault: it is reported as a normal result so the UI can say
     * "that slot just went" rather than showing an error page.
     */
    if (isSlotConflict(error)) return { ok: false, reason: 'slot_taken' };
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Write: reschedule                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Reschedule.
 *
 * Moves `during` on the existing row. The exclusion constraint applies to UPDATEs exactly
 * as it does to INSERTs, so moving an appointment onto an occupied slot fails identically
 * — including when two people move different appointments onto the same slot at once.
 */
export async function rescheduleAppointment(
  appointmentId: string,
  patientId: string,
  /** Wall-clock 'YYYY-MM-DDTHH:mm' in CLINIC time, not an instant. See below. */
  startsAt: string,
  durationMinutes: number,
): Promise<BookingResult> {
  try {
    return await auditedWrite(
      {
        permission: 'appointment.update',
        action: 'appointment.update',
        entityType: 'appointment',
        entityId: appointmentId,
        // Attributable to one patient; passed in and verified in-query below.
        subjectPatientId: patientId,
        metadata: { operation: 'reschedule', durationMinutes },
      },
      async (tx, session): Promise<BookingResult> => {
        /* Converted in the clinic's timezone, for the reason spelled out in
           bookAppointment: an offset-less string parsed by the server means the server's
           timezone silently decides when the patient is seen. */
        const start = zonedWallClock(startsAt, session.clinicTimeZone);
        if (Number.isNaN(start.getTime())) return { ok: false, reason: 'invalid_time' };
        const end = new Date(start.getTime() + durationMinutes * 60_000);
        const range = rangeLiteral(start, end);

        const [existing] = await tx
          .select({
            patientId: appointment.patientId,
            providerUserId: appointment.providerUserId,
            status: appointment.status,
          })
          .from(appointment)
          .where(
            and(
              eq(appointment.id, appointmentId),
              eq(appointment.patientId, patientId),
              eq(appointment.clinicId, session.clinicId),
              isNull(appointment.archivedAt),
            ),
          )
          .limit(1);

        if (!existing) return { ok: false, reason: 'patient_missing' };

        if (
          await findBlockingException(
            tx,
            session.clinicId,
            existing.providerUserId,
            range,
          )
        ) {
          return { ok: false, reason: 'closed' };
        }

        await tx
          .update(appointment)
          .set({ during: range, version: sql`${appointment.version} + 1` })
          .where(eq(appointment.id, appointmentId));

        return { ok: true, appointmentId };
      },
    );
  } catch (error) {
    if (isSlotConflict(error)) return { ok: false, reason: 'slot_taken' };
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Write: status                                                              */
/* -------------------------------------------------------------------------- */

export type StatusResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'illegal_transition' | 'not_your_appointment' };

/**
 * Move an appointment through its status lifecycle.
 *
 * TWO CHECKS BEYOND THE PERMISSION, both server-side:
 *
 *   1. The transition must be legal. `completed -> scheduled` is refused whoever asks.
 *      Without this, a stale browser tab replays a button and resurrects an appointment.
 *
 *   2. ROW-LEVEL SCOPE. A clinician may only touch appointments assigned to them. This
 *      cannot be expressed as a permission grant — `appointment.status` is held by all
 *      three roles — so the appointment's provider is re-read here and compared against
 *      the session. Reception and administration are not scoped this way: covering the
 *      desk means marking anyone's no-shows.
 */
export async function changeAppointmentStatus(
  appointmentId: string,
  patientId: string,
  next: AppointmentStatus,
): Promise<StatusResult> {
  return auditedWrite(
    {
      permission: next === 'checked_in' ? 'appointment.checkin' : 'appointment.status',
      action: next === 'checked_in' ? 'appointment.checkin' : 'appointment.update',
      entityType: 'appointment',
      entityId: appointmentId,
      // The subject the audit log needs. Passed by the caller and VERIFIED in the query
      // below (the notes pattern) — a mismatched pair finds no row. A single-appointment
      // write is attributable to exactly one patient, so this must be present, and the
      // appointment table is only read inside this transaction, so it has to come in.
      subjectPatientId: patientId,
      metadata: { toStatus: next },
    },
    async (tx, session): Promise<StatusResult> => {
      const [existing] = await tx
        .select({
          status: appointment.status,
          providerUserId: appointment.providerUserId,
          patientId: appointment.patientId,
        })
        .from(appointment)
        .where(
          and(
            eq(appointment.id, appointmentId),
            eq(appointment.patientId, patientId),
            eq(appointment.clinicId, session.clinicId),
            isNull(appointment.archivedAt),
          ),
        )
        .limit(1);

      if (!existing) return { ok: false, reason: 'not_found' };

      // Row-level scope for clinicians.
      const schedulingRole =
        session.permissions.has('appointment.update') ||
        session.permissions.has('appointment.checkin');

      if (!schedulingRole && existing.providerUserId !== session.userId) {
        return { ok: false, reason: 'not_your_appointment' };
      }

      if (!canTransition(existing.status as AppointmentStatus, next)) {
        return { ok: false, reason: 'illegal_transition' };
      }

      await tx
        .update(appointment)
        .set({
          status: next,
          version: sql`${appointment.version} + 1`,
          ...(next === 'checked_in'
            ? { checkedInAt: new Date(), checkedInBy: session.userId }
            : {}),
        })
        .where(eq(appointment.id, appointmentId));

      return { ok: true };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Write: cancel                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Cancel.
 *
 * Never a delete. The row stays with its reason and its canceller — a cancelled
 * appointment is part of the patient's history, and "who cancelled this and why" is a
 * question that gets asked.
 *
 * Because the exclusion constraint excludes cancelled rows, this also releases the slot
 * immediately for someone else to book.
 */
export async function cancelAppointment(
  appointmentId: string,
  patientId: string,
  reason: string,
): Promise<StatusResult> {
  return auditedWrite(
    {
      permission: 'appointment.cancel',
      action: 'appointment.cancel',
      entityType: 'appointment',
      entityId: appointmentId,
      subjectPatientId: patientId,
      purpose: reason,
    },
    async (tx, session): Promise<StatusResult> => {
      const [existing] = await tx
        .select({ status: appointment.status, patientId: appointment.patientId })
        .from(appointment)
        .where(
          and(
            eq(appointment.id, appointmentId),
            eq(appointment.patientId, patientId),
            eq(appointment.clinicId, session.clinicId),
            isNull(appointment.archivedAt),
          ),
        )
        .limit(1);

      if (!existing) return { ok: false, reason: 'not_found' };

      if (!canTransition(existing.status as AppointmentStatus, 'cancelled')) {
        return { ok: false, reason: 'illegal_transition' };
      }

      await tx
        .update(appointment)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: session.userId,
          cancellationReason: reason,
          version: sql`${appointment.version} + 1`,
        })
        .where(eq(appointment.id, appointmentId));

      return { ok: true };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Supporting reads                                                           */
/* -------------------------------------------------------------------------- */

/** Clinicians and appointment types, for the booking form. Not PHI. */
export async function getBookingOptions(): Promise<{
  providers: { id: string; name: string }[];
  types: { id: string; name: string; durationMinutes: number }[];
}> {
  return auditedRead(
    {
      permission: 'appointment.read',
      // Staff names and appointment types are clinic reference data, not PHI.
      action: 'reference.read',
      entityType: 'clinic',
      metadata: { scope: 'booking_options' },
    },
    async (tx, session) => {
      const providers = await tx
        .select({ id: userAccount.id, name: userAccount.fullName })
        .from(userAccount)
        .where(
          and(
            eq(userAccount.clinicId, session.clinicId),
            eq(userAccount.status, 'active'),
            isNull(userAccount.archivedAt),
          ),
        )
        .orderBy(asc(userAccount.fullName));
      const types = await tx
        .select({
          id: appointmentType.id,
          name: appointmentType.displayName,
          durationMinutes: appointmentType.defaultDurationMinutes,
        })
        .from(appointmentType)
        .where(
          and(
            eq(appointmentType.clinicId, session.clinicId),
            eq(appointmentType.isActive, true),
          ),
        )
        .orderBy(asc(appointmentType.sortOrder));

      return { providers, types };
    },
  );
}

export { AuthorizationError };
