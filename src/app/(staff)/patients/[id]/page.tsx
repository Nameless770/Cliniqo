import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, EmptyState } from '@/components/ui';
import { APPOINTMENT_STATUS_LABELS } from '@/lib/appointment-schemas';
import { NOTE_STATUS_LABELS, VERSION_KIND_LABELS } from '@/lib/note-schemas';
import { PRESCRIPTION_STATUS_LABELS } from '@/lib/prescription-schemas';
import { formatDateInZone, formatTimeInZone } from '@/lib/clinic-time';
import { can } from '@/lib/permissions';
import { guardPage } from '@/server/auth/authorize';
import { getPatientAppointments } from '@/server/data-access/appointments';
import { listAllergies, listFlags } from '@/server/data-access/clinical-facts';
import { getPatientNotes } from '@/server/data-access/notes';
import { getPatient } from '@/server/data-access/patients';
import { getPatientPrescriptions } from '@/server/data-access/prescriptions';

import { BreakGlassButton } from './BreakGlassButton';
import { ClinicalFacts } from './ClinicalFacts';
import { ArchiveControls } from './ArchiveControls';
import { InvitePatientButton } from './InvitePatientButton';
import { PrescriptionActions } from './PrescriptionActions';
import { StartNoteButton } from './StartNoteButton';

/**
 * Patient profile.
 *
 * A Server Component throughout. Nothing here crosses a client boundary, so no patient
 * field is serialised into the page payload beyond what is rendered as HTML.
 *
 * The clinical section is not conditionally hidden — for a receptionist it does not exist
 * in the returned object at all, and TypeScript will not let this file read it without
 * narrowing on `view.scope === 'full'`. The SQL for a receptionist never selected those
 * columns and never issued the allergy or flag queries.
 */
