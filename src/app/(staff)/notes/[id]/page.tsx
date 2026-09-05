import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui';
import { NOTE_STATUS_LABELS } from '@/lib/note-schemas';
import { guardPage } from '@/server/auth/authorize';
import { getNote } from '@/server/data-access/notes';

import { NoteEditor } from '../NoteEditor';

/**
 * Write or amend a visit note.
 *
 * Guarded on `note.read`. A receptionist reaching this URL is redirected to /forbidden and
 * the attempt is recorded - they hold no note permission at all, so the guard denies
 * before any note column is queried.
 *
 * `patientId` comes from the query string and is VERIFIED against the note inside the
 * data layer: a mismatched pair returns null rather than silently auditing the read
 * against the wrong person.
 */
export const dynamic = 'force-dynamic';

export default async function NotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await guardPage('note.read');
  const { id } = await params;
  const sp = await searchParams;
  const patientId = typeof sp['patient'] === 'string' ? sp['patient'] : '';

  if (!patientId) notFound();

  const note = await getNote(id, patientId);
  if (!note) notFound();

  const current = note.versions[note.versions.length - 1];
  const isDraft = note.status === 'draft';
  const mayWrite = session.permissions.has('note.create');
  const mayAmend = session.permissions.has('note.amend');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href={`/patients/${note.patientId}`}>Back to patient</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0' }}>
          Visit note
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          <Badge tone={isDraft ? 'warning' : 'success'}>
            {NOTE_STATUS_LABELS[note.status]}
          </Badge>{' '}
          started by {note.authorName} - version {note.versions.length}
        </p>
      </div>

      {isDraft && mayWrite ? (
        <NoteEditor
          noteId={note.id}
          patientId={note.patientId}
          version={note.rowVersion}
          mode="draft"
          defaults={{
            chiefComplaint: current?.chiefComplaint ?? '',
            subjective: current?.subjective ?? '',
            objective: current?.objective ?? '',
            assessment: current?.assessment ?? '',
            plan: current?.plan ?? '',
          }}
        />
      ) : !isDraft && mayAmend ? (
        <NoteEditor
          noteId={note.id}
          patientId={note.patientId}
          version={note.rowVersion}
          mode="addendum"
        />
      ) : (
        <p style={{ color: 'var(--text-secondary)' }}>
          You can read this note but not change it.
        </p>
      )}
    </div>
  );
}
