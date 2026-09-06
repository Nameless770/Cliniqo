import { requireSession } from '@/server/auth/session';

import { ChangePasswordForm } from './ChangePasswordForm';

/**
 * Change your own password.
 *
 * Deliberately NOT behind `guardPage`. There is no permission for this — every account
 * may change its own credential — and gating it would break the case it exists for: an
 * account flagged `must_change_password` is redirected here by the layout, so requiring
 * an extra grant would strand exactly the user who cannot get anywhere else.
 *
 * `requireSession` still applies, so an anonymous visitor is bounced to /login. That is
 * authentication, which this page does need; authorization is the part that does not
 * apply, because the subject is always the caller.
 */
export const metadata = { title: 'Change password · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage() {
  const session = await requireSession();
  const forced = session.mustChangePassword;

  return (
    <div style={{ maxWidth: '32rem', display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          {forced ? 'Set a new password' : 'Change password'}
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {forced
            ? 'Your account is flagged to change its password before continuing.'
            : 'Nobody at the clinic can see your password, including an administrator.'}
        </p>
      </div>

      {forced ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-warn-bg)',
            color: 'var(--status-warn-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          This usually means your credential was issued or reset by someone else. A
          password another person has seen is a shared login, which HIPAA&rsquo;s unique
          user identification rule (&sect;164.312(a)(2)(i)) does not allow — the audit
          trail cannot attribute an action to a person if two people can sign in as them.
        </p>
      ) : null}

      <ChangePasswordForm forced={forced} />
    </div>
  );
}