export const dynamic = 'force-dynamic';

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: 'grid', gap: '2px' }}>
      <dt
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 'var(--text-base)' }}>{value || '—'}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--bg-surface)',
        padding: 'var(--space-5)',
      }}
    >
      <h2
        style={{
          fontSize: 'var(--text-md)',
          marginBottom: 'var(--space-4)',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
  gap: 'var(--space-4)',
} as const;

export default async function PatientProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await guardPage('patient.read.identifying');
  const { id } = await params;

  // Both reads are audited with subjectPatientId = id, before anything renders.
  const mayReadNotes = can(session.permissions, 'note.read');
  const mayReadRx = can(session.permissions, 'prescription.read');
  const mayPrescribe = can(session.permissions, 'prescription.create');
  const mayEditClinical = can(session.permissions, 'patient.update.clinical');
  const mayWriteNotes = can(session.permissions, 'note.create');

  /*
   * The note query is CONDITIONAL on the permission — not fetched-then-hidden.
   * For a receptionist no SELECT against visit_note is ever issued, so note text cannot
   * reach this page's memory, its HTML, or a screenshot of it.
   */
  const [view, appointments, notes, prescriptions, allAllergies, allFlags] =
    await Promise.all([
      getPatient(id),
      getPatientAppointments(id, 10),
      mayReadNotes ? getPatientNotes(id) : Promise.resolve([]),
      // Conditional on the grant — a receptionist's request issues no prescription query.
      mayReadRx ? getPatientPrescriptions(id) : Promise.resolve([]),
      // Full allergy/flag history — including withdrawn entries — only for clinicians who
      // can act on it. The chart's own banner uses the narrower active-only projection.
      mayEditClinical ? listAllergies(id) : Promise.resolve([]),
      mayEditClinical ? listFlags(id) : Promise.resolve([]),
    ]);

  if (!view) notFound();

  const p = view.patient;
  const mayEdit = can(session.permissions, 'patient.update');
  const mayBook = can(session.permissions, 'appointment.create');
  const mayBill = can(session.permissions, 'billing.create');
  const mayExport = can(session.permissions, 'patient.export');
  const mayAudit = can(session.permissions, 'audit.read');
  const mayBreakGlass = can(session.permissions, 'breakglass.use');
  const mayArchive = can(session.permissions, 'patient.archive');
  const timeZone = session.clinicTimeZone;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            <Link href="/patients">Patients</Link>
          </p>
          <h1
            style={{
              fontSize: 'var(--text-xl)',
              margin: 'var(--space-1) 0',
            }}
          >
            {p.legalLastName}, {p.legalFirstName} {p.legalMiddleName ?? ''}
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {p.mrn} · born {p.dateOfBirth}
            {p.preferredName ? ` · known as ${p.preferredName}` : ''}
            {p.pronouns ? ` · ${p.pronouns}` : ''}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {mayBook && !p.archivedAt ? (
            <Link
              href={`/patients/${id}/book`}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--brand-solid)',
                color: 'var(--brand-text-on-solid)',
                textDecoration: 'none',
                fontSize: 'var(--text-sm)',
                fontWeight: 'var(--weight-medium)',
              }}
            >
              Book appointment
            </Link>
          ) : null}
          {mayBill && !p.archivedAt ? (
            <Link
              href={`/patients/${id}/invoice/new`}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-default)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                textDecoration: 'none',
                fontSize: 'var(--text-sm)',
              }}
            >
              New invoice
            </Link>
          ) : null}
          {mayEdit && !p.archivedAt ? (
            <Link
              href={`/patients/${id}/edit`}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-default)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                textDecoration: 'none',
                fontSize: 'var(--text-sm)',
              }}
            >
              Edit
            </Link>
          ) : null}

          {/* §164.524 — right of access. Separate permission from reading the chart. */}
          {mayExport ? (
            <Link
              href={`/patients/${id}/export`}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-default)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                textDecoration: 'none',
                fontSize: 'var(--text-sm)',
              }}
            >
              Export record
            </Link>
          ) : null}

          {/* §164.528 — accounting of disclosures. Admin only, like the log itself. */}
          {mayAudit ? (
            <Link
              href={`/patients/${id}/disclosures`}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-default)',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                textDecoration: 'none',
                fontSize: 'var(--text-sm)',
              }}
            >
              Who accessed this
            </Link>
          ) : null}
        </div>
      </div>

      {mayBreakGlass ? <BreakGlassButton patientId={id} /> : null}

      {p.archivedAt ? (
        <p
          role="status"
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-warn-bg)',
            color: 'var(--status-warn-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          This record is archived. {p.archiveReason ?? ''}
        </p>
      ) : null}

      {mayArchive && p.archivedAt ? (
        <ArchiveControls patientId={id} archived={true} />
      ) : null}

      {/*
        CLINICAL SECTION.
        Reachable only when the data layer returned scope 'full'. A receptionist's
        `view` is narrowed to the identifying variant, so this branch is unreachable and
        the fields it reads do not exist on that type.
      */}
      {view.scope === 'full' && mayEditClinical ? (
        <Section title="Allergies and medical flags">
          <ClinicalFacts
            patientId={id}
            allergies={allAllergies.map((a) => ({
              id: a.id,
              allergenType: a.allergenType,
              allergenName: a.allergenName,
              reaction: a.reaction,
              severity: a.severity,
              status: a.status,
              recordedByName: a.recordedByName,
            }))}
            flags={allFlags.map((f) => ({
              id: f.id,
              flagType: f.flagType,
              label: f.label,
              detail: f.detail,
              severity: f.severity,
              validTo: f.validTo,
            }))}
          />
        </Section>
      ) : view.scope === 'full' ? (
        <Section title="Allergies and medical flags">
          {view.allergies.length === 0 && view.flags.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              No allergies or flags recorded.{' '}
              <strong>This is not the same as none being present</strong> — confirm with
              the patient.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              {view.allergies.map((a) => (
                <div
                  key={a.id}
                  style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
                >
                  <Badge
                    tone={
                      a.severity === 'life_threatening' || a.severity === 'severe'
                        ? 'danger'
                        : 'warning'
                    }
                  >
                    {a.severity ?? 'unknown severity'}
                  </Badge>
                  <span>
                    <strong>{a.allergenName}</strong>
                    {a.reaction ? ` — ${a.reaction}` : ''}
                  </span>
                </div>
              ))}

              {view.flags.map((f) => (
                <div
                  key={f.id}
                  style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
                >
                  <Badge tone={f.severity === 'critical' ? 'danger' : 'info'}>
                    {f.flagType.replace(/_/g, ' ')}
                  </Badge>
                  <span>
                    <strong>{f.label}</strong>
                    {f.detail ? ` — ${f.detail}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      ) : (
        <EmptyState
          title="Clinical information is not shown for your role"
          description="Allergies, medical flags, and clinical fields are restricted to clinicians. This is a minimum-necessary boundary, not a display setting — the data was never sent to this page."
        />
      )}

      {mayReadNotes ? (
        <Section title="Visit notes">
          {mayWriteNotes ? <StartNoteButton patientId={id} /> : null}
          {notes.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              No visit notes recorded.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              {notes.map((note) => (
                <article
                  key={note.id}
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-3) var(--space-4)',
                  }}
                >
                  <header
                    style={{
                      display: 'flex',
                      gap: 'var(--space-2)',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      marginBottom: 'var(--space-2)',
                    }}
                  >
                    <Badge tone={note.status === 'draft' ? 'warning' : 'success'}>
                      {NOTE_STATUS_LABELS[note.status]}
                    </Badge>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>
                      {note.authorName}
                    </strong>
                    <span
                      style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}
                    >
                      {note.versions.length} version
                      {note.versions.length === 1 ? '' : 's'}
                    </span>
                    <Link
                      href={`/notes/${note.id}?patient=${id}`}
                      style={{ fontSize: 'var(--text-sm)', marginInlineStart: 'auto' }}
                    >
                      Open
                    </Link>
                  </header>

                  {/*
                    READ-ONLY version history. Every version is listed, oldest first,
                    including superseded ones — that is the entire point of the model:
                    an amendment appends, it never overwrites, so the record shows what
                    was written and when it changed.
                  */}
                  <ol
                    style={{
                      margin: 0,
                      paddingInlineStart: '1.1rem',
                      display: 'grid',
                      gap: 'var(--space-2)',
                    }}
                  >
                    {note.versions.map((v) => (
                      <li key={v.id} style={{ fontSize: 'var(--text-sm)' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          v{v.versionNumber} · {VERSION_KIND_LABELS[v.kind]} ·{' '}
                          {v.authoredByName} ·{' '}
                          {v.authoredAt.toISOString().slice(0, 16).replace('T', ' ')}
                          {v.frozenAt ? ' · frozen' : ' · editable'}
                        </span>
                        {v.assessment ? (
                          <div style={{ marginTop: '2px' }}>{v.assessment}</div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>
          )}
        </Section>
      ) : null}

      {mayReadRx ? (
        <Section title="Prescriptions">
          {mayPrescribe && !p.archivedAt ? (
            <p style={{ margin: '0 0 var(--space-3)' }}>
              <Link
                href={`/patients/${id}/prescribe`}
                style={{ fontSize: 'var(--text-sm)' }}
              >
                Issue a prescription
              </Link>
            </p>
          ) : null}

          {prescriptions.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              No prescriptions recorded.
            </p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 'var(--space-3)',
              }}
            >
              {prescriptions.map((rx) => (
                <li
                  key={rx.id}
                  style={{
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-3) var(--space-4)',
                    opacity: rx.status === 'cancelled' ? 0.7 : 1,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      gap: 'var(--space-2)',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      marginBottom: 'var(--space-1)',
                    }}
                  >
                    <Badge tone={rx.status === 'cancelled' ? 'neutral' : 'success'}>
                      {PRESCRIPTION_STATUS_LABELS[rx.status]}
                    </Badge>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>
                      {rx.lines.map((l) => l.medicationName).join(', ')}
                    </strong>
                    <span
                      style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}
                    >
                      {rx.prescriberName}
                      {rx.signedAt ? ` · ${rx.signedAt.toISOString().slice(0, 10)}` : ''}
                    </span>
                  </div>

                  {rx.lines.map((l, i) => (
                    <div key={i} style={{ fontSize: 'var(--text-sm)' }}>
                      {l.dose} {l.route} · {l.frequency} · {l.durationDays} days · qty{' '}
                      {l.quantity} {l.quantityUnit}
                      {l.refills > 0 ? ` · ${l.refills} refills` : ''}
                      {l.instructions ? ` — ${l.instructions}` : ''}
                    </div>
                  ))}

                  {/*
                    The correction chain, made visible. A cancelled entry keeps its
                    reason, and a replacement names what it superseded — that pairing is
                    the whole point of never editing in place.
                  */}
                  {rx.cancellationReason ? (
                    <p
                      style={{
                        margin: 'var(--space-2) 0 0',
                        fontSize: 'var(--text-xs)',
                        color: 'var(--status-warn-text)',
                      }}
                    >
                      Cancelled: {rx.cancellationReason}
                    </p>
                  ) : null}
                  {rx.supersedesPrescriptionId ? (
                    <p
                      style={{
                        margin: 'var(--space-1) 0 0',
                        fontSize: 'var(--text-xs)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      Replaces an earlier prescription in this list.
                    </p>
                  ) : null}

                  {/*
                    Cancel / correct, only for a LIVE prescription a prescriber can act on.
                    A cancelled one is already history; a draft has no separate flow here;
                    an archived patient takes no new clinical writes.
                  */}
                  {mayPrescribe &&
                  !p.archivedAt &&
                  (rx.status === 'signed' || rx.status === 'printed') ? (
                    <PrescriptionActions patientId={id} prescriptionId={rx.id} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      <Section title="Appointments">
        {appointments.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            No appointments recorded.
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 'var(--space-2)',
            }}
          >
            {appointments.map((a) => (
              <li
                key={a.id}
                style={{
                  display: 'flex',
                  gap: 'var(--space-3)',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: '11rem' }}>
                  {formatDateInZone(a.startsAt, timeZone)}{' '}
                  {formatTimeInZone(a.startsAt, timeZone)}
                </span>
                <span style={{ flex: '1 1 10rem' }}>
                  {a.typeName} · {a.providerName}
                </span>
                <Badge
                  tone={
                    a.status === 'completed'
                      ? 'success'
                      : a.status === 'no_show'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {APPOINTMENT_STATUS_LABELS[a.status]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Contact">
        <dl style={grid}>
          <Row label="Phone" value={p.phonePrimary} />
          <Row label="Alternate phone" value={p.phoneSecondary} />
          <Row label="Email" value={p.email} />
          <Row label="Preferred language" value={p.preferredLanguage} />
          <Row
            label="Address"
            value={[p.addressLine1, p.addressLine2, p.city, p.state, p.postalCode]
              .filter(Boolean)
              .join(', ')}
          />
        </dl>
      </Section>

      <Section title="Emergency contact">
        <dl style={grid}>
          <Row label="Name" value={p.emergencyContactName} />
          <Row label="Phone" value={p.emergencyContactPhone} />
          <Row label="Relationship" value={p.emergencyContactRelationship} />
        </dl>
      </Section>

      <Section title="Demographics">
        <dl style={grid}>
          <Row label="Gender identity" value={p.genderIdentity} />
          {view.scope === 'full' ? (
            <>
              <Row
                label="Sex assigned at birth"
                value={view.patient.sexAssignedAtBirth}
              />
              <Row label="Deceased" value={view.patient.deceasedDate} />
            </>
          ) : null}
          <Row
            label="Privacy notice acknowledged"
            value={
              p.nppAcknowledgedAt ? p.nppAcknowledgedAt.toISOString().slice(0, 10) : null
            }
          />
        </dl>
      </Section>

      {/*
        Administrative footer. Archival is destructive-ish and rare, so it sits at the
        bottom away from the everyday actions — a record is taken out of circulation, not
        deleted (CLAUDE.md rule 4). Only shown to holders of `patient.archive`, and only
        when the record is still active.
      */}
      {(mayArchive || mayEdit) && !p.archivedAt ? (
        <section
          style={{
            marginTop: 'var(--space-4)',
            paddingTop: 'var(--space-4)',
            borderTop: '1px solid var(--border-subtle)',
            display: 'grid',
            gap: 'var(--space-4)',
          }}
        >
          <h2
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
              margin: 0,
            }}
          >
            Administration
          </h2>
          {mayEdit ? <InvitePatientButton patientId={id} /> : null}
          {mayArchive ? <ArchiveControls patientId={id} archived={false} /> : null}
        </section>
      ) : null}
    </div>
  );
}
