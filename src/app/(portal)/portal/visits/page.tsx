import Link from 'next/link';
import { redirect } from 'next/navigation';

import { listMyVisitSummaries, type VisitSummaryVersion } from '@/server/portal/notes';
import { getPatientSession } from '@/server/portal/session';

export const metadata = { title: 'Your visit notes · Cliniqo' };
export const dynamic = 'force-dynamic';

/*
 * Plain words for the SOAP headings. The note is shown exactly as written — this only
 * changes what the headings are called, never the text beneath them.
 */
const SECTIONS: { key: keyof VisitSummaryVersion; label: string }[] = [
  { key: 'chiefComplaint', label: 'Reason for visit' },
  { key: 'subjective', label: 'What you told us' },
  { key: 'objective', label: 'What we found' },
  { key: 'assessment', label: 'Assessment' },
  { key: 'plan', label: 'Plan' },
];

function longDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);
}

function VersionBody({ version }: { version: VisitSummaryVersion }) {
  const filled = SECTIONS.filter(({ key }) => {
    const value = version[key];
    return typeof value === 'string' && value.trim().length > 0;
  });

  return (
    <dl style={{ margin: 0, display: 'grid', gap: 'var(--space-3)' }}>
      {filled.map(({ key, label }) => (
        <div key={key}>
          <dt
            style={{
              fontSize: 'var(--text-xs)',
              fontWeight: 'var(--weight-semibold)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
            }}
          >
            {label}
          </dt>
          {/* pre-wrap: clinicians write in lines and lists, and flattening them loses meaning. */}
          <dd style={{ margin: 'var(--space-1) 0 0', whiteSpace: 'pre-wrap' }}>
            {version[key] as string}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The patient's own visit notes.
 *
 * A Server Component: the notes are rendered to HTML on the server and never serialised
 * into a client payload. Everything shown comes from `listMyVisitSummaries`, which reads
 * only this session's patient, only signed notes, and never the text of a withheld one —
 * and records the read in the audit log with the patient as the actor.
 *
 * Fully expanded, not collapsed behind toggles, so printing the page prints the whole record.
 */
export default async function PortalVisitsPage() {
  const session = await getPatientSession();
  if (!session) redirect('/portal/login');

  const { summaries, withheld } = await listMyVisitSummaries();
  const tz = session.clinicTimeZone;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-6)' }}>
      <div>
        <p
          className="no-print"
          style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}
        >
          <Link href="/portal">← Your appointments</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 0 }}>Your visit notes</h1>
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--text-secondary)' }}>
          {session.fullName} · {session.clinicName}
        </p>
      </div>

      <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
        These are the notes your clinicians wrote after your visits. A note appears here
        once it has been signed. If something in a note is wrong, you have the right to
        ask the clinic to correct it — the correction is added to the note, and the
        original stays.
      </p>

      {/*
        Held-back notes are ANNOUNCED, with the only basis the law allows for it, and how to
        challenge it. A patient who is denied access without being told cannot ask for the
        decision to be reviewed, and that request is their right (§164.524(a)(4)).
      */}
      {withheld.map((visit, index) => (
        <p
          key={`withheld-${index}`}
          role="note"
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-warn-bg)',
            color: 'var(--status-warn-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          <strong>A note from your visit on {longDate(visit.visitAt, tz)}</strong> is not
          available online yet. {visit.clinicianName} decided that reading it online now
          could put your health or safety at risk, and would like to talk it through with
          you. You can ask the clinic for a copy, or ask for this decision to be reviewed
          by another clinician.
        </p>
      ))}

      {summaries.length === 0 && withheld.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          You have no visit notes yet. They appear here after a visit, once your clinician
          has signed them.
        </p>
      ) : null}

      {summaries.map((visit, index) => {
        const [original, ...addenda] = visit.versions;
        return (
          <article
            key={`visit-${index}`}
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--bg-surface)',
              padding: 'var(--space-5)',
              display: 'grid',
              gap: 'var(--space-4)',
              breakInside: 'avoid',
            }}
          >
            <header>
              <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>
                {longDate(visit.visitAt, tz)}
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-secondary)',
                }}
              >
                {visit.visitType ? `${visit.visitType} · ` : ''}
                {visit.clinicianName}
              </p>
            </header>

            {original ? <VersionBody version={original} /> : null}

            {/*
              Corrections are shown after the original, never merged into it. The patient
              sees what was written and what was later added — the same history staff see.
            */}
            {addenda.map((addendum, addendumIndex) => (
              <section
                key={`addendum-${addendumIndex}`}
                style={{
                  borderTop: '1px solid var(--border-subtle)',
                  paddingTop: 'var(--space-4)',
                  display: 'grid',
                  gap: 'var(--space-3)',
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: 'var(--text-sm)',
                    fontWeight: 'var(--weight-semibold)',
                  }}
                >
                  Added {longDate(addendum.authoredAt, tz)} by {addendum.authoredByName}
                </p>
                <VersionBody version={addendum} />
              </section>
            ))}
          </article>
        );
      })}
    </div>
  );
}
