'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { portalClaimAction, type PortalFormState } from '@/server/actions/portal';

export function PortalClaimForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<PortalFormState, FormData>(
    portalClaimAction,
    {},
  );

  if (state.ok) {
    return (
      <div
        role="status"
        style={{
          display: 'grid',
          gap: 'var(--space-3)',
          padding: 'var(--space-4)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--status-success-bg)',
          color: 'var(--status-success-text)',
        }}
      >
        <strong>{state.message}</strong>
        <div>
          <Link href="/portal/login">Go to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <input type="hidden" name="token" value={token} />

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

      <Field
        id="password"
        label="Choose a password"
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

      <div>
        <Button type="submit" variant="primary" loading={pending}>
          Set password
        </Button>
      </div>
    </form>
  );
}
