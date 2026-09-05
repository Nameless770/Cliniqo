'use client';

import { useActionState } from 'react';

import { Badge, Button, Field, Input } from '@/components/ui';
import { DAY_NAMES } from '@/lib/clinic-config-schemas';
import {
  createAppointmentTypeAction,
  saveHoursAction,
  toggleAppointmentTypeAction,
  updateClinicAction,
  type ConfigFormState,
} from '@/server/actions/clinic-config';

export type SettingsView = {
  clinic: {
    name: string;
    timezone: string;
    phone: string | null;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    mrnPrefix: string;
  };
  types: {
    id: string;
    code: string;
    displayName: string;
    defaultDurationMinutes: number;
    isActive: boolean;
  }[];
  hours: { dayOfWeek: number; opensAt: string; closesAt: string }[];
};

function Banner({ state }: { state: ConfigFormState }) {
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

export function SettingsForms({ settings }: { settings: SettingsView }) {
  const [clinicState, clinicAction, savingClinic] = useActionState<
    ConfigFormState,
    FormData
  >(updateClinicAction, {});
  const [typeState, typeAction, savingType] = useActionState<ConfigFormState, FormData>(
    createAppointmentTypeAction,
    {},
  );
  const [toggleState, toggleAction] = useActionState<ConfigFormState, FormData>(
    toggleAppointmentTypeAction,
    {},
  );
  const [hoursState, hoursAction, savingHours] = useActionState<
    ConfigFormState,
    FormData
  >(saveHoursAction, {});

  // One row per weekday, pre-filled from whatever is stored.
  const hoursByDay = new Map(settings.hours.map((h) => [h.dayOfWeek, h]));

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      {/* ------------------------------------------------ clinic details */}
      <form action={clinicAction} style={card}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Clinic details</h2>
        <Banner state={clinicState} />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          <Field
            id="name"
            label="Clinic name"
            required
            error={clinicState.errors?.['name']?.[0]}
          >
            <Input name="name" defaultValue={settings.clinic.name} />
          </Field>

          {/*
            The consequential field. Every schedule boundary is computed in this zone, so
            changing it after bookings exist moves what everyone SEES — the stored instants
            do not move, which is correct, but the day will look different.
          */}
          <Field
            id="timezone"
            label="Timezone"
            required
            hint="IANA name. Changing this shifts how all existing appointments display."
            error={clinicState.errors?.['timezone']?.[0]}
          >
            <Input name="timezone" defaultValue={settings.clinic.timezone} />
          </Field>

          <Field id="phone" label="Phone" error={clinicState.errors?.['phone']?.[0]}>
            <Input name="phone" defaultValue={settings.clinic.phone ?? ''} />
          </Field>
          <Field id="addressLine1" label="Address">
            <Input
              name="addressLine1"
              defaultValue={settings.clinic.addressLine1 ?? ''}
            />
          </Field>
          <Field id="city" label="City">
            <Input name="city" defaultValue={settings.clinic.city ?? ''} />
          </Field>
          <Field id="state" label="State">
            <Input name="state" defaultValue={settings.clinic.state ?? ''} />
          </Field>
          <Field id="postalCode" label="Postal code">
            <Input name="postalCode" defaultValue={settings.clinic.postalCode ?? ''} />
          </Field>
        </div>

        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          Medical record numbers are issued as{' '}
          <code>{settings.clinic.mrnPrefix}-000001</code>. The prefix is not editable
          here: changing it after patients exist would produce two numbering schemes in
          one clinic.
        </p>

        <div>
          <Button type="submit" variant="primary" loading={savingClinic}>
            Save clinic details
          </Button>
        </div>
      </form>

      {/* -------------------------------------------- appointment types */}
      <section style={card}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Appointment types</h2>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Nothing can be booked until at least one exists. These are also what a
          receptionist picks instead of typing a reason, which is what keeps clinical
          detail out of the front-desk view.
        </p>

        <Banner state={typeState} />
        <Banner state={toggleState} />

        {settings.types.length === 0 ? (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--status-warn-bg)',
              color: 'var(--status-warn-text)',
              fontSize: 'var(--text-sm)',
            }}
          >
            No appointment types yet — booking will not work until you add one.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid' }}>
            {settings.types.map((t) => (
              <li
                key={t.id}
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: 'var(--space-2) 0',
                  borderBottom: '1px solid var(--border-subtle)',
                  opacity: t.isActive ? 1 : 0.6,
                }}
              >
                <Badge tone={t.isActive ? 'success' : 'neutral'}>
                  {t.isActive ? 'bookable' : 'retired'}
                </Badge>
                <strong style={{ flex: '1 1 12rem' }}>
                  {t.displayName}{' '}
                  <span
                    style={{
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-xs)',
                    }}
                  >
                    {t.code}
                  </span>
                </strong>
                <span
                  style={{
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  {t.defaultDurationMinutes} min
                </span>
                <form action={toggleAction}>
                  <input type="hidden" name="typeId" value={t.id} />
                  <input
                    type="hidden"
                    name="isActive"
                    value={t.isActive ? 'false' : 'true'}
                  />
                  <Button type="submit" size="sm" variant="ghost">
                    {t.isActive ? 'Retire' : 'Reactivate'}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form
          action={typeAction}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
            gap: 'var(--space-3)',
            alignItems: 'end',
          }}
        >
          <Field id="code" label="Code" required error={typeState.errors?.['code']?.[0]}>
            <Input name="code" placeholder="FOLLOWUP" />
          </Field>
          <Field
            id="displayName"
            label="Name"
            required
            error={typeState.errors?.['displayName']?.[0]}
          >
            <Input name="displayName" placeholder="Follow-up" />
          </Field>
          <Field
            id="defaultDurationMinutes"
            label="Minutes"
            required
            error={typeState.errors?.['defaultDurationMinutes']?.[0]}
          >
            <Input
              name="defaultDurationMinutes"
              type="number"
              min={5}
              max={480}
              defaultValue={20}
            />
          </Field>
          <Field id="sortOrder" label="Order">
            <Input name="sortOrder" type="number" min={0} defaultValue={0} />
          </Field>
          <div>
            <Button type="submit" variant="secondary" loading={savingType}>
              Add type
            </Button>
          </div>
        </form>
      </section>

      {/* ------------------------------------------------ opening hours */}
      <form action={hoursAction} style={card}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Opening hours</h2>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Leave a day blank to mark it closed. Times are in the clinic timezone.
        </p>
        <Banner state={hoursState} />

        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          {DAY_NAMES.map((day, index) => {
            const existing = hoursByDay.get(index);
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
                <label htmlFor={`opens-${index}`} style={{ fontSize: 'var(--text-sm)' }}>
                  {day}
                </label>
                <input type="hidden" name="dayOfWeek" value={index} />
                <Input
                  id={`opens-${index}`}
                  name="opensAt"
                  type="time"
                  defaultValue={existing?.opensAt?.slice(0, 5) ?? ''}
                />
                <Input
                  name="closesAt"
                  type="time"
                  aria-label={`${day} closing time`}
                  defaultValue={existing?.closesAt?.slice(0, 5) ?? ''}
                />
              </div>
            );
          })}
        </div>

        <div>
          <Button type="submit" variant="primary" loading={savingHours}>
            Save hours
          </Button>
        </div>
      </form>
    </div>
  );
}
