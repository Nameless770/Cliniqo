import Link from 'next/link';

import { Badge, EmptyState, Table, TableContainer, Td, Th, Tr } from '@/components/ui';
import { formatDateInZone } from '@/lib/clinic-time';
import { guardPage } from '@/server/auth/authorize';
import {
  listRecentPrescriptions,
  type RecentPrescriptionRow,
} from '@/server/data-access/prescriptions';

/**
 * Recent prescribing activity — the other sidebar link that has 404'd since Phase 7.
 *
 * A Server Component; no prescription data crosses a client boundary.
 *
 * WHY THIS IS THE SHAPE IT IS. A signed prescription can never be edited — a correction
 * is a cancellation plus a replacement pointing back at the original. That model only
 * works if a prescriber can FIND what they issued. Until now the only route to a
 * prescription was the chart of the patient it belongs to, so catching a mistake required
 * already suspecting one.
 *
 * Dose, frequency, quantity and indication are deliberately absent — see the data-access
 * comment. Medication name is enough to recognise an entry; an indication is a diagnosis,
 * and a screenful of them is a bulk disclosure rather than a worklist.
 */
export const metadata = { title: 'Prescriptions · Cliniqo' };
export const dynamic = 'force-dynamic';

function StatusBadge({ row }: { row: RecentPrescriptionRow }) {
  if (row.cancelledAt) return <Badge tone="danger">Cancelled</Badge>;
  if (row.status === 'draft') return <Badge tone="warning">Draft</Badge>;
  return <Badge tone="success">Issued</Badge>;
}

export default async function PrescriptionsPage() {
  const session = await guardPage('prescription.read');
  const recent = await listRecentPrescriptions();
  const timeZone = session.clinicTimeZone;

  const clinicWide = recent.scope === 'clinic';
  const cancelled = recent.rows.filter((r) => r.cancelledAt).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Prescriptions
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Last {recent.windowDays} days · {clinicWide ? 'all prescribers' : 'yours'} ·{' '}
          {recent.rows.length} {recent.rows.length === 1 ? 'entry' : 'entries'}
          {cancelled > 0 ? ` · ${cancelled} cancelled` : ''}
        </p>
      </div>

      <p
        style={{
          margin: 0,
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-sunken)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        A prescription cannot be edited once issued. To correct one, open the patient’s
        chart and issue a correction — the original is cancelled with a reason and the
        replacement records what it supersedes, so both remain visible.
      </p>

      {recent.rows.length === 0 ? (
        <EmptyState
          title="Nothing prescribed recently"
          description={
            clinicWide
              ? `No prescriptions have been issued in the clinic in the last ${recent.windowDays} days.`
              : `You have not issued a prescription in the last ${recent.windowDays} days. Prescriptions are issued from a patient's chart.`
          }
        />
      ) : (
        <TableContainer label="Recent prescriptions">
          <Table caption="Recent prescriptions" captionVisible={false}>
            <thead>
              <Tr>
                <Th>Status</Th>
                <Th>Issued</Th>
                <Th>Patient</Th>
                <Th>MRN</Th>
                <Th>Medication</Th>
                {clinicWide ? <Th>Prescriber</Th> : null}
              </Tr>
            </thead>
            <tbody>
              {recent.rows.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <StatusBadge row={row} />
                  </Td>
                  <Td variant="numeric">{formatDateInZone(row.issuedAt, timeZone)}</Td>
                  <Td>
                    {/* No /prescriptions/[id] route exists — and none should. The
                        prescription only means anything beside the allergies and the rest
                        of the chart, so the link goes there. */}
                    <Link href={`/patients/${row.patientId}`}>{row.patientName}</Link>
                  </Td>
                  <Td variant="identifier">{row.mrn}</Td>
                  <Td>
                    {row.medicationNames.length > 0
                      ? row.medicationNames.join(', ')
                      : '—'}
                    {row.supersedesPrescriptionId ? (
                      <span
                        style={{
                          color: 'var(--text-muted)',
                          fontSize: 'var(--text-xs)',
                        }}
                      >
                        {' '}
                        (replaces an earlier prescription)
                      </span>
                    ) : null}
                  </Td>
                  {clinicWide ? (
                    <Td>
                      {row.prescriberName}
                      {row.prescribedByMe ? (
                        <span
                          style={{
                            color: 'var(--text-muted)',
                            fontSize: 'var(--text-xs)',
                          }}
                        >
                          {' '}
                          (you)
                        </span>
                      ) : null}
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      )}
    </div>
  );
}
