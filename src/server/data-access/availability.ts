import 'server-only';

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import {
  providerAvailability,
  role,
  scheduleException,
  userAccount,
  userRole,
} from '@/db/schema';
import { zonedWallClock } from '@/lib/clinic-time';
import type { ExceptionInput } from '@/lib/availability-schemas';

import { auditedRead, auditedWrite } from './audited';

/**
 * Provider availability and schedule exceptions — the write side of the schedule.
 *
 * These two tables were enforced or intended but never writable: `schedule_exception`
 * already BLOCKS booking (a slot overlapping one is refused), yet nothing could create an
 * exception, and `provider_availability` was dormant entirely. This is the management
 * surface that makes "Dr Okafor is off Tuesday" and "the clinic is closed for the holiday"
 * expressible.
 *
 * Gated on `appointment.update` (admin + reception) — the same people who manage the
 * diary. None of this is PHI: it concerns providers and clinic hours, not patients, so the
 * audit action is the non-PHI `schedule.configure` and no `subjectPatientId` applies.
 */

export type AvailabilityRow = {
  id: string;
  providerUserId: string;
  dayOfWeek: number;
  startsAt: string;
  endsAt: string;
};

export type ExceptionRow = {
  id: string;
  providerUserId: string | null;
  providerName: string | null;
  kind: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
};

export type AvailabilityView = {
  providers: { id: string; name: string }[];
  availability: AvailabilityRow[];
  exceptions: ExceptionRow[];
};

function parseRange(during: string): [Date, Date] {
  const m = /^\[(.+),(.+)\)$/.exec(during);
  return m ? [new Date(m[1]!), new Date(m[2]!)] : [new Date(), new Date()];
}

export async function getAvailabilityView(): Promise<AvailabilityView> {
  return auditedRead(
    {
      permission: 'appointment.update',
      action: 'reference.read',
      entityType: 'clinic',
      metadata: { scope: 'availability_management' },
    },
    async (tx, session) => {
      const providers = await tx
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
        .orderBy(asc(userAccount.fullName));

      const availability = await tx
        .select({
          id: providerAvailability.id,
          providerUserId: providerAvailability.providerUserId,
          dayOfWeek: providerAvailability.dayOfWeek,
          startsAt: providerAvailability.startsAt,
          endsAt: providerAvailability.endsAt,
        })
        .from(providerAvailability)
        .where(eq(providerAvailability.clinicId, session.clinicId))
        .orderBy(asc(providerAvailability.dayOfWeek), asc(providerAvailability.startsAt));

      const exceptionRows = await tx
        .select({
          id: scheduleException.id,
          providerUserId: scheduleException.providerUserId,
          providerName: userAccount.fullName,
          kind: scheduleException.kind,
          during: scheduleException.during,
          reason: scheduleException.reason,
        })
        .from(scheduleException)
        .leftJoin(userAccount, eq(userAccount.id, scheduleException.providerUserId))
        .where(
          and(
            eq(scheduleException.clinicId, session.clinicId),
            // Only what still matters: exceptions whose window has not fully passed.
            sql`upper(${scheduleException.during}) >= now()`,
          ),
        )
        .orderBy(sql`lower(${scheduleException.during}) asc`);

      const exceptions: ExceptionRow[] = exceptionRows.map((r) => {
        const [startsAt, endsAt] = parseRange(r.during as unknown as string);
        return {
          id: r.id,
          providerUserId: r.providerUserId,
          providerName: r.providerName,
          kind: r.kind,
          startsAt,
          endsAt,
          reason: r.reason,
        };
      });

      return { providers, availability, exceptions };
    },
  );
}

export type AvailabilityResult =
  | { ok: true }
  | { ok: false; reason: 'unknown_provider' | 'not_found' };

/**
 * Replace one provider's weekly hours.
 *
 * Delete-and-reinsert in one transaction, like the clinic hours: availability is a small,
 * wholly-owned set with no foreign keys pointing at it, so reconciling row-by-row would be
 * more code for no behavioural difference — and a failure leaves the previous hours intact
 * rather than a provider with none.
 */
