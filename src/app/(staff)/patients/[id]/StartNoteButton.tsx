'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui';
import { startNoteAction, type NoteFormState } from '@/server/actions/notes';

/**
 * Start a visit note.
 *
 * `startNoteAction` and the whole note editor have existed since Phase 6, but nothing
 * ever called this action — so a note could be edited, signed and amended, while no note
 * could be created. The feature was unreachable. This is the missing caller.
 *
 * Rendered only when the viewer holds `note.create`, which is clinicians only: an
 * administrator can read a note but must not author one, because a note carries a
 * clinical assertion and an author's name. That is presentation — `createNote` re-checks
 * `note.create` server-side, so rendering this for the wrong role would produce a
 * refusal, not a note.
 *
 * No appointment id is passed. The schema makes it nullable precisely so a walk-in can be
 * documented without a prior booking; a note started here is that case.
 */
export function StartNoteButton({ patientId }: { patientId: string }) {
  const [state, action, pending] = useActionState<NoteFormState, FormData>(
    startNoteAction,
    {},
  );

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <input type="hidden" name="patientId" value={patientId} />

      {state.message ? (
        <p
          role={state.ok ? 'status' : 'alert'}
          style={{
            margin: 0,
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: state.ok ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
            color: state.ok ? 'var(--status-success-text)' : 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {state.message}
          {state.ok ? ' It is listed below — open it to write and sign.' : ''}
        </p>
      ) : null}

      <div>
        <Button type="submit" variant="secondary" size="sm" loading={pending}>
          Start visit note
        </Button>
      </div>
    </form>
  );
}
