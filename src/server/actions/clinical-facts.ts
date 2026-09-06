'use server';

import { revalidatePath } from 'next/cache';

import {
  addAllergyInput,
  addFlagInput,
  allergyStatusInput,
  endFlagInput,
} from '@/lib/clinical-fact-schemas';
import { formFields, toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import {
  addAllergy,
  addFlag,
  endFlag,
  setAllergyStatus,
} from '@/server/data-access/clinical-facts';

/**
 * Allergy and flag actions.
 *
 * All four require `patient.update.clinical` at the data layer — clinician only. A
 * receptionist or administrator calling these directly is refused before a row is
 * written, and the attempt is recorded.
 */

export type ClinicalFactState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
};

function authzMessage(error: unknown): ClinicalFactState | null {
  if (error instanceof AuthorizationError) {
    return {
      message:
        error.reason === 'UNAUTHENTICATED'
          ? 'Your session has ended. Sign in again.'
          : 'Only a clinician can change clinical records. The attempt has been recorded.',
    };
  }
  return null;
}

export async function addAllergyAction(
  _previous: ClinicalFactState,
  formData: FormData,
): Promise<ClinicalFactState> {
  const parsed = addAllergyInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const { patientId, ...input } = parsed.data;

  try {
    await addAllergy(patientId, input);
    revalidatePath(`/patients/${patientId}`);
    return { ok: true, message: 'Allergy recorded.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function setAllergyStatusAction(
  _previous: ClinicalFactState,
  formData: FormData,
): Promise<ClinicalFactState> {
  const parsed = allergyStatusInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await setAllergyStatus(
      parsed.data.allergyId,
      parsed.data.patientId,
      parsed.data.status,
      parsed.data.reason,
    );

    if (!result.ok) return { message: 'That allergy could not be found.' };

    revalidatePath(`/patients/${parsed.data.patientId}`);
    return {
      ok: true,
      message:
        parsed.data.status === 'entered_in_error'
          ? 'Marked as entered in error. It remains on the record, visibly retracted.'
          : 'Allergy updated.',
    };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function addFlagAction(
  _previous: ClinicalFactState,
  formData: FormData,
): Promise<ClinicalFactState> {
  const parsed = addFlagInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const { patientId, ...input } = parsed.data;

  try {
    await addFlag(patientId, input);
    revalidatePath(`/patients/${patientId}`);
    return { ok: true, message: 'Flag added.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function endFlagAction(
  _previous: ClinicalFactState,
  formData: FormData,
): Promise<ClinicalFactState> {
  const parsed = endFlagInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await endFlag(
      parsed.data.flagId,
      parsed.data.patientId,
      parsed.data.reason,
    );

    if (!result.ok) return { message: 'That flag could not be found.' };

    revalidatePath(`/patients/${parsed.data.patientId}`);
    return { ok: true, message: 'Flag ended. It remains on the record.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}
