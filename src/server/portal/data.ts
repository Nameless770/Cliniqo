import 'server-only';

import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import {
  appointment,
  appointmentType,
  clinicHours,
  providerAvailability,
  role,
  scheduleException,
  userAccount,
  userRole,
} from '@/db/schema';
import type { Tx } from '@/server/audit/log';
import { writeAuditEvent, type AuditInput } from '@/server/audit/log';
import { requestMeta, safeInet } from '@/server/auth/session';
import { zonedWallClock } from '@/lib/clinic-time';
import { isSlotContention } from '@/lib/pg-errors';

import { requirePatientSession, type PatientSession } from './session';

/**
 * The patient portal's data access.
 *
 * THE ENTIRE AUTHORITY MODEL IS ONE LINE: every query is filtered by
 * `eq(..., session.patientId)`. A patient has no roles and no permissions; the only thing
 * they may touch is the record their account is bound to, and that binding lives on the
 * session, resolved server-side from the cookie. There is no id in any of these functions
 * that a caller could point at someone else — the subject is always the session's own
 * patient.
 *
 * Patient actions are audited like staff actions, with the patient as actor
 * (`actor_patient_account_id`), so "who booked this" is answerable for self-service too.
 */

async function auditAsPatient(
  tx: Tx,
  session: PatientSession,
  event: Omit<AuditInput, 'clinicId' | 'actorPatientAccountId' | 'sessionId'>,
): Promise<void> {
  const { ip, userAgent } = await requestMeta();
  await writeAuditEvent(tx, {
    clinicId: session.clinicId,
    actorPatientAccountId: session.patientAccountId,
    actorIp: safeInet(ip),
    actorUserAgent: userAgent,
    sessionId: session.sessionId,
    ...event,
  });
}

export type MyAppointment = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  typeName: string;
  providerName: string;
};

export type MyAppointments = { upcoming: MyAppointment[]; past: MyAppointment[] };

/**
 * The signed-in patient's own appointments, split into upcoming and past/cancelled.
 *
 * The split happens HERE, against the wall clock, rather than in the page — a React render
 * must stay pure, and "what is upcoming" depends on the current time.
 */
export async function listMyAppointments(): Promise<MyAppointments> {
  const session = await requirePatientSession();
  const db = getDb();

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: appointment.id,
        during: appointment.during,
        status: appointment.status,
        typeName: appointmentType.displayName,
        providerName: userAccount.fullName,
      })
      .from(appointment)
      .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
      .innerJoin(userAccount, eq(userAccount.id, appointment.providerUserId))
      .where(
        and(
          eq(appointment.patientId, session.patientId),
          eq(appointment.clinicId, session.clinicId),
          isNull(appointment.archivedAt),
        ),
      )
      .orderBy(desc(appointment.startsAt));

    await auditAsPatient(tx, session, {
      action: 'appointment.read',
      outcome: 'allowed',
      subjectPatientId: session.patientId,
      entityType: 'appointment',
      metadata: { scope: 'portal_my_appointments', resultCount: rows.length },
    });

    const now = Date.now();
    const mapped: MyAppointment[] = rows.map((r) => {
      // during is '[start,end)' — parse the two instants for display.
      const m = /^\[(.+),(.+)\)$/.exec(r.during as unknown as string);
      return {
        id: r.id,
        startsAt: m ? new Date(m[1]!) : new Date(),
        endsAt: m ? new Date(m[2]!) : new Date(),
        status: r.status,
        typeName: r.typeName,
        providerName: r.providerName,
      };
    });

    const upcoming = mapped
      .filter((a) => a.endsAt.getTime() >= now && a.status !== 'cancelled')
      // newest-first from the query; show soonest-first to the patient.
      .reverse();
    const past = mapped.filter(
      (a) => a.endsAt.getTime() < now || a.status === 'cancelled',
    );
    return { upcoming, past };
  });
}

