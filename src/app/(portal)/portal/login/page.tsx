import { redirect } from 'next/navigation';

import { getPatientSession } from '@/server/portal/session';

import { PortalLoginForm } from './PortalLoginForm';

export const metadata = { title: 'Patient sign in · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function PortalLoginPage() {
  // Already signed in? Go straight to the portal.
  if (await getPatientSession()) redirect('/portal');

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)', marginTop: 'var(--space-8)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Your appointments
        </h1>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          Sign in to see and book appointments. Your clinic sets up your account — if you
          cannot sign in, contact them directly.
        </p>
      </div>
      <PortalLoginForm />
    </div>
  );
}
