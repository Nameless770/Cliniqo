'use client';

import { useActionState, useState } from 'react';

import { Button, Field, Textarea } from '@/components/ui';
import {
  requestBreakGlassAction,
  type ComplianceFormState,
} from '@/server/actions/compliance';

/**
 * Take emergency access to this record.
 *
 * Collapsed behind a click on purpose. It is not a normal control and should not sit on
 * screen looking like one - but it is also never more than one click away, because a
 * safeguard a clinician has to hunt for during an emergency is a safeguard that gets
 * worked around instead.
 *
 * The form states plainly what happens next. Access is granted unconditionally; the
 * consequence is that somebody reads the reason afterwards.
 */
export function BreakGlassButton({ patientId }: { patientId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ComplianceFormState, FormData>(
    requestBreakGlassAction,
    {},
  );

  if (state.ok) {
    return (
      <p
        role="status"
        style={{
          margin: 0,
          padding: 'var(--space-3) var(--space-4)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--status-warn-bg)',
          color: 'var(--status-warn-text)',
          fontSize: 'var(--text-sm)',
        }}
      >
        {state.message}
      </p>
    );
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Emergency access
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      style={{
        display: 'grid',
        gap: 'var(--space-3)',
        border: '1px solid var(--warn-600)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--status-warn-bg)',
        padding: 'var(--space-4)',
      }}
    >
      <input type="hidden" name="patientId" value={patientId} />

      <p
        style={{
          margin: 0,
          fontSize: 'var(--text-sm)',
          color: 'var(--status-warn-text)',
        }}
      >
        <strong>This will not be refused.</strong> Emergency access lifts the normal
        limits on how much you can read, immediately. Your reason is recorded and an
        administrator reviews it afterwards.
      </p>

      {state.message ? (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--status-danger-text)',
          }}
        >
          {state.message}
        </p>
      ) : null}

      <Field
        id="break-glass-reason"
        label="Clinical reason"
        required
        hint="Enough detail for a reviewer to judge it later"
        error={state.errors?.['reason']?.[0]}
      >
        <Textarea name="reason" rows={3} autoFocus />
      </Field>

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button type="submit" variant="danger" loading={pending}>
          Take emergency access
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
