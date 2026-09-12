import Link from 'next/link';
import { redirect } from 'next/navigation';

import { portalGoogleConfig } from '@/server/portal/google';
import { getPatientSession } from '@/server/portal/session';

import { PortalLoginForm } from './PortalLoginForm';

export const metadata = { title: 'Patient sign in · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in? Go straight to the portal.
  if (await getPatientSession()) redirect('/portal');

  /* Null unless the clinic has switched patient Google sign-in on. Off by default — see
     `portalGoogleConfig` for why it is a separate decision from staff sign-in. */
  const google = portalGoogleConfig();
  const { error } = await searchParams;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)', marginTop: 'var(--space-8)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Your appointments
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Sign in to see and book appointments. Your clinic sets up your account — if you
          cannot sign in, contact them directly.
        </p>
      </div>

      {/*
        One message for every Google refusal — a stale handshake, an unverified address,
        no matching account, a suspended one. Telling them apart here would let anyone ask
        this page whether a given email address belongs to a patient of this practice.
      */}
      {error === 'sso' ? (
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
          Could not sign you in with Google. Your clinic must have set up your portal
          account with that same email address first — or sign in with your password
          below.
        </p>
      ) : null}

      {/*
        The one refusal allowed to look different. See the staff login page: an outage
        answers the same for every address, so distinguishing it makes this page no more
        of an oracle than it already is -- and spares the patient looking for a mistake
        they did not make.
      */}
      {error === 'unavailable' ? (
        <p
          role="alert"
          style={{
            margin: 0,
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

      <PortalLoginForm />

      {google ? (
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              color: 'var(--text-muted)',
              fontSize: 'var(--text-xs)',
            }}
          >
            <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
            or
            <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
          </div>

          {/*
            THE NOTICE COMES BEFORE THE BUTTON, and it is not a link to a policy page.

            Pressing this button is itself the disclosure: the redirect tells Google that
            this person is signing in to a medical practice's application. The patient can
            only be the one choosing that if they are told what it does before they press
            it, in words they do not have to be a lawyer to read. Everything else in this
            feature — the recorded authorization, the audit row, the disconnect control —
            is downstream of the patient actually having been informed here.
          */}
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--bg-surface)',
              padding: 'var(--space-4)',
              display: 'grid',
              gap: 'var(--space-3)',
            }}
          >
            <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
              <strong>Before you use Google:</strong> signing in this way tells Google
              that you have an account with this clinic. Your appointments, messages and
              medical information are never shared — but the fact that you are a patient
              here is.
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
              }}
            >
              Your password sign-in above shares nothing with anyone. You can disconnect
              Google later from your account page, though that cannot undo a sign-in you
              have already made.
            </p>

            {/*
              A real form POST, not a link. A GET would fire from any prefetch or <img> on
              any page — and here the request itself is the thing being consented to.
            */}
            <form action="/portal/auth/google/start" method="POST">
              <button
                type="submit"
                style={{
                  width: '100%',
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-page)',
                  color: 'var(--text-primary)',
                  font: 'inherit',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 'var(--weight-medium)',
                  cursor: 'pointer',
                }}
              >
                Continue with Google
              </button>
            </form>

            <p
              style={{
                margin: 0,
                fontSize: 'var(--text-xs)',
                color: 'var(--text-muted)',
              }}
            >
              Only works if your clinic has already set up your portal account with the
              same email address. Signing in with Google never creates one.
            </p>
          </div>
        </div>
      ) : null}

      <p
        style={{
          marginTop: 'var(--space-2)',
          paddingTop: 'var(--space-5)',
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        Clinic staff? <Link href="/login">Sign in here</Link>.
      </p>
    </div>
  );
}
