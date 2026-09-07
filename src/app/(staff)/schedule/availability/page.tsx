import Link from 'next/link';

import { formatDateInZone, formatTimeInZone } from '@/lib/clinic-time';
import { guardPage } from '@/server/auth/authorize';
import { getAvailabilityView } from '@/server/data-access/availability';

import { AvailabilityForms } from './AvailabilityForms';

/**
 * Manage provider availability and schedule exceptions.
 *
 * Guarded on `appointment.update` — the diary managers (admin + reception). This is the
 * write side of two tables that were previously enforced-but-unsettable
 * (`schedule_exception`) or dormant (`provider_availability`).
 */
export const metadata = { title: 'Availability · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function AvailabilityPage() {
  const session = await guardPage('appointment.update');
  const view = await getAvailabilityView();
  const tz = session.clinicTimeZone;

  const forForm = {
    providers: view.providers,
    availability: view.availability,
    exceptions: view.exceptions.map((e) => ({
      id: e.id,
      providerUserId: e.providerUserId,
      providerName: e.providerName,
      kind: e.kind,
      startsAt: `${formatDateInZone(e.startsAt, tz)} ${formatTimeInZone(e.startsAt, tz)}`,
      endsAt: `${formatDateInZone(e.endsAt, tz)} ${formatTimeInZone(e.endsAt, tz)}`,
      reason: e.reason,
    })),
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href="/schedule">← Schedule</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0 0' }}>
          Availability
        </h1>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          Weekly working hours and one-off closures. Times are in {tz}.
        </p>
      </div>

      <AvailabilityForms view={forForm} />
    </div>
  );
}
