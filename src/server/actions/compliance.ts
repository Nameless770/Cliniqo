'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import { requestBreakGlass, reviewBreakGlass } from '@/server/data-access/break-glass';

/**
 * Compliance actions: emergency access, and its review.
 *
 * Export and the disclosure accounting are READS, so they are page loads rather than
 * actions — there is nothing to mutate, and a GET keeps them linkable and re-runnable.
 */

export type ComplianceFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
};

function authzMessage(error: unknown): ComplianceFormState | null {
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

/**
 * Reason is required and substantive.
 *
 * A 40-character floor, not to be obstructive but because "emergency" is not a reason —
 * this text is the entire basis on which an administrator later decides the access was
 * justified, and a reviewer reading "urgent" learns nothing.
 */
const breakGlassInput = z.object({
  patientId: z.uuid(),
  reason: z
    .string()
    .trim()
    .min(40, 'Describe the clinical situation — a reviewer needs enough to judge it.')
    .max(1000),
});

export async function requestBreakGlassAction(
  _previous: ComplianceFormState,
  formData: FormData,
): Promise<ComplianceFormState> {
  const parsed = breakGlassInput.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await requestBreakGlass(parsed.data.patientId, parsed.data.reason);

    if (!result.ok) return { message: 'That patient could not be found.' };

    revalidatePath(`/patients/${parsed.data.patientId}`);
    return {
      ok: true,
      message: `Emergency access granted until ${result.expiresAt.toISOString().slice(11, 16)} UTC. An administrator will review this.`,
    };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}

const reviewInput = z.object({
  grantId: z.uuid(),
  outcome: z.enum(['justified', 'not_justified']),
  note: z.string().trim().max(1000).optional().default(''),
});

export async function reviewBreakGlassAction(
  _previous: ComplianceFormState,
  formData: FormData,
): Promise<ComplianceFormState> {
  const parsed = reviewInput.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    const result = await reviewBreakGlass(
      parsed.data.grantId,
      parsed.data.outcome,
      parsed.data.note,
    );

    if (!result.ok) return { message: 'That grant could not be found.' };

    revalidatePath('/break-glass');
    revalidatePath('/dashboard');
    return { ok: true, message: 'Review recorded.' };
  } catch (error) {
    const authz = authzMessage(error);
    if (authz) return authz;
    throw error;
  }
}
