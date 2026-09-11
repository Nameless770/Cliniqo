import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui';
import { formatDateInZone, formatTimeInZone } from '@/lib/clinic-time';
import { guardPage } from '@/server/auth/authorize';
import { getTriageConversation } from '@/server/data-access/triage';
import { URGENCY_LABELS, type TriageUrgency } from '@/server/triage';

/**
 * One triage conversation, including what the patient actually wrote.
 *
 * THE CLINICAL HALF, and the reason it is a separate page rather than an expandable row on
 * the queue. Guarded on `patient.read.clinical`, which a receptionist does not hold: the
 * front desk needs to know who to book and how soon, and that is all the queue gives them.
 * Reading someone's description of their own body is a different disclosure, and it is
 * audited per record with the patient as subject so "who read my symptoms" is answerable.
 *
 * `guardPage` refuses before any data is fetched, so a receptionist following the link
 * never reaches a query, let alone a rendered word of it.
 */
export const metadata = { title: 'Triage conversation · Cliniqo' };
export const dynamic = 'force-dynamic';

const URGENCY_TONE: Record<TriageUrgency, 'danger' | 'warning' | 'info' | 'neutral'> = {
  emergency: 'danger',
  urgent: 'warning',
  routine: 'info',
  self_care: 'neutral',
};

export default async function TriageConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await guardPage('patient.read.clinical');
  const { id } = await params;

  const conversation = await getTriageConversation(id);
  if (!conversation) notFound();

  const tz = session.clinicTimeZone;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href="/triage">← Triage</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0 0' }}>
          <Link href={`/patients/${conversation.patientId}`}>
            {conversation.patientName}
          </Link>
        </h1>
        <p
          style={{
            margin: 'var(--space-1) 0 0',
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          <Badge tone={conversation.urgency ? URGENCY_TONE[conversation.urgency] : 'neutral'}>
            {conversation.urgency ? URGENCY_LABELS[conversation.urgency] : 'Not assessed'}
          </Badge>
          <span>{conversation.recommendedSpecialty ?? 'No service suggested'}</span>
          <span>
            {formatDateInZone(conversation.createdAt, tz)}{' '}
            {formatTimeInZone(conversation.createdAt, tz)}
          </span>
        </p>
      </div>

      {/*
        Which engine produced the recommendation, stated plainly.
        A clinician reading "go to cardiology" needs to know whether a rule table or a
        language model decided that, and `red-flag` means the emergency path fired and no
        model was consulted at all.
      */}
      <p
        style={{
          margin: 0,
          padding: 'var(--space-2) var(--space-3)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-sunken)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-secondary)',
        }}
      >
        Routed automatically by <strong>{conversation.engine}</strong>. Not a clinical
        assessment, and not reviewed by a clinician before now.
      </p>

      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gap: 'var(--space-3)',
        }}
      >
        {conversation.messages.map((message) => (
          <li key={message.id} style={{ display: 'grid', gap: 'var(--space-1)' }}>
            <span
              style={{
                fontSize: 'var(--text-2xs)',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--text-muted)',
              }}
            >
              {message.role === 'patient' ? 'Patient' : 'Assistant · automated'} ·{' '}
              {formatTimeInZone(message.createdAt, tz)}
            </span>
            <p
              style={{
                margin: 0,
                maxWidth: '44rem',
                padding: 'var(--space-3) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
                background:
                  message.role === 'patient' ? 'var(--bg-surface)' : 'var(--brand-soft)',
                fontSize: 'var(--text-sm)',
                lineHeight: 'var(--leading-relaxed)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {message.body}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
