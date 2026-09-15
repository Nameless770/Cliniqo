import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EmptyState } from '@/components/ui';
import { guardPage } from '@/server/auth/authorize';
import {
  getMergeProvenance,
  listMergeCandidates,
} from '@/server/data-access/patient-merge';
import { getPatient } from '@/server/data-access/patients';

import { MergeForm } from './MergeForm';

/**
 * Fold a duplicate chart into this one.
 *
 * ==========================================================================
 * ADMINISTRATOR ONLY, AND WHY IT IS NOT THE FRONT DESK
 * ==========================================================================
 *
 * `guardPage('patient.merge')` sends anyone else to /forbidden and audits the refusal.
 * That is defence in depth and UX — the control is `requirePermission` inside the merge
 * itself, which re-checks on every call because a server action is a public endpoint.
 *
 * The front desk is usually who NOTICES a duplicate: they register patients and meet the
 * same person twice. They can see the candidate list, which reads with
 * `patient.read.identifying`. They cannot commit the merge, because moving clinical rows
 * between records — and combining two people's charts if it turns out to be wrong — is a
 * records decision, which practices give to health-information staff. Here `admin` is the
 * records role.
 *
 * The page is reached from the chart, so the surviving record is the one you were already
 * looking at, and the duplicate is chosen. That direction is deliberate: it is much easier
 * to reason about "fold that one into the chart in front of me" than about two rows in a
 * list where either could be the survivor.
 */
export const metadata = { title: 'Merge duplicate chart - Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function MergePage({ params }: { params: Promise<{ id: string }> }) {
  await guardPage('patient.merge');
  const { id } = await params;

  const [chart, candidates, provenance] = await Promise.all([
    getPatient(id),
    listMergeCandidates(id),
    getMergeProvenance(id),
  ]);

  if (!chart) notFound();

  /* Merging INTO a chart that has itself been folded away would build a chain, which the
     database refuses and the reversal logic is built to exclude. Send them to the record
     that actually survives rather than rendering a form that cannot succeed. */
  if (provenance.mergedInto) {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href={`/patients/${id}`}>Back to patient</Link>
        </p>
        <EmptyState
          title="This chart has been merged away"
          description="It cannot absorb another record. Open the chart it was merged into and merge there."
        />
      </div>
    );
  }

  const { patient: record } = chart;
  const survivingName = record.preferredName
    ? `${record.legalLastName}, ${record.preferredName}`
    : `${record.legalLastName}, ${record.legalFirstName}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href={`/patients/${id}`}>Back to patient</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0' }}>
          Merge a duplicate into this chart
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          Surviving record: {survivingName} · {record.mrn}
        </p>
      </div>

      {candidates.length === 0 ? (
        <EmptyState
          title="No likely duplicates"
          description="Nothing else in this clinic shares this patient's surname and date of birth. Duplicates that differ in both are not offered here — merging the wrong pair is worse than missing one."
        />
      ) : (
        <MergeForm
          survivingPatientId={id}
          survivingName={survivingName}
          survivingMrn={record.mrn}
          candidates={candidates}
        />
      )}
    </div>
  );
}
