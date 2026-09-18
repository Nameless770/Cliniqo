'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

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

  /*
   * "Start a new conversation" only stops sending this conversation's id, so the next
   * message opens a new one on the server. The old thread stays in the record, and in the
   * front desk's queue, exactly as it was. The page keys this component on the
   * conversation id, so once the new one exists this resets and shows it.
   */
  const [startingNew, setStartingNew] = useState(false);
  const showThread = !startingNew;

  /* Ready for the next answer: the textarea is re-mounted per turn, so focus it again. */
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (turns.length > 0 || startingNew) input.current?.focus();
  }, [turns.length, startingNew]);

  const isEmergency = showThread && urgency === 'emergency';

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

      {showThread && turns.length > 0 ? (
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

      {showThread && specialty && !isEmergency ? (
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
        {conversationId && showThread ? (
          <input type="hidden" name="conversationId" value={conversationId} />
        ) : null}
        <label htmlFor="message" style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)' }}>
          {turns.length === 0 || startingNew ? 'What is going on?' : 'Your reply'}
        </label>
        <textarea
          id="message"
          name="message"
          ref={input}
          rows={3}
          maxLength={2000}
          required
          key={`${turns.length}-${startingNew}`}
          placeholder={
            turns.length === 0 || startingNew
              ? 'For example: I have had a sore throat for four days and it hurts to swallow.'
              : 'Type your answer'
          }
          aria-describedby="message-hint"
          onKeyDown={(event) => {
            /* Enter sends, as in any chat; Shift+Enter is a new line. Not while an IME is
               composing, where Enter confirms a character rather than the message. */
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!pending && event.currentTarget.value.trim()) {
                event.currentTarget.form?.requestSubmit();
              }
            }
          }}
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
          Press Enter to send, Shift+Enter for a new line. Do not include anything you would
          not want in your medical record — this is saved to it.
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button type="submit" variant="primary" loading={pending}>
            Send
          </Button>
          {turns.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStartingNew((v) => !v)}
            >
              {startingNew ? 'Back to this conversation' : 'Start a new conversation'}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
