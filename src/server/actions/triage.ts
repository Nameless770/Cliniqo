'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { formFields } from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import { closeTriageConversation } from '@/server/data-access/triage';

/**
 * Staff actions on the triage queue.
 *
 * Authorization is enforced inside `closeTriageConversation`, on `appointment.status`, and
 * re-checked there on every call — this action never assumes the page that rendered the
 * button did the checking.
 */

export type TriageQueueState = { message?: string; ok?: boolean };

const closeInput = z
  .object({ conversationId: z.uuid(), patientId: z.uuid() })
  .strict();

export async function closeTriageAction(
  _prev: TriageQueueState,
  formData: FormData,
): Promise<TriageQueueState> {
  const parsed = closeInput.safeParse(formFields(formData));
  if (!parsed.success) return { message: 'Bad request.' };

  try {
    const result = await closeTriageConversation(
      parsed.data.conversationId,
      parsed.data.patientId,
    );
    if (!result.ok) {
      return { message: 'That item is no longer open.' };
    }

    revalidatePath('/triage');
    return { ok: true, message: 'Marked as dealt with.' };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        message:
          error.reason === 'UNAUTHENTICATED'
            ? 'Your session has ended. Sign in again.'
            : 'You do not have permission to clear triage items.',
      };
    }
    throw error;
  }
}
