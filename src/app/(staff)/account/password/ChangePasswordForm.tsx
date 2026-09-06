'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { changePasswordAction, type AccountFormState } from '@/server/actions/account';

/**
 * Change your own password.
 *
 * On success every session is revoked — including this one — so the form does not try to
 * navigate anywhere. It shows the outcome and a link back to the login page, because the
 * user is, correctly, no longer signed in.
 */
export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const [state, action, pending] = useActionState<AccountFormState, FormData>(
    changePasswordAction,
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
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          Every device signed in to this account has been signed out, including this one.
        </p>
        <div>
          <Link href="/login">Go to sign in</Link>
        </div>
      </div>
    );
  }

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

      <Field
        id="currentPassword"
        label="Current password"
        required
        hint={
          forced
            ? 'The password you just signed in with.'
            : 'Confirms it is you at the keyboard, not just an open session.'
        }
        error={state.errors?.['currentPassword']?.[0]}
      >
        <Input
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          autoFocus
        />
      </Field>

      <Field
        id="password"
        label="New password"
        required
        hint="At least 12 characters. A short phrase is easier to remember and harder to guess."
        error={state.errors?.['password']?.[0]}
      >
        <Input name="password" type="password" autoComplete="new-password" />
      </Field>

      <Field
        id="confirm"
        label="Confirm new password"
        required
        error={state.errors?.['confirm']?.[0]}
      >
        <Input name="confirm" type="password" autoComplete="new-password" />
      </Field>

      <div>
        <Button type="submit" variant="primary" loading={pending}>
          Change password
        </Button>
      </div>
    </form>
  );
}
