import Link from 'next/link';
import { notFound } from 'next/navigation';

import { guardPage } from '@/server/auth/authorize';
import { getFormulary } from '@/server/data-access/prescriptions';
import { getPatient } from '@/server/data-access/patients';

import { PrescribeForm } from './PrescribeForm';

/**
 * Issue a prescription, normally reached from an open visit note.
 *
 * Guarded on `prescription.create` - doctor only. An administrator reaching this URL is
 * redirected to /forbidden and the attempt recorded: they may READ prescriptions but
 * never issue one, because prescribing is a licensed act.
 */
export const dynamic = 'force-dynamic';

export default async function PrescribePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPage('prescription.create');
  const { id } = await params;
  const sp = await searchParams;
  const visitNoteId = typeof sp['note'] === 'string' ? sp['note'] : undefined;

  const [view, formulary] = await Promise.all([getPatient(id), getFormulary()]);
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
          Issue prescription
        </h1>
        <p
          style={{
            margin: 'var(--space-1) 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {p.mrn} - born {p.dateOfBirth}
          {visitNoteId ? ' - attached to this visit' : ''}
        </p>
      </div>

      {/*
        Allergies are surfaced here on purpose. Prescribing without seeing them is the
        single highest-consequence mistake this screen can enable, and the clinician
        should not have to navigate away to check.
      */}
      {view.scope === 'full' && view.allergies.length > 0 ? (
        <div
          role="alert"
          style={{
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          <strong>Allergies on file:</strong>{' '}
          {view.allergies
            .map((a) => `${a.allergenName}${a.reaction ? ` (${a.reaction})` : ''}`)
            .join('; ')}
        </div>
      ) : null}

      <PrescribeForm
        patientId={id}
        {...(visitNoteId ? { visitNoteId } : {})}
        formulary={formulary}
      />
    </div>
  );
}
