'use client';

import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { verifyMfaAction, type MfaFormState } from '@/server/actions/mfa';

/**
 * The second step of signing in.
 *
 * `inputMode="numeric"` and `autoComplete="one-time-code"` between them make a phone
 * offer the code from the notification shade, which is the difference between this
 * feeling like a security feature and feeling like an obstacle. The field still accepts a
 * recovery code, which is not numeric — hence `type="text"` rather than `type="number"`,
 * which would also strip leading zeros from a code that legitimately starts with one.
 *
 * Nothing here knows whose account it is. The signed challenge cookie carries that, and
 * this component is handed no identity at all.
 */
export function VerifyForm() {
  const [state, action, pending] = useActionState<MfaFormState, FormData>(
    verifyMfaAction,
    {},
  );

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <Field
        id="mfa-code"
        label="Code from your authenticator app"
        error={state.message}
        hint="Or one of your recovery codes, if you do not have your phone."
      >
        <Input
          id="mfa-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          // A 6-digit code or a 9-character recovery code; neither benefits from
          // autocorrect deciding it knows better.
          autoCapitalize="characters"
          spellCheck={false}
        />
      </Field>

      <Button type="submit" loading={pending}>
        Continue
      </Button>
    </form>
  );
}
