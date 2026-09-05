'use client';

import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { login, type LoginState } from '@/server/actions/auth';

/**
 * Login form.
 *
 * A Client Component because it renders server-action state. It handles staff credentials
 * — which are secrets, but not PHI — and nothing else. No patient data reaches this file,
 * and none should: the moment it does, it is serialised into the page payload.
 *
 * The password input is uncontrolled and never echoed back on failure. Only the email is
 * returned by the action so the user does not retype it.
 */
export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <form action={formAction} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {state.error ? (
        /*
         * role="alert" so the failure is announced rather than silently repainted.
         * The message is intentionally the same for every failure mode.
         */
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--weight-medium)',
          }}
        >
          {state.error}
        </p>
      ) : null}

      <Field id="login-email" label="Email" required>
        <Input
          name="email"
          type="email"
          autoComplete="username"
          defaultValue={state.email ?? ''}
          autoFocus
          required
        />
      </Field>

      <Field id="login-password" label="Password" required>
        <Input
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>

      <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
        {pending ? 'Signing in' : 'Sign in'}
      </Button>
    </form>
  );
}
