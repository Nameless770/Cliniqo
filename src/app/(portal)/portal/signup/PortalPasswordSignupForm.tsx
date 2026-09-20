'use client';

import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import {
  createPatientAccountAction,
  type PortalFormState,
} from '@/server/actions/portal';

/**
 * Create a patient portal account with an email address and a password.
 *
 * Everything here is typed by the patient and posted straight to the server action. Nothing
 * comes from the clinic's records, and the password is never echoed back on an error.
 */
export function PortalPasswordSignupForm() {
  const [state, formAction, pending] = useActionState<PortalFormState, FormData>(
    createPatientAccountAction,
    {},
  );
  const error = (field: string) => state.errors?.[field]?.[0];

  return (
    <form action={formAction} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {state.message ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {state.message}
        </p>
      ) : null}

      <Field
        id="portal-signup-first"
        label="Legal first name"
        required
        hint="As it appears on your ID."
        error={error('legalFirstName')}
      >
        <Input name="legalFirstName" autoComplete="given-name" required />
      </Field>

      <Field
        id="portal-signup-last"
        label="Legal last name"
        required
        error={error('legalLastName')}
      >
        <Input name="legalLastName" autoComplete="family-name" required />
      </Field>

      <Field
        id="portal-signup-dob"
        label="Date of birth"
        required
        error={error('dateOfBirth')}
      >
        <Input name="dateOfBirth" type="date" autoComplete="bday" required />
      </Field>

      <Field
        id="portal-signup-phone"
        label="Phone number"
        hint="Optional. So the clinic can reach you about an appointment."
        error={error('phonePrimary')}
      >
        <Input name="phonePrimary" type="tel" autoComplete="tel" />
      </Field>

      <Field id="portal-signup-email" label="Email" required error={error('email')}>
        <Input name="email" type="email" autoComplete="email" required />
      </Field>

      <Field
        id="portal-signup-password"
        label="Password"
        required
        hint="At least 12 characters. A short phrase works well."
        error={error('password')}
      >
        <Input name="password" type="password" autoComplete="new-password" required />
      </Field>

      <Field
        id="portal-signup-confirm"
        label="Password again"
        required
        error={error('confirm')}
      >
        <Input name="confirm" type="password" autoComplete="new-password" required />
      </Field>

      <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
        Create account
      </Button>
    </form>
  );
}
