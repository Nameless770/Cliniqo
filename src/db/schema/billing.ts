/**
 * Billing.
 *
 * IT WAS IN THE ROLE MATRIX AND NOWHERE ELSE. CLAUDE.md grants billing to `admin` and
 * `receptionist` and withholds it from `doctor`; until now there was no permission, no
 * table and no screen behind any of that. A capability matrix that promises something the
 * system cannot do is worse than one that omits it, because the omission is visible.
 *
 * ==========================================================================
 * BILLING DATA IS PHI
 * ==========================================================================
 *
 * An invoice ties an identifiable person to services rendered on a date — that is exactly
 * what §160.103 describes, and the fact that it is about money changes nothing. Payment is
 * one of the three permitted TPO purposes, so this is lawful to hold; it is not exempt
 * from being audited, minimised, or soft-deleted like the rest of the chart.
 *
 * THE DOCTOR IS DELIBERATELY EXCLUDED, and that is a clinical decision rather than an
 * administrative one: a clinician does not need to know what a patient owes in order to
 * treat them, and knowing it is the kind of thing that quietly shapes care. Minimum
 * necessary cuts both ways.
 *
 * ==========================================================================
 * MONEY IS INTEGER MINOR UNITS. NEVER A FLOAT.
 * ==========================================================================
 *
 * Every amount here is an integer count of cents. `numeric` would also be correct, but
 * integers make it impossible to introduce a float by accident anywhere in the stack —
 * JavaScript has no decimal type, so a `numeric` column read into JS becomes a string that
 * somebody eventually multiplies. 0.1 + 0.2 is a rounding error in a ledger, and a ledger
 * with rounding errors is an audit finding.
 */

import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { appointment } from './scheduling';
import { clinic } from './clinic';
import { invoiceStatus, paymentMethod } from './enums';
import { userAccount } from './identity';
import { patient } from './patient';
import { primaryId, rowVersion, softDelete, timestamps } from './shared';

export const invoice = pgTable(
  'invoice',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patient.id),

    /**
     * The human-facing reference, from a sequence.
     *
     * A patient rings up quoting a number, and a UUID is not a number anyone reads over
     * the phone. Allocated by the database rather than computed by the application: two
     * receptionists issuing at once would otherwise both read "last number + 1".
     *
     * Gaps are expected and fine — a sequence does not roll back with its transaction,
     * so an abandoned draft consumes a number. Contiguity is an accounting nicety this
     * does not promise.
     */
    number: bigserial('number', { mode: 'number' }).notNull(),

    /** The visit being billed, when there is one. Not every invoice has an appointment. */
    appointmentId: uuid('appointment_id').references(() => appointment.id),

    status: invoiceStatus('status').notNull().default('draft'),

    /**
     * Copied from the clinic at creation, not joined at read time.
     *
     * A clinic that changes its currency must not silently re-denominate every historical
     * invoice from dollars to euros. The figure on a document that was sent to somebody
     * is a fact about the past.
     */
    currency: text('currency').notNull(),

    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),

    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => userAccount.id),
    voidReason: text('void_reason'),

    /**
     * Front-desk visible, and logistics only — "patient to pay in two instalments".
     *
     * Same exposure as `appointment.booking_note`: the schema cannot stop somebody typing
     * a diagnosis here, and the mitigation is the same. Labelled as non-clinical in the
     * UI, and sampled during audit review.
     */
    memo: text('memo'),

    createdBy: uuid('created_by').references(() => userAccount.id),

    ...timestamps(),
    ...rowVersion(),
    ...softDelete(() => userAccount.id),
  },
  (t) => [
    uniqueIndex('invoice_clinic_number_idx').on(t.clinicId, t.number),
    /** A patient's billing history, newest first. */
    index('invoice_patient_idx').on(t.patientId, t.createdAt.desc()),
    /** The front desk's worklist: what is owed. Partial — paid and void are not chased. */
    index('invoice_clinic_outstanding_idx')
      .on(t.clinicId, t.dueAt)
      .where(sql`${t.status} = 'issued' and ${t.archivedAt} is null`),
    /*
     * Voiding must say why. An invoice that vanishes from the ledger without a recorded
     * reason is indistinguishable from one deleted to hide something.
     */
    check(
      'invoice_void_has_reason',
      sql`(${t.status} <> 'void') or (${t.voidedAt} is not null and ${t.voidReason} is not null)`,
    ),
    check('invoice_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const invoiceLine = pgTable(
  'invoice_line',
  {
    id: primaryId(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoice.id),

    /** A billing code — CPT, or whatever the practice uses. Free text by design. */
    code: text('code'),
    description: text('description').notNull(),

    quantity: integer('quantity').notNull().default(1),
    unitAmountCents: integer('unit_amount_cents').notNull(),

    /**
     * Generated, never written.
     *
     * The one arithmetic in the system that must not be done twice. If the application
     * computed this, a line could be stored whose total disagreed with its own quantity
     * and price — and the disagreement would be invisible until somebody reconciled a
     * statement by hand.
     */
    amountCents: integer('amount_cents').generatedAlwaysAs(
      sql`"quantity" * "unit_amount_cents"`,
    ),

    ...timestamps(),
  },
  (t) => [
    index('invoice_line_invoice_idx').on(t.invoiceId),
    check('invoice_line_quantity_positive', sql`${t.quantity} > 0`),
    /* Zero is allowed — a written-off or bundled line is legitimate. Negative is not:
       a refund is a payment, not a line, or the total stops meaning anything. */
    check('invoice_line_amount_non_negative', sql`${t.unitAmountCents} >= 0`),
  ],
);

export const payment = pgTable(
  'payment',
  {
    id: primaryId(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinic.id),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoice.id),

    amountCents: integer('amount_cents').notNull(),
    method: paymentMethod('method').notNull(),

    /**
     * A reconciliation handle: a transfer reference, a terminal receipt number, the last
     * four digits of a card.
     *
     * NEVER a full card number, and nothing that would make this application part of a
     * PCI-DSS scope it is not built for. Card data belongs with a payment processor,
     * behind its own contract; this column holds the string that lets somebody match a
     * row here to a line on a bank statement.
     */
    reference: text('reference'),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').references(() => userAccount.id),

    ...timestamps(),
  },
  (t) => [
    index('payment_invoice_idx').on(t.invoiceId),
    index('payment_clinic_time_idx').on(t.clinicId, t.receivedAt.desc()),
    /* A refund is a negative-signed correction somebody must record deliberately; it is
       not a payment of zero or less arriving through the normal path. */
    check('payment_amount_positive', sql`${t.amountCents} > 0`),
  ],
);
