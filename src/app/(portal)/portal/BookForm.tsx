'use client';

import { useActionState, useEffect, useState } from 'react';

import { Button, Field, Select } from '@/components/ui';
import { portalScheduleAction, type PortalScheduleState } from '@/server/actions/portal';

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

  /*
   * The booking stamp: a check drawn over the card for a moment after a booking commits.
   *
   * Shown only on a state the SERVER returned `ok` for — never optimistically on click.
   * The study plays it before adding the row; here the row is already written by the time
   * the stamp appears, because a mark saying "booked" over something that might still be
   * refused is the one animation in this portal that could tell a patient something false.
   *
   * Tracked as "which result has been dismissed" rather than a boolean flipped inside the
   * effect, so the stamp belongs to one specific booking and cannot re-show for it.
   */
  const [stampDismissed, setStampDismissed] = useState<PortalScheduleState | null>(null);
  /*
   * The state this form was first rendered with. A booking posted with JavaScript off comes
   * back from the server with `ok` already set, and the page hydrates holding it; stamping
   * THAT would mean the server drew no overlay and the browser drew one — a hydration
   * mismatch, and an overlay for a booking the patient saw confirmed a page-load ago.
   * Only a result that arrives after hydration earns the stamp.
   */
  const [initialState] = useState(state);
  useEffect(() => {
    if (!state.ok) return;
    const id = window.setTimeout(() => setStampDismissed(state), 1150);
    return () => window.clearTimeout(id);
  }, [state]);
  const showStamp =
    Boolean(state.ok) &&
    state !== initialState &&
    stampDismissed !== state &&
    /* Under reduced motion there is no stamp at all, as in the study: a still overlay
       hiding the form for a second is a delay, not a confirmation. Never reached during a
       server render — the check above short-circuits there, before `window` is touched. */
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (types.length === 0) {
    return (
      <p
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
      >
        Online booking is not available right now. Please contact the clinic to make an
        appointment.
      </p>
    );
  }

  // A booking succeeded: the chosen slot is spent, and the list behind it has moved on.
  const selected = state.ok ? null : chosen;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {showStamp ? (
        /*
         * aria-hidden: the status paragraph below already announces the booking, and a
         * second announcement of the same fact is noise. This is its visual echo only.
         * Positioned against the booking <section>, which the page makes relative.
         */
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 4,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '14px',
            borderRadius: 'inherit',
            background: 'color-mix(in srgb, var(--bg-surface) 94%, transparent)',
          }}
        >
          <div
            className="cq-commit"
            style={{
              width: '66px',
              height: '66px',
              borderRadius: '50%',
              background: 'var(--accent-600)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
              <path
                className="cq-check"
                d="M7 17.5 L14 24 L27 10"
                /* A CSS variable cannot go in an SVG presentation attribute; style can. */
                style={{ stroke: 'var(--bg-page)' }}
                strokeWidth="3.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div style={{ fontSize: '17px', fontWeight: 'var(--weight-semibold)' }}>
            Appointment booked
          </div>
        </div>
      ) : null}

      {state.message ? (
        <p
          role={state.ok ? 'status' : 'alert'}
          className="cq-rowin"
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
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Looking for available times…
        </p>
      ) : state.providers ? (
        state.providers.length === 0 ? (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            No clinician has an opening for {state.typeName} in the next three weeks.
            Please contact the clinic and they will find you a time.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            <p
              style={{
                margin: 0,
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
              }}
            >
              Available times for {state.typeName} ({state.durationMinutes} min). All
              times are clinic time ({state.clinicTimeZone}).
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
                    <span style={{ paddingTop: '0.35rem' }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 'var(--text-sm)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {day.label}
                      </span>
                      {/*
                        Scarcity, stated only when it is true. The server returns every
                        open slot for a day — there is no cap on slots, only on days — so
                        "2 left" is a count of this clinician's actual openings, not a
                        nudge. A day with more room says nothing.
                      */}
                      {day.slots.length > 0 && day.slots.length <= 2 ? (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            marginTop: '4px',
                            fontSize: '10px',
                            fontWeight: 'var(--weight-semibold)',
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: 'var(--accent-2-700)',
                          }}
                        >
                          <span className="cq-filldot" aria-hidden="true" />
                          {day.slots.length === 1
                            ? 'Last slot'
                            : `${day.slots.length} left`}
                        </span>
                      ) : null}
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
                            className="cq-btn cq-slot"
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
          className="cq-rowin"
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
          <Button type="submit" variant="primary" className="cq-btn" loading={pending}>
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
