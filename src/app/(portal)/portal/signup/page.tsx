import Link from 'next/link';
import { redirect } from 'next/navigation';

import { readPendingSignup, signupClinicId } from '@/server/auth/pending-signup';
import { clinicDisplayName } from '@/server/data-access/clinic-name';
import { getPatientSession } from '@/server/portal/session';

import { PortalSignupForm } from './PortalSignupForm';

export const metadata = { title: 'Create your account · Cliniqo' };
export const dynamic = 'force-dynamic';

/**
 * Confirm a patient registration.
 *
 * Reachable only straight after "Continue with Google" on the portal found no account;
 * without a valid signed token for the portal audience it redirects and renders nothing.
 *
 * It tells the patient, before anything is created, that this is a NEW record and that the
 * clinic will check their identity. Someone who is already a patient here should not come
 * away believing they have just been connected to their existing history — they have not,
 * and the page says so.
 */
export default async function PortalSignupPage() {
  if (await getPatientSession()) redirect('/portal');

  const clinicId = signupClinicId('portal');
  if (!clinicId) redirect('/portal/login');

  const pending = await readPendingSignup('portal');
  if (!pending) redirect('/portal/login');

  const clinicName = (await clinicDisplayName(clinicId)) ?? 'this clinic';

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
          {clinicName} · signing in as <strong>{pending.email}</strong>
        </p>
      </div>

      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--bg-surface)',
          padding: 'var(--space-4)',
          display: 'grid',
          gap: 'var(--space-2)',
          fontSize: 'var(--text-sm)',
        }}
      >
        <p style={{ margin: 0 }}>
          You will be able to book and manage appointments straight away.
        </p>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          If you have been to this clinic before, this does not connect you to your
          existing records. Bring photo ID to your next visit and the clinic will join
          them up.
        </p>
      </div>

      <PortalSignupForm
        givenName={pending.givenName ?? ''}
        familyName={pending.familyName ?? ''}
      />

      <p
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
      >
        Not you, or the wrong Google account?{' '}
        <Link href="/portal/login">Go back to sign in</Link>.
      </p>
    </div>
  );
}
