'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import {
  cancelPrescriptionAction,
  type PrescriptionFormState,
} from '@/server/actions/prescriptions';

/**
 * Cancel or correct one prescription, from the chart.
 *
 * A signed prescription is never edited — CLAUDE.md rule 4, and migration 0001 freezes it
 * at the database. So the only two remedies are here:
 *
 *   - CANCEL: withdraw it, with a reason, leaving nothing in its place. The row stays,
 *     visibly cancelled — the withdrawn instruction remains part of the record.
 *   - CORRECT: cancel it AND issue a replacement that names what it superseded, in one
 *     step. This is the normal path for "wrong dose"; it goes through the prescribe form
 *     pre-filled from the original, so the chain is unbroken.
 *
 * `prescription.cancel` / `prescription.create` gate the server actions; this is only
 * rendered for a prescriber on a live prescription, which is presentation, not the guard.
 */
export function PrescriptionActions({
  patientId,
  prescriptionId,
}: {
  patientId: string;
  prescriptionId: string;
}) {
  const [state, action, pending] = useActionState<PrescriptionFormState, FormData>(
    cancelPrescriptionAction,
    {},
  );
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 'var(--space-2)', display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Link
          href={`/patients/${patientId}/prescribe?correct=${prescriptionId}`}
          style={{ fontSize: 'var(--text-sm)' }}
        >
          Correct (replace)
        </Link>
        {!open ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Cancel
          </Button>
        ) : null}
      </div>

      {open ? (
        <form
          action={action}
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            padding: 'var(--space-3)',
            background: 'var(--bg-sunken)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <input type="hidden" name="prescriptionId" value={prescriptionId} />
          <input type="hidden" name="patientId" value={patientId} />
          <Field
            id={`rx-reason-${prescriptionId}`}
            label="Reason for cancellation"
            error={state.errors?.['reason']?.[0]}
          >
            <Input
              id={`rx-reason-${prescriptionId}`}
              name="reason"
              placeholder="Required"
            />
          </Field>
          <Button type="submit" size="sm" variant="danger" loading={pending}>
            Cancel prescription
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Keep it
          </Button>
        </form>
      ) : null}

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
  );
}
