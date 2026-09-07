'use client';

import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { portalLoginAction, type PortalFormState } from '@/server/actions/portal';

export function PortalLoginForm() {
  const [state, action, pending] = useActionState<PortalFormState, FormData>(
    portalLoginAction,
    {},
  );

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {state.message ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {state.message}
        </p>
      ) : null}

      <Field id="email" label="Email" required error={state.errors?.['email']?.[0]}>
        <Input name="email" type="email" autoComplete="email" autoFocus />
      </Field>

      <Field id="password" label="Password" required error={state.errors?.['password']?.[0]}>
        <Input name="password" type="password" autoComplete="current-password" />
      </Field>

      <div>
        <Button type="submit" variant="primary" loading={pending}>
          Sign in
        </Button>
      </div>
    </form>
  );
}
