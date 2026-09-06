'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  appointmentTypeInput,
  clinicHoursInput,
  clinicInput,
} from '@/lib/clinic-config-schemas';
import { formFields, toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import {
  createAppointmentType,
  replaceClinicHours,
  setAppointmentTypeActive,
  updateClinicSettings,
} from '@/server/data-access/clinic-config';

/**
 * Clinic configuration actions. Administrator only, enforced at the data layer.
 */

export type ConfigFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
};

function authzMessage(error: unknown): ConfigFormState | null {
  if (error instanceof AuthorizationError) {
    return {
      message:
        error.reason === 'UNAUTHENTICATED'
          ? 'Your session has ended. Sign in again.'
          : 'Only an administrator can change clinic settings. The attempt has been recorded.',
    };
  }
  return null;
}

export async function updateClinicAction(
  _previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const parsed = clinicInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await updateClinicSettings(parsed.data);
    if (!result.ok) return { message: 'The clinic record could not be found.' };

    revalidatePath('/settings');
    revalidatePath('/schedule');
    return { ok: true, message: 'Clinic settings saved.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function createAppointmentTypeAction(
  _previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const parsed = appointmentTypeInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await createAppointmentType(parsed.data);
    if (!result.ok) {
      return {
        message:
          result.reason === 'duplicate_code'
            ? 'An appointment type with that code already exists.'
            : 'That could not be saved.',
      };
    }

    revalidatePath('/settings');
    return { ok: true, message: 'Appointment type added. It is now bookable.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function toggleAppointmentTypeAction(
  _previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const parsed = z
    .object({ typeId: z.uuid(), isActive: z.enum(['true', 'false']) })
    .safeParse(formFields(formData));

  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await setAppointmentTypeActive(
      parsed.data.typeId,
      parsed.data.isActive === 'true',
    );
    if (!result.ok) return { message: 'That appointment type could not be found.' };

    revalidatePath('/settings');
    return {
      ok: true,
      message:
        parsed.data.isActive === 'true'
          ? 'Type reactivated.'
          : 'Type retired. Existing appointments keep it; new bookings cannot use it.',
    };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

/**
 * Replace opening hours wholesale.
 *
 * The form posts parallel arrays, which is how a repeating fieldset serialises. Rows with
 * no opening time are dropped rather than rejected - a blank row is "this day is closed",
 * not a validation error.
 */
export async function saveHoursAction(
  _previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const days = formData.getAll('dayOfWeek');
  const opens = formData.getAll('opensAt');
  const closes = formData.getAll('closesAt');

  const rows = days
    .map((d, i) => ({
      dayOfWeek: Number(d),
      opensAt: String(opens[i] ?? ''),
      closesAt: String(closes[i] ?? ''),
    }))
    .filter((r) => r.opensAt !== '' && r.closesAt !== '');

  const parsed = clinicHoursInput.safeParse({ rows });
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    await replaceClinicHours(parsed.data.rows);
    revalidatePath('/settings');
    revalidatePath('/schedule');
    return { ok: true, message: 'Opening hours saved.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}
