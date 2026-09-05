import Link from 'next/link';

import { can } from '@/lib/permissions';
import { todayInZone, zonedDayRange } from '@/lib/clinic-time';
import { getSession } from '@/server/auth/session';
import { getClinicOverview } from '@/server/data-access/admin';
import { redirect } from 'next/navigation';

/**
 * Dashboard.
 *
 * Every signed-in user gets a landing page; only an administrator gets the clinic
 * overview, which is gated on `clinic.configure` inside `getClinicOverview` — so the
 * numbers are not fetched at all for anyone else.
 *
 * COUNTS ONLY. No names, no identifiers, nothing that identifies a patient. This is the
 * screen most likely to be left open on a monitor visible from a waiting room.
 */
export const metadata = { title: 'Dashboard · Cliniqo' };
export const dynamic = 'force-dynamic';

function Stat({
  label,
  value,
  hint,
  tone,
  href,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: 'warning' | 'danger';
  href?: string;
}) {
  const body = (
    <div
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--bg-surface)',
        padding: 'var(--space-4)',
        display: 'grid',
        gap: '2px',
        height: '100%',
      }}
    >
      <span
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </span>
      <strong
        style={{
          fontSize: 'var(--text-2xl)',
          fontVariantNumeric: 'tabular-nums',
          color:
            tone === 'danger' && value > 0
              ? 'var(--status-danger-text)'
              : tone === 'warning' && value > 0
                ? 'var(--status-warn-text)'
                : 'var(--text-primary)',
        }}
      >
        {value}
      </strong>
      {hint ? (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
          {hint}
        </span>
      ) : null}
    </div>
  );

  return href ? (
    <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
      {body}
    </Link>
  ) : (
    body
  );
}

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const isAdmin = can(session.permissions, 'clinic.configure');

  if (!isAdmin) {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>Good day, {session.fullName}</h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          <Link href="/schedule">Today&rsquo;s schedule</Link> ·{' '}
          <Link href="/patients">Patients</Link>
        </p>
      </div>
    );
  }

  const timeZone = session.clinicTimeZone;
  const [dayStart, dayEnd] = zonedDayRange(todayInZone(timeZone), timeZone);
  const overview = await getClinicOverview(dayStart, dayEnd);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          {session.clinicName}
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {todayInZone(timeZone)} · times in {timeZone}
        </p>
      </div>

      <section>
        <h2
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: 'var(--space-2)',
          }}
        >
          Today
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          <Stat
            label="Appointments"
            value={overview.appointmentsToday}
            href="/schedule"
          />
          <Stat
            label="Checked in"
            value={overview.checkedInNow}
            hint="Waiting or in progress"
          />
          <Stat label="Completed" value={overview.completedToday} />
          <Stat label="No-shows" value={overview.noShowsToday} tone="warning" />
        </div>
      </section>

      <section>
        <h2
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: 'var(--space-2)',
          }}
        >
          Clinic
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          <Stat
            label="Active patients"
            value={overview.activePatients}
            href="/patients"
          />
          <Stat label="Active staff" value={overview.activeStaff} href="/staff" />
        </div>
      </section>

      {/*
        The two numbers that should prompt action. Unsigned notes are a care-quality and
        billing failure; refused access attempts are usually the first visible sign of a
        compromised account or a misconfigured role.
      */}
      <section>
        <h2
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: 'var(--space-2)',
          }}
        >
          Needs attention
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          <Stat
            label="Unsigned notes"
            value={overview.unsignedNotes}
            hint="Drafts never committed to the record"
            tone="warning"
          />
          <Stat
            label="Denied access (24h)"
            value={overview.deniedLast24h}
            hint="Refused attempts"
            tone="danger"
            href="/audit?outcome=denied"
          />
          <Stat
            label="High-volume readers"
            value={overview.bulkReaders}
            hint="Accounts reading many records in 24h"
            tone="danger"
            href="/audit?action=patient.read"
          />
          <Stat
            label="Break-glass to review"
            value={overview.breakGlassPending}
            hint="Emergency access awaiting review"
            tone="warning"
            href="/break-glass"
          />
        </div>
      </section>
    </div>
  );
}
