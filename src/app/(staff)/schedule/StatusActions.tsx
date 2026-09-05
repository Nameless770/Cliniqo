'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui';
import {
  ALLOWED_TRANSITIONS,
  APPOINTMENT_STATUS_LABELS,
  type AppointmentStatus,
} from '@/lib/appointment-schemas';
import {
  changeStatusAction,
  type AppointmentFormState,
} from '@/server/actions/appointments';

/**
 * Status controls for one appointment row.
 *
 * Buttons are derived from `ALLOWED_TRANSITIONS`, the same table the server enforces — so
 * the UI cannot offer a move the server will refuse, and the two cannot drift.
 *
 * That shared table is a convenience, NOT the control. The server re-reads the
 * appointment's current status and its assigned clinician before writing: a stale tab, a
 * replayed request, or a hand-crafted POST all hit the same checks.
 *
 * Receives only what it renders — an id, a status, and whether check-in is offered. No
 * patient record crosses this boundary.
 */
export function StatusActions({
  appointmentId,
  status,
  canCheckIn,
  canChangeStatus,
}: {
  appointmentId: string;
  status: AppointmentStatus;
  canCheckIn: boolean;
  canChangeStatus: boolean;
}) {
  const [state, formAction, pending] = useActionState<AppointmentFormState, FormData>(
    changeStatusAction,
    {},
  );

  const next = ALLOWED_TRANSITIONS[status].filter((target) => {
    if (target === 'cancelled') return false; // cancellation needs a reason; separate flow
    if (target === 'checked_in') return canCheckIn;
    return canChangeStatus;
  });

  if (next.length === 0 && !state.message) return null;

  return (
    <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
      {next.map((target) => (
        <form action={formAction} key={target}>
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <input type="hidden" name="status" value={target} />
          <Button
            type="submit"
            size="sm"
            variant={target === 'checked_in' ? 'primary' : 'secondary'}
            loading={pending}
          >
            {target === 'checked_in' ? 'Check in' : APPOINTMENT_STATUS_LABELS[target]}
          </Button>
        </form>
      ))}

      {state.message && !state.ok ? (
        <span
          role="alert"
          style={{ fontSize: 'var(--text-xs)', color: 'var(--status-danger-text)' }}
        >
          {state.message}
        </span>
      ) : null}
    </div>
  );
}
