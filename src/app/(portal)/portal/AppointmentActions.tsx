'use client';

import { useActionState, useState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import {
  portalCancelAction,
  portalRescheduleAction,
  type PortalFormState,
} from '@/server/actions/portal';

/**
 * Cancel / reschedule controls for one upcoming appointment.
 *
 * A Client Component only because it holds two pieces of local UI state: whether the
 * reschedule form is open, and whether the cancel has been confirmed. It receives the
 * appointment ID and nothing else — no name, no reason, no clinical detail — so the
 * client bundle carries an opaque identifier rather than PHI.
 *
 * Neither button is the access control. Both post to server actions that re-resolve the
 * patient from the session cookie and refuse an appointment that is not theirs; hiding a
 * button is presentation, and the server assumes the button was never there.
 */
export function AppointmentActions({
  appointmentId,
  timeZone,
}: {
  appointmentId: string;
  timeZone: string;
}) {
  const [cancelState, cancelAction, cancelling] = useActionState<
    PortalFormState,
    FormData
  >(portalCancelAction, {});
  const [moveState, moveAction, moving] = useActionState<PortalFormState, FormData>(
    portalRescheduleAction,
    {},
  );

  const [confirming, setConfirming] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);

  const state = cancelState.message ? cancelState : moveState;

  return (
    <div style={{ flex: '1 1 100%', display: 'grid', gap: 'var(--space-2)' }}>
      {state.message ? (
        <p
          role={state.ok ? 'status' : 'alert'}
          style={{
            margin: 0,
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: state.ok ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
            color: state.ok ? 'var(--status-success-text)' : 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {state.message}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            setRescheduling((open) => !open);
            setConfirming(false);
          }}
          aria-expanded={rescheduling}
        >
          {rescheduling ? 'Keep this time' : 'Reschedule'}
        </Button>

        {confirming ? (
          <form
            action={cancelAction}
            style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
          >
            <input type="hidden" name="appointmentId" value={appointmentId} />
            <Button type="submit" size="sm" variant="danger" loading={cancelling}>
              Yes, cancel it
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(true);
              setRescheduling(false);
            }}
          >
            Cancel
          </Button>
        )}
      </div>

      {rescheduling ? (
        <form
          action={moveAction}
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            paddingTop: 'var(--space-2)',
          }}
        >
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <Field
            id={`move-${appointmentId}`}
            label="New date and time"
            hint={`Clinic time (${timeZone}). Same clinician and visit type.`}
            error={moveState.errors?.['startsAt']?.[0]}
          >
            <Input name="startsAt" type="datetime-local" />
          </Field>
          <Button type="submit" size="sm" variant="primary" loading={moving}>
            Move appointment
          </Button>
        </form>
      ) : null}
    </div>
  );
}
