import { redirect } from 'next/navigation';

import { Badge } from '@/components/ui';
import { formatDateInZone, formatTimeInZone } from '@/lib/clinic-time';
import { portalLogoutAction } from '@/server/actions/portal';
import { getBookingOptions, listMyAppointments } from '@/server/portal/data';
import { getPatientSession } from '@/server/portal/session';

import { AppointmentActions } from './AppointmentActions';
import { BookForm } from './BookForm';

export const metadata = { title: 'Your appointments · Cliniqo' };
export const dynamic = 'force-dynamic';

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (status === 'cancelled' || status === 'no_show') return 'neutral';
  if (status === 'completed') return 'success';
  if (status === 'checked_in' || status === 'in_progress') return 'info';
  return 'warning';
}

export default async function PortalHomePage() {
  const session = await getPatientSession();
  if (!session) redirect('/portal/login');

  const [{ upcoming, past }, options] = await Promise.all([
    listMyAppointments(),
    getBookingOptions(),
  ]);

  const tz = session.clinicTimeZone;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-6)' }}>
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
          <h1 style={{ fontSize: 'var(--text-xl)', margin: 0 }}>Hello, {session.fullName}</h1>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            {session.clinicName}
          </p>
        </div>
        <form action={portalLogoutAction}>
          <button
            type="submit"
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
      </header>

      {/* --------------------------------------------------------- book */}
      <section
        style={{
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
          providers={options.providers}
          hours={options.hours}
          timeZone={options.clinicTimeZone}
        />
      </section>

      {/* -------------------------------------------------- upcoming */}
      <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Upcoming</h2>
        {upcoming.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            You have no upcoming appointments.
          </p>
        ) : (
          upcoming.map((a) => (
              <article
                key={a.id}
                style={{
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
          <h2 style={{ fontSize: 'var(--text-md)', margin: 0, color: 'var(--text-secondary)' }}>
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
