import { mfaStatus } from '@/server/auth/mfa';
import { requireSession } from '@/server/auth/session';

import { SecurityPanel } from './SecurityPanel';

/**
 * Two-step sign-in, for your own account.
 *
 * Deliberately NOT behind `guardPage`, for the same reason the password page is not:
 * there is no permission for this and there should not be. The subject is always the
 * caller, every account may strengthen its own credential, and requiring a grant would
 * mean an administrator could decide who is allowed to be secure.
 *
 * `requireSession` still applies — that is authentication, which this does need.
 */
export const metadata = { title: 'Two-step sign-in · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  const session = await requireSession();
  const status = await mfaStatus(session.userId);

  return (
    <div style={{ maxWidth: '34rem', display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Two-step sign-in
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {/*
            Why it matters HERE specifically, rather than a generic security nag. Every
            other control in this system is written in terms of an authenticated actor, so
            a stolen password is not one compromised control — it is all of them, with
            every action correctly attributed to somebody who did not perform it.
          */}
          A code from your phone, in addition to your password. It is the only protection
          that still works after a password is stolen — everything else this system does
          assumes the account is you.
        </p>
      </div>

      <SecurityPanel
        initial={{
          enrolled: status.enrolled,
          recoveryCodesRemaining: status.recoveryCodesRemaining,
        }}
      />
    </div>
  );
}
