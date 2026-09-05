import Link from 'next/link';

import { EmptyState } from '@/components/ui';

/**
 * 403.
 *
 * Lives inside the `(staff)` group so it renders in the shell with working navigation —
 * a dead-end error page for someone who took one wrong turn is its own small failure.
 *
 * Says nothing about WHAT was refused or what permission would have been needed. That
 * detail is in the audit log, readable by an administrator. Telling the user which
 * permission they lack maps the application's authorization surface for anyone probing
 * it, and a clinician who genuinely needs access gets it faster by asking an
 * administrator than by reading an error string.
 */
export const metadata = { title: 'Not permitted · Cliniqo' };

export default function ForbiddenPage() {
  return (
    <EmptyState
      title="You do not have access to that page"
      description="Your account does not include this capability. If you need it for your work, ask a clinic administrator — the request has been recorded."
      action={
        <Link
          href="/dashboard"
          style={{
            display: 'inline-block',
            padding: 'var(--space-2) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--brand-solid)',
            color: 'var(--brand-text-on-solid)',
            textDecoration: 'none',
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--weight-medium)',
          }}
        >
          Back to dashboard
        </Link>
      }
    />
  );
}
