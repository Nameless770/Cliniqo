'use client';

import { useActionState } from 'react';

import { Badge, Button, Input } from '@/components/ui';
import {
  reviewBreakGlassAction,
  type ComplianceFormState,
} from '@/server/actions/compliance';

export type GrantView = {
  id: string;
  patientMrn: string;
  userName: string;
  reason: string;
  grantedAt: string;
  reviewOutcome: 'pending' | 'justified' | 'not_justified';
};

/**
 * Break-glass review queue.
 *
 * This list IS the safeguard. Emergency access is never refused in the moment, so the
 * entire control is that somebody reads these afterwards and records a judgement.
 */
export function BreakGlassReview({ grants }: { grants: GrantView[] }) {
  const [state, formAction, pending] = useActionState<ComplianceFormState, FormData>(
    reviewBreakGlassAction,
    {},
  );

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {state.message ? (
        <p
          role={state.ok ? 'status' : 'alert'}
          style={{
            margin: 0,
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: state.ok ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
            color: state.ok ? 'var(--status-success-text)' : 'var(--status-danger-text)',
            fontSize: 'var(--text-sm)',
          }}
        >
          {state.message}
        </p>
      ) : null}

      {grants.map((g) => (
        <article
          key={g.id}
          style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-surface)',
            padding: 'var(--space-4)',
            display: 'grid',
            gap: 'var(--space-2)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Badge
              tone={
                g.reviewOutcome === 'pending'
                  ? 'warning'
                  : g.reviewOutcome === 'justified'
                    ? 'success'
                    : 'danger'
              }
            >
              {g.reviewOutcome.replace('_', ' ')}
            </Badge>
            <strong>{g.userName}</strong>
            <span
              style={{
                color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
                fontSize: 'var(--text-sm)',
              }}
            >
              {g.patientMrn} · {g.grantedAt.replace('T', ' ').slice(0, 16)}
            </span>
          </div>

          {/* The clinician's stated reason, verbatim. This is what is being judged. */}
          <blockquote
            style={{
              margin: 0,
              padding: 'var(--space-2) var(--space-3)',
              borderInlineStart: '3px solid var(--border-default)',
              background: 'var(--bg-sunken)',
              fontSize: 'var(--text-sm)',
            }}
          >
            {g.reason}
          </blockquote>

          {g.reviewOutcome === 'pending' ? (
            <form
              action={formAction}
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <input type="hidden" name="grantId" value={g.id} />
              <label className="sr-only" htmlFor={`note-${g.id}`}>
                Review note
              </label>
              <Input
                id={`note-${g.id}`}
                name="note"
                placeholder="Review note (optional)"
                style={{ flex: '1 1 16rem' }}
              />
              <Button
                type="submit"
                name="outcome"
                value="justified"
                size="sm"
                loading={pending}
              >
                Justified
              </Button>
              <Button
                type="submit"
                name="outcome"
                value="not_justified"
                size="sm"
                variant="danger"
                loading={pending}
              >
                Not justified
              </Button>
            </form>
          ) : null}
        </article>
      ))}
    </div>
  );
}
