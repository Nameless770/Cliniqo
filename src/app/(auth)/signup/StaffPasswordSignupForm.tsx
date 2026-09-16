'use client';

import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { createStaffAccountAction, type SignupFormState } from '@/server/actions/signup';

/**
 * Create a staff account with an email address and a password.
 *
 * No role field, on purpose: what a new account may do is decided by an administrator,
 * never chosen on a public form. The password is never echoed back on an error.
 */
export function StaffPasswordSignupForm() {
  const [state, formAction, pending] = useActionState<SignupFormState, FormData>(
    createStaffAccountAction,
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

      <Field id="staff-signup-name" label="Full name" required error={error('fullName')}>
        <Input name="fullName" autoComplete="name" required />
      </Field>

      <Field id="staff-signup-email" label="Work email" required error={error('email')}>
        <Input name="email" type="email" autoComplete="email" required />
      </Field>

      <Field
        id="staff-signup-password"
        label="Password"
        required
        hint="At least 12 characters. A short phrase works well."
        error={error('password')}
      >
        <Input name="password" type="password" autoComplete="new-password" required />
      </Field>

      <Field
        id="staff-signup-confirm"
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
