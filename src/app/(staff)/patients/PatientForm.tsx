'use client';

import { useActionState } from 'react';

import { Button, Field, Input, Select } from '@/components/ui';
import type { PatientFormState } from '@/server/actions/patients';

/**
 * Patient create/edit form.
 *
 * A Client Component, because it renders server-action state and per-field errors.
 *
 * IT RECEIVES ONLY WHAT IT RENDERS. `defaults` is a flat map of the fields this form
 * shows — never a patient row. Handing a Client Component the whole record would
 * serialise every column into the page payload, including ones the current role may not
 * see, and no amount of conditional rendering takes them back out of view-source.
 *
 * `showClinical` is a rendering hint, not a control. The server decides which schema
 * parses the submission and which permission the write requires; if this were flipped to
 * true for a receptionist, the request would fail validation and then fail authorization.
 */

export type PatientFormDefaults = Partial<{
  legalFirstName: string;
  legalMiddleName: string;
  legalLastName: string;
  preferredName: string;
  pronouns: string;
  dateOfBirth: string;
  genderIdentity: string;
  phonePrimary: string;
  phoneSecondary: string;
  email: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  preferredLanguage: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelationship: string;
  sexAssignedAtBirth: string;
  deceasedDate: string;
}>;

const sectionStyle = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--bg-surface)',
  padding: 'var(--space-5)',
  display: 'grid',
  gap: 'var(--space-4)',
} as const;

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))',
  gap: 'var(--space-4)',
} as const;

