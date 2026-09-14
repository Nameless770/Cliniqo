'use client';

import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import {
  completePatientSignupAction,
  type PortalFormState,
} from '@/server/actions/portal';

/**
 * The patient's registration details.
 *
 * Prefilled only with what the patient's own Google account already says about them, and
 * shown to that same person. Nothing here came from the clinic's records, because a sign-up
 * never reads them.
 */
export function PortalSignupForm({
  givenName,
  familyName,
}: {
  givenName: string;
  familyName: string;
}) {
  const [state, formAction, pending] = useActionState<PortalFormState, FormData>(
    completePatientSignupAction,
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
        id="signup-first"
        label="Legal first name"
        required
        hint="As it appears on your ID."
        error={error('legalFirstName')}
      >
        <Input
          name="legalFirstName"
          defaultValue={givenName}
          autoComplete="given-name"
          required
        />
      </Field>

      <Field
        id="signup-last"
        label="Legal last name"
        required
        error={error('legalLastName')}
      >
        <Input
          name="legalLastName"
          defaultValue={familyName}
          autoComplete="family-name"
          required
        />
      </Field>

      <Field id="signup-dob" label="Date of birth" required error={error('dateOfBirth')}>
        <Input name="dateOfBirth" type="date" autoComplete="bday" required />
      </Field>

      <Field
        id="signup-phone"
        label="Phone number"
        hint="Optional. So the clinic can reach you about an appointment."
        error={error('phonePrimary')}
      >
        <Input name="phonePrimary" type="tel" autoComplete="tel" />
      </Field>

      <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
        Create my account
      </Button>
    </form>
  );
}
