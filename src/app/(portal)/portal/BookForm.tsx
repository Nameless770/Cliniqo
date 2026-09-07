'use client';

import { useActionState } from 'react';

import { Button, Field, Input, Select } from '@/components/ui';
import { portalBookAction, type PortalFormState } from '@/server/actions/portal';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function BookForm({
  types,
  providers,
  hours,
  timeZone,
}: {
  types: { id: string; name: string; durationMinutes: number }[];
  providers: { id: string; name: string }[];
  hours: { dayOfWeek: number; opensAt: string; closesAt: string }[];
  timeZone: string;
}) {
  const [state, action, pending] = useActionState<PortalFormState, FormData>(
    portalBookAction,
    {},
  );

  if (types.length === 0 || providers.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        Online booking is not available right now. Please contact the clinic to make an
        appointment.
      </p>
    );
  }

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-4)' }}>
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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
          gap: 'var(--space-3)',
        }}
      >
        <Field id="appointmentTypeId" label="Visit type" required>
          <Select name="appointmentTypeId" defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.durationMinutes} min)
              </option>
            ))}
          </Select>
        </Field>

        <Field id="providerUserId" label="Clinician" required>
          <Select name="providerUserId" defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        id="startsAt"
        label="Date and time"
        required
        hint={`Times are in the clinic's timezone (${timeZone}).`}
      >
        <Input name="startsAt" type="datetime-local" />
      </Field>

      {hours.length > 0 ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          <strong>Opening hours:</strong>{' '}
          {hours
            .map((h) => `${DAY_NAMES[h.dayOfWeek]} ${h.opensAt.slice(0, 5)}–${h.closesAt.slice(0, 5)}`)
            .join(' · ')}
        </div>
      ) : null}

      <div>
        <Button type="submit" variant="primary" loading={pending}>
          Book appointment
        </Button>
      </div>
    </form>
  );
}
