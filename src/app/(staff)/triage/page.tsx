import Link from 'next/link';

import { Badge, EmptyState } from '@/components/ui';
import { formatDateInZone, formatTimeInZone } from '@/lib/clinic-time';
import { guardPage } from '@/server/auth/authorize';
import { listTriageQueue } from '@/server/data-access/triage';
import { URGENCY_LABELS, type TriageUrgency } from '@/server/triage';

import { CloseTriageButton } from './CloseTriageButton';

/**
 * The triage queue.
 *
 * Patients have been describing symptoms into their record since the assistant shipped,
 * and until now nothing on the staff side read them. This is the screen that closes that
 * loop — and it is deliberately the SCHEDULING view, not the clinical one.
 *
 * Guarded on `appointment.read`, which every role holds, because deciding who to book and
 * how soon is front-desk work. The symptom text is NOT here: `listTriageQueue` never
 * selects a message body, so a receptionist's page is not a page with the clinical detail
 * hidden — it is a page the clinical detail never reached. Reading what a patient actually
 * wrote needs `patient.read.clinical` and lives one click away.
 */
export const metadata = { title: 'Triage · Cliniqo' };
export const dynamic = 'force-dynamic';

const URGENCY_TONE: Record<TriageUrgency, 'danger' | 'warning' | 'info' | 'neutral'> = {
  emergency: 'danger',
  urgent: 'warning',
  routine: 'info',
  self_care: 'neutral',
};

export default async function TriagePage() {
  const session = await guardPage('appointment.read');
  const queue = await listTriageQueue();
  const tz = session.clinicTimeZone;

  const emergencies = queue.filter((row) => row.urgency === 'emergency').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 0 }}>Triage</h1>
        <p
          style={{
            margin: 'var(--space-1) 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            maxWidth: '46em',
          }}
        >
          What patients have described through the portal, most urgent first. These are the
          patient&rsquo;s own words routed by an automated assistant — not a clinical
          assessment, and nobody has reviewed them until someone here does.
        </p>
      </div>

      {/*
        An emergency in this queue means the patient was already told, on screen and at the
        time, to call an ambulance. It is surfaced here anyway: the assistant cannot know
        whether they did, and a clinic seeing it the same day is the backstop.
      */}
      {emergencies > 0 ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--weight-semibold)',
          }}
        >
          {emergencies} {emergencies === 1 ? 'person' : 'people'} described something the
          assistant treated as an emergency. They were told to call an ambulance — please
          confirm someone has followed up.
        </p>
      ) : null}

      {queue.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="When a patient describes a symptom through the portal, it appears here."
        />
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
          {queue.map((row) => (
            <li
              key={row.id}
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-surface)',
                padding: 'var(--space-3) var(--space-4)',
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <Badge tone={row.urgency ? URGENCY_TONE[row.urgency] : 'neutral'}>
                {row.urgency ? URGENCY_LABELS[row.urgency] : 'Not assessed'}
              </Badge>

              <span style={{ flex: '1 1 14rem', fontSize: 'var(--text-sm)' }}>
                <Link href={`/patients/${row.patientId}`}>
                  <strong>{row.patientName}</strong>
                </Link>{' '}
                <span className="tabular" style={{ color: 'var(--text-muted)' }}>
                  {row.mrn}
                </span>
              </span>

              <span style={{ fontSize: 'var(--text-sm)', flex: '0 1 12rem' }}>
                {row.recommendedSpecialty ?? '—'}
              </span>

              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-muted)',
                  flex: '0 1 9rem',
                }}
              >
                {formatDateInZone(row.createdAt, tz)} {formatTimeInZone(row.createdAt, tz)}
              </span>

              <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                {/*
                  Reading the conversation is a separate, more privileged page. The link is
                  shown to everyone because hiding it is not access control — the page
                  itself refuses a receptionist, which is where the decision belongs.
                */}
                <Link href={`/triage/${row.id}`} style={{ fontSize: 'var(--text-sm)' }}>
                  Read
                </Link>
                <CloseTriageButton conversationId={row.id} patientId={row.patientId} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
