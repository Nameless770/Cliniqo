import Link from 'next/link';
import { redirect } from 'next/navigation';

import { readPendingSignup, signupClinicId } from '@/server/auth/pending-signup';
import { getSession } from '@/server/auth/session';
import { clinicDisplayName } from '@/server/data-access/clinic-name';

import { StaffSignupForm } from './StaffSignupForm';

export const metadata = { title: 'Request access · Cliniqo' };
export const dynamic = 'force-dynamic';

/**
 * Confirm a staff sign-up.
 *
 * Reachable only straight after "Continue with Google" found no account: without a valid
 * signed token for the staff audience it redirects to sign-in and renders nothing. The page
 * says plainly what the account will and will not be able to do BEFORE it exists, so nobody
 * requests access expecting to be let straight into the patient list.
 */
export default async function StaffSignupPage() {
  if (await getSession()) redirect('/dashboard');

  const clinicId = signupClinicId('staff');
  if (!clinicId) redirect('/login');

  const pending = await readPendingSignup('staff');
  if (!pending) redirect('/login');

  const clinicName = (await clinicDisplayName(clinicId)) ?? 'this clinic';

  return (
    <section
      style={{ maxWidth: '24rem', width: '100%', display: 'grid', gap: 'var(--space-5)' }}
    >
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-2)' }}>
          Request access
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          No staff account uses <strong>{pending.email}</strong> yet.
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
          This creates a staff account at <strong>{clinicName}</strong> that you sign in
          to with this Google account.
        </p>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          It starts with <strong>no access</strong>. You will not see patients, the
          schedule or anything else until an administrator gives you a role.
        </p>
      </div>

      <StaffSignupForm suggestedName={pending.name ?? ''} />

      <p
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
      >
        Wrong Google account? <Link href="/login">Go back and choose another</Link>.
      </p>
    </section>
  );
}
