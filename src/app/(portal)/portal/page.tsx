import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Badge } from '@/components/ui';
import { formatDateInZone, formatTimeInZone } from '@/lib/clinic-time';
import { portalLogoutAction } from '@/server/actions/portal';
import { getBookingOptions, listMyAppointments } from '@/server/portal/data';
import { getPatientSession } from '@/server/portal/session';

import { AppointmentActions } from './AppointmentActions';
import { BookForm } from './BookForm';
import { ClinicClock } from './ClinicClock';

export const metadata = { title: 'Your appointments · Cliniqo' };
export const dynamic = 'force-dynamic';

function statusTone(
  status: string,
): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (status === 'cancelled' || status === 'no_show') return 'neutral';
  if (status === 'completed') return 'success';
  if (status === 'checked_in' || status === 'in_progress') return 'info';
  return 'warning';
}

export default async function PortalHomePage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string }>;
}) {
  const session = await getPatientSession();
  if (!session) redirect('/portal/login');

  /* Set once, by the Google callback, on the sign-in that created the link. A
     boolean about the sign-in method - no PHI, and nothing a referrer could leak. */
  const { linked } = await searchParams;

  const [{ upcoming, past }, options] = await Promise.all([
    listMyAppointments(),
    getBookingOptions(),
  ]);

  const tz = session.clinicTimeZone;
  const next = upcoming[0];

  return (
    <div style={{ display: 'grid', gap: 'var(--space-6)' }}>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h1 style={{ fontSize: 'var(--text-xl)', margin: 0 }}>
              Hello, {session.fullName}
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
              }}
            >
              {session.clinicName}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <Link href="/portal/account" style={{ fontSize: 'var(--text-sm)' }}>
              Your account
            </Link>
            <form action={portalLogoutAction}>
              <button
                type="submit"
                className="cq-btn"
                style={{
                  padding: 'var(--space-1) var(--space-3)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--text-sm)',
                  cursor: 'pointer',
                }}
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        {/*
        The masthead: a heavy rule over a light one, like a newspaper's dateline. The live
        half — open or closed, and the clinic's clock — is a small Client Component fed
        only clinic configuration. The patient's next appointment is theirs, so it is
        rendered here by the server and never crosses into that island.
      */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
            borderTop: '2px solid var(--text-primary)',
            borderBottom: '1px solid var(--text-primary)',
            padding: '9px 0',
          }}
        >
          <ClinicClock timeZone={tz} hours={options.hours} closures={options.closures} />
          <span style={{ flex: 1 }} />
          <span
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-secondary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {next
              ? `Next: ${formatDateInZone(next.startsAt, tz)}, ${formatTimeInZone(next.startsAt, tz)}`
              : 'No upcoming appointments'}
          </span>
        </div>
      </div>

      {/*
        Shown once, after the sign-in that created the link. It confirms what just
        happened and points at where to undo it - a connection made silently, with no
        way back visible, is not something a patient has agreed to in any real sense.
      */}
      {linked === '1' ? (
        <p
          role="status"
          className="cq-rowin"
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
            fontSize: 'var(--text-sm)',
          }}
        >
          Your Google account is now connected to this portal. You can{' '}
          <Link href="/portal/account">disconnect it at any time</Link>.
        </p>
      ) : null}

      {/*
        The way in to triage. Placed above booking on purpose: a patient who does not know
        which service they need should meet this before the visit-type dropdown, not after
        guessing at it.
      */}
      <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
        Not sure what to book?{' '}
        <Link href="/portal/assistant">Describe your symptoms and get a suggestion</Link>.
      </p>

      {/* --------------------------------------------------------- book */}
      <section
        style={{
          /* The positioning context for the booking stamp BookForm lays over this card. */
          position: 'relative',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--bg-surface)',
          padding: 'var(--space-5)',
          display: 'grid',
          gap: 'var(--space-4)',
        }}
      >
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Book an appointment</h2>
        <BookForm
          types={options.types}
          hours={options.hours}
          timeZone={options.clinicTimeZone}
        />
      </section>

      {/* -------------------------------------------------- upcoming */}
      <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Upcoming</h2>
        {upcoming.length === 0 ? (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            You have no upcoming appointments.
          </p>
        ) : (
          upcoming.map((a) => (
            <article
              key={a.id}
              /* A row booked moments ago slides in, a beat after the booking stamp. See
                 `justBooked` in the data layer for why it is a flag, not an id in a URL. */
              className={a.justBooked ? 'cq-rowin' : undefined}
              style={{
                /* Lands as the stamp over the booking card clears. */
                animationDelay: a.justBooked ? '900ms' : undefined,
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-surface)',
                padding: 'var(--space-3) var(--space-4)',
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontWeight: 'var(--weight-semibold)', minWidth: '11rem' }}>
                {formatDateInZone(a.startsAt, tz)} · {formatTimeInZone(a.startsAt, tz)}
              </span>
              <span style={{ flex: '1 1 10rem' }}>
                {a.typeName} · {a.providerName}
              </span>
              <Badge tone={statusTone(a.status)}>{a.status.replace(/_/g, ' ')}</Badge>
              {a.status === 'scheduled' ? (
                <AppointmentActions appointmentId={a.id} timeZone={tz} />
              ) : null}
            </article>
          ))
        )}
      </section>

      {/* ------------------------------------------------------ past */}
      {past.length > 0 ? (
        <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <h2
            style={{
              fontSize: 'var(--text-md)',
              margin: 0,
              color: 'var(--text-secondary)',
            }}
          >
            Past &amp; cancelled
          </h2>
          {past.map((a) => (
            <article
              key={a.id}
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-3) var(--space-4)',
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'center',
                flexWrap: 'wrap',
                opacity: 0.7,
              }}
            >
              <span style={{ minWidth: '11rem' }}>
                {formatDateInZone(a.startsAt, tz)} · {formatTimeInZone(a.startsAt, tz)}
              </span>
              <span style={{ flex: '1 1 10rem' }}>
                {a.typeName} · {a.providerName}
              </span>
              <Badge tone={statusTone(a.status)}>{a.status.replace(/_/g, ' ')}</Badge>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
