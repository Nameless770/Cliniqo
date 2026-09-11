'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui';
import { closeTriageAction, type TriageQueueState } from '@/server/actions/triage';

/**
 * Clear one item from the queue.
 *
 * A Client Component only for the pending state and the inline refusal message. It carries
 * two opaque ids and nothing else — no name, no symptom text — so the client bundle holds
 * identifiers rather than PHI.
 */
export function CloseTriageButton({
  conversationId,
  patientId,
}: {
  conversationId: string;
  patientId: string;
}) {
  const [state, action, pending] = useActionState<TriageQueueState, FormData>(
    closeTriageAction,
    {},
  );

  if (state.message && !state.ok) {
    return (
      <span
        role="alert"
        style={{ fontSize: 'var(--text-xs)', color: 'var(--status-danger-text)' }}
      >
        {state.message}
      </span>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="patientId" value={patientId} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Dealt with
      </Button>
    </form>
  );
}
