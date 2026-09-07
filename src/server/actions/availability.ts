'use server';

import { z } from 'zod';

import { revalidatePath } from 'next/cache';

import { formFields } from '@/lib/patient-schemas';
import {
  exceptionInput,
  providerAvailabilityInput,
} from '@/lib/availability-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import {
  addScheduleException,
  deleteScheduleException,
  setProviderAvailability,
} from '@/server/data-access/availability';

/**
 * Provider availability and schedule-exception management (staff).
 *
 * Every mutation is gated inside the data-access layer on `appointment.update` and audited
 * as `schedule.configure`. Nothing here is PHI — it concerns providers and clinic hours.
 */

export type AvailabilityFormState = {
  errors?: Record<string, string[]>;
  message?: string;
  ok?: boolean;
};

function fieldErrors(error: import('zod').ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

function authz(error: unknown): AvailabilityFormState | null {
  if (error instanceof AuthorizationError) {
    return {
      message:
        error.reason === 'UNAUTHENTICATED'
          ? 'Your session has ended. Sign in again.'
          : 'You do not have permission to manage the schedule.',
    };
  }
  return null;
}

export async function saveAvailabilityAction(
  _prev: AvailabilityFormState,
  formData: FormData,
): Promise<AvailabilityFormState> {
  const providerUserId = String(formData.get('providerUserId') ?? '');
  const days = formData.getAll('dayOfWeek');
  const starts = formData.getAll('startsAt');
  const ends = formData.getAll('endsAt');

  const rows = days
    .map((d, i) => ({
      dayOfWeek: Number(d),
      startsAt: String(starts[i] ?? ''),
      endsAt: String(ends[i] ?? ''),
    }))
    .filter((r) => r.startsAt !== '' && r.endsAt !== '');

  const parsed = providerAvailabilityInput.safeParse({ providerUserId, rows });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  try {
    const result = await setProviderAvailability(
      parsed.data.providerUserId,
      parsed.data.rows,
    );
    if (!result.ok) return { message: 'That clinician could not be found.' };
    revalidatePath('/schedule/availability');
    revalidatePath('/schedule');
    return { ok: true, message: 'Availability saved.' };
  } catch (error) {
    const a = authz(error);
    if (a) return a;
    throw error;
  }
}

export async function addExceptionAction(
  _prev: AvailabilityFormState,
  formData: FormData,
): Promise<AvailabilityFormState> {
  const parsed = exceptionInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  try {
    const result = await addScheduleException(parsed.data);
    if (!result.ok) return { message: 'That clinician could not be found.' };
    revalidatePath('/schedule/availability');
    revalidatePath('/schedule');
    return { ok: true, message: 'Exception added.' };
  } catch (error) {
    const a = authz(error);
    if (a) return a;
    throw error;
  }
}

export async function deleteExceptionAction(
  _prev: AvailabilityFormState,
  formData: FormData,
): Promise<AvailabilityFormState> {
  const parsed = z
    .object({ exceptionId: z.uuid() })
    .safeParse(formFields(formData));
  if (!parsed.success) return { message: 'Bad request.' };

  try {
    const result = await deleteScheduleException(parsed.data.exceptionId);
    if (!result.ok) return { message: 'That exception was already removed.' };
    revalidatePath('/schedule/availability');
    revalidatePath('/schedule');
    return { ok: true, message: 'Exception removed.' };
  } catch (error) {
    const a = authz(error);
    if (a) return a;
    throw error;
  }
}
