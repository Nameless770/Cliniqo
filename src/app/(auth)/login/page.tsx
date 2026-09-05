import { redirect } from 'next/navigation';

import { getSession } from '@/server/auth/session';

import { LoginForm } from './LoginForm';

/**
 * Sign-in.
 *
 * A Server Component that renders the form island. There is no self-registration link:
 * accounts are created by an administrator (phase 8), which is what keeps
 * §164.312(a)(2)(i) — one account per identified human — enforceable.
 */
export const metadata = { title: 'Sign in · Cliniqo' };

export default async function LoginPage() {
  // Already signed in — don't show a login form to an authenticated user.
  if (await getSession()) redirect('/dashboard');

  return (
    <section style={{ maxWidth: '22rem', width: '100%' }}>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Sign in to Cliniqo
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
    </section>
  );
}
