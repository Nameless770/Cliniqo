'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui';
import { portalTriageAction, type PortalTriageState } from '@/server/actions/portal';

export type ChatTurn = { id: string; role: 'patient' | 'assistant'; body: string };

/**
 * The triage thread.
 *
 * A Client Component only for the pending state and to clear the textarea between turns;
 * the messages themselves are rendered from server data and re-fetched by the action's
 * `revalidatePath`, so no PHI is held in client state longer than one submit.
 *
 * The assistant's turns are visually and semantically distinct from a clinician's voice —
 * labelled every time, never styled like a person. A patient must not come away thinking
 * a doctor read this.
 */
export function AssistantChat({
  conversationId,
  turns,
  urgency,
  specialty,
}: {
  conversationId: string | null;
  turns: ChatTurn[];
  urgency: string | null;
  specialty: string | null;
}) {
  const [state, action, pending] = useActionState<PortalTriageState, FormData>(
    portalTriageAction,
    {},
  );

  const isEmergency = urgency === 'emergency';

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {/*
        The emergency banner is rendered from SERVER state, not from the action result,
        so it survives a reload and is still there if the patient comes back to the tab.
        role="alert" so it is announced the moment it appears.
      */}
      {isEmergency ? (
        <div
          role="alert"
          style={{
            border: '2px solid var(--status-danger-text)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-text)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-4) var(--space-5)',
            display: 'grid',
            gap: 'var(--space-1)',
          }}
        >
          <strong style={{ fontSize: 'var(--text-md)' }}>This may be an emergency</strong>
          <span style={{ fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-relaxed)' }}>
            Do not wait for an appointment. Call your local emergency number now.
          </span>
        </div>
      ) : null}

      {turns.length > 0 ? (
        <ol
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 'var(--space-3)',
          }}
        >
          {turns.map((turn) => (
            <li
              key={turn.id}
              style={{
                display: 'grid',
                gap: 'var(--space-1)',
                justifyItems: turn.role === 'patient' ? 'end' : 'start',
              }}
            >
              <span
                style={{
                  fontSize: 'var(--text-2xs)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: 'var(--text-muted)',
                }}
              >
                {turn.role === 'patient' ? 'You' : 'Assistant · automated'}
              </span>
              <p
                style={{
                  margin: 0,
                  maxWidth: '34rem',
                  padding: 'var(--space-3) var(--space-4)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-subtle)',
                  background:
                    turn.role === 'patient' ? 'var(--bg-surface)' : 'var(--brand-soft)',
                  fontSize: 'var(--text-sm)',
                  lineHeight: 'var(--leading-relaxed)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {turn.body}
              </p>
            </li>
          ))}
        </ol>
      ) : null}

      {specialty && !isEmergency ? (
        <p
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-sm)',
          }}
        >
          Suggested service: <strong>{specialty}</strong>.{' '}
          <a href="/portal">Book an appointment</a> — you can choose any visit type, this is
          only a suggestion.
        </p>
      ) : null}

      {state.message ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {state.message}
        </p>
      ) : null}

      <form action={action} style={{ display: 'grid', gap: 'var(--space-2)' }}>
        {conversationId ? (
          <input type="hidden" name="conversationId" value={conversationId} />
        ) : null}
        <label htmlFor="message" style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)' }}>
          {turns.length === 0 ? 'What is going on?' : 'Anything else?'}
        </label>
        <textarea
          id="message"
          name="message"
          rows={4}
          maxLength={2000}
          required
          key={turns.length}
          placeholder="For example: I have had a sore throat for four days and it hurts to swallow."
          aria-describedby="message-hint"
          style={{
            width: '100%',
            padding: 'var(--space-3)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            font: 'inherit',
            fontSize: 'var(--text-sm)',
            resize: 'vertical',
          }}
        />
        {state.errors?.['message']?.[0] ? (
          <span role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--status-danger-text)' }}>
            {state.errors['message'][0]}
          </span>
        ) : null}
        <span id="message-hint" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          Do not include anything you would not want in your medical record — this is saved
          to it.
        </span>
        <div>
          <Button type="submit" variant="primary" loading={pending}>
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
