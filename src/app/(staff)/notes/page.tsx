import Link from 'next/link';

import { Badge, EmptyState, Table, TableContainer, Td, Th, Tr } from '@/components/ui';
import { formatDateInZone } from '@/lib/clinic-time';
import { guardPage } from '@/server/auth/authorize';
import { listUnsignedNotes } from '@/server/data-access/notes';

/**
 * Unsigned visit notes — the work queue the sidebar has linked to since Phase 6.
 *
 * A Server Component. Patient names are rendered on the server and never serialised into
 * a client payload; there is no Client Component on this page at all.
 *
 * NO NOTE CONTENT IS FETCHED OR SHOWN. The query selects who, which patient, and when —
 * never chief complaint, assessment, or plan. A hundred clinical summaries on one screen
 * would be a bulk disclosure dressed up as a worklist. Opening a note writes its own
 * per-patient `note.read` audit row, which is where the attributable trail comes from.
 *
 * Scope is decided server-side in `listUnsignedNotes` and reported back, not requested:
 * clinicians see their own drafts, administrators with `audit.read` see the clinic.
 */
export const metadata = { title: 'Unsigned notes · Cliniqo' };
export const dynamic = 'force-dynamic';

/** Whole days elapsed. Age is the entire signal here — a 40-day draft is the problem. */
function daysSince(instant: Date): number {
  return Math.max(0, Math.floor((Date.now() - instant.getTime()) / 86_400_000));
}

function AgeCell({ startedAt }: { startedAt: Date }) {
  const days = daysSince(startedAt);

  // Thresholds are a prompt to act, not a clinical or billing rule. Most payers work to
  // much tighter windows; a clinic should tune these to its own policy.
  const tone = days >= 14 ? 'danger' : days >= 3 ? 'warning' : 'neutral';
  const label = days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;

  return <Badge tone={tone}>{label}</Badge>;
}

export default async function UnsignedNotesPage() {
  const session = await guardPage('note.read');
  const queue = await listUnsignedNotes();
  const timeZone = session.clinicTimeZone;

  const clinicWide = queue.scope === 'clinic';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Unsigned notes
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {queue.rows.length} {queue.rows.length === 1 ? 'draft' : 'drafts'} ·{' '}
          {clinicWide ? 'all clinicians' : 'yours'}
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
        A draft is not part of the medical record. It does not appear to the next
        clinician, is excluded from a record export, and cannot be billed.
        {clinicWide
          ? ' You are seeing every clinician’s drafts because you hold audit access; only their author can sign one.'
          : ' Only you can sign yours.'}
      </p>

      {queue.rows.length === 0 ? (
        <EmptyState
          title={clinicWide ? 'Nothing unsigned' : 'Nothing waiting on you'}
          description={
            clinicWide
              ? 'Every visit note in the clinic has been signed.'
              : 'Every note you have started has been signed. Notes you begin will appear here until you sign them.'
          }
        />
      ) : (
        <TableContainer label="Unsigned visit notes">
          <Table caption="Unsigned notes" captionVisible={false}>
            <thead>
              <Tr>
                <Th>Age</Th>
                <Th>Patient</Th>
                <Th>MRN</Th>
                {clinicWide ? <Th>Author</Th> : null}
                <Th>Started</Th>
                <Th>Last edited</Th>
              </Tr>
            </thead>
            <tbody>
              {queue.rows.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <AgeCell startedAt={row.startedAt} />
                  </Td>
                  <Td>
                    {/* Links to the note, not the chart: signing is the action here. */}
                    <Link href={`/notes/${row.id}?patient=${row.patientId}`}>
                      {row.patientName}
                    </Link>
                  </Td>
                  <Td variant="identifier">{row.mrn}</Td>
                  {clinicWide ? (
                    <Td>
                      {row.authorName}
                      {row.authoredByMe ? (
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
                  <Td variant="numeric">{formatDateInZone(row.startedAt, timeZone)}</Td>
                  <Td variant="numeric">
                    {formatDateInZone(row.lastTouchedAt, timeZone)}
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
