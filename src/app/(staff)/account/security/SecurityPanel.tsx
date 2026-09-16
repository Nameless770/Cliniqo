'use client';

import { useActionState, useState, useTransition } from 'react';

import { Badge, Button, Field, Input } from '@/components/ui';
import {
  beginEnrollmentAction,
  confirmEnrollmentAction,
  disableMfaAction,
  type MfaFormState,
} from '@/server/actions/mfa';

/**
 * Turning two-step sign-in on and off, for your own account.
 *
 * ==========================================================================
 * THE SECRET NEVER ARRIVES UNTIL IT IS ASKED FOR
 * ==========================================================================
 *
 * The enrollment secret is a credential. It is fetched by an explicit action when the user
 * chooses to start, rather than rendered into the page for everyone who opens their
 * settings — so it is not sitting in the HTML of a tab left open on a shared desk, and it
 * is not in the browser cache of anybody who never enrolled.
 *
 * Recovery codes are shown ONCE, here, and never again: only their hashes are stored, so
 * there is nothing to show a second time. Saying so plainly on screen is the difference
 * between a user copying them down and a user assuming they can come back for them.
 */

export type SecurityState = {
  enrolled: boolean;
  recoveryCodesRemaining: number;
};

export function SecurityPanel({ initial }: { initial: SecurityState }) {
  const [setup, setSetup] = useState<{
    manualEntryKey: string;
    otpauthUri: string;
  } | null>(null);
  const [starting, startTransition] = useTransition();
  const [startError, setStartError] = useState<string | null>(null);

  const [confirmState, confirmAction, confirming] = useActionState<
    MfaFormState,
    FormData
  >(confirmEnrollmentAction, {});
  const [disableState, disableAction, disabling] = useActionState<MfaFormState, FormData>(
    disableMfaAction,
    {},
  );

  const enrolled = (initial.enrolled || confirmState.ok) && !disableState.ok;

  function begin() {
    setStartError(null);
    startTransition(async () => {
      const result = await beginEnrollmentAction();
      if (result.ok && result.setup) setSetup(result.setup);
      else setStartError(result.message ?? 'Could not start setup.');
    });
  }

  /* Codes are in the response of the confirm action and nowhere else — not in state that
     survives a refresh, because after a refresh they no longer exist to show. */
  if (confirmState.recoveryCodes) {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p role="status" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <strong>Two-step sign-in is on.</strong>
        </p>
        <div
          style={{
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-warn-bg)',
            color: 'var(--status-warn-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          <p style={{ margin: '0 0 var(--space-2)' }}>
            <strong>Save these recovery codes now.</strong> They are shown once and cannot
            be retrieved — only their hashes are stored. Each one works a single time, and
            they are how you get in if you lose your phone.
          </p>
          <ul
            style={{
              margin: 0,
              paddingLeft: 'var(--space-4)',
              fontFamily: 'var(--font-mono, monospace)',
              columns: 2,
            }}
          >
            {confirmState.recoveryCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (enrolled) {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Badge tone="success">On</Badge>{' '}
          {initial.recoveryCodesRemaining > 0
            ? `${initial.recoveryCodesRemaining} recovery codes left.`
            : 'No recovery codes left — turn two-step off and on again to get a new set.'}
        </p>

        <form action={disableAction} style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <Field
            id="mfa-disable-password"
            label="Turn it off"
            hint="Your password is required, because an unattended signed-in screen is exactly what this protects against."
            error={disableState.message}
          >
            <Input
              id="mfa-disable-password"
              name="password"
              type="password"
              autoComplete="current-password"
            />
          </Field>
          <span>
            <Button type="submit" variant="danger" size="sm" loading={disabling}>
              Turn off two-step sign-in
            </Button>
          </span>
        </form>
      </div>
    );
  }

  if (!setup) {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Badge tone="neutral">Off</Badge> A password alone is the only thing standing
          between a stolen credential and every record you can reach.
        </p>
        <Button type="button" onClick={begin} loading={starting}>
          Set up two-step sign-in
        </Button>
        {startError || disableState.message ? (
          <span role="status" style={{ fontSize: 'var(--text-sm)' }}>
            {startError ?? disableState.message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <ol
        style={{ margin: 0, paddingLeft: 'var(--space-4)', fontSize: 'var(--text-sm)' }}
      >
        <li style={{ marginBottom: 'var(--space-2)' }}>
          Open your authenticator app and add an account by entering this key by hand:
          <br />
          <code
            style={{
              display: 'inline-block',
              marginTop: 'var(--space-1)',
              padding: 'var(--space-2)',
              background: 'var(--bg-sunken)',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono, monospace)',
              letterSpacing: '0.05em',
              wordBreak: 'break-all',
            }}
          >
            {setup.manualEntryKey}
          </code>
          {/*
            No QR code: encoding one means Reed–Solomon, masking and version selection, or
            a dependency in the login path. Every authenticator app accepts a typed key,
            and this is typed exactly once.
          */}
        </li>
        <li>Then enter the 6-digit code it shows, to prove it is working.</li>
      </ol>

      <form action={confirmAction} style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <Field
          id="mfa-confirm-code"
          label="Code from your app"
          error={confirmState.message}
        >
          <Input
            id="mfa-confirm-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
          />
        </Field>
        <span>
          <Button type="submit" loading={confirming}>
            Turn on two-step sign-in
          </Button>
        </span>
      </form>
    </div>
  );
}
