'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { formFields, toFieldErrors, type FieldErrors } from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import { recordReview } from '@/server/data-access/compliance-review';

/**
 * Filing a review of system activity — §164.308(a)(1)(ii)(D).
 *
 * The form carries the WINDOW and the CONCLUSION, and nothing else. It deliberately does
 * not carry the counts: whoever files the review would otherwise be able to submit
 * "nothing flagged" for a week that flagged fifty things, and that row is exactly the
 * artifact an auditor is shown. `recordReview` rebuilds the digest server-side for the
 * submitted period and stores those numbers instead.
 *
 * `audit.review` is checked inside the data layer and re-checked on every call.
 */

export type ReviewFormState = {
  errors?: FieldErrors;
  message?: string;
  ok?: boolean;
};

const reviewInput = z
  .object({
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
    /*
     * A real conclusion, not a checkbox. "Reviewed" tells a future reader nothing;
     * "two same-surname reads, both front-desk staff looking up their own appointments,
     * spoke to R." is the sentence that makes the record worth keeping.
     */
    notes: z
      .string()
      .trim()
      .min(15, 'Write what you actually concluded — a tick is not a review.')
      .max(2000),
  })
  .strict()
  .refine((v) => new Date(v.periodStart) < new Date(v.periodEnd), {
    path: ['periodEnd'],
    message: 'The period must end after it starts.',
  });

export async function recordReviewAction(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  const parsed = reviewInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: toFieldErrors(parsed.error) };

  try {
    await recordReview(
      new Date(parsed.data.periodStart),
      new Date(parsed.data.periodEnd),
      parsed.data.notes,
    );

    revalidatePath('/audit/review');
    return { ok: true, message: 'Review recorded.' };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        message:
          error.reason === 'UNAUTHENTICATED'
            ? 'Your session has ended. Sign in again.'
            : 'You do not have permission to file a review. The attempt has been recorded.',
      };
    }
    throw error;
  }
}
