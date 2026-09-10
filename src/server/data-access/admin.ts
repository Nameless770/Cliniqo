import 'server-only';

import { and, asc, count, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';

import { appointment, auditEvent, patient, userAccount, visitNote } from '@/db/schema';
import type { AuditAction } from '@/server/audit/actions';

import { auditedRead } from './audited';
import { pendingBreakGlassCount } from './break-glass';
import { bulkReaders } from './read-budget';

/**
 * Administrator surfaces: the audit viewer and the clinic dashboard.
 */

/* -------------------------------------------------------------------------- */
/* Audit viewer                                                               */
/* -------------------------------------------------------------------------- */

export type AuditFilters = {
  actorUserId?: string;
  subjectPatientId?: string;
  action?: string;
  outcome?: 'allowed' | 'denied' | 'error';
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
};

export type AuditRow = {
  id: string;
  occurredAt: Date;
  action: string;
  outcome: string;
  actorName: string | null;
  actorRoleCodes: string[] | null;
  subjectPatientId: string | null;
  subjectPatientMrn: string | null;
  entityType: string | null;
  entityId: string | null;
  purpose: string | null;
};

export type AuditPage = {
  rows: AuditRow[];
  total: number;
  page: number;
  pageCount: number;
};

/**
 * Read the audit log, filtered.
 *
 * READING THE AUDIT LOG IS ITSELF AUDITED. This goes through `auditedRead` like every
 * other read, so each query writes one `audit.read` row recording who looked, when, and
 * WHICH FILTERS they used — never the filter values, because a filter naming a patient
 * would put that patient's identity into the log a second time.
 *
 * One row per request, not per result: bounded, and exactly what "who reviewed the log,
 * and when" requires. Paginating writes one row per page, which is honest — each page is
 * a separate act of looking.
 */
export async function readAuditLog(filters: AuditFilters): Promise<AuditPage> {
  return auditedRead(
    {
      permission: 'audit.read',
      action: 'audit.read',
      entityType: 'audit_event',
      // Filter NAMES and the window size. Never the ids or the action being searched for.
      metadata: {
        filteredBy: Object.entries(filters)
          .filter(([k, v]) => v !== undefined && k !== 'page' && k !== 'pageSize')
          .map(([k]) => k),
        page: filters.page,
      },
    },
    async (tx, session) => {
      const where: SQL[] = [eq(auditEvent.clinicId, session.clinicId)];

      if (filters.actorUserId)
        where.push(eq(auditEvent.actorUserId, filters.actorUserId));
      if (filters.subjectPatientId) {
        where.push(eq(auditEvent.subjectPatientId, filters.subjectPatientId));
      }
      if (filters.action)
        where.push(eq(auditEvent.action, filters.action as AuditAction));
      if (filters.outcome) where.push(eq(auditEvent.outcome, filters.outcome));
      if (filters.from) where.push(gte(auditEvent.occurredAt, filters.from));
      if (filters.to) where.push(lte(auditEvent.occurredAt, filters.to));

      const predicate = and(...where);

      const rows = await tx
        .select({
          id: auditEvent.id,
          occurredAt: auditEvent.occurredAt,
          action: auditEvent.action,
          outcome: auditEvent.outcome,
          actorName: userAccount.fullName,
          actorRoleCodes: auditEvent.actorRoleCodes,
          subjectPatientId: auditEvent.subjectPatientId,
          subjectPatientMrn: patient.mrn,
          entityType: auditEvent.entityType,
          entityId: auditEvent.entityId,
          purpose: auditEvent.purpose,
        })
        .from(auditEvent)
        // LEFT joins: an audit row must render even if its actor or subject is gone.
        .leftJoin(userAccount, eq(userAccount.id, auditEvent.actorUserId))
        .leftJoin(patient, eq(patient.id, auditEvent.subjectPatientId))
        .where(predicate)
        .orderBy(desc(auditEvent.occurredAt))
        .limit(filters.pageSize)
        .offset((filters.page - 1) * filters.pageSize);
      const [totals] = await tx
        .select({ value: count() })
        .from(auditEvent)
        .where(predicate);

      const total = totals?.value ?? 0;

      return {
        rows: rows as AuditRow[],
        total,
        page: filters.page,
        pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
      };
    },
  );
}

/** Distinct actors and actions present in the log, for the filter dropdowns. */
export async function getAuditFilterOptions(): Promise<{
  actors: { id: string; name: string }[];
  actions: string[];
}> {
  return auditedRead(
    {
      permission: 'audit.read',
      action: 'reference.read',
      entityType: 'audit_event',
      metadata: { scope: 'audit_filter_options' },
    },
    async (tx, session) => {
      const actors = await tx
        .select({ id: userAccount.id, name: userAccount.fullName })
        .from(userAccount)
        .where(eq(userAccount.clinicId, session.clinicId))
        .orderBy(asc(userAccount.fullName));
      const actions = await tx
        .selectDistinct({ action: auditEvent.action })
        .from(auditEvent)
        .where(eq(auditEvent.clinicId, session.clinicId))
        .orderBy(asc(auditEvent.action));

      return { actors, actions: actions.map((a) => a.action) };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export type ClinicOverview = {
  activePatients: number;
  activeStaff: number;
  appointmentsToday: number;
  checkedInNow: number;
  completedToday: number;
  noShowsToday: number;
  unsignedNotes: number;
  deniedLast24h: number;
  /** F1 detection: actors whose 24h read volume warrants a look. */
  bulkReaders: number;
  breakGlassPending: number;
};

/**
 * Clinic overview.
 *
 * COUNTS ONLY — no names, no identifiers. A dashboard is the screen most likely to be
 * left open on a monitor visible from a waiting room, so it deliberately carries nothing
 * that identifies a patient.
 *
 * `deniedLast24h` and `unsignedNotes` are on here because they are the two numbers that
 * should prompt action: refused access attempts are the first sign of a problem, and
 * unsigned notes are both a care-quality and a billing failure.
 */
export async function getClinicOverview(
  dayStart: Date,
  dayEnd: Date,
): Promise<ClinicOverview> {
  return auditedRead(
    {
      permission: 'clinic.configure',
      action: 'reference.read',
      entityType: 'clinic',
      metadata: { scope: 'dashboard_counts' },
    },
    async (tx, session) => {
      const clinicId = session.clinicId;
      const inDay = sql`${appointment.during} && tstzrange(${dayStart.toISOString()}, ${dayEnd.toISOString()})`;

      const scalar = async (q: Promise<{ value: number }[]>) => (await q)[0]?.value ?? 0;

      const activePatients = await scalar(
        tx
          .select({ value: count() })
          .from(patient)
          .where(and(eq(patient.clinicId, clinicId), isNull(patient.archivedAt))),
      );
      const activeStaff = await scalar(
        tx
          .select({ value: count() })
          .from(userAccount)
          .where(
            and(
              eq(userAccount.clinicId, clinicId),
              eq(userAccount.status, 'active'),
              isNull(userAccount.archivedAt),
            ),
          ),
      );
      const appointmentsToday = await scalar(
        tx
          .select({ value: count() })
          .from(appointment)
          .where(
            and(
              eq(appointment.clinicId, clinicId),
              inDay,
              isNull(appointment.archivedAt),
            ),
          ),
      );
      const checkedInNow = await scalar(
        tx
          .select({ value: count() })
          .from(appointment)
          .where(
            and(
              eq(appointment.clinicId, clinicId),
              inDay,
              eq(appointment.status, 'checked_in'),
            ),
          ),
      );
      const completedToday = await scalar(
        tx
          .select({ value: count() })
          .from(appointment)
          .where(
            and(
              eq(appointment.clinicId, clinicId),
              inDay,
              eq(appointment.status, 'completed'),
            ),
          ),
      );
      const noShowsToday = await scalar(
        tx
          .select({ value: count() })
          .from(appointment)
          .where(
            and(
              eq(appointment.clinicId, clinicId),
              inDay,
              eq(appointment.status, 'no_show'),
            ),
          ),
      );
      const unsignedNotes = await scalar(
        tx
          .select({ value: count() })
          .from(visitNote)
          .where(
            and(
              eq(visitNote.clinicId, clinicId),
              eq(visitNote.status, 'draft'),
              isNull(visitNote.archivedAt),
            ),
          ),
      );
      const deniedLast24h = await scalar(
        tx
          .select({ value: count() })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.clinicId, clinicId),
              eq(auditEvent.outcome, 'denied'),
              sql`${auditEvent.occurredAt} > now() - interval '24 hours'`,
            ),
          ),
      );

      const heavy = await bulkReaders(clinicId);
      const breakGlassPending = await pendingBreakGlassCount(clinicId);

      return {
        activePatients,
        activeStaff,
        appointmentsToday,
        checkedInNow,
        completedToday,
        noShowsToday,
        unsignedNotes,
        deniedLast24h,
        bulkReaders: heavy.length,
        breakGlassPending,
      };
    },
  );
}
