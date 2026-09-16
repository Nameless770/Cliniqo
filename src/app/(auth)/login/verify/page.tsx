import Link from 'next/link';
import { redirect } from 'next/navigation';

import { readChallenge } from '@/server/auth/mfa';
import { getSession } from '@/server/auth/session';

import { VerifyForm } from './VerifyForm';

/**
 * The second step of signing in.
 *
 * ==========================================================================
 * THIS PAGE IS NOT A GATE, AND MUST NOT BE MISTAKEN FOR ONE
 * ==========================================================================
 *
 * Reaching it proves nothing and grants nothing. There is no session yet — the password
 * step deliberately created none — so there is nothing here to bypass by navigating
 * straight to the URL. Without the signed challenge cookie the page has no account to
 * speak of and sends the visitor back to sign in; with one, the code still has to verify
 * server-side before any session exists.
 *
 * That is the whole reason the password step hands over a signed token instead of creating
 * a session flagged "pending". A half-authenticated session row would make every
 * `getSession()` call in the codebase responsible for remembering the flag.
 */
export const metadata = { title: 'Verify sign-in · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function VerifyPage() {
  /* Already finished signing in — nothing to verify. */
  if (await getSession()) redirect('/dashboard');

  /* No challenge, or an expired one: back to the start. The five-minute window is short
     enough that a shared workstation forgets a half-finished sign-in. */
  if (!(await readChallenge())) redirect('/login?error=expired');

  return (
    <section style={{ maxWidth: '22rem', width: '100%' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 var(--space-1)' }}>
        One more step
      </h1>
      <p
        style={{
          margin: '0 0 var(--space-4)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        Your password was accepted. Enter the current code from your authenticator app to
        finish signing in.
      </p>

      <VerifyForm />

      <p style={{ margin: 'var(--space-4) 0 0', fontSize: 'var(--text-sm)' }}>
        <Link href="/login">Start again</Link>
      </p>
      <p
        style={{
          margin: 'var(--space-2) 0 0',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        Lost your phone and your recovery codes? An administrator can remove two-step
        sign-in from your account after checking who you are.
      </p>
    </section>
  );
}
