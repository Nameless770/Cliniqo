'use client';

import { useActionState, useState } from 'react';

import { Button, Field, Input, Select } from '@/components/ui';
import {
  bookAppointmentAction,
  type AppointmentFormState,
} from '@/server/actions/appointments';

/**
 * Booking form.
 *
 * Receives only ids and display names — clinician names and appointment-type labels are
 * clinic reference data, not PHI. The patient is passed as an id plus the name already
 * rendered by the server page above it.
 *
 * There is deliberately no "check availability" step. Any availability the client could
 * show would be a snapshot that is already stale by the time submit is pressed, and
 * presenting it as authoritative is what makes double-booking feel impossible right up
 * until it happens. The database decides at write time; if the slot went, the form says so.
 */
export function BookingForm({
  patientId,
  providers,
  types,
  defaultProviderId,
}: {
  patientId: string;
  providers: { id: string; name: string }[];
  types: { id: string; name: string; durationMinutes: number }[];
  defaultProviderId?: string;
}) {
  const [state, formAction, pending] = useActionState<AppointmentFormState, FormData>(
    bookAppointmentAction,
    {},
  );

  // Choosing a type pre-fills its default duration; still editable, still re-validated
  // server-side.
  const [duration, setDuration] = useState(types[0]?.durationMinutes ?? 20);

  const err = (f: string) => state.errors?.[f]?.[0];

  if (state.ok) {
    return (
      <p
        role="status"
        style={{
          padding: 'var(--space-3) var(--space-4)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--status-success-bg)',
          color: 'var(--status-success-text)',
          fontSize: 'var(--text-sm)',
        }}
      >
        {state.message} <a href="/schedule">View the schedule</a>.
      </p>
    );
  }

  return (
    <form action={formAction} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <input type="hidden" name="patientId" value={patientId} />

      {state.message ? (
        <p
          role="alert"
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
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        <Field
          id="providerUserId"
          label="Clinician"
          required
          error={err('providerUserId')}
        >
          <Select name="providerUserId" defaultValue={defaultProviderId ?? ''}>
            <option value="">Choose…</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="appointmentTypeId"
          label="Appointment type"
          required
          hint="The reason for the visit, as a code"
          error={err('appointmentTypeId')}
        >
          <Select
            name="appointmentTypeId"
            defaultValue={types[0]?.id ?? ''}
            onChange={(e) => {
              const t = types.find((x) => x.id === e.target.value);
              if (t) setDuration(t.durationMinutes);
            }}
          >
            <option value="">Choose…</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="startsAt" label="Starts at" required error={err('startsAt')}>
          <Input name="startsAt" type="datetime-local" />
        </Field>

        <Field
          id="durationMinutes"
          label="Duration (minutes)"
          required
          error={err('durationMinutes')}
        >
          <Input
            name="durationMinutes"
            type="number"
            min={5}
            max={480}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </Field>
      </div>

      <Field
        id="bookingNote"
        label="Logistics note"
        hint="Access needs, interpreter, transport. NOT clinical detail — the front desk can read this."
        error={err('bookingNote')}
      >
        <Input name="bookingNote" />
      </Field>

      <div>
        <Button type="submit" variant="primary" size="lg" loading={pending}>
          {pending ? 'Booking' : 'Book appointment'}
        </Button>
      </div>
    </form>
  );
}
