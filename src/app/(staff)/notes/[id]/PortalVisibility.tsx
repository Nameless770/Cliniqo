'use client';

import { useActionState, useState } from 'react';

import { Button, Field, Textarea } from '@/components/ui';
import {
  setNotePortalVisibilityAction,
  type NoteFormState,
} from '@/server/actions/notes';

/**
 * Hide a signed note from the patient's portal, or release it.
 *
 * Receives two ids and whether the note is currently withheld — nothing else. The note's
 * content and the existing reason are rendered by the server page around this component,
 * never passed into it, so no clinical text is serialised into the client payload.
 *
 * Rendered only for holders of `note.sign`, which is presentation. The action re-checks.
 */
export function PortalVisibility({
  noteId,
  patientId,
  withheld,
}: {
  noteId: string;
  patientId: string;
  withheld: boolean;
}) {
  const [state, action, pending] = useActionState<NoteFormState, FormData>(
    setNotePortalVisibilityAction,
    {},
  );
  const [open, setOpen] = useState(false);

  const message = state.message ? (
    <p
      role={state.ok ? 'status' : 'alert'}
      style={{
        margin: 0,
        fontSize: 'var(--text-sm)',
        color: state.ok ? 'var(--status-success-text)' : 'var(--status-danger-text)',
      }}
    >
      {state.message}
    </p>
  ) : null;

  if (withheld) {
    return (
      <form action={action} style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <input type="hidden" name="intent" value="release" />
        <input type="hidden" name="noteId" value={noteId} />
        <input type="hidden" name="patientId" value={patientId} />
        <div>
          <Button type="submit" size="sm" variant="primary" loading={pending}>
            Release to patient portal
          </Button>
        </div>
        {message}
      </form>
    );
  }

  if (!open) {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setOpen(true)}
          >
            Hide from patient portal…
          </Button>
        </div>
        {message}
      </div>
    );
  }

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <input type="hidden" name="intent" value="withhold" />
      <input type="hidden" name="noteId" value={noteId} />
      <input type="hidden" name="patientId" value={patientId} />

      <p
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
      >
        Only when reading this note online now is reasonably likely to put the
        patient&rsquo;s life or safety at risk. The patient will see that a note from this
        visit is held back and that they can ask for the decision to be reviewed.
      </p>

      <Field
        id={`withhold-reason-${noteId}`}
        label="Why this note should not be shown yet"
        required
        hint="Recorded in the audit log for review. The patient does not see this text."
        error={state.errors?.['reason']?.[0]}
      >
        <Textarea name="reason" rows={3} required />
      </Field>

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button type="submit" size="sm" variant="danger" loading={pending}>
          Hide from patient portal
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {message}
    </form>
  );
}
