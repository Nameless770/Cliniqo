'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { formFields, toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import {
  mergePatients,
  reverseMerge,
  type MergeRefusal,
  type ReverseRefusal,
} from '@/server/data-access/patient-merge';

/**
 * Merging a duplicate chart, and undoing it.
 *
 * Administrator-only, enforced in `data-access/patient-merge.ts` on `patient.merge` and
 * re-checked there on every call — this file never assumes the page that rendered the
 * button did the checking. A server action is a public endpoint; the page above it is a
 * courtesy.
 *
 * The confirmation the UI asks for is NOT a control either. It exists because the
 * consequence of a wrong merge is that two people's records become one, which staff
 * should have to think about for a second — but the thing that actually stops a
 * receptionist merging charts is that they do not hold the permission.
 */

export type MergeFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
};

const mergeInput = z
  .object({
    survivingPatientId: z.uuid(),
    duplicatePatientId: z.uuid(),
    /*
     * Required, and a real sentence. "checked driver's licence at the desk" is what makes
     * this reviewable a year later; a merge with no stated basis is indistinguishable
     * from a mistake when somebody audits it.
     */
    reason: z
      .string()
      .trim()
      .min(10, 'Say how you confirmed these are the same person.')
      .max(500),
    /* The typed confirmation. Present so the click is deliberate, not as a check. */
    confirm: z.literal('MERGE', {
      message: 'Type MERGE to confirm.',
    }),
  })
  .strict();

function explainMerge(reason: MergeRefusal): string {
  switch (reason) {
    case 'same_patient':
      return 'A chart cannot be merged into itself.';
    case 'already_merged':
      return 'That chart has already been merged into another record.';
    case 'survivor_merged':
      return 'The chart you are merging into has itself been merged away. Merge into the record that survives.';
    case 'survivor_archived':
      return 'The chart you are merging into is archived. Restore it first, or merge the other way round.';
    default:
      /* `not_found` and `different_clinic` share one message on purpose: distinguishing
         them would confirm whether a given record id is a patient at this clinic. */
      return 'That record could not be found.';
  }
}

export async function mergePatientsAction(
  _previous: MergeFormState,
  formData: FormData,
): Promise<MergeFormState> {
  const parsed = mergeInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  let survivor: string;

  try {
    const result = await mergePatients(
      parsed.data.survivingPatientId,
      parsed.data.duplicatePatientId,
      parsed.data.reason,
    );

    if (!result.ok) return { message: explainMerge(result.reason) };
    survivor = parsed.data.survivingPatientId;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        message:
          error.reason === 'UNAUTHENTICATED'
            ? 'Your session has ended. Sign in again.'
            : 'You do not have permission to merge charts. The attempt has been recorded.',
      };
    }
    throw error;
  }

  /* Both charts change, and so does every list either appeared on. */
  revalidatePath('/patients');
  revalidatePath(`/patients/${survivor}`);
  revalidatePath(`/patients/${parsed.data.duplicatePatientId}`);

  /* Outside the try: redirect() signals by throwing, and catching it here would turn a
     successful merge into an "unexpected error" message. */
  redirect(`/patients/${survivor}`);
}

const reverseInput = z
  .object({
    mergeId: z.uuid(),
    patientId: z.uuid(),
    reason: z.string().trim().min(10, 'Say why this merge is being undone.').max(500),
  })
  .strict();

function explainReverse(reason: ReverseRefusal): string {
  return reason === 'already_reversed'
    ? 'That merge has already been undone.'
    : 'That merge record could not be found.';
}

/**
 * Undo a merge.
 *
 * Same permission as performing one. Whoever can combine two records can separate them
 * again — a reversal that needed a higher authority than the mistake would mean the
 * fastest way to fix a wrong merge is to wait, while the wrong chart is the one clinicians
 * are reading.
 */
export async function reverseMergeAction(
  _previous: MergeFormState,
  formData: FormData,
): Promise<MergeFormState> {
  const parsed = reverseInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await reverseMerge(parsed.data.mergeId, parsed.data.reason);
    if (!result.ok) return { message: explainReverse(result.reason) };

    revalidatePath('/patients');
    revalidatePath(`/patients/${parsed.data.patientId}`);
    revalidatePath(`/patients/${result.duplicatePatientId}`);

    return {
      ok: true,
      message:
        'Merge undone. The separated chart stays archived — restore it from its own page if it should be active again.',
    };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        message:
          error.reason === 'UNAUTHENTICATED'
            ? 'Your session has ended. Sign in again.'
            : 'You do not have permission to undo a merge. The attempt has been recorded.',
      };
    }
    throw error;
  }
}
