import Link from 'next/link';
import { notFound } from 'next/navigation';

import { guardPage } from '@/server/auth/authorize';
import { getFormulary, getPatientPrescriptions } from '@/server/data-access/prescriptions';
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
  const correctId = typeof sp['correct'] === 'string' ? sp['correct'] : undefined;

  const [view, formulary] = await Promise.all([getPatient(id), getFormulary()]);
  if (!view) notFound();

  const p = view.patient;

  /*
   * Correction. When `?correct=<id>` is present, pre-fill the form from the prescription
   * being replaced so the clinician edits rather than retypes. The original is fetched
   * through the same audited read as the chart — reading it to correct it is a legitimate
   * `prescription.read`. A stale or foreign id simply yields no defaults; the server
   * action re-verifies the supersede target anyway.
   */
  let correcting: { originalId: string; defaults: Record<string, string | number> } | undefined;
  if (correctId) {
    const existing = await getPatientPrescriptions(id);
    const original = existing.find((rx) => rx.id === correctId);
    const line = original?.lines[0];
    if (original && line) {
      correcting = {
        originalId: original.id,
        defaults: {
          medicationId: line.medicationId,
          dose: line.dose ?? '',
          route: line.route ?? 'oral',
          frequency: line.frequency ?? '',
          durationDays: line.durationDays ?? 7,
          quantity: line.quantity ?? '',
          quantityUnit: line.quantityUnit ?? '',
          refills: line.refills,
          instructions: line.instructions ?? '',
          indication: line.indication ?? '',
        },
      };
    }
  }

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
        {...(correcting ? { correcting } : {})}
        formulary={formulary}
      />
    </div>
  );
}
