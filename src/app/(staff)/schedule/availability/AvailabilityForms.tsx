'use client';

import { useActionState, useState } from 'react';

import { Badge, Button, Field, Input, Select } from '@/components/ui';
import {
  DAY_NAMES,
  EXCEPTION_KINDS,
  EXCEPTION_KIND_LABELS,
} from '@/lib/availability-schemas';
import {
  addExceptionAction,
  deleteExceptionAction,
  saveAvailabilityAction,
  type AvailabilityFormState,
} from '@/server/actions/availability';

export type AvailabilityView = {
  providers: { id: string; name: string }[];
  availability: {
    id: string;
    providerUserId: string;
    dayOfWeek: number;
    startsAt: string;
    endsAt: string;
  }[];
  exceptions: {
    id: string;
    providerUserId: string | null;
    providerName: string | null;
    kind: string;
    startsAt: string;
    endsAt: string;
    reason: string | null;
  }[];
};

function Banner({ state }: { state: AvailabilityFormState }) {
  if (!state.message) return null;
  return (
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
  );
}

const card = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--bg-surface)',
  padding: 'var(--space-5)',
  display: 'grid',
  gap: 'var(--space-4)',
} as const;

export function AvailabilityForms({ view }: { view: AvailabilityView }) {
  const [availState, availAction, savingAvail] = useActionState<
    AvailabilityFormState,
    FormData
  >(saveAvailabilityAction, {});
  const [excState, excAction, savingExc] = useActionState<AvailabilityFormState, FormData>(
    addExceptionAction,
    {},
  );
  const [delState, delAction] = useActionState<AvailabilityFormState, FormData>(
    deleteExceptionAction,
    {},
  );

  const firstProvider = view.providers[0]?.id ?? '';
  const [selected, setSelected] = useState(firstProvider);

  // Stored hours for the selected provider, keyed by weekday.
  const byDay = new Map(
    view.availability
      .filter((a) => a.providerUserId === selected)
      .map((a) => [a.dayOfWeek, a]),
  );

  if (view.providers.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        No clinicians to schedule yet. Add a doctor under Staff first.
      </p>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      {/* ------------------------------------------------ weekly hours */}
      <form action={availAction} style={card} key={selected}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Weekly working hours</h2>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          When a clinician publishes weekly hours, patients booking online may only choose
          slots inside them. Leave a day blank to mean they are not normally available then.
          Staff can still book any time.
        </p>
        <Banner state={availState} />

        <Field id="providerUserId" label="Clinician">
          {/* Not inside the submitted form's provider — the select drives which stored
              hours pre-fill below, and its value IS submitted as providerUserId. */}
          <Select
            name="providerUserId"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {view.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          {DAY_NAMES.map((day, index) => {
            const existing = byDay.get(index);
            return (
              <div
                key={day}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '7rem 1fr 1fr',
                  gap: 'var(--space-2)',
                  alignItems: 'center',
                }}
              >
                <label htmlFor={`start-${index}`} style={{ fontSize: 'var(--text-sm)' }}>
                  {day}
                </label>
                <input type="hidden" name="dayOfWeek" value={index} />
                <Input
                  id={`start-${index}`}
                  name="startsAt"
                  type="time"
                  defaultValue={existing?.startsAt?.slice(0, 5) ?? ''}
                />
                <Input
                  name="endsAt"
                  type="time"
                  aria-label={`${day} end time`}
                  defaultValue={existing?.endsAt?.slice(0, 5) ?? ''}
                />
              </div>
            );
          })}
        </div>

        <div>
          <Button type="submit" variant="primary" loading={savingAvail}>
            Save hours
          </Button>
        </div>
      </form>

      {/* ------------------------------------------------ exceptions */}
      <section style={card}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Time off &amp; closures</h2>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          A closure, a clinician&rsquo;s time off, or a blocked window. Any booking that
          overlaps one is refused — for staff and patients alike.
        </p>
        <Banner state={excState} />
        <Banner state={delState} />

        {view.exceptions.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            No upcoming exceptions.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
            {view.exceptions.map((e) => (
              <li
                key={e.id}
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: 'var(--space-2) 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <Badge tone={e.kind === 'closure' ? 'danger' : 'warning'}>
                  {EXCEPTION_KIND_LABELS[e.kind as 'closure'] ?? e.kind}
                </Badge>
                <span style={{ flex: '1 1 14rem', fontSize: 'var(--text-sm)' }}>
                  <strong>{e.providerName ?? 'Whole clinic'}</strong> · {e.startsAt} →{' '}
                  {e.endsAt}
                  {e.reason ? ` · ${e.reason}` : ''}
                </span>
                <form action={delAction}>
                  <input type="hidden" name="exceptionId" value={e.id} />
                  <Button type="submit" size="sm" variant="ghost">
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form
          action={excAction}
          style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-2)' }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            <Field id="excProvider" label="Applies to">
              <Select name="providerUserId" defaultValue="">
                <option value="">Whole clinic</option>
                {view.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="kind" label="Kind" error={excState.errors?.['kind']?.[0]}>
              <Select name="kind" defaultValue="time_off">
                {EXCEPTION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {EXCEPTION_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="startsAt" label="From" error={excState.errors?.['startsAt']?.[0]}>
              <Input name="startsAt" type="datetime-local" />
            </Field>
            <Field id="endsAt" label="To" error={excState.errors?.['endsAt']?.[0]}>
              <Input name="endsAt" type="datetime-local" />
            </Field>
          </div>
          <Field id="reason" label="Reason" error={excState.errors?.['reason']?.[0]}>
            <Input name="reason" placeholder="e.g. Public holiday, annual leave" />
          </Field>
          <div>
            <Button type="submit" variant="secondary" loading={savingExc}>
              Add exception
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
