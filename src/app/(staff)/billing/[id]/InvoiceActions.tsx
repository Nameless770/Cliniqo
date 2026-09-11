'use client';

import { useActionState } from 'react';

import { Button, Field, Input, Select } from '@/components/ui';
import { PAYMENT_METHOD_LABELS } from '@/lib/billing-schemas';
import {
  issueInvoiceAction,
  recordPaymentAction,
  voidInvoiceAction,
  type BillingFormState,
} from '@/server/actions/billing';

/**
 * What can be done to an invoice, given its state.
 *
 * A Client Component for the pending states and inline messages. It receives ids, a status
 * and an outstanding figure — no patient name, no line descriptions — so the client bundle
 * carries identifiers and an amount rather than a billing record.
 *
 * The buttons rendered depend on status, but that is presentation: each action re-checks
 * the permission AND the status server-side, so a stale tab cannot issue an invoice twice
 * or pay a voided one.
 */
function Banner({ state }: { state: BillingFormState }) {
  if (!state.message) return null;
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      style={{
        margin: 0,
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: state.ok ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
        color: state.ok ? 'var(--status-success-text)' : 'var(--status-danger-text)',
        fontSize: 'var(--text-sm)',
      }}
    >
      {state.message}
    </p>
  );
}

export function InvoiceActions({
  invoiceId,
  patientId,
  status,
  outstanding,
  canVoid,
}: {
  invoiceId: string;
  patientId: string;
  status: string;
  /** Pre-formatted by the server; the client never does money arithmetic. */
  outstanding: string;
  canVoid: boolean;
}) {
  const [issueState, issue, issuing] = useActionState<BillingFormState, FormData>(
    issueInvoiceAction,
    {},
  );
  const [payState, pay, paying] = useActionState<BillingFormState, FormData>(
    recordPaymentAction,
    {},
  );
  const [voidState, doVoid, voiding] = useActionState<BillingFormState, FormData>(
    voidInvoiceAction,
    {},
  );

  const ids = (
    <>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="patientId" value={patientId} />
    </>
  );

  const card = {
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)',
    padding: 'var(--space-4)',
    display: 'grid',
    gap: 'var(--space-3)',
  } as const;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {status === 'draft' ? (
        <form action={issue} style={card}>
          <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Issue this invoice</h2>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            Once issued the lines are frozen — the database refuses to change them. A wrong
            invoice is corrected by voiding it and raising a replacement.
          </p>
          <Banner state={issueState} />
          {ids}
          <Field id="dueDate" label="Due date" hint="Optional.">
            <Input name="dueDate" type="date" />
          </Field>
          <div>
            <Button type="submit" variant="primary" loading={issuing}>
              Issue invoice
            </Button>
          </div>
        </form>
      ) : null}

      {status === 'issued' ? (
        <form action={pay} style={card}>
          <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Record a payment</h2>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            {outstanding} outstanding.
          </p>
          <Banner state={payState} />
          {ids}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            <Field id="amount" label="Amount" required error={payState.errors?.['amount']?.[0]}>
              <Input name="amount" inputMode="decimal" placeholder="45.00" />
            </Field>
            <Field id="method" label="Method" required>
              <Select name="method" defaultValue="card">
                {Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              id="reference"
              label="Reference"
              hint="For reconciliation only — never a full card number."
            >
              <Input name="reference" maxLength={64} />
            </Field>
          </div>
          <div>
            <Button type="submit" variant="primary" loading={paying}>
              Record payment
            </Button>
          </div>
        </form>
      ) : null}

      {status === 'issued' && canVoid ? (
        <form action={doVoid} style={card}>
          <h2 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Void this invoice</h2>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            Nothing is deleted. The invoice stays in the ledger marked reversed, with your
            reason recorded against it.
          </p>
          <Banner state={voidState} />
          {ids}
          <Field id="reason" label="Reason" required error={voidState.errors?.['reason']?.[0]}>
            <Input name="reason" placeholder="e.g. Billed in error — duplicate of #412" />
          </Field>
          <div>
            <Button type="submit" variant="danger" loading={voiding}>
              Void invoice
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
