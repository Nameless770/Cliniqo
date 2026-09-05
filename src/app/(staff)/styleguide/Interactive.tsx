'use client';

import { useState } from 'react';

import { Button, Dialog, Field, Input, Textarea, useToast } from '@/components/ui';

/**
 * The parts of the styleguide that genuinely need state: the dialog and the toasts.
 *
 * Kept in one small island so the styleguide page itself stays a Server Component —
 * the same pattern feature pages should follow, where the server renders the data and
 * only the interactive shell crosses the boundary.
 */
export function InteractiveDemos() {
  const [open, setOpen] = useState(false);
  const [wideOpen, setWideOpen] = useState(false);
  const { show } = useToast();

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <Button onClick={() => setWideOpen(true)}>Open wide dialog</Button>

      <Button
        onClick={() =>
          show({
            tone: 'success',
            title: 'Appointment booked',
            message: 'Record 4821 updated.',
          })
        }
      >
        Success toast
      </Button>
      <Button
        onClick={() =>
          show({
            tone: 'error',
            title: 'Could not save note',
            message: 'The note was edited elsewhere. Reload before retrying.',
          })
        }
      >
        Error toast
      </Button>
      <Button
        onClick={() => show({ tone: 'warning', title: 'Session expires in 2 minutes' })}
      >
        Warning toast
      </Button>
      <Button onClick={() => show({ tone: 'info', title: 'Schedule refreshed' })}>
        Info toast
      </Button>

      <Dialog
        id="demo-dialog"
        open={open}
        onClose={() => setOpen(false)}
        title="Archive patient record"
        description="The record is retained and remains reachable from historical appointments."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setOpen(false);
                show({ tone: 'success', title: 'Record archived' });
              }}
            >
              Archive record
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            Archiving removes the patient from search. Nothing is deleted — clinical data
            is never hard-deleted.
          </p>
          <Field
            id="archive-reason"
            label="Reason for archiving"
            hint="Recorded in the audit log alongside your name."
            required
          >
            <Textarea name="reason" rows={3} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        id="demo-dialog-wide"
        open={wideOpen}
        onClose={() => setWideOpen(false)}
        title="Wide dialog"
        wide
        footer={<Button onClick={() => setWideOpen(false)}>Close</Button>}
      >
        <Field id="demo-wide-input" label="Search" hint="Try Tab and Escape.">
          <Input name="q" placeholder="Focus is trapped inside this dialog" />
        </Field>
      </Dialog>
    </div>
  );
}
