'use client';

import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { claimAccountAction, type StaffFormState } from '@/server/actions/staff';

/**
 * Password-setting form for a new staff member.
 *
 * The token rides in a hidden field rather than being re-read from the URL by the action,
 * so the action has a single input surface to validate.
 */
export function ClaimForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(
    claimAccountAction,
    {},
  );

  if (state.ok) {
    return (
      <p
        role="status"
        style={{
          padding: 'var(--space-3) var(--space-4)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--status-success-bg)',
          color: 'var(--status-success-text)',
          fontSize: 'var(--text-sm)',
        }}
      >
        {state.message} <a href="/login">Sign in</a>.
      </p>
    );
  }

  return (
    <form action={formAction} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <input type="hidden" name="token" value={token} />

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
        id="password"
        label="New password"
        required
        hint="At least 12 characters. A short phrase is easier to remember and harder to guess."
        error={state.errors?.['password']?.[0]}
      >
        <Input name="password" type="password" autoComplete="new-password" autoFocus />
      </Field>

      <Field
        id="confirm"
        label="Confirm password"
        required
        error={state.errors?.['confirm']?.[0]}
      >
        <Input name="confirm" type="password" autoComplete="new-password" />
      </Field>

      <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
        {pending ? 'Setting password' : 'Set password'}
      </Button>
    </form>
  );
}
