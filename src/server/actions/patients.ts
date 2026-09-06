'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  archivePatientInput,
  clinicalPatientInput,
  createPatientInput,
  formFields,
  identifyingPatientInput,
  toFieldErrors,
  unarchivePatientInput,
  type FieldErrors,
} from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import { requireAuthenticated } from '@/server/auth/authorize';
import {
  archivePatient,
  createPatient,
  findPotentialDuplicates,
  unarchivePatient,
  updatePatient,
  type PatientListRow,
} from '@/server/data-access/patients';

/**
 * Patient server actions.
 *
 * Every export is a PUBLIC HTTP ENDPOINT — reachable by anyone who can reach the app,
 * with any arguments, regardless of what the UI rendered. These are thin: validate, then
 * delegate to the data-access layer, which authorizes and audits. No SQL here.
 */

export type PatientFormState = {
  errors?: FieldErrors;
  message?: string;
  /** Set on a successful mutation, so the UI can style the message as success. */
  ok?: boolean;
  /** Populated when registration collides with an existing record. */
  duplicates?: PatientListRow[];
};

/**
 * Turn a thrown authorization failure into a form message.
 *
 * Deliberately vague, and deliberately identical for both cases: telling a caller which
 * permission they lack maps the authorization surface for anyone probing it.
 */
function authzMessage(error: unknown): PatientFormState | null {
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
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export async function createPatientAction(
  _previous: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const raw = formFields(formData);

  const parsed = createPatientInput.safeParse({
    ...raw,
    confirmedNotDuplicate: raw['confirmedNotDuplicate'] === 'true',
  });

  if (!parsed.success) {
    return { errors: toFieldErrors(parsed.error) };
  }

  const input = parsed.data;

  try {
    /*
     * Duplicate guard. Surname plus date of birth is the collision that actually happens
     * at a front desk, and a duplicate chart hides allergies — so this blocks by default
     * and requires an explicit human confirmation to pass.
     */
    if (!input.confirmedNotDuplicate) {
      const duplicates = await findPotentialDuplicates(
        input.legalLastName,
        input.dateOfBirth,
      );

      if (duplicates.length > 0) {
        return {
          duplicates,
          message:
            'A patient with this surname and date of birth already exists. Check whether this is the same person before continuing.',
        };
      }
    }

    const { id } = await createPatient(input);

    revalidatePath('/patients');
    redirect(`/patients/${id}`);
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Update                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Update a patient.
 *
 * THE SCOPE DECISION IS HERE, AND IT IS MADE FROM THE SESSION — never from the form.
 *
 * A caller holding `patient.update.clinical` has their payload parsed by the clinical
 * schema. Everyone else is parsed by `identifyingPatientInput`, which is `.strict()` and
 * in which clinical fields do not exist. A receptionist submitting `sexAssignedAtBirth`
 * therefore gets a validation FAILURE, not a silent strip — and the data layer refuses
 * the write independently, since it asks for a permission the caller does not hold.
 */
export async function updatePatientAction(
  patientId: string,
  _previous: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  try {
    const session = await requireAuthenticated();
    const canWriteClinical = session.permissions.has('patient.update.clinical');

    const raw = formFields(formData);
    const expectedVersion = Number(raw['version']);
    delete raw['version'];

    if (!Number.isInteger(expectedVersion)) {
      return { message: 'This form is stale. Reload the page and try again.' };
    }

    const schema = canWriteClinical ? clinicalPatientInput : identifyingPatientInput;
    const parsed = schema.safeParse(raw);

    if (!parsed.success) {
      return { errors: toFieldErrors(parsed.error) };
    }

    const result = await updatePatient(
      patientId,
      parsed.data,
      expectedVersion,
      canWriteClinical ? 'clinical' : 'identifying',
    );

    if (result.conflict) {
      return {
        message:
          'Someone else changed this record while you were editing. Reload to see their changes, then reapply yours.',
      };
    }

    revalidatePath(`/patients/${patientId}`);
    revalidatePath('/patients');
    return { message: 'Saved.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Archive                                                                    */
/* -------------------------------------------------------------------------- */

export async function archivePatientAction(
  _previous: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const parsed = archivePatientInput.safeParse(formFields(formData));

  if (!parsed.success) {
    return { errors: toFieldErrors(parsed.error) };
  }

  try {
    const { archived } = await archivePatient(parsed.data.patientId, parsed.data.reason);

    if (!archived) {
      return { message: 'That patient is already archived, or does not exist.' };
    }

    revalidatePath('/patients');
    revalidatePath(`/patients/${parsed.data.patientId}`);
    return { ok: true, message: 'Patient archived.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

export async function unarchivePatientAction(
  _previous: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  /*
   * F6: validated like every sibling action.
   *
   * Previously this read the raw form value. Not injectable — Drizzle parameterises — but
   * a malformed value reached PostgreSQL as a uuid parameter and raised
   * "invalid input syntax for type uuid", surfacing as an unhandled 500 instead of a
   * clean rejection. It also skipped the shape check every other mutation performs.
   */
  const parsed = unarchivePatientInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  const { patientId } = parsed.data;

  try {
    const { restored } = await unarchivePatient(patientId);

    if (!restored) {
      return { message: 'That patient is not archived.' };
    }

    revalidatePath('/patients');
    revalidatePath(`/patients/${patientId}`);
    return { ok: true, message: 'Patient restored.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}