export async function setProviderAvailability(
  providerUserId: string,
  rows: { dayOfWeek: number; startsAt: string; endsAt: string }[],
): Promise<AvailabilityResult> {
  return auditedWrite<AvailabilityResult>(
    {
      permission: 'appointment.update',
      action: 'schedule.configure',
      entityType: 'clinic',
      entityId: providerUserId,
      metadata: { operation: 'set_availability', rowCount: rows.length },
    },
    async (tx, session): Promise<AvailabilityResult> => {
      // The provider must be one of the clinic's active doctors.
      const [doc] = await tx
        .select({ id: userAccount.id })
        .from(userAccount)
        .innerJoin(userRole, eq(userRole.userId, userAccount.id))
        .innerJoin(role, eq(role.id, userRole.roleId))
        .where(
          and(
            eq(userAccount.id, providerUserId),
            eq(userAccount.clinicId, session.clinicId),
            isNull(userRole.revokedAt),
            eq(role.code, 'doctor'),
          ),
        )
        .limit(1);
      if (!doc) return { ok: false, reason: 'unknown_provider' };

      await tx
        .delete(providerAvailability)
        .where(
          and(
            eq(providerAvailability.providerUserId, providerUserId),
            eq(providerAvailability.clinicId, session.clinicId),
          ),
        );

      if (rows.length > 0) {
        await tx.insert(providerAvailability).values(
          rows.map((r) => ({
            clinicId: session.clinicId,
            providerUserId,
            dayOfWeek: r.dayOfWeek,
            startsAt: r.startsAt,
            endsAt: r.endsAt,
          })),
        );
      }

      return { ok: true };
    },
  );
}

export async function addScheduleException(
  input: ExceptionInput,
): Promise<AvailabilityResult> {
  return auditedWrite<AvailabilityResult>(
    {
      permission: 'appointment.update',
      action: 'schedule.configure',
      entityType: 'clinic',
      metadata: {
        operation: 'add_exception',
        kind: input.kind,
        clinicWide: input.providerUserId === undefined,
      },
    },
    async (tx, session): Promise<AvailabilityResult> => {
      if (input.providerUserId) {
        const [doc] = await tx
          .select({ id: userAccount.id })
          .from(userAccount)
          .innerJoin(userRole, eq(userRole.userId, userAccount.id))
          .innerJoin(role, eq(role.id, userRole.roleId))
          .where(
            and(
              eq(userAccount.id, input.providerUserId),
              eq(userAccount.clinicId, session.clinicId),
              isNull(userRole.revokedAt),
              eq(role.code, 'doctor'),
            ),
          )
          .limit(1);
        if (!doc) return { ok: false, reason: 'unknown_provider' };
      }

      // Wall-clock in the clinic zone, same discipline as booking.
      const start = zonedWallClock(input.startsAt, session.clinicTimeZone);
      const end = zonedWallClock(input.endsAt, session.clinicTimeZone);
      const range = `[${start.toISOString()},${end.toISOString()})`;

      await tx.insert(scheduleException).values({
        clinicId: session.clinicId,
        providerUserId: input.providerUserId ?? null,
        during: range,
        kind: input.kind,
        reason: input.reason ?? null,
        createdBy: session.userId,
      });

      return { ok: true };
    },
  );
}

/** Remove a schedule exception (e.g. a time-off booked in error). Audited. */
export async function deleteScheduleException(
  exceptionId: string,
): Promise<AvailabilityResult> {
  return auditedWrite<AvailabilityResult>(
    {
      permission: 'appointment.update',
      action: 'schedule.configure',
      entityType: 'clinic',
      entityId: exceptionId,
      metadata: { operation: 'delete_exception' },
    },
    async (tx, session): Promise<AvailabilityResult> => {
      const deleted = await tx
        .delete(scheduleException)
        .where(
          and(
            eq(scheduleException.id, exceptionId),
            eq(scheduleException.clinicId, session.clinicId),
          ),
        )
        .returning({ id: scheduleException.id });

      return deleted.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
    },
  );
}

