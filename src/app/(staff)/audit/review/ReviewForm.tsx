'use client';

import { useActionState } from 'react';

import { Button, Field, Textarea } from '@/components/ui';
import {
  recordReviewAction,
  type ReviewFormState,
} from '@/server/actions/compliance-review';

/**
 * File the review.
 *
 * Carries the window and the conclusion. It does NOT carry the counts shown on the page —
 * the server rebuilds those for the submitted period, because a form that reported its own
 * findings would let the reviewer file "nothing to report" over a week that had plenty.
 *
 * No PHI reaches this component: two timestamps and a textarea.
 */
export function ReviewForm({
  periodStart,
  periodEnd,
  alreadyReviewed,
}: {
  periodStart: string;
  periodEnd: string;
  alreadyReviewed: boolean;
}) {
  const [state, action, pending] = useActionState<ReviewFormState, FormData>(
    recordReviewAction,
    {},
  );

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <input type="hidden" name="periodStart" value={periodStart} />
      <input type="hidden" name="periodEnd" value={periodEnd} />

      <Field
        id="review-notes"
        label="What did you conclude?"
        error={state.errors?.['notes']?.[0]}
        hint="Recorded permanently and cannot be edited afterwards. Name what you checked and what you did about it."
      >
        <Textarea
          id="review-notes"
          name="notes"
          rows={3}
          placeholder="e.g. Two same-surname reads, both front-desk staff opening their own appointments. Break-glass on Tuesday discussed with Dr N; clinically justified."
        />
      </Field>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <Button type="submit" loading={pending}>
          {alreadyReviewed ? 'Add another review' : 'Record this review'}
        </Button>
        {state.message ? (
          <span
            role={state.ok ? 'status' : 'alert'}
            style={{
              fontSize: 'var(--text-sm)',
              color: state.ok ? undefined : 'var(--status-danger-text)',
            }}
          >
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
