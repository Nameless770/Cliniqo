'use client';

import { useState } from 'react';
import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { reverseMergeAction, type MergeFormState } from '@/server/actions/patient-merge';

/**
 * Charts folded into this one, with a way to undo each.
 *
 * Undo exists because the failure mode is asymmetric. A merge that should not have
 * happened has combined two people's records — a breach, not a typo — and the fastest
 * correction has to be available to whoever discovers it. So reversal takes the same
 * permission as the merge rather than a higher one: needing to escalate would mean the
 * quickest fix is to wait, while clinicians read the wrong chart.
 *
 * A reason is required here for the same purpose it is required on the merge: the row
 * stays in `patient_merge` forever, and "undone because they turned out to be siblings" is
 * what makes that row legible later.
 */

export type Absorbed = {
  mergeId: string;
  patientId: string;
  mrn: string;
  name: string;
  reason: string;
  performedAt: string;
};

export function MergeProvenance({
  patientId,
  absorbed,
  mayUndo,
}: {
  patientId: string;
  absorbed: Absorbed[];
  mayUndo: boolean;
}) {
  const [state, action, pending] = useActionState<MergeFormState, FormData>(
    reverseMergeAction,
    {},
  );
  const [open, setOpen] = useState<string | null>(null);

  if (absorbed.length === 0) return null;

  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--space-2)',
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-sunken)',
        fontSize: 'var(--text-sm)',
      }}
    >
      <strong>
        {absorbed.length === 1
          ? 'One duplicate chart was merged into this record'
          : `${absorbed.length} duplicate charts were merged into this record`}
      </strong>

      {absorbed.map((entry) => (
        <div key={entry.mergeId} style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {entry.name} · {entry.mrn} · merged {entry.performedAt}
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>{entry.reason}</span>

          {mayUndo ? (
            open === entry.mergeId ? (
              <form
                action={action}
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  alignItems: 'flex-end',
                  flexWrap: 'wrap',
                }}
              >
                <input type="hidden" name="mergeId" value={entry.mergeId} />
                <input type="hidden" name="patientId" value={patientId} />
                <Field
                  id={`undo-${entry.mergeId}`}
                  label="Why is this merge being undone?"
                  error={state.errors?.['reason']?.[0]}
                >
                  <Input
                    id={`undo-${entry.mergeId}`}
                    name="reason"
                    placeholder="Required"
                  />
                </Field>
                <Button type="submit" size="sm" variant="danger" loading={pending}>
                  Undo merge
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpen(null)}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpen(entry.mergeId)}
                >
                  Undo this merge
                </Button>
              </span>
            )
          ) : null}
        </div>
      ))}

      {state.message ? (
        <span
          role={state.ok ? 'status' : 'alert'}
          style={{ color: state.ok ? undefined : 'var(--status-danger-text)' }}
        >
          {state.message}
        </span>
      ) : null}
    </div>
  );
}