export type BookingOptions = {
  clinicTimeZone: string;
  types: { id: string; name: string; durationMinutes: number }[];
  providers: { id: string; name: string }[];
  hours: { dayOfWeek: number; opensAt: string; closesAt: string }[];
};

/**
 * What a patient may choose when booking: active appointment types, the clinic's doctors,
 * and opening hours. All reference data, no PHI — so no per-record audit, matching how
 * staff `reference.read` is treated.
 */
export async function getBookingOptions(): Promise<BookingOptions> {
  const session = await requirePatientSession();
  const db = getDb();

  const [types, providers, hours] = await Promise.all([
    db
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
      .orderBy(asc(appointmentType.sortOrder), asc(appointmentType.displayName)),
    db
      .selectDistinct({ id: userAccount.id, name: userAccount.fullName })
      .from(userAccount)
      .innerJoin(userRole, eq(userRole.userId, userAccount.id))
      .innerJoin(role, eq(role.id, userRole.roleId))
      .where(
        and(
          eq(userAccount.clinicId, session.clinicId),
          eq(userAccount.status, 'active'),
          isNull(userAccount.archivedAt),
          isNull(userRole.revokedAt),
          eq(role.code, 'doctor'),
        ),
      )
      .orderBy(asc(userAccount.fullName)),
    db
      .select({
        dayOfWeek: clinicHours.dayOfWeek,
        opensAt: clinicHours.opensAt,
        closesAt: clinicHours.closesAt,
      })
      .from(clinicHours)
      .where(eq(clinicHours.clinicId, session.clinicId))
      .orderBy(asc(clinicHours.dayOfWeek)),
  ]);

  return { clinicTimeZone: session.clinicTimeZone, types, providers, hours };
}

export type PortalBookInput = {
  providerUserId: string;
  appointmentTypeId: string;
  /** Wall-clock 'YYYY-MM-DDTHH:mm' in CLINIC time — the portal states times are clinic-local. */
  startsAt: string;
};

export type PortalBookResult =
  | { ok: true; appointmentId: string }
  | {
      ok: false;
      reason:
        | 'invalid_time'
        | 'past'
        | 'outside_hours'
        | 'unavailable'
        | 'unknown_provider'
        | 'unknown_type'
        | 'slot_taken';
    };

const toMinutes = (hms: string): number => {
  const [h, m] = hms.split(':');
  return Number(h) * 60 + Number(m);
};

/**
 * The patient books their own appointment.
 *
 * Every decision the client could get wrong is re-made on the server: the DURATION comes
 * from the appointment type, never the request; the PATIENT is the session's own; the
 * PROVIDER must be one of the clinic's active doctors; and the time must be in the future
 * and inside the clinic's opening hours for that weekday. The GiST exclusion constraint
 * has the final say on conflicts — the same one that protects staff booking — so two
 * patients racing for the last slot resolve to exactly one winner.
 */