export function PatientForm({
  action,
  defaults = {},
  version,
  showClinical,
  submitLabel,
}: {
  action: (state: PatientFormState, formData: FormData) => Promise<PatientFormState>;
  defaults?: PatientFormDefaults;
  /** Optimistic-concurrency token. Absent when creating. */
  version?: number;
  showClinical: boolean;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState<PatientFormState, FormData>(
    action,
    {},
  );

  const err = (field: string) => state.errors?.[field]?.[0];

  return (
    <form action={formAction} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {state.message ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: state.duplicates
              ? 'var(--status-warn-bg)'
              : 'var(--status-danger-bg)',
            color: state.duplicates
              ? 'var(--status-warn-text)'
              : 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {state.message}
        </p>
      ) : null}

      {/*
        Duplicate guard. Surfaced with the matching records so a human can compare, and
        passed only when they explicitly confirm these are different people — a duplicate
        chart hides allergies from whoever opens the wrong one.
      */}
      {state.duplicates && state.duplicates.length > 0 ? (
        <div style={{ ...sectionStyle, borderColor: 'var(--warn-600)' }}>
          <p style={{ margin: 0, fontWeight: 'var(--weight-semibold)' }}>
            Possible duplicate{state.duplicates.length > 1 ? 's' : ''}
          </p>
          <ul style={{ margin: 0, paddingInlineStart: '1.2rem' }}>
            {state.duplicates.map((d) => (
              <li key={d.id} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {d.mrn} — {d.legalLastName}, {d.legalFirstName} (born {d.dateOfBirth})
              </li>
            ))}
          </ul>
          <label
            style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start' }}
          >
            <input type="checkbox" name="confirmedNotDuplicate" value="true" />
            <span style={{ fontSize: 'var(--text-sm)' }}>
              I have checked, and this is a different person. Register a new record.
            </span>
          </label>
        </div>
      ) : null}

      {version !== undefined ? (
        <input type="hidden" name="version" value={version} />
      ) : null}

      <fieldset style={{ ...sectionStyle, border: '1px solid var(--border-subtle)' }}>
        <legend style={{ fontWeight: 'var(--weight-semibold)' }}>Identity</legend>
        <div style={gridStyle}>
          <Field
            id="legalFirstName"
            label="First name"
            required
            error={err('legalFirstName')}
          >
            <Input name="legalFirstName" defaultValue={defaults.legalFirstName ?? ''} />
          </Field>
          <Field id="legalMiddleName" label="Middle name" error={err('legalMiddleName')}>
            <Input name="legalMiddleName" defaultValue={defaults.legalMiddleName ?? ''} />
          </Field>
          <Field
            id="legalLastName"
            label="Last name"
            required
            error={err('legalLastName')}
          >
            <Input name="legalLastName" defaultValue={defaults.legalLastName ?? ''} />
          </Field>
          <Field
            id="preferredName"
            label="Preferred name"
            hint="What staff should call them"
            error={err('preferredName')}
          >
            <Input name="preferredName" defaultValue={defaults.preferredName ?? ''} />
          </Field>
          <Field id="pronouns" label="Pronouns" error={err('pronouns')}>
            <Input name="pronouns" defaultValue={defaults.pronouns ?? ''} />
          </Field>
          <Field
            id="dateOfBirth"
            label="Date of birth"
            required
            hint="YYYY-MM-DD"
            error={err('dateOfBirth')}
          >
            <Input
              name="dateOfBirth"
              type="date"
              defaultValue={defaults.dateOfBirth ?? ''}
            />
          </Field>
          <Field
            id="genderIdentity"
            label="Gender identity"
            error={err('genderIdentity')}
          >
            <Input name="genderIdentity" defaultValue={defaults.genderIdentity ?? ''} />
          </Field>
        </div>
      </fieldset>

      <fieldset style={sectionStyle}>
        <legend style={{ fontWeight: 'var(--weight-semibold)' }}>Contact</legend>
        <div style={gridStyle}>
          <Field id="phonePrimary" label="Phone" error={err('phonePrimary')}>
            <Input
              name="phonePrimary"
              type="tel"
              defaultValue={defaults.phonePrimary ?? ''}
            />
          </Field>
          <Field
            id="phoneSecondary"
            label="Alternate phone"
            error={err('phoneSecondary')}
          >
            <Input
              name="phoneSecondary"
              type="tel"
              defaultValue={defaults.phoneSecondary ?? ''}
            />
          </Field>
          <Field id="email" label="Email" error={err('email')}>
            <Input name="email" type="email" defaultValue={defaults.email ?? ''} />
          </Field>
          <Field
            id="preferredLanguage"
            label="Preferred language"
            error={err('preferredLanguage')}
          >
            <Input
              name="preferredLanguage"
              defaultValue={defaults.preferredLanguage ?? ''}
            />
          </Field>
          <Field id="addressLine1" label="Address line 1" error={err('addressLine1')}>
            <Input name="addressLine1" defaultValue={defaults.addressLine1 ?? ''} />
          </Field>
          <Field id="addressLine2" label="Address line 2" error={err('addressLine2')}>
            <Input name="addressLine2" defaultValue={defaults.addressLine2 ?? ''} />
          </Field>
          <Field id="city" label="City" error={err('city')}>
            <Input name="city" defaultValue={defaults.city ?? ''} />
          </Field>
          <Field id="state" label="State" error={err('state')}>
            <Input name="state" defaultValue={defaults.state ?? ''} />
          </Field>
          <Field id="postalCode" label="Postal code" error={err('postalCode')}>
            <Input name="postalCode" defaultValue={defaults.postalCode ?? ''} />
          </Field>
        </div>
      </fieldset>

      <fieldset style={sectionStyle}>
        <legend style={{ fontWeight: 'var(--weight-semibold)' }}>
          Emergency contact
        </legend>
        <div style={gridStyle}>
          <Field
            id="emergencyContactName"
            label="Name"
            error={err('emergencyContactName')}
          >
            <Input
              name="emergencyContactName"
              defaultValue={defaults.emergencyContactName ?? ''}
            />
          </Field>
          <Field
            id="emergencyContactPhone"
            label="Phone"
            error={err('emergencyContactPhone')}
          >
            <Input
              name="emergencyContactPhone"
              type="tel"
              defaultValue={defaults.emergencyContactPhone ?? ''}
            />
          </Field>
          <Field
            id="emergencyContactRelationship"
            label="Relationship"
            error={err('emergencyContactRelationship')}
          >
            <Input
              name="emergencyContactRelationship"
              defaultValue={defaults.emergencyContactRelationship ?? ''}
            />
          </Field>
        </div>
      </fieldset>

      {/*
        Rendered only for clinicians. Not the control — the server picks the parsing
        schema from the session, so submitting these without the permission fails
        validation and then fails authorization.
      */}
      {showClinical ? (
        <fieldset style={sectionStyle}>
          <legend style={{ fontWeight: 'var(--weight-semibold)' }}>Clinical</legend>
          <div style={gridStyle}>
            <Field
              id="sexAssignedAtBirth"
              label="Sex assigned at birth"
              hint="Affects reference ranges and screening"
              error={err('sexAssignedAtBirth')}
            >
              <Select
                name="sexAssignedAtBirth"
                defaultValue={defaults.sexAssignedAtBirth ?? ''}
              >
                <option value="">Not recorded</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="intersex">Intersex</option>
                <option value="unknown">Unknown</option>
              </Select>
            </Field>
            <Field id="deceasedDate" label="Deceased date" error={err('deceasedDate')}>
              <Input
                name="deceasedDate"
                type="date"
                defaultValue={defaults.deceasedDate ?? ''}
              />
            </Field>
          </div>
        </fieldset>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button type="submit" variant="primary" size="lg" loading={pending}>
          {pending ? 'Saving' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
