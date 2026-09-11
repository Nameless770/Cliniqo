import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui';
import {
  INVOICE_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  formatMoney,
} from '@/lib/billing-schemas';
import { formatDateInZone } from '@/lib/clinic-time';
import { guardPage } from '@/server/auth/authorize';
import { getInvoice } from '@/server/data-access/billing';

import { InvoiceActions } from './InvoiceActions';

/**
 * One invoice.
 *
 * Guarded on `billing.read`; the actions beneath are each gated again on their own
 * permission, so an administrator sees a Void form a receptionist does not — and a
 * receptionist who submits one anyway is refused by the server, not by the absence of a
 * button.
 *
 * Every figure is formatted here, on the server, from integer cents. The client component
 * below receives strings and does no money arithmetic at all.
 */
export const metadata = { title: 'Invoice · Cliniqo' };
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  draft: 'neutral',
  issued: 'warning',
  paid: 'success',
  void: 'danger',
};

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await guardPage('billing.read');
  const { id } = await params;

  const invoice = await getInvoice(id);
  if (!invoice) notFound();

  const tz = session.clinicTimeZone;
  const money = (cents: number) => formatMoney(cents, invoice.currency);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href="/billing">← Billing</Link>
        </p>
        <h1
          style={{
            fontSize: 'var(--text-xl)',
            margin: 'var(--space-1) 0 0',
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span className="tabular">Invoice #{invoice.number}</span>
          <Badge tone={STATUS_TONE[invoice.status] ?? 'neutral'}>
            {INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
          </Badge>
        </h1>
        <p
          style={{
            margin: 'var(--space-1) 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
          }}
        >
          <Link href={`/patients/${invoice.patientId}`}>{invoice.patientName}</Link>{' '}
          <span className="tabular">{invoice.mrn}</span>
          {invoice.issuedAt ? ` · issued ${formatDateInZone(invoice.issuedAt, tz)}` : ''}
          {invoice.dueAt ? ` · due ${formatDateInZone(invoice.dueAt, tz)}` : ''}
        </p>
        {invoice.memo ? (
          <p style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--text-sm)' }}>
            {invoice.memo}
          </p>
        ) : null}
        {invoice.voidReason ? (
          <p
            style={{
              margin: 'var(--space-2) 0 0',
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--status-danger-bg)',
              color: 'var(--status-danger-text)',
              fontSize: 'var(--text-sm)',
            }}
          >
            Voided: {invoice.voidReason}
          </p>
        ) : null}
      </div>

      <table className="tabular" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <caption className="sr-only">Invoice lines</caption>
        <thead>
          <tr>
            {['Code', 'Description', 'Qty', 'Unit', 'Amount'].map((h, i) => (
              <th
                key={h}
                scope="col"
                style={{
                  textAlign: i >= 2 ? 'right' : 'left',
                  fontSize: 'var(--text-2xs)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-muted)',
                  padding: 'var(--space-2)',
                  borderBottom: '1px solid var(--border-default)',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.id}>
              <td style={{ padding: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
                {line.code ?? '—'}
              </td>
              <td style={{ padding: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
                {line.description}
              </td>
              <td
                style={{
                  padding: 'var(--space-2)',
                  fontSize: 'var(--text-sm)',
                  textAlign: 'right',
                }}
              >
                {line.quantity}
              </td>
              <td
                style={{
                  padding: 'var(--space-2)',
                  fontSize: 'var(--text-sm)',
                  textAlign: 'right',
                }}
              >
                {money(line.unitAmountCents)}
              </td>
              <td
                style={{
                  padding: 'var(--space-2)',
                  fontSize: 'var(--text-sm)',
                  textAlign: 'right',
                }}
              >
                {money(line.amountCents)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4} style={{ padding: 'var(--space-2)', textAlign: 'right' }}>
              Total
            </td>
            <td
              style={{
                padding: 'var(--space-2)',
                textAlign: 'right',
                fontWeight: 'var(--weight-semibold)',
                borderTop: '1px solid var(--border-default)',
              }}
            >
              {money(invoice.totalCents)}
            </td>
          </tr>
          {invoice.paidCents > 0 ? (
            <tr>
              <td colSpan={4} style={{ padding: 'var(--space-2)', textAlign: 'right' }}>
                Paid
              </td>
              <td style={{ padding: 'var(--space-2)', textAlign: 'right' }}>
                −{money(invoice.paidCents)}
              </td>
            </tr>
          ) : null}
          <tr>
            <td colSpan={4} style={{ padding: 'var(--space-2)', textAlign: 'right' }}>
              Outstanding
            </td>
            <td
              style={{
                padding: 'var(--space-2)',
                textAlign: 'right',
                fontWeight: 'var(--weight-semibold)',
              }}
            >
              {money(invoice.outstandingCents)}
            </td>
          </tr>
        </tfoot>
      </table>

      {invoice.payments.length > 0 ? (
        <section style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Payments</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '2px' }}>
            {invoice.payments.map((p) => (
              <li
                key={p.id}
                style={{
                  display: 'flex',
                  gap: 'var(--space-3)',
                  fontSize: 'var(--text-sm)',
                  padding: 'var(--space-2) 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <span className="tabular" style={{ flex: '0 0 7rem' }}>
                  {money(p.amountCents)}
                </span>
                <span style={{ flex: '0 0 8rem' }}>
                  {PAYMENT_METHOD_LABELS[p.method] ?? p.method}
                </span>
                <span style={{ flex: '1 1 auto', color: 'var(--text-muted)' }}>
                  {p.reference ?? ''}
                </span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {formatDateInZone(p.receivedAt, tz)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <InvoiceActions
        invoiceId={invoice.id}
        patientId={invoice.patientId}
        status={invoice.status}
        outstanding={money(invoice.outstandingCents)}
        canVoid={session.permissions.has('billing.void')}
      />
    </div>
  );
}
