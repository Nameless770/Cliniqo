'use client';

import { useActionState } from 'react';

import { Button, Field, Textarea, Input } from '@/components/ui';
import {
  addAddendumAction,
  submitNoteAction,
  type NoteFormState,
} from '@/server/actions/notes';

/**
 * Note editor.
 *
 * A Client Component, and the ONE place clinical free text crosses into client code. That
 * is unavoidable for a textarea — but it is reached only by callers the server has already
 * authorized: the page above it is guarded on `note.read`/`note.create`, and every action
 * it posts to re-checks independently.
 *
 * It receives the current version's content and nothing else: no patient record, no
 * allergies, no other notes.
 */

const fieldHints = {
  chiefComplaint: 'Why the patient came in, in their words',
  subjective: 'What the patient reports',
  objective: 'What you observed and measured',
  assessment: 'Your clinical impression',
  plan: 'What happens next',
} as const;

export function NoteEditor({
  noteId,
  patientId,
  version,
  mode,
  defaults,
}: {
  noteId: string;
  patientId: string;
  version: number;
  /** `draft` edits in place; `addendum` appends to a signed note. */
  mode: 'draft' | 'addendum';
  defaults?: Partial<Record<keyof typeof fieldHints, string>>;
}) {
  const action = mode === 'draft' ? submitNoteAction : addAddendumAction;
  const [state, formAction, pending] = useActionState<NoteFormState, FormData>(
    action,
    {},
  );

  const err = (f: string) => state.errors?.[f]?.[0];
  const banner = state.message;
  const bannerOk = state.ok;

  const fields = (
    <>
      <input type="hidden" name="noteId" value={noteId} />
      <input type="hidden" name="patientId" value={patientId} />
      <input type="hidden" name="version" value={version} />

      <Field
        id="chiefComplaint"
        label="Chief complaint"
        hint={fieldHints.chiefComplaint}
        error={err('chiefComplaint')}
      >
        <Input name="chiefComplaint" defaultValue={defaults?.chiefComplaint ?? ''} />
      </Field>

      {(['subjective', 'objective', 'assessment', 'plan'] as const).map((f) => (
        <Field
          key={f}
          id={f}
          label={f[0]!.toUpperCase() + f.slice(1)}
          hint={fieldHints[f]}
          error={err(f)}
        >
          <Textarea name={f} rows={5} defaultValue={defaults?.[f] ?? ''} />
        </Field>
      ))}
    </>
  );

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {banner ? (
        <p
          role={bannerOk ? 'status' : 'alert'}
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: bannerOk ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
            color: bannerOk ? 'var(--status-success-text)' : 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {banner}
        </p>
      ) : null}

      {mode === 'addendum' ? (
        <p
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-info-bg)',
            color: 'var(--status-info-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          This note is signed. Your text is added as an <strong>addendum</strong> — the
          original version stays in the record exactly as signed.
        </p>
      ) : null}

      {/*
        ONE form, two submit buttons distinguished by `intent`. Signing therefore always
        commits exactly what is on screen — it cannot freeze a stale version.

        Signing is still a separate PERMISSION server-side (`note.sign`, not
        `note.create`), because attesting that content is accurate is a different act
        from writing it.
      */}
      <form action={formAction} style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {fields}

        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button
            type="submit"
            name="intent"
            value="save"
            variant="secondary"
            loading={pending}
          >
            {mode === 'draft' ? 'Save draft' : 'Add addendum'}
          </Button>

          {mode === 'draft' ? (
            <Button
              type="submit"
              name="intent"
              value="sign"
              variant="primary"
              loading={pending}
            >
              Sign note
            </Button>
          ) : null}
        </div>

        {mode === 'draft' ? (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            Signing saves what is on screen and commits it to the legal record. After
            signing, corrections are added as addenda and the original cannot be changed.
          </p>
        ) : null}
      </form>
    </div>
  );
}
