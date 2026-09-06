'use client';

import { useState } from 'react';
import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import {
  ALLOWED_TRANSITIONS,
  APPOINTMENT_STATUS_LABELS,
  type AppointmentStatus,
} from '@/lib/appointment-schemas';
import {
  cancelAppointmentAction,
  changeStatusAction,
  rescheduleAppointmentAction,
  type AppointmentFormState,
} from '@/server/actions/appointments';

/**
 * Per-appointment controls: status transitions, cancellation, and reschedule.
 *
 * Buttons are derived from `ALLOWED_TRANSITIONS`, the same table the server enforces — so
 * the UI cannot offer a move the server will refuse, and the two cannot drift.
 *
 * That shared table is a convenience, NOT the control. The server re-reads the
 * appointment's current status and its assigned clinician before writing: a stale tab, a
 * replayed request, or a hand-crafted POST all hit the same checks.
 *
 * Cancellation and reschedule each live behind their own reveal, because each needs an
 * input a one-click button cannot carry: cancellation a REASON (a cancelled slot with no
 * reason is an unanswerable question later), reschedule a NEW TIME. Both are offered only
 * while an appointment is still live — a completed or already-cancelled one is history.
 *
 * Receives an id, a status, a preformatted local start time and duration for the
 * reschedule prefill, and permission flags. No patient record crosses this boundary.
 */
export function StatusActions({
  appointmentId,
  patientId,
  status,
  startsAtLocal,
  durationMinutes,
  canCheckIn,
  canChangeStatus,
  canCancel,
  canReschedule,
}: {
  appointmentId: string;
  patientId: string;
  status: AppointmentStatus;
  /** 'YYYY-MM-DDTHH:mm' in clinic time, for the reschedule field's default. */
  startsAtLocal: string;
  durationMinutes: number;
  canCheckIn: boolean;
  canChangeStatus: boolean;
  canCancel: boolean;
  canReschedule: boolean;
}) {
  const [statusState, statusAction, statusPending] = useActionState<
    AppointmentFormState,
    FormData
  >(changeStatusAction, {});
  const [cancelState, cancelAction, cancelPending] = useActionState<
    AppointmentFormState,
    FormData
  >(cancelAppointmentAction, {});
  const [reschedState, reschedAction, reschedPending] = useActionState<
    AppointmentFormState,
    FormData
  >(rescheduleAppointmentAction, {});

  const [reveal, setReveal] = useState<null | 'cancel' | 'reschedule'>(null);

  // 'cancelled' is filtered out of the quick buttons: it needs a reason, so it is offered
  // through the reveal below instead. Everything else in the table is a one-click move.
  const quick = ALLOWED_TRANSITIONS[status].filter((target) => {
    if (target === 'cancelled') return false;
    if (target === 'checked_in') return canCheckIn;
    return canChangeStatus;
  });

  // Cancel and reschedule only make sense while the appointment is still ahead of itself.
  const isLive = status === 'scheduled' || status === 'checked_in';
  const showCancel = isLive && canCancel;
  const showReschedule = isLive && canReschedule;

  const errorText =
    (!statusState.ok ? statusState.message : undefined) ??
    (!cancelState.ok ? cancelState.message : undefined) ??
    (!reschedState.ok ? reschedState.message : undefined);

  const panel = {
    display: 'flex',
    gap: 'var(--space-2)',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    padding: 'var(--space-2)',
    background: 'var(--bg-sunken)',
    borderRadius: 'var(--radius-md)',
  } as const;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-1)', justifyItems: 'start' }}>
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
        {quick.map((target) => (
          <form action={statusAction} key={target}>
            <input type="hidden" name="appointmentId" value={appointmentId} />
            <input type="hidden" name="patientId" value={patientId} />
            <input type="hidden" name="status" value={target} />
            <Button
              type="submit"
              size="sm"
              variant={target === 'checked_in' ? 'primary' : 'secondary'}
              loading={statusPending}
            >
              {target === 'checked_in' ? 'Check in' : APPOINTMENT_STATUS_LABELS[target]}
            </Button>
          </form>
        ))}

        {showReschedule ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setReveal((r) => (r === 'reschedule' ? null : 'reschedule'))}
          >
            {reveal === 'reschedule' ? 'Close' : 'Reschedule'}
          </Button>
        ) : null}

        {showCancel ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setReveal((r) => (r === 'cancel' ? null : 'cancel'))}
          >
            {reveal === 'cancel' ? 'Close' : 'Cancel'}
          </Button>
        ) : null}
      </div>

      {reveal === 'reschedule' && showReschedule ? (
        <form action={reschedAction} style={panel}>
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <input type="hidden" name="patientId" value={patientId} />
          <Field
            id={`starts-${appointmentId}`}
            label="New time"
            error={reschedState.errors?.['startsAt']?.[0]}
          >
            <Input
              id={`starts-${appointmentId}`}
              name="startsAt"
              type="datetime-local"
              defaultValue={startsAtLocal}
            />
          </Field>
          <Field
            id={`dur-${appointmentId}`}
            label="Minutes"
            error={reschedState.errors?.['durationMinutes']?.[0]}
          >
            <Input
              id={`dur-${appointmentId}`}
              name="durationMinutes"
              type="number"
              min={5}
              max={480}
              defaultValue={durationMinutes}
            />
          </Field>
          <Button type="submit" size="sm" variant="primary" loading={reschedPending}>
            Move
          </Button>
        </form>
      ) : null}

      {reveal === 'cancel' && showCancel ? (
        <form action={cancelAction} style={panel}>
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <input type="hidden" name="patientId" value={patientId} />
          <Field
            id={`reason-${appointmentId}`}
            label="Reason for cancellation"
            error={cancelState.errors?.['reason']?.[0]}
          >
            <Input id={`reason-${appointmentId}`} name="reason" placeholder="Required" />
          </Field>
          <Button type="submit" size="sm" variant="danger" loading={cancelPending}>
            Cancel appointment
          </Button>
        </form>
      ) : null}

      {errorText ? (
        <span
          role="alert"
          style={{ fontSize: 'var(--text-xs)', color: 'var(--status-danger-text)' }}
        >
          {errorText}
        </span>
      ) : null}
    </div>
  );
}
