import Link from 'next/link';
import { notFound } from 'next/navigation';

import { guardPage } from '@/server/auth/authorize';
import { exportPatientRecord } from '@/server/data-access/disclosures';

/**
 * Patient record export — HIPAA §164.524, right of access.
 *
 * A printable page rather than a file download, deliberately.
 *
 * A JSON or CSV download would be machine-readable and useless to the person who asked
 * for it. What a patient exercising right of access receives is a document they can read,
 * keep, and hand to another clinician — so the deliverable is a page that prints cleanly.
 * "Print to PDF" is a browser feature; reimplementing it server-side would add a PDF
 * dependency that processes PHI and therefore needs a BAA.
 *
 * Gated on `patient.export`, which is separate from reading the chart: assembling an
 * entire record into something that leaves the building is a disclosure, and it is logged
 * as one event rather than as a scatter of ordinary reads.
 */
export const metadata = { title: 'Patient record · Cliniqo', robots: { index: false } };
export const dynamic = 'force-dynamic';

const sectionStyle = {
  marginTop: 'var(--space-5)',
  breakInside: 'avoid',
} as const;

const h2Style = {
  fontSize: 'var(--text-md)',
  borderBottom: '1px solid var(--border-default)',
  paddingBottom: 'var(--space-1)',
  marginBottom: 'var(--space-2)',
} as const;

export default async function ExportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await guardPage('patient.export');
  const { id } = await params;

  const record = await exportPatientRecord(id);
  if (!record) notFound();

  return (
    <div style={{ maxWidth: '48rem' }}>
      {/* Screen-only chrome. Hidden when printed so the document starts at the title. */}
      <div className="no-print" style={{ marginBottom: 'var(--space-4)' }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href={`/patients/${id}`}>Back to patient</Link>
        </p>
        <p
          style={{
            margin: 'var(--space-2) 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Use your browser&rsquo;s print function to produce a PDF for the patient. This
          disclosure has been recorded in the audit log.
        </p>
      </div>

      <header>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>Patient record</h1>
        <p
          style={{
            margin: 'var(--space-1) 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          {record.clinic} · generated{' '}
          {record.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
        </p>
      </header>

      <section style={sectionStyle}>
        <h2 style={h2Style}>Demographics</h2>
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 'var(--space-1) var(--space-4)',
            margin: 0,
            fontSize: 'var(--text-sm)',
          }}
        >
          {Object.entries(record.demographics).map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
              <dd style={{ margin: 0 }}>{v || '—'}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>Allergies</h2>
        {record.allergies.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>None recorded.</p>
        ) : (
          <ul
            style={{
              margin: 0,
              paddingInlineStart: '1.2rem',
              fontSize: 'var(--text-sm)',
            }}
          >
            {record.allergies.map((a, i) => (
              <li key={i}>
                <strong>{a.allergen}</strong>
                {a.severity ? ` — ${a.severity}` : ''}
                {a.reaction ? ` — ${a.reaction}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {record.flags.length > 0 ? (
        <section style={sectionStyle}>
          <h2 style={h2Style}>Medical flags</h2>
          <ul
            style={{
              margin: 0,
              paddingInlineStart: '1.2rem',
              fontSize: 'var(--text-sm)',
            }}
          >
            {record.flags.map((f, i) => (
              <li key={i}>
                <strong>{f.label}</strong> ({f.severity})
                {f.detail ? ` — ${f.detail}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section style={sectionStyle}>
        <h2 style={h2Style}>Visit notes</h2>
        {record.notes.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>None recorded.</p>
        ) : (
          record.notes.map((n, i) => (
            <article
              key={i}
              style={{ marginBottom: 'var(--space-4)', breakInside: 'avoid' }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-secondary)',
                }}
              >
                {n.author}
                {n.signedAt
                  ? ` · signed ${n.signedAt.toISOString().slice(0, 10)}`
                  : ' · unsigned draft'}
              </p>

              {/*
                EVERY version, oldest first — including superseded ones.
                An export showing only the latest text would present an amended note as
                though it had always said that, which misrepresents the record.
              */}
              {n.versions.map((v) => (
                <div
                  key={v.version}
                  style={{
                    marginTop: 'var(--space-2)',
                    paddingInlineStart: 'var(--space-3)',
                    borderInlineStart: '2px solid var(--border-subtle)',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      color: 'var(--text-muted)',
                      fontSize: 'var(--text-xs)',
                    }}
                  >
                    Version {v.version} · {v.kind} ·{' '}
                    {v.authoredAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </p>
                  {(
                    [
                      ['Chief complaint', v.chiefComplaint],
                      ['Subjective', v.subjective],
                      ['Objective', v.objective],
                      ['Assessment', v.assessment],
                      ['Plan', v.plan],
                    ] as const
                  )
                    .filter(([, value]) => Boolean(value))
                    .map(([label, value]) => (
                      <p key={label} style={{ margin: 'var(--space-1) 0 0' }}>
                        <strong>{label}:</strong> {value}
                      </p>
                    ))}
                </div>
              ))}
            </article>
          ))
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>Prescriptions</h2>
        {record.prescriptions.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>None recorded.</p>
        ) : (
          <ul
            style={{
              margin: 0,
              paddingInlineStart: '1.2rem',
              fontSize: 'var(--text-sm)',
            }}
          >
            {record.prescriptions.map((r, i) => (
              <li key={i}>
                <strong>{r.medication}</strong>
                {r.dose ? ` ${r.dose}` : ''}
                {r.frequency ? `, ${r.frequency}` : ''} — {r.status}
                {r.issuedAt ? ` · ${r.issuedAt.toISOString().slice(0, 10)}` : ''} ·{' '}
                {r.prescriber}
                {r.instructions ? <div>{r.instructions}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>Appointments</h2>
        {record.appointments.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>None recorded.</p>
        ) : (
          <ul
            style={{
              margin: 0,
              paddingInlineStart: '1.2rem',
              fontSize: 'var(--text-sm)',
            }}
          >
            {record.appointments.map((a, i) => (
              <li key={i}>
                {a.when
                  ? a.when.toISOString().slice(0, 16).replace('T', ' ')
                  : 'unscheduled'}{' '}
                — {a.type} with {a.clinician} ({a.status})
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
