import Link from 'next/link';
import { redirect } from 'next/navigation';

import { clientEnv } from '@/env/client';
import { getSession } from '@/server/auth/session';

import { LoginForm } from './LoginForm';

/**
 * Sign-in.
 *
 * A Server Component that renders the form island. There is no self-registration link:
 * accounts are created by an administrator (phase 8), which is what keeps
 * §164.312(a)(2)(i) — one account per identified human — enforceable.
 */
const appName = clientEnv.NEXT_PUBLIC_APP_NAME;

export const metadata = { title: 'Sign in · Cliniqo' };

export default async function LoginPage() {
  // Already signed in — don't show a login form to an authenticated user.
  if (await getSession()) redirect('/dashboard');

  return (
    <section style={{ maxWidth: '22rem', width: '100%' }}>
      {/*
        The study's nameplate: the mark, a short heavy rule, then the heading. The rule
        is the load-bearing part — it is what makes the wordmark read as a masthead
        rather than as a logo, and it is the same device the app shell carries.

        No clinic name above it, unlike the study, which sets one: this page is reached
        before any session exists and nothing maps an anonymous request to a clinic
        while multi-tenancy is undecided.
      */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div
          style={{
            fontSize: 'var(--text-2xl)',
            fontWeight: 'var(--weight-semibold)',
            letterSpacing: 'var(--tracking-tight)',
            lineHeight: 1,
          }}
        >
          {appName}
        </div>
        <div
          aria-hidden="true"
          style={{
            width: '52px',
            height: '2px',
            background: 'var(--text-primary)',
            margin: 'var(--space-3) 0 var(--space-5)',
          }}
        />
        <h1 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-1)' }}>
          Sign in
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Staff accounts only.
        </p>
      </div>

      <LoginForm />

      <p
        style={{
          marginTop: 'var(--space-6)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-muted)',
        }}
      >
        Accounts are issued by a clinic administrator. If you cannot sign in, contact them
        directly — there is no self-service password reset.
      </p>

      {/*
        The way in for patients. Without it the portal is unreachable except by pasting a
        URL — the invite link is emailed once and then gone, so a patient coming back a
        month later would land here with nowhere to go.
      */}
      <p
        style={{
          marginTop: 'var(--space-5)',
          paddingTop: 'var(--space-5)',
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        Are you a patient?{' '}
        <Link href="/portal/login">Sign in to see and book your appointments</Link>.
      </p>
    </section>
  );
}
