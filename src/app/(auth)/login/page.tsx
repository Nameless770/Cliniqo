import Link from 'next/link';
import { redirect } from 'next/navigation';

import { clientEnv } from '@/env/client';
import { googleConfig } from '@/server/auth/google';
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

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in — don't show a login form to an authenticated user.
  if (await getSession()) redirect('/dashboard');

  /* Null when Google sign-in is not configured, in which case nothing about it renders. */
  const google = googleConfig();
  const { error } = await searchParams;

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

      {/*
        One message for every SSO refusal — a bad handshake, an unverified address, the
        wrong Workspace domain, no matching staff account. Telling them apart would make
        this page an oracle for which addresses belong to clinic staff.
      */}
      {error === 'sso' ? (
        <p
          role="alert"
          style={{
            margin: '0 0 var(--space-4)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          Could not sign you in with Google. Your clinic must have issued you an account
          first — ask an administrator, or sign in with your password.
        </p>
      ) : null}

      {/*
        A DIFFERENT message, on purpose, and the only refusal that is allowed to be
        distinguishable. Every other outcome collapses into one message so this page
        cannot be asked which addresses hold staff accounts — but an outage answers
        identically for every address, so it reveals nothing about any of them, and
        showing the same "ask an administrator" text would send somebody hunting for a
        mistake they did not make.
      */}
      {error === 'unavailable' ? (
        <p
          role="alert"
          style={{
            margin: '0 0 var(--space-4)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-warn-bg)',
            color: 'var(--status-warn-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          Sign-in is temporarily unavailable. Nothing is wrong with your account — please
          try again shortly.
        </p>
      ) : null}

      <LoginForm />

      {google ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              margin: 'var(--space-5) 0',
              color: 'var(--text-muted)',
              fontSize: 'var(--text-xs)',
            }}
          >
            <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
            or
            <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
          </div>

          {/*
            A real form POST, not a link. A GET would be triggerable by any prefetch or
            <img> on any page, silently starting authentication flows.
          */}
          <form action="/auth/google/start" method="POST">
            <button
              type="submit"
              style={{
                width: '100%',
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-default)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                font: 'inherit',
                fontSize: 'var(--text-sm)',
                fontWeight: 'var(--weight-medium)',
                cursor: 'pointer',
              }}
            >
              Sign in with Google
            </button>
          </form>

          <p
            style={{
              margin: 'var(--space-2) 0 0',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-muted)',
            }}
          >
            Only works for an account your clinic has already issued. Signing in with
            Google never creates one.
          </p>
        </>
      ) : null}

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
