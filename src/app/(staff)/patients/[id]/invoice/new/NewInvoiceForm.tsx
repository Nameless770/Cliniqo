'use client';

import { useActionState, useState } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { createInvoiceAction, type BillingFormState } from '@/server/actions/billing';

const BLANK = { code: '', description: '', quantity: '1', unitAmount: '' };

/**
 * Raise a draft invoice.
 *
 * The rows are local state so lines can be added without a round trip, but they submit as
 * repeated form fields rather than a serialised blob — the server reads them with
 * `getAll`, which keeps each line individually validatable and the form working without
 * JavaScript.
 *
 * Amounts are typed as decimals and converted to integer cents exactly once, server-side.
 * Nothing in this component multiplies anything.
 */
export function NewInvoiceForm({ patientId }: { patientId: string }) {
  const [state, action, pending] = useActionState<BillingFormState, FormData>(
    createInvoiceAction,
    {},
  );
  const [rows, setRows] = useState([{ ...BLANK }]);

  return (
    <form action={action} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <input type="hidden" name="patientId" value={patientId} />

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

      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {rows.map((row, index) => (
          <div
            key={index}
            style={{
              display: 'grid',
              gridTemplateColumns: '7rem 1fr 5rem 8rem',
              gap: 'var(--space-2)',
              alignItems: 'end',
            }}
          >
            <Field id={`code-${index}`} label={index === 0 ? 'Code' : ''}>
              <Input name="code" defaultValue={row.code} maxLength={32} />
            </Field>
            <Field
              id={`description-${index}`}
              label={index === 0 ? 'Description' : ''}
              error={index === 0 ? state.errors?.['lines']?.[0] : undefined}
            >
              <Input name="description" defaultValue={row.description} maxLength={200} />
            </Field>
            <Field id={`quantity-${index}`} label={index === 0 ? 'Qty' : ''}>
              <Input name="quantity" type="number" min={1} max={999} defaultValue={row.quantity} />
            </Field>
            <Field id={`unitAmount-${index}`} label={index === 0 ? 'Unit price' : ''}>
              <Input
                name="unitAmount"
                inputMode="decimal"
                placeholder="45.00"
                defaultValue={row.unitAmount}
              />
            </Field>
          </div>
        ))}
      </div>

      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setRows((current) => [...current, { ...BLANK }])}
        >
          Add a line
        </Button>
      </div>

      <Field
        id="memo"
        label="Memo"
        hint="Logistics only — payment arrangements, not clinical detail."
      >
        <Input name="memo" maxLength={500} />
      </Field>

      <div>
        <Button type="submit" variant="primary" loading={pending}>
          Create draft
        </Button>
      </div>
    </form>
  );
}
