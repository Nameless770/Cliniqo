'use server';

import { revalidatePath } from 'next/cache';

import {
  bookAppointmentInput,
  cancelAppointmentInput,
  changeStatusInput,
  rescheduleAppointmentInput,
} from '@/lib/appointment-schemas';
import { toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import {
  bookAppointment,
  cancelAppointment,
  changeAppointmentStatus,
  rescheduleAppointment,
} from '@/server/data-access/appointments';

/**
 * Appointment server actions.
 *
 * Public HTTP endpoints. Validate, delegate, translate the result into something a person
 * can act on. No SQL, and no authorization decisions — those belong to the data layer,
 * which re-checks regardless of which action called it.
 */

export type AppointmentFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
};

function authzMessage(error: unknown): AppointmentFormState | null {
  if (error instanceof AuthorizationError) {
    return {
      message:
        error.reason === 'UNAUTHENTICATED'
          ? 'Your session has ended. Sign in again.'
          : 'You do not have permission to do that. The attempt has been recorded.',
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */

export async function bookAppointmentAction(
  _previous: AppointmentFormState,
  formData: FormData,
): Promise<AppointmentFormState> {
  const parsed = bookAppointmentInput.safeParse(Object.fromEntries(formData.entries()));

  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await bookAppointment(parsed.data);

    if (!result.ok) {
      return {
        message:
          result.reason === 'slot_taken'
            ? // The honest message for losing a race. Someone else committed first.
              'That slot was taken while you were booking. Pick another time.'
            : result.reason === 'closed'
              ? 'The clinic or that clinician is unavailable then. Pick another time.'
              : 'That patient could not be found.',
      };
    }

    revalidatePath('/schedule');
    revalidatePath(`/patients/${parsed.data.patientId}`);
    return { ok: true, message: 'Appointment booked.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function rescheduleAppointmentAction(
  _previous: AppointmentFormState,
  formData: FormData,
): Promise<AppointmentFormState> {
  const parsed = rescheduleAppointmentInput.safeParse(
    Object.fromEntries(formData.entries()),
  );

  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await rescheduleAppointment(
      parsed.data.appointmentId,
      new Date(parsed.data.startsAt),
      parsed.data.durationMinutes,
    );

    if (!result.ok) {
      return {
        message:
          result.reason === 'slot_taken'
            ? 'That slot is already taken. Pick another time.'
            : result.reason === 'closed'
              ? 'The clinic or that clinician is unavailable then.'
              : 'That appointment could not be found.',
      };
    }

    revalidatePath('/schedule');
    return { ok: true, message: 'Appointment moved.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function changeStatusAction(
  _previous: AppointmentFormState,
  formData: FormData,
): Promise<AppointmentFormState> {
  const parsed = changeStatusInput.safeParse(Object.fromEntries(formData.entries()));

  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await changeAppointmentStatus(
      parsed.data.appointmentId,
      parsed.data.status,
    );

    if (!result.ok) {
      return {
        message:
          result.reason === 'illegal_transition'
            ? 'That status change is not allowed from the appointment’s current state. Reload to see where it actually is.'
            : result.reason === 'not_your_appointment'
              ? 'You can only change the status of your own appointments. The attempt has been recorded.'
              : 'That appointment could not be found.',
      };
    }

    revalidatePath('/schedule');
    return { ok: true, message: 'Updated.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function cancelAppointmentAction(
  _previous: AppointmentFormState,
  formData: FormData,
): Promise<AppointmentFormState> {
  const parsed = cancelAppointmentInput.safeParse(Object.fromEntries(formData.entries()));

  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await cancelAppointment(parsed.data.appointmentId, parsed.data.reason);

    if (!result.ok) {
      return {
        message:
          result.reason === 'illegal_transition'
            ? 'That appointment is already closed and cannot be cancelled.'
            : 'That appointment could not be found.',
      };
    }

    revalidatePath('/schedule');
    return { ok: true, message: 'Appointment cancelled.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}
