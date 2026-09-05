import Link from 'next/link';

import { EmptyState } from '@/components/ui';
import { guardPage } from '@/server/auth/authorize';
import { listBreakGlassGrants } from '@/server/data-access/break-glass';

import { BreakGlassReview } from './BreakGlassReview';

/**
 * Emergency-access review. Administrator only (gated on `audit.read`).
 *
 * Deliberately the same permission as the audit log: reviewing emergency access IS audit
 * review, and splitting them would let someone review the grants without being able to
 * check what was actually read under them.
 */
export const metadata = { title: 'Emergency access - Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function BreakGlassPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPage('audit.read');
  const sp = await searchParams;
  const showAll = sp['all'] === '1';

  const grants = await listBreakGlassGrants(!showAll);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Emergency access
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          Clinicians can take access beyond the ordinary limits in an emergency. It is
          never refused in the moment - this queue is the control. HIPAA
          164.312(a)(2)(ii).
        </p>
      </div>

      <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
        {showAll ? (
          <Link href="/break-glass">Show pending only</Link>
        ) : (
          <Link href="/break-glass?all=1">Show all, including reviewed</Link>
        )}
      </p>

      {grants.length === 0 ? (
        <EmptyState
          title={
            showAll ? 'No emergency access has been taken' : 'Nothing awaiting review'
          }
          description="Grants appear here as soon as a clinician takes emergency access."
        />
      ) : (
        <BreakGlassReview
          grants={grants.map((g) => ({
            id: g.id,
            patientMrn: g.patientMrn,
            userName: g.userName,
            reason: g.reason,
            grantedAt: g.grantedAt.toISOString(),
            reviewOutcome: g.reviewOutcome,
          }))}
        />
      )}
    </div>
  );
}
