import Link from 'next/link';
import { redirect } from 'next/navigation';

import { googleConfig } from '@/server/auth/google';
import {
  passwordSignupClinicId,
  readPendingSignup,
  signupClinicId,
} from '@/server/auth/pending-signup';
import { getSession } from '@/server/auth/session';
import { clinicDisplayName } from '@/server/data-access/clinic-name';

import { StaffPasswordSignupForm } from './StaffPasswordSignupForm';
import { StaffSignupForm } from './StaffSignupForm';

export const metadata = { title: 'Create an account · Cliniqo' };
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
 * Create a staff account.
 *
 * Two shapes, chosen by whether the person has just come back from Google:
 *
 *   - With a valid signed token (issued by the Google callback when it found no account):
 *     confirm the request for that Google identity. Nothing exists until they confirm.
 *   - Otherwise: the "Create an account" page — an email-and-password form and a Google
 *     button, each shown only if its switch is on.
 *
 * Either way, and said on the page BEFORE anything is created: the account starts with no
 * access. Nobody requests access expecting to be let straight into the patient list.
 */
export default async function StaffSignupPage() {
  if (await getSession()) redirect('/dashboard');

  const googleClinic = googleConfig() ? signupClinicId('staff') : null;
  const passwordClinic = passwordSignupClinicId('staff');
  const pending = googleClinic ? await readPendingSignup('staff') : null;

  /* ----------------------------------------------- back from Google: confirm */
  if (pending && googleClinic) {
    const clinicName = (await clinicDisplayName(googleClinic)) ?? 'this clinic';
    return (
      <section
        style={{
          maxWidth: '24rem',
          width: '100%',
          display: 'grid',
          gap: 'var(--space-5)',
        }}
      >
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-2)' }}>
            Request access
          </h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            No staff account uses <strong>{pending.email}</strong> yet.
          </p>
        </div>

        <div style={panel}>
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
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Wrong Google account? <Link href="/login">Go back and choose another</Link>.
        </p>
      </section>
    );
  }

  /* ------------------------------------------------- create an account */
  if (!passwordClinic && !googleClinic) redirect('/login');

  const clinicName =
    (await clinicDisplayName((passwordClinic ?? googleClinic)!)) ?? 'this clinic';

  return (
    <section
      style={{ maxWidth: '24rem', width: '100%', display: 'grid', gap: 'var(--space-5)' }}
    >
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Create a staff account
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{clinicName}</p>
      </div>

      <div style={panel}>
        <p style={{ margin: 0 }}>
          Your account starts with <strong>no access</strong>. An administrator at{' '}
          {clinicName} gives you a role before you can see patients or the schedule.
        </p>
      </div>

      {passwordClinic ? <StaffPasswordSignupForm /> : null}

      {googleClinic ? (
        <>
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
          {/* A real POST, never a link — a GET would start sign-in flows from any prefetch. */}
          <form action="/auth/google/start" method="POST">
            <button
              type="submit"
              className="cq-btn"
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
              Continue with Google
            </button>
          </form>
        </>
      ) : null}

      <p
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
      >
        Already have an account? <Link href="/login">Sign in</Link>.
      </p>
    </section>
  );
}
