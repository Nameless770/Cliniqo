import Link from 'next/link';

import { guardPage } from '@/server/auth/authorize';

import { NewInvoiceForm } from './NewInvoiceForm';

/**
 * Raise an invoice for a patient.
 *
 * Guarded on `billing.create`. The patient id comes from the path and is verified inside
 * `createInvoice` against the session's clinic, so a guessed id in the URL produces a
 * refusal rather than an invoice against somebody else's record.
 *
 * The page deliberately shows no patient detail — no name, no chart, nothing clinical. It
 * needs the id and nothing else, and not fetching the record means this screen cannot
 * become a way to read one.
 */
export const metadata = { title: 'New invoice · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function NewInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await guardPage('billing.create');
  const { id } = await params;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          <Link href={`/patients/${id}`}>← Back to the patient</Link>
        </p>
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 'var(--space-1) 0 0' }}>
          New invoice
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            maxWidth: '42em',
          }}
        >
          This creates a <strong>draft</strong>. Nothing is sent and nothing is owed until
          you issue it — and once issued, the lines are frozen.
        </p>
      </div>

      <NewInvoiceForm patientId={id} />
    </div>
  );
}
