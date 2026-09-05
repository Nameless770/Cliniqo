import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { appointmentType, clinic, clinicHours } from '@/db/schema';
import type { AppointmentTypeInput, ClinicInput } from '@/lib/clinic-config-schemas';

import { auditedRead, auditedWrite } from './audited';

/**
 * Clinic configuration. Administrator only (`clinic.configure`).
 *
 * This closes the gap that made the application unusable on day one: `appointment_type`
 * was read by the booking form and written by nothing but a migration, so a fresh clinic
 * had an empty dropdown and could not book anything. Same for opening hours, which the
 * schedule needs in order to mean anything.
 *
 * None of this is PHI — it is clinic reference data — so reads use `reference.read`
 * rather than a patient action, and no `subjectPatientId` applies.
 */

export type ClinicSettings = {
  id: string;
  name: string;
  timezone: string;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  mrnPrefix: string;
};

export type AppointmentTypeRow = {
  id: string;
  code: string;
  displayName: string;
  defaultDurationMinutes: number;
  isActive: boolean;
  sortOrder: number;
};

export type HoursRow = {
  id: string;
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
};

/* -------------------------------------------------------------------------- */

export async function getClinicSettings(): Promise<{
  clinic: ClinicSettings;
  types: AppointmentTypeRow[];
  hours: HoursRow[];
} | null> {
  return auditedRead(
    {
      permission: 'clinic.configure',
      action: 'reference.read',
      entityType: 'clinic',
      metadata: { scope: 'clinic_settings' },
    },
    async (tx, session) => {
      const [row] = await tx
        .select({
          id: clinic.id,
          name: clinic.name,
          timezone: clinic.timezone,
          phone: clinic.phone,
          addressLine1: clinic.addressLine1,
          city: clinic.city,
          state: clinic.state,
          postalCode: clinic.postalCode,
          mrnPrefix: clinic.mrnPrefix,
        })
        .from(clinic)
        .where(eq(clinic.id, session.clinicId))
        .limit(1);

      if (!row) return null;

      const [types, hours] = await Promise.all([
        tx
          .select({
            id: appointmentType.id,
            code: appointmentType.code,
            displayName: appointmentType.displayName,
            defaultDurationMinutes: appointmentType.defaultDurationMinutes,
            isActive: appointmentType.isActive,
            sortOrder: appointmentType.sortOrder,
          })
          .from(appointmentType)
          .where(eq(appointmentType.clinicId, session.clinicId))
          .orderBy(asc(appointmentType.sortOrder), asc(appointmentType.displayName)),
        tx
          .select({
            id: clinicHours.id,
            dayOfWeek: clinicHours.dayOfWeek,
            opensAt: clinicHours.opensAt,
            closesAt: clinicHours.closesAt,
          })
          .from(clinicHours)
          .where(eq(clinicHours.clinicId, session.clinicId))
          .orderBy(asc(clinicHours.dayOfWeek), asc(clinicHours.opensAt)),
      ]);

      return { clinic: row as ClinicSettings, types, hours };
    },
  );
}

export type ConfigResult =
  { ok: true } | { ok: false; reason: 'duplicate_code' | 'not_found' };

/**
 * Clinic details.
 *
 * The TIMEZONE is the consequential field. Every schedule boundary is computed in it, so
 * changing it moves every appointment's displayed time — the stored instants do not move,
 * which is correct, but a clinic that changes this after booking anything will see its
 * day shift. Worth a warning in the UI, which is why the form says so.
 */
export async function updateClinicSettings(input: ClinicInput): Promise<ConfigResult> {
  return auditedWrite(
    {
      permission: 'clinic.configure',
      action: 'clinic.configure',
      entityType: 'clinic',
      metadata: { fields: Object.keys(input) },
    },
    async (tx, session): Promise<ConfigResult> => {
      const updated = await tx
        .update(clinic)
        .set({
          name: input.name,
          timezone: input.timezone,
          phone: input.phone ?? null,
          addressLine1: input.addressLine1 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          postalCode: input.postalCode ?? null,
        })
        .where(eq(clinic.id, session.clinicId))
        .returning({ id: clinic.id });

      return updated.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
    },
  );
}

export async function createAppointmentType(
  input: AppointmentTypeInput,
): Promise<ConfigResult> {
  return auditedWrite(
    {
      permission: 'clinic.configure',
      action: 'clinic.configure',
      entityType: 'clinic',
      metadata: { operation: 'create_appointment_type', code: input.code },
    },
    async (tx, session): Promise<ConfigResult> => {
      const [existing] = await tx
        .select({ id: appointmentType.id })
        .from(appointmentType)
        .where(
          and(
            eq(appointmentType.clinicId, session.clinicId),
            eq(appointmentType.code, input.code),
          ),
        )
        .limit(1);

      if (existing) return { ok: false, reason: 'duplicate_code' };

      await tx.insert(appointmentType).values({
        clinicId: session.clinicId,
        code: input.code,
        displayName: input.displayName,
        defaultDurationMinutes: input.defaultDurationMinutes,
        sortOrder: input.sortOrder,
        isActive: true,
      });

      return { ok: true };
    },
  );
}

/**
 * Retire an appointment type rather than delete it.
 *
 * Every past appointment references one by foreign key. Deleting would either fail or
 * orphan history; deactivating removes it from the booking dropdown while leaving old
 * appointments readable.
 */
export async function setAppointmentTypeActive(
  typeId: string,
  isActive: boolean,
): Promise<ConfigResult> {
  return auditedWrite(
    {
      permission: 'clinic.configure',
      action: 'clinic.configure',
      entityType: 'clinic',
      entityId: typeId,
      metadata: { operation: 'set_appointment_type_active', isActive },
    },
    async (tx, session): Promise<ConfigResult> => {
      const updated = await tx
        .update(appointmentType)
        .set({ isActive })
        .where(
          and(
            eq(appointmentType.id, typeId),
            eq(appointmentType.clinicId, session.clinicId),
          ),
        )
        .returning({ id: appointmentType.id });

      return updated.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
    },
  );
}

/**
 * Replace the weekly opening hours.
 *
 * Delete-and-reinsert rather than diffing: hours are a small, wholly-owned set with no
 * foreign keys pointing at them, and reconciling row-by-row would be more code for no
 * behavioural difference. Both halves run in one transaction, so a failure leaves the
 * previous hours intact rather than a clinic with no opening times.
 */
export async function replaceClinicHours(
  rows: { dayOfWeek: number; opensAt: string; closesAt: string }[],
): Promise<ConfigResult> {
  return auditedWrite(
    {
      permission: 'clinic.configure',
      action: 'clinic.configure',
      entityType: 'clinic',
      metadata: { operation: 'replace_hours', rowCount: rows.length },
    },
    async (tx, session): Promise<ConfigResult> => {
      await tx.delete(clinicHours).where(eq(clinicHours.clinicId, session.clinicId));

      if (rows.length > 0) {
        await tx.insert(clinicHours).values(
          rows.map((r) => ({
            clinicId: session.clinicId,
            dayOfWeek: r.dayOfWeek,
            opensAt: r.opensAt,
            closesAt: r.closesAt,
          })),
        );
      }

      return { ok: true };
    },
  );
}
