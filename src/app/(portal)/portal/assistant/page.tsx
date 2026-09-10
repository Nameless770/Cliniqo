import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getMyLatestTriage } from '@/server/portal/triage';
import { getPatientSession } from '@/server/portal/session';

import { AssistantChat } from './AssistantChat';

/**
 * Symptom triage for patients.
 *
 * Guarded by the portal session, like every other page in this group: no session, no page.
 * The conversation is loaded server-side and passed down as turns, so the symptom text
 * reaches the client only as the rendered thread the patient is already looking at.
 *
 * The disclaimer is not decoration. This tells someone where to go for a medical problem,
 * so it has to be unmistakable that nothing here is a diagnosis and no clinician has read
 * it — stated before the input, not buried under it.
 */
export const metadata = { title: 'Check a symptom · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function AssistantPage() {
  const session = await getPatientSession();
  if (!session) redirect('/portal/login');

  const conversation = await getMyLatestTriage();

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href="/portal">← Your appointments</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-2) 0 var(--space-1)' }}>
          Check a symptom
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            lineHeight: 'var(--leading-relaxed)',
            maxWidth: '34em',
          }}
        >
          Describe what is bothering you and this will suggest which of our services to
          book. It is automated — <strong>it is not a diagnosis, and no clinician has read
          it</strong>. If you are worried, book an appointment anyway.
        </p>
      </div>

      <AssistantChat
        conversationId={conversation?.id ?? null}
        turns={conversation?.messages ?? []}
        urgency={conversation?.urgency ?? null}
        specialty={conversation?.recommendedSpecialty ?? null}
      />
    </div>
  );
}
