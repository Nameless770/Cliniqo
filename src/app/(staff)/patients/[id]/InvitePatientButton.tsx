'use client';

import { useActionState, useState } from 'react';

import { Button } from '@/components/ui';
import { invitePatientAction, type InviteFormState } from '@/server/actions/patients';

/**
 * Invite this patient to the self-service portal.
 *
 * The action is gated on `patient.update` server-side (front desk), which also audits the
 * invite. On success the claim link is shown ONCE for staff to hand to the patient — it
 * carries a single-use token and is not stored in the clear, so it cannot be shown again;
 * a fresh invite must be issued if it is lost.
 */
export function InvitePatientButton({ patientId }: { patientId: string }) {
  const [state, action, pending] = useActionState<InviteFormState, FormData>(
    invitePatientAction,
    {},
  );
  const [origin, setOrigin] = useState('');

  // Resolve an absolute link only in the browser; the token never rides in the URL server-side.
  if (typeof window !== 'undefined' && origin === '') {
    setOrigin(window.location.origin);
  }

  if (state.ok && state.claimPath) {
    const link = origin ? `${origin}${state.claimPath}` : state.claimPath;
    return (
      <div
        role="status"
        style={{
          display: 'grid',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--status-success-bg)',
          color: 'var(--status-success-text)',
          fontSize: 'var(--text-sm)',
        }}
      >
        <strong>Portal invite created — give this link to the patient (shown once):</strong>
        <code
          style={{
            wordBreak: 'break-all',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            padding: 'var(--space-2)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {link}
        </code>
      </div>
    );
  }

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <input type="hidden" name="patientId" value={patientId} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Invite to patient portal
      </Button>
      {state.message ? (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--status-danger-text)' }}>
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
