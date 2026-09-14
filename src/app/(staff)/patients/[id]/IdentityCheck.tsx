'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui';
import {
  markIdentityVerifiedAction,
  type PatientFormState,
} from '@/server/actions/patients';

/**
 * The button behind the "registered online" banner.
 *
 * Receives the record id and nothing else. The permission check and the audit row are in
 * `markIdentityVerified`; rendering this only for holders of `patient.update` is
 * presentation, not the control.
 */
export function IdentityCheck({ patientId }: { patientId: string }) {
  const [state, action, pending] = useActionState<PatientFormState, FormData>(
    markIdentityVerifiedAction,
    {},
  );

  return (
    <form
      action={action}
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <input type="hidden" name="patientId" value={patientId} />
      <Button type="submit" size="sm" variant="primary" loading={pending}>
        I have checked their photo ID
      </Button>
      {state.message ? (
        <span role={state.ok ? 'status' : 'alert'} style={{ fontSize: 'var(--text-sm)' }}>
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
