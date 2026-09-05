import Link from 'next/link';
import { notFound } from 'next/navigation';

import { guardPage } from '@/server/auth/authorize';
import { getBookingOptions } from '@/server/data-access/appointments';
import { getPatient } from '@/server/data-access/patients';

import { BookingForm } from './BookingForm';

/**
 * Book an appointment for a patient.
 *
 * Guarded on `appointment.create`, which after migration 0006 is held by reception and
 * administration only — a clinician reaching this URL is redirected to /forbidden and the
 * attempt is recorded.
 *
 * Reached from the patient profile, so the patient is fixed by the route rather than
 * chosen in the form. That removes a whole class of mistake: booking the right slot for
 * the wrong person.
 */
export const dynamic = 'force-dynamic';

export default async function BookAppointmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await guardPage('appointment.create');
  const { id } = await params;

  const [view, options] = await Promise.all([getPatient(id), getBookingOptions()]);

  if (!view) notFound();

  const p = view.patient;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href={`/patients/${id}`}>
            {p.legalLastName}, {p.legalFirstName}
          </Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0 0' }}>
          Book appointment
        </h1>
        <p
          style={{
            margin: 'var(--space-1) 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {p.mrn} · born {p.dateOfBirth}
        </p>
      </div>

      <BookingForm patientId={id} providers={options.providers} types={options.types} />
    </div>
  );
}
