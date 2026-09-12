import Link from 'next/link';
import { redirect } from 'next/navigation';

import { formatDateInZone } from '@/lib/clinic-time';
import { portalUnlinkGoogleAction } from '@/server/actions/portal';
import { getGoogleLinkStatus, portalGoogleConfig } from '@/server/portal/google';
import { getPatientSession } from '@/server/portal/session';

export const metadata = { title: 'Your account · Cliniqo' };
export const dynamic = 'force-dynamic';

/**
 * The patient's own account page.
 *
 * It exists because of one control: a Google connection a patient cannot withdraw is not
 * consent, it is a setting the clinic made on their behalf. Everything else here is
 * context for that decision.
 *
 * A Server Component reading through the portal session, so the only account it can
 * describe is the session's own. There is no id in the URL to change.
 */
export default async function PortalAccountPage() {
  const session = await getPatientSession();
  if (!session) redirect('/portal/login');

  const google = portalGoogleConfig();
  const link = google ? await getGoogleLinkStatus(session.patientAccountId) : null;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-6)' }}>
      <div>
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>
          <Link href="/portal">← Your appointments</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 0 }}>Your account</h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {session.email} · {session.clinicName}
        </p>
      </div>

      {google ? (
        <section
          style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-surface)',
            padding: 'var(--space-5)',
            display: 'grid',
            gap: 'var(--space-3)',
          }}
        >
          <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>
            Signing in with Google
          </h2>

          {link?.connected ? (
            <>
              <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
                Connected to <strong>{link.emailAtLink}</strong>
                {link.linkedAt
                  ? ` since ${formatDateInZone(link.linkedAt, session.clinicTimeZone)}`
                  : ''}
                . You can sign in with either Google or your password.
              </p>

              {/*
                Said plainly rather than softened. Disconnecting stops future sign-ins
                from telling Google anything new; it does not reach back and unsay what
                the earlier ones said. A control that implies otherwise is worse than no
                control, because the patient would stop being careful on the strength of
                it.
              */}
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-secondary)',
                }}
              >
                Disconnecting stops any further sign-in from telling Google you have an
                account here. It cannot undo the sign-ins you have already made, and it
                does not remove anything from your medical record. Your password keeps
                working.
              </p>

              <form action={portalUnlinkGoogleAction}>
                <button
                  type="submit"
                  style={{
                    padding: 'var(--space-2) var(--space-4)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-default)',
                    background: 'var(--bg-page)',
                    color: 'var(--text-primary)',
                    font: 'inherit',
                    fontSize: 'var(--text-sm)',
                    cursor: 'pointer',
                  }}
                >
                  Disconnect Google
                </button>
              </form>
            </>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
                Not connected. Your password is the only way into this account, and
                nothing about you is shared with Google.
              </p>
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-secondary)',
                }}
              >
                You can connect Google from the sign-in page next time you sign in. Doing
                so tells Google that you have an account with this clinic — never your
                appointments, messages, or medical information.
              </p>
            </>
          )}
        </section>
      ) : null}

      <section style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Changing your details</h2>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Your name, date of birth, address and contact details are part of your medical
          record, so the clinic changes them rather than this page. Contact them directly
          and they will correct it.
        </p>
      </section>
    </div>
  );
}
