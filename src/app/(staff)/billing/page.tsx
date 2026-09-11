import Link from 'next/link';

import { Badge, EmptyState } from '@/components/ui';
import { INVOICE_STATUS_LABELS, formatMoney } from '@/lib/billing-schemas';
import { formatDateInZone } from '@/lib/clinic-time';
import { guardPage } from '@/server/auth/authorize';
import { listInvoices } from '@/server/data-access/billing';

/**
 * The billing worklist.
 *
 * Guarded on `billing.read`, which `admin` and `receptionist` hold and `doctor` does not.
 * That exclusion is the one thing about this screen worth stating twice: a clinician is
 * refused here by the same guard that refuses a receptionist a clinical note, and for a
 * symmetrical reason. Knowing what a patient owes is not an input to treating them.
 *
 * Defaults to outstanding rather than everything — the question the front desk actually
 * has is "who owes us money", and a full ledger answers a different one.
 */
export const metadata = { title: 'Billing · Cliniqo' };
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  draft: 'neutral',
  issued: 'warning',
  paid: 'success',
  void: 'danger',
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await guardPage('billing.read');
  const { scope } = await searchParams;
  const showAll = scope === 'all';

  const invoices = await listInvoices(showAll ? 'all' : 'outstanding');
  const tz = session.clinicTimeZone;

  const outstandingTotal = invoices.reduce((sum, row) => sum + row.outstandingCents, 0);
  const currency = invoices[0]?.currency ?? 'USD';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ fontSize: 'var(--text-xl)', margin: 0 }}>Billing</h1>
          <p
            style={{
              margin: 'var(--space-1) 0 0',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            {showAll ? 'Every invoice.' : 'Issued invoices awaiting payment.'}{' '}
            <Link href={showAll ? '/billing' : '/billing?scope=all'}>
              {showAll ? 'Show outstanding only' : 'Show all'}
            </Link>
          </p>
        </div>

        {!showAll && invoices.length > 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            Outstanding:{' '}
            <strong className="tabular">{formatMoney(outstandingTotal, currency)}</strong>
          </p>
        ) : null}
      </div>

      {invoices.length === 0 ? (
        <EmptyState
          title={showAll ? 'No invoices yet' : 'Nothing outstanding'}
          description="Raise an invoice from a patient's record."
        />
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 'var(--space-2)',
          }}
        >
          {invoices.map((row) => (
            <li
              key={row.id}
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-surface)',
                padding: 'var(--space-3) var(--space-4)',
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>
                {INVOICE_STATUS_LABELS[row.status] ?? row.status}
              </Badge>

              <Link
                href={`/billing/${row.id}`}
                className="tabular"
                style={{ fontSize: 'var(--text-sm)', flex: '0 0 5rem' }}
              >
                #{row.number}
              </Link>

              <span style={{ flex: '1 1 12rem', fontSize: 'var(--text-sm)' }}>
                {row.patientName}{' '}
                <span className="tabular" style={{ color: 'var(--text-muted)' }}>
                  {row.mrn}
                </span>
              </span>

              <span
                className="tabular"
                style={{ fontSize: 'var(--text-sm)', flex: '0 1 7rem', textAlign: 'right' }}
              >
                {formatMoney(row.totalCents, row.currency)}
              </span>

              <span
                className="tabular"
                style={{
                  fontSize: 'var(--text-sm)',
                  flex: '0 1 7rem',
                  textAlign: 'right',
                  fontWeight: row.outstandingCents > 0 ? 'var(--weight-semibold)' : undefined,
                }}
              >
                {row.outstandingCents > 0
                  ? formatMoney(row.outstandingCents, row.currency)
                  : '—'}
              </span>

              <span
                style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-muted)',
                  flex: '0 1 7rem',
                }}
              >
                {row.dueAt ? `due ${formatDateInZone(row.dueAt, tz)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
