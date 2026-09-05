import Link from 'next/link';

import { Badge, EmptyState, Table, TableContainer, Td, Th, Tr } from '@/components/ui';
import { guardPage } from '@/server/auth/authorize';
import {
  ACCOUNTING_YEARS,
  getDisclosureAccounting,
} from '@/server/data-access/disclosures';
import { notFound } from 'next/navigation';

/**
 * Accounting of disclosures - HIPAA 164.528.
 *
 * Answers "who accessed my record, and when" for a patient who asks, six years back.
 * Administrator only: the person producing this should be the one with oversight of the
 * log, not everyone who can open the chart - otherwise the answer is produced by someone
 * who may appear in it.
 *
 * Printable, because what the patient receives is a document.
 */
export const metadata = { title: 'Disclosure accounting - Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function DisclosuresPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPage('audit.read');
  const { id } = await params;
  const sp = await searchParams;

  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - ACCOUNTING_YEARS);

  const fromParam = typeof sp['from'] === 'string' ? new Date(sp['from']) : null;
  const start = fromParam && !Number.isNaN(fromParam.getTime()) ? fromParam : from;

  const report = await getDisclosureAccounting(id, start, to);
  if (!report) notFound();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href={`/patients/${id}`}>Back to patient</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0' }}>
          Accounting of disclosures
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {report.patientName} - {report.patientMrn}
          <br />
          {start.toISOString().slice(0, 10)} to {to.toISOString().slice(0, 10)} -{' '}
          {report.entries.length} {report.entries.length === 1 ? 'entry' : 'entries'}
          {report.truncated ? ' (truncated - narrow the range)' : ''}
        </p>
      </div>

      {report.entries.length === 0 ? (
        <EmptyState
          title="No recorded access in this period"
          description="Nobody has opened this record in the selected range."
        />
      ) : (
        <TableContainer label="Disclosure accounting">
          <Table caption="Who accessed this record" captionVisible={false}>
            <thead>
              <Tr>
                <Th>When (UTC)</Th>
                <Th>Who</Th>
                <Th>Role</Th>
                <Th>What</Th>
                <Th>Basis</Th>
              </Tr>
            </thead>
            <tbody>
              {report.entries.map((e, i) => (
                <Tr key={i}>
                  <Td variant="numeric">
                    {e.occurredAt.toISOString().replace('T', ' ').slice(0, 19)}
                  </Td>
                  <Td>{e.actorName ?? 'account removed'}</Td>
                  <Td>{e.actorRoles?.join(', ') ?? '-'}</Td>
                  <Td>{e.action}</Td>
                  <Td>
                    {e.viaBreakGlass ? (
                      <Badge tone="danger">Emergency access</Badge>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>Routine</span>
                    )}
                    {e.purpose ? (
                      <div
                        style={{
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {e.purpose}
                      </div>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      )}
    </div>
  );
}
