'use server';

import { revalidatePath } from 'next/cache';

import { formFields, toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import {
  cancelPrescriptionInput,
  correctPrescriptionInput,
  createPrescriptionInput,
} from '@/lib/prescription-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import {
  cancelPrescription,
  correctPrescription,
  createPrescription,
} from '@/server/data-access/prescriptions';

/**
 * Prescription server actions.
 *
 * Public HTTP endpoints. A receptionist holds no `prescription.*` grant, and an
 * administrator holds only `prescription.read` — both are refused here by the data layer
 * before any row is written, with an `authz.denied` audit entry.
 *
 * Note there is no update action. Correcting an issued prescription goes through
 * `correctPrescriptionAction`, which cancels and replaces.
 */

export type PrescriptionFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
};

function authzMessage(error: unknown): PrescriptionFormState | null {
  if (error instanceof AuthorizationError) {
    return {
      message:
        error.reason === 'UNAUTHENTICATED'
          ? 'Your session has ended. Sign in again.'
          : 'You do not have permission to prescribe. The attempt has been recorded.',
    };
  }
  return null;
}

function explain(reason: string): string {
  switch (reason) {
    case 'controlled_substance':
      return 'That medication is a controlled substance. Cliniqo does not implement DEA EPCS, so it cannot be prescribed here — issue it on paper.';
    case 'already_cancelled':
      return 'That prescription has already been cancelled. Issue a new one instead.';
    default:
      return 'That prescription could not be found.';
  }
}

/* -------------------------------------------------------------------------- */

export async function createPrescriptionAction(
  _previous: PrescriptionFormState,
  formData: FormData,
): Promise<PrescriptionFormState> {
  const raw = formFields(formData);
  // An empty optional uuid arrives as "" and must not be parsed as a bad uuid.
  if (raw['visitNoteId'] === '') delete raw['visitNoteId'];

  const parsed = createPrescriptionInput.safeParse(raw);
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await createPrescription(parsed.data);
    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath(`/patients/${parsed.data.patientId}`);
    return { ok: true, message: 'Prescription issued.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

/**
 * Correct an issued prescription.
 *
 * Cancels the original and issues a replacement that references it. Both stay in the
 * record — the history shows what was withdrawn, why, and what took its place.
 */
export async function correctPrescriptionAction(
  _previous: PrescriptionFormState,
  formData: FormData,
): Promise<PrescriptionFormState> {
  const parsed = correctPrescriptionInput.safeParse(
    formFields(formData),
  );
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const { originalPrescriptionId, patientId, reason, ...line } = parsed.data;

  try {
    const result = await correctPrescription(
      originalPrescriptionId,
      patientId,
      reason,
      line,
    );
    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath(`/patients/${patientId}`);
    return {
      ok: true,
      message: 'Correction issued. The original is cancelled and remains in the record.',
    };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function cancelPrescriptionAction(
  _previous: PrescriptionFormState,
  formData: FormData,
): Promise<PrescriptionFormState> {
  const parsed = cancelPrescriptionInput.safeParse(
    formFields(formData),
  );
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await cancelPrescription(
      parsed.data.prescriptionId,
      parsed.data.patientId,
      parsed.data.reason,
    );
    if (!result.ok) return { message: explain(result.reason) };

    revalidatePath(`/patients/${parsed.data.patientId}`);
    return { ok: true, message: 'Prescription cancelled. It remains in the record.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}
