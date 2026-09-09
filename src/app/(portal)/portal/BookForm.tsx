'use client';

import { useActionState, useState } from 'react';

import { Button, Field, Select } from '@/components/ui';
import {
  portalScheduleAction,
  type PortalScheduleState,
} from '@/server/actions/portal';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

type Chosen = {
  providerUserId: string;
  providerName: string;
  startsAt: string;
  dayLabel: string;
  timeLabel: string;
};

/**
 * Book an appointment: choose what the visit is for, then pick from the times that are
 * actually free.
 *
 * The old form asked for a clinician and a raw date-time and let the server say no. That
 * puts the patient in a guessing game against rules they cannot see — opening hours, the
 * clinician's own availability, closures, and every appointment already in the diary.
 * Choosing the visit type first is what makes the rest answerable: the type fixes the
 * duration, and only with a duration can the server say which starting times leave room.
 *
 * Both forms below dispatch the SAME action, so the openings on screen are always the
 * ones the server last computed — including straight after a booking, when the slot just
 * taken has to disappear.
 *
 * Nothing here is trusted. The chosen provider and time travel back as ordinary form
 * fields, and booking re-checks every rule server-side before it writes.
 */
export function BookForm({
  types,
  hours,
  timeZone,
}: {
  types: { id: string; name: string; durationMinutes: number }[];
  hours: { dayOfWeek: number; opensAt: string; closesAt: string }[];
  timeZone: string;
}) {
  const [state, action, pending] = useActionState<PortalScheduleState, FormData>(
    portalScheduleAction,
    {},
  );
  const [chosen, setChosen] = useState<Chosen | null>(null);

  if (types.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        Online booking is not available right now. Please contact the clinic to make an
        appointment.
      </p>
    );
  }

  // A booking succeeded: the chosen slot is spent, and the list behind it has moved on.
  const selected = state.ok ? null : chosen;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
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

      {/* ----------------------------------------------------- 1. visit type */}
      <form action={action}>
        <input type="hidden" name="intent" value="find" />
        <Field
          id="appointmentTypeId"
          label="What is the visit for?"
          required
          hint="Choose this first — it decides how long the appointment needs to be."
        >
          <Select
            name="appointmentTypeId"
            defaultValue=""
            onChange={(event) => {
              setChosen(null);
              event.currentTarget.form?.requestSubmit();
            }}
          >
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
      </form>

      {/* -------------------------------------------------- 2. who is free */}
      {pending ? (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          Looking for available times…
        </p>
      ) : state.providers ? (
        state.providers.length === 0 ? (
          <p
            style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
          >
            No clinician has an opening for {state.typeName} in the next three weeks.
            Please contact the clinic and they will find you a time.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            <p
              style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
            >
              Available times for {state.typeName} ({state.durationMinutes} min). All times
              are clinic time ({state.clinicTimeZone}).
            </p>

            {state.providers.map((provider) => (
              <section
                key={provider.providerUserId}
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-3) var(--space-4)',
                  display: 'grid',
                  gap: 'var(--space-3)',
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: 'var(--text-sm)',
                    fontWeight: 'var(--weight-semibold)',
                  }}
                >
                  {provider.providerName}
                </h3>

                {provider.days.map((day) => (
                  <div
                    key={day.date}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(6rem, 8rem) 1fr',
                      gap: 'var(--space-3)',
                      alignItems: 'start',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 'var(--text-sm)',
                        color: 'var(--text-secondary)',
                        paddingTop: '0.35rem',
                      }}
                    >
                      {day.label}
                    </span>
                    <div
                      style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}
                    >
                      {day.slots.map((slot) => {
                        const isChosen =
                          selected?.startsAt === slot.startsAt &&
                          selected?.providerUserId === provider.providerUserId;
                        return (
                          <Button
                            key={slot.startsAt}
                            type="button"
                            size="sm"
                            variant={isChosen ? 'primary' : 'ghost'}
                            aria-pressed={isChosen}
                            onClick={() =>
                              setChosen({
                                providerUserId: provider.providerUserId,
                                providerName: provider.providerName,
                                startsAt: slot.startsAt,
                                dayLabel: day.label,
                                timeLabel: slot.label,
                              })
                            }
                          >
                            {slot.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )
      ) : (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          Pick a visit type above to see which clinicians are free and when. All times are
          clinic time ({timeZone}).
        </p>
      )}

      {/* ------------------------------------------------------- 3. confirm */}
      {selected && state.typeId ? (
        <form
          action={action}
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'center',
            flexWrap: 'wrap',
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 'var(--space-4)',
          }}
        >
          <input type="hidden" name="intent" value="book" />
          <input type="hidden" name="appointmentTypeId" value={state.typeId} />
          <input type="hidden" name="providerUserId" value={selected.providerUserId} />
          <input type="hidden" name="startsAt" value={selected.startsAt} />
          <span style={{ flex: '1 1 14rem', fontSize: 'var(--text-sm)' }}>
            {selected.dayLabel} at <strong>{selected.timeLabel}</strong> with{' '}
            <strong>{selected.providerName}</strong>
          </span>
          <Button type="submit" variant="primary" loading={pending}>
            Confirm booking
          </Button>
        </form>
      ) : null}

      {hours.length > 0 ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          <strong>Opening hours:</strong>{' '}
          {hours
            .map(
              (h) =>
                `${DAY_NAMES[h.dayOfWeek]} ${h.opensAt.slice(0, 5)}–${h.closesAt.slice(0, 5)}`,
            )
            .join(' · ')}
        </div>
      ) : null}
    </div>
  );
}
