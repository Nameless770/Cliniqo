'use client';

import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { requestStaffAccessAction, type SignupFormState } from '@/server/actions/signup';

/**
 * One field: the person's name, prefilled from Google and editable, because the name on a
 * Google account is often a nickname and the name on a staff record should not be.
 *
 * Handles a staff member's own name and nothing else. No roles are offered, on purpose.
 */
export function StaffSignupForm({ suggestedName }: { suggestedName: string }) {
  const [state, formAction, pending] = useActionState<SignupFormState, FormData>(
    requestStaffAccessAction,
    {},
  );

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
        id="signup-name"
        label="Your full name"
        required
        hint="As your colleagues and the audit log should see it."
        error={state.errors?.['fullName']?.[0]}
      >
        <Input
          name="fullName"
          defaultValue={suggestedName}
          autoComplete="name"
          required
        />
      </Field>

      <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
        Request access
      </Button>
    </form>
  );
}