export async function bookMyAppointment(
  input: PortalBookInput,
): Promise<PortalBookResult> {
  const session = await requirePatientSession();
  const db = getDb();

  const start = zonedWallClock(input.startsAt, session.clinicTimeZone);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: 'invalid_time' };
  if (start.getTime() <= Date.now()) return { ok: false, reason: 'past' };

  // Local wall-clock parts, straight from the submitted string (it is clinic-local).
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(input.startsAt);
  if (!m) return { ok: false, reason: 'invalid_time' };
  const dayOfWeek = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getUTCDay();
  const startMinutes = Number(m[4]) * 60 + Number(m[5]);

  try {
    return await db.transaction(async (tx): Promise<PortalBookResult> => {
      const [type] = await tx
        .select({ duration: appointmentType.defaultDurationMinutes })
        .from(appointmentType)
        .where(
          and(
            eq(appointmentType.id, input.appointmentTypeId),
            eq(appointmentType.clinicId, session.clinicId),
            eq(appointmentType.isActive, true),
          ),
        )
        .limit(1);
      if (!type) return { ok: false, reason: 'unknown_type' };

      const [provider] = await tx
        .select({ id: userAccount.id })
        .from(userAccount)
        .innerJoin(userRole, eq(userRole.userId, userAccount.id))
        .innerJoin(role, eq(role.id, userRole.roleId))
        .where(
          and(
            eq(userAccount.id, input.providerUserId),
            eq(userAccount.clinicId, session.clinicId),
            eq(userAccount.status, 'active'),
            isNull(userAccount.archivedAt),
            isNull(userRole.revokedAt),
            eq(role.code, 'doctor'),
          ),
        )
        .limit(1);
      if (!provider) return { ok: false, reason: 'unknown_provider' };

      const endMinutes = startMinutes + type.duration;

      // Must sit entirely within one opening-hours window for that weekday.
      const windows = await tx
        .select({ opensAt: clinicHours.opensAt, closesAt: clinicHours.closesAt })
        .from(clinicHours)
        .where(
          and(
            eq(clinicHours.clinicId, session.clinicId),
            eq(clinicHours.dayOfWeek, dayOfWeek),
          ),
        );
      const withinHours = windows.some(
        (w) => toMinutes(w.opensAt) <= startMinutes && endMinutes <= toMinutes(w.closesAt),
      );
      if (!withinHours) return { ok: false, reason: 'outside_hours' };

      const end = new Date(start.getTime() + type.duration * 60_000);
      const range = `[${start.toISOString()},${end.toISOString()})`;

      /*
       * A closure or the provider's time off blocks the slot. Staff booking already checks
       * this; the portal did not, so a patient could have booked a doctor who was away.
       * NULL provider = clinic-wide closure; a matching provider = their own time off.
       */
      const blocked = await tx
        .select({ id: scheduleException.id })
        .from(scheduleException)
        .where(
          and(
            eq(scheduleException.clinicId, session.clinicId),
            sql`${scheduleException.during} && ${range}::tstzrange`,
            or(
              isNull(scheduleException.providerUserId),
              eq(scheduleException.providerUserId, input.providerUserId),
            )!,
          ),
        )
        .limit(1);
      if (blocked.length > 0) return { ok: false, reason: 'unavailable' };

      /*
       * Provider availability. If this provider publishes weekly hours, a patient may only
       * book WITHIN them; if they publish none, clinic hours above are the only gate. Staff
       * are deliberately not held to this — they can squeeze a patient in — but a patient
       * self-serving may only take an advertised slot.
       */
      const avail = await tx
        .select({
          dayOfWeek: providerAvailability.dayOfWeek,
          startsAt: providerAvailability.startsAt,
          endsAt: providerAvailability.endsAt,
        })
        .from(providerAvailability)
        .where(
          and(
            eq(providerAvailability.clinicId, session.clinicId),
            eq(providerAvailability.providerUserId, input.providerUserId),
          ),
        );
      if (avail.length > 0) {
        const forDay = avail.filter((a) => a.dayOfWeek === dayOfWeek);
        const withinAvail = forDay.some(
          (a) => toMinutes(a.startsAt) <= startMinutes && endMinutes <= toMinutes(a.endsAt),
        );
        if (!withinAvail) return { ok: false, reason: 'unavailable' };
      }

      const [row] = await tx
        .insert(appointment)
        .values({
          clinicId: session.clinicId,
          patientId: session.patientId,
          providerUserId: input.providerUserId,
          appointmentTypeId: input.appointmentTypeId,
          during: range,
          // Booked by the patient; there is no staff creator.
          createdBy: null,
          bookingNote: 'Booked online by patient',
        })
        .returning({ id: appointment.id });

      await auditAsPatient(tx, session, {
        action: 'appointment.create',
        outcome: 'allowed',
        subjectPatientId: session.patientId,
        entityType: 'appointment',
        entityId: row!.id,
        metadata: { via: 'portal', durationMinutes: type.duration },
      });

      return { ok: true, appointmentId: row!.id };
    });
  } catch (error) {
    if (isSlotContention(error)) return { ok: false, reason: 'slot_taken' };
    throw error;
  }
}
