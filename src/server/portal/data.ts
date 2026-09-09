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
import { canTransition, type AppointmentStatus } from '@/lib/appointment-schemas';
import {
  formatDateInZone,
  parseTstzRange,
  shiftDate,
  todayInZone,
  zonedStartOfDay,
  zonedWallClock,
} from '@/lib/clinic-time';
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
      const [startsAt, endsAt] = parseTstzRange(r.during as unknown as string);
      return {
        id: r.id,
        startsAt,
        endsAt,
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

/* -------------------------------------------------------------------------- */
/* Open slots: "who is free, and when"                                        */
/* -------------------------------------------------------------------------- */

/**
 * How far ahead to look, and how much of it to show.
 *
 * The horizon is the search; the cap is what comes back. A clinician with wide-open hours
 * has forty openings a day, and three weeks of those is a payload nobody reads and a page
 * nobody can scan. Six days of real openings is enough to choose from, and the patient who
 * needs something further out is the patient who should be phoning anyway.
 */
const HORIZON_DAYS = 21;
const MAX_DAYS_SHOWN = 6;

/** Minutes since local midnight, as a half-open window. */
type Window = { start: number; end: number };

function overlapWindows(a: Window[], b: Window[]): Window[] {
  const out: Window[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

const pad = (n: number): string => String(n).padStart(2, '0');
const clockLabel = (minutes: number): string =>
  `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export type OpenSlot = {
  /** Wall-clock 'YYYY-MM-DDTHH:mm' in CLINIC time — what the booking action expects. */
  startsAt: string;
  /** 'HH:mm', already in clinic time, so the client formats nothing. */
  label: string;
};

export type OpenDay = { date: string; label: string; slots: OpenSlot[] };

export type ProviderOpenings = {
  providerUserId: string;
  providerName: string;
  days: OpenDay[];
};

export type OpenSlotsResult =
  | {
      ok: true;
      clinicTimeZone: string;
      typeName: string;
      durationMinutes: number;
      providers: ProviderOpenings[];
    }
  | { ok: false; reason: 'unknown_type' };

/**
 * Free appointment slots for one visit type, per clinician.
 *
 * WHAT THIS DOES AND DOES NOT DISCLOSE. Computing free time requires reading when
 * clinicians are already busy, and those rows are appointments belonging to OTHER
 * patients. None of it leaves the server: the busy ranges are used to subtract, and what
 * returns is only the times that remain. A patient learns "11:00 is not offered", never
 * that anyone has an appointment, let alone who — which is the minimum-necessary reading
 * of §164.502(b) for a booking screen.
 *
 * Times are offered under exactly the rules `checkSlot` enforces — clinic opening hours,
 * the clinician's published availability, closures and time off, and existing bookings.
 * The list is a PREVIEW of that decision, never a substitute for it: the returned slots
 * are ordinary client-supplied values by the time they come back, so booking re-runs
 * every check. Two patients handed the same slot still resolve to one winner at the
 * exclusion constraint.
 */
export async function getOpenSlots(appointmentTypeId: string): Promise<OpenSlotsResult> {
  const session = await requirePatientSession();
  const db = getDb();
  const tz = session.clinicTimeZone;

  return db.transaction(async (tx): Promise<OpenSlotsResult> => {
    const [type] = await tx
      .select({
        name: appointmentType.displayName,
        duration: appointmentType.defaultDurationMinutes,
      })
      .from(appointmentType)
      .where(
        and(
          eq(appointmentType.id, appointmentTypeId),
          eq(appointmentType.clinicId, session.clinicId),
          eq(appointmentType.isActive, true),
        ),
      )
      .limit(1);
    if (!type) return { ok: false, reason: 'unknown_type' };

    const today = todayInZone(tz);
    const dates = Array.from({ length: HORIZON_DAYS }, (_, i) => shiftDate(today, i));
    const horizonEnd = zonedStartOfDay(shiftDate(today, HORIZON_DAYS), tz);
    const horizonRange = `[${new Date().toISOString()},${horizonEnd.toISOString()})`;

    const [providers, hours, availability, exceptions, booked] = await Promise.all([
      tx
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
      tx
        .select({
          dayOfWeek: clinicHours.dayOfWeek,
          opensAt: clinicHours.opensAt,
          closesAt: clinicHours.closesAt,
        })
        .from(clinicHours)
        .where(eq(clinicHours.clinicId, session.clinicId)),
      tx
        .select({
          providerUserId: providerAvailability.providerUserId,
          dayOfWeek: providerAvailability.dayOfWeek,
          startsAt: providerAvailability.startsAt,
          endsAt: providerAvailability.endsAt,
        })
        .from(providerAvailability)
        .where(eq(providerAvailability.clinicId, session.clinicId)),
      tx
        .select({
          providerUserId: scheduleException.providerUserId,
          startsAt: sql<Date>`lower(${scheduleException.during})`,
          endsAt: sql<Date>`upper(${scheduleException.during})`,
        })
        .from(scheduleException)
        .where(
          and(
            eq(scheduleException.clinicId, session.clinicId),
            sql`${scheduleException.during} && ${horizonRange}::tstzrange`,
          ),
        ),
      /*
       * Busy time. Deliberately the narrowest projection that answers "is this slot
       * taken": a provider and two instants. No patient id, no type, no note — a query
       * that cannot return PHI cannot leak it, whatever the caller does with the result.
       *
       * The status filter mirrors the exclusion constraint's own WHERE clause exactly. A
       * cancelled appointment does not hold its slot in the database, so it must not hold
       * it here either, or the portal would hide time the clinic is free.
       */
      tx
        .select({
          providerUserId: appointment.providerUserId,
          startsAt: sql<Date>`lower(${appointment.during})`,
          endsAt: sql<Date>`upper(${appointment.during})`,
        })
        .from(appointment)
        .where(
          and(
            eq(appointment.clinicId, session.clinicId),
            isNull(appointment.archivedAt),
            sql`${appointment.status} not in ('cancelled', 'no_show')`,
            sql`${appointment.during} && ${horizonRange}::tstzrange`,
          ),
        ),
    ]);

    const hoursByDay = new Map<number, Window[]>();
    for (const h of hours) {
      const list = hoursByDay.get(h.dayOfWeek) ?? [];
      list.push({ start: toMinutes(h.opensAt), end: toMinutes(h.closesAt) });
      hoursByDay.set(h.dayOfWeek, list);
    }

    // Provider → weekday → windows. A provider absent from this map publishes no hours.
    const availByProvider = new Map<string, Map<number, Window[]>>();
    for (const a of availability) {
      const byDay = availByProvider.get(a.providerUserId) ?? new Map<number, Window[]>();
      const list = byDay.get(a.dayOfWeek) ?? [];
      list.push({ start: toMinutes(a.startsAt), end: toMinutes(a.endsAt) });
      byDay.set(a.dayOfWeek, list);
      availByProvider.set(a.providerUserId, byDay);
    }

    type Busy = { start: number; end: number };
    const busyByProvider = new Map<string, Busy[]>();
    const addBusy = (providerId: string, start: Date, end: Date) => {
      const list = busyByProvider.get(providerId) ?? [];
      list.push({ start: new Date(start).getTime(), end: new Date(end).getTime() });
      busyByProvider.set(providerId, list);
    };
    for (const b of booked) addBusy(b.providerUserId, b.startsAt, b.endsAt);

    // A clinic-wide closure blocks every clinician; time off blocks only its own.
    const clinicWideClosures: Busy[] = [];
    for (const e of exceptions) {
      if (e.providerUserId) addBusy(e.providerUserId, e.startsAt, e.endsAt);
      else
        clinicWideClosures.push({
          start: new Date(e.startsAt).getTime(),
          end: new Date(e.endsAt).getTime(),
        });
    }

    const now = Date.now();
    const durationMs = type.duration * 60_000;

    const result: ProviderOpenings[] = [];

    for (const provider of providers) {
      const published = availByProvider.get(provider.id);
      const busy = busyByProvider.get(provider.id) ?? [];
      const days: OpenDay[] = [];

      for (const date of dates) {
        if (days.length >= MAX_DAYS_SHOWN) break;

        const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
        const open = hoursByDay.get(dayOfWeek) ?? [];
        if (open.length === 0) continue;

        /* Published hours NARROW the clinic's; publishing none means the clinic's hours
           are the only gate. Identical to the rule in `checkSlot`. */
        const windows = published
          ? overlapWindows(open, published.get(dayOfWeek) ?? [])
          : open;
        if (windows.length === 0) continue;

        const slots: OpenSlot[] = [];
        for (const window of windows) {
          for (
            let minute = window.start;
            minute + type.duration <= window.end;
            minute += type.duration
          ) {
            const localISO = `${date}T${clockLabel(minute)}`;
            /* Converted through the same function booking uses, per slot rather than by
               adding minutes to midnight — on the two days a year the clock shifts,
               arithmetic from midnight offers times that do not exist. */
            const start = zonedWallClock(localISO, tz).getTime();
            const end = start + durationMs;

            if (start <= now) continue;
            if (clinicWideClosures.some((c) => start < c.end && end > c.start)) continue;
            if (busy.some((b) => start < b.end && end > b.start)) continue;

            slots.push({ startsAt: localISO, label: clockLabel(minute) });
          }
        }

        if (slots.length > 0) {
          days.push({
            date,
            label: formatDateInZone(zonedStartOfDay(date, tz), tz),
            slots,
          });
        }
      }

      if (days.length > 0) {
        result.push({
          providerUserId: provider.id,
          providerName: provider.name,
          days,
        });
      }
    }

    /*
     * Audited as a non-PHI reference read: it discloses the schedule, not a record.
     *
     * The visit type is deliberately NOT in the metadata. The actor on this row is the
     * patient, so recording which type they searched would file "this person was looking
     * for a sexual-health appointment" into a table with six-year retention and broader
     * read access than the chart it describes. Metadata carries counts, never the values
     * a patient chose — the booking that follows is where the type legitimately lands, on
     * the appointment itself.
     */
    await auditAsPatient(tx, session, {
      action: 'reference.read',
      outcome: 'allowed',
      entityType: 'clinic',
      metadata: {
        scope: 'portal_open_slots',
        horizonDays: HORIZON_DAYS,
        providersWithOpenings: result.length,
      },
    });

    return {
      ok: true,
      clinicTimeZone: tz,
      typeName: type.name,
      durationMinutes: type.duration,
      providers: result,
    };
  });
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

export type SlotDenial =
  | 'invalid_time'
  | 'past'
  | 'outside_hours'
  | 'unavailable'
  | 'unknown_provider';

type SlotCheck = { ok: true; range: string } | { ok: false; reason: SlotDenial };

/**
 * Every rule deciding whether a patient may take a given slot, in one place.
 *
 * Shared by booking and rescheduling deliberately. A reschedule is a booking that happens
 * to reuse a row, and if the two checks drifted apart, "move it" would quietly become the
 * loophole that puts an appointment where "make it" refuses to — the closed Tuesday, the
 * doctor on leave, the hour outside published availability.
 *
 * `durationMinutes` is passed in from the appointment TYPE, never from the request. A
 * client that could name its own duration could book a one-minute slot to slip inside a
 * gap the clinic never offered.
 */
async function checkSlot(
  tx: Tx,
  session: PatientSession,
  args: { providerUserId: string; durationMinutes: number; startsAt: string },
): Promise<SlotCheck> {
  const start = zonedWallClock(args.startsAt, session.clinicTimeZone);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: 'invalid_time' };
  if (start.getTime() <= Date.now()) return { ok: false, reason: 'past' };

  // Local wall-clock parts, straight from the submitted string (it is clinic-local).
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(args.startsAt);
  if (!m) return { ok: false, reason: 'invalid_time' };
  const dayOfWeek = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getUTCDay();
  const startMinutes = Number(m[4]) * 60 + Number(m[5]);
  const endMinutes = startMinutes + args.durationMinutes;

  const [provider] = await tx
    .select({ id: userAccount.id })
    .from(userAccount)
    .innerJoin(userRole, eq(userRole.userId, userAccount.id))
    .innerJoin(role, eq(role.id, userRole.roleId))
    .where(
      and(
        eq(userAccount.id, args.providerUserId),
        eq(userAccount.clinicId, session.clinicId),
        eq(userAccount.status, 'active'),
        isNull(userAccount.archivedAt),
        isNull(userRole.revokedAt),
        eq(role.code, 'doctor'),
      ),
    )
    .limit(1);
  if (!provider) return { ok: false, reason: 'unknown_provider' };

  // Must sit entirely within one opening-hours window for that weekday.
  const windows = await tx
    .select({ opensAt: clinicHours.opensAt, closesAt: clinicHours.closesAt })
    .from(clinicHours)
    .where(
      and(eq(clinicHours.clinicId, session.clinicId), eq(clinicHours.dayOfWeek, dayOfWeek)),
    );
  const withinHours = windows.some(
    (w) => toMinutes(w.opensAt) <= startMinutes && endMinutes <= toMinutes(w.closesAt),
  );
  if (!withinHours) return { ok: false, reason: 'outside_hours' };

  const end = new Date(start.getTime() + args.durationMinutes * 60_000);
  const range = `[${start.toISOString()},${end.toISOString()})`;

  /*
   * A closure or the provider's time off blocks the slot.
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
          eq(scheduleException.providerUserId, args.providerUserId),
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
        eq(providerAvailability.providerUserId, args.providerUserId),
      ),
    );
  if (avail.length > 0) {
    const forDay = avail.filter((a) => a.dayOfWeek === dayOfWeek);
    const withinAvail = forDay.some(
      (a) => toMinutes(a.startsAt) <= startMinutes && endMinutes <= toMinutes(a.endsAt),
    );
    if (!withinAvail) return { ok: false, reason: 'unavailable' };
  }

  return { ok: true, range };
}

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

      const slot = await checkSlot(tx, session, {
        providerUserId: input.providerUserId,
        durationMinutes: type.duration,
        startsAt: input.startsAt,
      });
      if (!slot.ok) return { ok: false, reason: slot.reason };

      const [row] = await tx
        .insert(appointment)
        .values({
          clinicId: session.clinicId,
          patientId: session.patientId,
          providerUserId: input.providerUserId,
          appointmentTypeId: input.appointmentTypeId,
          during: slot.range,
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

/* -------------------------------------------------------------------------- */
/* Changing an appointment you already have                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a patient may do to their own booking, and when.
 *
 * Narrower than the staff rule on purpose. `ALLOWED_TRANSITIONS` lets a CHECKED-IN
 * appointment be cancelled — correct for a receptionist, wrong for self-service: someone
 * already standing in the waiting room cancelling from their phone leaves the front desk
 * with a patient present and no appointment. So self-service additionally requires the
 * appointment to still be `scheduled` and still be in the future; anything else is a phone
 * call to the clinic, which is also the honest answer for a late cancellation.
 */
type SelfServiceCheck =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'too_late' | 'not_changeable' };

function assessSelfService(
  existing: { status: string; startsAt: Date | null } | undefined,
): SelfServiceCheck {
  if (!existing) return { ok: false, reason: 'not_found' };

  const status = existing.status as AppointmentStatus;
  if (status !== 'scheduled' || !canTransition(status, 'cancelled')) {
    return { ok: false, reason: 'not_changeable' };
  }
  if (!existing.startsAt || existing.startsAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'too_late' };
  }
  return { ok: true };
}

export type PortalCancelResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'too_late' | 'not_changeable' };

/**
 * The patient cancels their own appointment.
 *
 * `cancelled_by` stays NULL. It is a foreign key to `user_account`, and writing some staff
 * id into it to satisfy the column would be a false record of who cancelled — precisely
 * what an audit exists to catch. The truthful attribution lives in the audit row, whose
 * actor is the patient account, exactly as it is for portal booking.
 *
 * Nothing is deleted: `cancelled` is a status, and the row and its history stay.
 */
export async function cancelMyAppointment(
  appointmentId: string,
): Promise<PortalCancelResult> {
  const session = await requirePatientSession();
  const db = getDb();

  return db.transaction(async (tx): Promise<PortalCancelResult> => {
    const [existing] = await tx
      .select({ status: appointment.status, startsAt: appointment.startsAt })
      .from(appointment)
      .where(
        and(
          // The whole authority check: it must be THIS patient's appointment.
          eq(appointment.id, appointmentId),
          eq(appointment.patientId, session.patientId),
          eq(appointment.clinicId, session.clinicId),
          isNull(appointment.archivedAt),
        ),
      )
      .limit(1);

    const verdict = assessSelfService(existing);
    if (!verdict.ok) {
      /*
       * Denials are audited too. A patient poking at an id that is not theirs is exactly
       * the access attempt §164.312(b) exists to record, and from the server it is
       * indistinguishable from a stale tab — which is why it is logged, not judged.
       */
      await auditAsPatient(tx, session, {
        action: 'appointment.cancel',
        outcome: 'denied',
        subjectPatientId: session.patientId,
        entityType: 'appointment',
        entityId: appointmentId,
        metadata: { via: 'portal', reason: verdict.reason },
      });
      return verdict;
    }

    await tx
      .update(appointment)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: null,
        cancellationReason: 'Cancelled online by patient',
        version: sql`${appointment.version} + 1`,
      })
      .where(eq(appointment.id, appointmentId));

    await auditAsPatient(tx, session, {
      action: 'appointment.cancel',
      outcome: 'allowed',
      subjectPatientId: session.patientId,
      entityType: 'appointment',
      entityId: appointmentId,
      metadata: { via: 'portal' },
    });

    return { ok: true };
  });
}

export type PortalRescheduleResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_found' | 'too_late' | 'not_changeable' | 'slot_taken' | SlotDenial;
    };

/**
 * The patient moves their own appointment to a different time.
 *
 * The clinician and the visit type are NOT re-chosen here — moving an appointment and
 * changing what it is for are different requests, and the second one belongs with the
 * clinic. The duration is re-read from the appointment type rather than carried over, so
 * a type whose length has since changed moves to the current one.
 *
 * The new time goes through `checkSlot`, the same gate as booking, and the GiST exclusion
 * constraint still has the final say if two people move into one slot at once.
 */
export async function rescheduleMyAppointment(
  appointmentId: string,
  startsAt: string,
): Promise<PortalRescheduleResult> {
  const session = await requirePatientSession();
  const db = getDb();

  try {
    return await db.transaction(async (tx): Promise<PortalRescheduleResult> => {
      const [existing] = await tx
        .select({
          status: appointment.status,
          startsAt: appointment.startsAt,
          providerUserId: appointment.providerUserId,
          duration: appointmentType.defaultDurationMinutes,
        })
        .from(appointment)
        .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
        .where(
          and(
            eq(appointment.id, appointmentId),
            eq(appointment.patientId, session.patientId),
            eq(appointment.clinicId, session.clinicId),
            isNull(appointment.archivedAt),
          ),
        )
        .limit(1);

      const verdict = assessSelfService(existing);
      if (!verdict.ok) {
        await auditAsPatient(tx, session, {
          action: 'appointment.update',
          outcome: 'denied',
          subjectPatientId: session.patientId,
          entityType: 'appointment',
          entityId: appointmentId,
          metadata: { via: 'portal', operation: 'reschedule', reason: verdict.reason },
        });
        return verdict;
      }

      const slot = await checkSlot(tx, session, {
        providerUserId: existing!.providerUserId,
        durationMinutes: existing!.duration,
        startsAt,
      });
      if (!slot.ok) return { ok: false, reason: slot.reason };

      await tx
        .update(appointment)
        .set({ during: slot.range, version: sql`${appointment.version} + 1` })
        .where(eq(appointment.id, appointmentId));

      await auditAsPatient(tx, session, {
        action: 'appointment.update',
        outcome: 'allowed',
        subjectPatientId: session.patientId,
        entityType: 'appointment',
        entityId: appointmentId,
        metadata: { via: 'portal', operation: 'reschedule' },
      });

      return { ok: true };
    });
  } catch (error) {
    if (isSlotContention(error)) return { ok: false, reason: 'slot_taken' };
    throw error;
  }
}
