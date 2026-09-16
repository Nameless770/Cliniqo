import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  passwordSignupClinicId,
  readPendingSignup,
  signupClinicId,
} from '@/server/auth/pending-signup';
import { clinicDisplayName } from '@/server/data-access/clinic-name';
import { portalGoogleConfig } from '@/server/portal/google';
import { getPatientSession } from '@/server/portal/session';

import { PortalPasswordSignupForm } from './PortalPasswordSignupForm';
import { PortalSignupForm } from './PortalSignupForm';

export const metadata = { title: 'Create your account · Cliniqo' };
export const dynamic = 'force-dynamic';

const panel = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--bg-surface)',
  padding: 'var(--space-4)',
  display: 'grid',
  gap: 'var(--space-2)',
  fontSize: 'var(--text-sm)',
} as const;

/**
 * Create a patient portal account.
 *
 * Two shapes, chosen by whether the patient has just come back from Google:
 *
 *   - With a valid signed token (issued by the portal Google callback when it found no
 *     account): finish registering that Google identity.
 *   - Otherwise: the "Create an account" page — an email-and-password form and a Google
 *     button, each shown only if its switch is on.
 *
 * Either way the page says, before anything is created, that this is a NEW record and the
 * clinic will check identity at the first visit. Someone who has been a patient here before
 * must not come away believing they were just connected to their history.
 */
export default async function PortalSignupPage() {
  if (await getPatientSession()) redirect('/portal');

  const googleClinic = portalGoogleConfig() ? signupClinicId('portal') : null;
  const passwordClinic = passwordSignupClinicId('portal');
  const pending = googleClinic ? await readPendingSignup('portal') : null;

  const newRecordNotice = (
    <div style={panel}>
      <p style={{ margin: 0 }}>
        You will be able to book and manage appointments straight away.
      </p>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
        If you have been to this clinic before, this does not connect you to your existing
        records. Bring photo ID to your next visit and the clinic will join them up.
      </p>
    </div>
  );

  /* ----------------------------------------------- back from Google: finish */
  if (pending && googleClinic) {
    const clinicName = (await clinicDisplayName(googleClinic)) ?? 'this clinic';
    return (
      <div
        style={{ display: 'grid', gap: 'var(--space-5)', marginTop: 'var(--space-8)' }}
      >
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
            Create your account
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            {clinicName} · signing in as <strong>{pending.email}</strong>
          </p>
        </div>

        {newRecordNotice}

        <PortalSignupForm
          givenName={pending.givenName ?? ''}
          familyName={pending.familyName ?? ''}
        />

        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Not you, or the wrong Google account?{' '}
          <Link href="/portal/login">Go back to sign in</Link>.
        </p>
      </div>
    );
  }

  /* ------------------------------------------------- create an account */
  if (!passwordClinic && !googleClinic) redirect('/portal/login');

  const clinicName =
    (await clinicDisplayName((passwordClinic ?? googleClinic)!)) ?? 'this clinic';

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)', marginTop: 'var(--space-8)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Create your account
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {clinicName}
        </p>
      </div>

      {newRecordNotice}

      {passwordClinic ? <PortalPasswordSignupForm /> : null}

      {googleClinic ? (
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {passwordClinic ? (
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
          ) : null}

          {/*
            The disclosure comes BEFORE the button, as on the sign-in page: pressing it tells
            Google this person is signing up with a medical practice, so the patient must be
            told that first.
          */}
          <div style={panel}>
            <p style={{ margin: 0 }}>
              <strong>Before you use Google:</strong> signing up this way tells Google
              that you have an account with this clinic. Your appointments and medical
              information are never shared — but the fact that you are a patient here is.
            </p>
          </div>
          <form action="/portal/auth/google/start" method="POST">
            <button
              type="submit"
              className="cq-btn"
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
        </div>
      ) : null}

      <p
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
      >
        Already have an account? <Link href="/portal/login">Sign in</Link>.
      </p>
    </div>
  );
}
