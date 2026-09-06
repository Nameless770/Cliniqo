import Link from 'next/link';

import { Badge, EmptyState } from '@/components/ui';
import {
  APPOINTMENT_STATUS_LABELS,
  scheduleViewInput,
  type AppointmentStatus,
} from '@/lib/appointment-schemas';
import {
  formatDateInZone,
  formatTimeInZone,
  formatWallClockInZone,
  shiftDate,
  todayInZone,
  zonedDayRange,
  zonedWeekRange,
} from '@/lib/clinic-time';
import { can } from '@/lib/permissions';
import { guardPage } from '@/server/auth/authorize';
import { getSchedule } from '@/server/data-access/appointments';

import { StatusActions } from './StatusActions';

/**
 * Day / week schedule.
 *
 * A Server Component: patient names are rendered to HTML on the server and never
 * serialised into a client payload. Only the small `StatusActions` island is a Client
 * Component, and it receives an id and a status — nothing else.
 *
 * All boundaries are computed in the CLINIC's timezone, not the server's. A UTC-bounded
 * day view drops evening appointments off the day they belong to for any clinic west of
 * Greenwich.
 */
export const metadata = { title: 'Schedule · Cliniqo' };
export const dynamic = 'force-dynamic';

function statusTone(status: AppointmentStatus) {
  switch (status) {
    case 'checked_in':
    case 'in_progress':
      return 'info' as const;
    case 'completed':
      return 'success' as const;
    case 'cancelled':
      return 'neutral' as const;
    case 'no_show':
      return 'warning' as const;
    default:
      return 'neutral' as const;
  }
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await guardPage('appointment.read');
  const params = await searchParams;

  const parsed = scheduleViewInput.safeParse({
    date: typeof params['date'] === 'string' ? params['date'] : undefined,
    view: params['view'] === 'week' ? 'week' : 'day',
    providerUserId:
      typeof params['provider'] === 'string' ? params['provider'] : undefined,
  });

  const input = parsed.success ? parsed.data : { view: 'day' as const };

  /*
   * Clinic timezone, not the server's. Sourced from the session's clinic so a deployment
   * moving between regions cannot silently shift everyone's schedule.
   */
  const timeZone = session.clinicTimeZone;
  const anchor = input.date ?? todayInZone(timeZone);

  /*
   * A clinician's schedule defaults to their OWN. This is a default, not a restriction —
   * `appointment.read` is clinic-wide, and a doctor covering for a colleague needs to see
   * their list. The restriction that IS enforced is on writing status, per-row, server-side.
   */
  const defaultProvider = can(session.permissions, 'appointment.create')
    ? undefined
    : session.userId;
  const providerFilter = input.providerUserId ?? defaultProvider;

  const [from, to] =
    input.view === 'week'
      ? zonedWeekRange(anchor, timeZone)
      : zonedDayRange(anchor, timeZone);

  const entries = await getSchedule(from, to, providerFilter);

  const mayCheckIn = can(session.permissions, 'appointment.checkin');
  const mayChangeStatus = can(session.permissions, 'appointment.status');
  const mayCancel = can(session.permissions, 'appointment.cancel');
  const mayReschedule = can(session.permissions, 'appointment.update');

  const href = (over: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    const date = over['date'] ?? anchor;
    const view = over['view'] ?? input.view;
    if (date) sp.set('date', date);
    if (view !== 'day') sp.set('view', view);
    if (providerFilter) sp.set('provider', providerFilter);
    return `/schedule?${sp.toString()}`;
  };

  // Group by clinic-local day, so a week view reads as days rather than a flat list.
  const byDay = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = formatDateInZone(entry.startsAt, timeZone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(entry);
    else byDay.set(key, [entry]);
  }

  const step = input.view === 'week' ? 7 : 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Schedule
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {entries.length} appointment{entries.length === 1 ? '' : 's'}
          {providerFilter && !input.providerUserId ? ' · your list' : ''} · times shown in{' '}
          {timeZone}
        </p>
      </div>

      <nav
        aria-label="Schedule navigation"
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 'var(--text-sm)',
        }}
      >
        <Link href={href({ date: shiftDate(anchor, -step) })}>&larr; Previous</Link>
        <Link href={href({ date: todayInZone(timeZone) })}>Today</Link>
        <Link href={href({ date: shiftDate(anchor, step) })}>Next &rarr;</Link>

        <span aria-hidden="true" style={{ color: 'var(--border-default)' }}>
          |
        </span>

        <Link
          href={href({ view: 'day' })}
          aria-current={input.view === 'day' ? 'page' : undefined}
        >
          Day
        </Link>
        <Link
          href={href({ view: 'week' })}
          aria-current={input.view === 'week' ? 'page' : undefined}
        >
          Week
        </Link>
      </nav>

      {entries.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          description={`No appointments in this ${input.view}. Book one from a patient's profile.`}
        />
      ) : (
        [...byDay.entries()].map(([day, dayEntries]) => (
          <section key={day}>
            <h2
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: 'var(--space-2)',
              }}
            >
              {day}
            </h2>

            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 'var(--space-2)',
              }}
            >
              {dayEntries.map((entry) => (
                <li
                  key={entry.id}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-4)',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    padding: 'var(--space-3) var(--space-4)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)',
                    background: 'var(--bg-surface)',
                    opacity: entry.status === 'cancelled' ? 0.6 : 1,
                  }}
                >
                  <span
                    style={{
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: 'var(--weight-semibold)',
                      minWidth: '7.5rem',
                    }}
                  >
                    {formatTimeInZone(entry.startsAt, timeZone)}–
                    {formatTimeInZone(entry.endsAt, timeZone)}
                  </span>

                  <span style={{ flex: '1 1 14rem', minWidth: 0 }}>
                    <Link href={`/patients/${entry.patientId}`}>{entry.patientName}</Link>
                    <span
                      style={{
                        color: 'var(--text-muted)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {' '}
                      {entry.patientMrn}
                    </span>
                    <br />
                    <span
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {entry.typeName} · {entry.providerName}
                      {entry.bookingNote ? ` · ${entry.bookingNote}` : ''}
                    </span>
                  </span>

                  <Badge tone={statusTone(entry.status)}>
                    {APPOINTMENT_STATUS_LABELS[entry.status]}
                  </Badge>

                  <StatusActions
                    appointmentId={entry.id}
                    patientId={entry.patientId}
                    status={entry.status}
                    startsAtLocal={formatWallClockInZone(entry.startsAt, timeZone)}
                    durationMinutes={Math.round(
                      (entry.endsAt.getTime() - entry.startsAt.getTime()) / 60_000,
                    )}
                    canCheckIn={mayCheckIn}
                    canChangeStatus={mayChangeStatus}
                    canCancel={mayCancel}
                    canReschedule={mayReschedule}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
