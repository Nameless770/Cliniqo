'use client';

import { useState } from 'react';
import { useActionState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import {
  archivePatientAction,
  unarchivePatientAction,
  type PatientFormState,
} from '@/server/actions/patients';

/**
 * Archive or restore a patient record.
 *
 * Archival is a soft delete — CLAUDE.md rule 4 forbids hard-deleting clinical data — so
 * the record is never removed, only hidden from the default list and blocked from new
 * bookings, notes, and prescriptions. Everything already on it stays readable, and the
 * audit trail is untouched.
 *
 * Two shapes, chosen by `archived`:
 *   - not archived → a reveal that demands a REASON before archiving. A record taken out
 *     of circulation without a recorded why is an unanswerable question at the next audit.
 *   - archived → a one-click restore, shown inside the archived banner.
 *
 * `patient.archive` gates both server-side; this component is only rendered for holders,
 * which is presentation, not the control. The action re-checks.
 */
export function ArchiveControls({
  patientId,
  archived,
}: {
  patientId: string;
  archived: boolean;
}) {
  const [state, action, pending] = useActionState<PatientFormState, FormData>(
    archived ? unarchivePatientAction : archivePatientAction,
    {},
  );
  const [open, setOpen] = useState(false);

  if (archived) {
    return (
      <form action={action} style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <input type="hidden" name="patientId" value={patientId} />
        <Button type="submit" size="sm" variant="secondary" loading={pending}>
          Restore record
        </Button>
        {state.message ? (
          <span role="status" style={{ fontSize: 'var(--text-sm)' }}>
            {state.message}
          </span>
        ) : null}
      </form>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      {!open ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Archive record
        </Button>
      ) : (
        <form
          action={action}
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            padding: 'var(--space-3)',
            background: 'var(--bg-sunken)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <input type="hidden" name="patientId" value={patientId} />
          <Field
            id="archive-reason"
            label="Reason for archiving"
            error={state.errors?.['reason']?.[0]}
          >
            <Input id="archive-reason" name="reason" placeholder="Required" />
          </Field>
          <Button type="submit" size="sm" variant="danger" loading={pending}>
            Archive
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </form>
      )}

      {state.message ? (
        <span
          role={state.ok ? 'status' : 'alert'}
          style={{
            fontSize: 'var(--text-sm)',
            color: state.ok ? undefined : 'var(--status-danger-text)',
          }}
        >
          {state.message}
        </span>
      ) : null}
    </div>
  );
}
