import { z } from 'zod';

/**
 * Billing input validation. Isomorphic — shapes and money rules, no PHI.
 *
 * MONEY ARRIVES AS A DECIMAL STRING AND LEAVES AS INTEGER CENTS. A receptionist types
 * "45.50"; the database stores 4550. The conversion happens exactly once, here, because a
 * currency amount that is parsed in two places is a currency amount that disagrees with
 * itself — and `Math.round(45.50 * 100)` is not the same expression as `parseFloat` on a
 * value someone typed with a comma.
 */

/** '45', '45.5', '45.50' — never negative, never more than two decimal places. */
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;

export const moneyToCents = z
  .string()
  .trim()
  .regex(MONEY, 'Enter an amount like 45.00.')
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    /* String arithmetic, not `* 100`. 19.99 * 100 is 1998.9999999999998 in binary
       floating point, and rounding it is a habit that works until it does not. */
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  });

export const invoiceLineInput = z.object({
  code: z.string().trim().max(32).optional(),
  description: z.string().trim().min(1, 'Describe the charge.').max(200),
  quantity: z.coerce.number().int().min(1, 'At least one.').max(999),
  unitAmount: moneyToCents,
});

export const createInvoiceInput = z
  .object({
    patientId: z.uuid(),
    memo: z.string().trim().max(500).optional(),
    lines: z.array(invoiceLineInput).min(1, 'An invoice needs at least one line.').max(50),
  })
  .strict();

export const issueInvoiceInput = z
  .object({
    invoiceId: z.uuid(),
    patientId: z.uuid(),
    /** Optional: not every practice sets terms. */
    dueDate: z
      .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')])
      .optional(),
  })
  .strict();

export const recordPaymentInput = z
  .object({
    invoiceId: z.uuid(),
    patientId: z.uuid(),
    amount: moneyToCents,
    method: z.enum(['cash', 'card', 'bank_transfer', 'insurance', 'other']),
    /* A reconciliation handle only. The UI says so, and the length cap makes a full card
       number awkward to paste — this application is not in PCI scope and must not drift
       into it. */
    reference: z.string().trim().max(64).optional(),
  })
  .strict();

export const voidInvoiceInput = z
  .object({
    invoiceId: z.uuid(),
    patientId: z.uuid(),
    reason: z.string().trim().min(3, 'Say why this is being voided.').max(300),
  })
  .strict();

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  insurance: 'Insurance',
  other: 'Other',
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  issued: 'Issued',
  paid: 'Paid',
  void: 'Void',
};

/** Integer cents to a display string. Formatting only — never feeds back into a total. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}
