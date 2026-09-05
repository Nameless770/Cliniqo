'use client';

import { useEffect } from 'react';

import { Button, EmptyState } from '@/components/ui';

/**
 * Error boundary for authenticated routes - security review finding F12.
 *
 * Next already masks server errors in production: the client receives a generic message
 * and a `digest`, never a stack trace. What was missing is a reference the user can quote
 * and an operator can grep for.
 *
 * The digest is that reference. It is a hash Next computes over the server-side error, so
 * it identifies the failure WITHOUT carrying any of its content - no query text, no
 * parameter values, no patient data. Safe to print on screen, read down a phone, and
 * paste into a ticket.
 *
 * Nothing about the error itself is rendered. `error.message` on a caught server error is
 * already sanitised by Next in production, but relying on that is a bet on framework
 * behaviour; not rendering it at all is not.
 */
export default function StaffError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Digest only. The message could carry database detail in development, and this
    // handler runs in the browser where nothing sensitive belongs.
    console.error('[ui] render failed, digest:', error.digest ?? 'none');
  }, [error.digest]);

  return (
    <EmptyState
      title="Something went wrong on our side"
      description={
        error.digest
          ? `The problem has been recorded. Quote reference ${error.digest} if you contact support.`
          : 'The problem has been recorded. Try again, and contact an administrator if it persists.'
      }
      action={
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
