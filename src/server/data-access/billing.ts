import 'server-only';

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import { clinic, invoice, invoiceLine, patient, payment } from '@/db/schema';

import { auditedRead, auditedSearch, auditedWrite } from './audited';

/**
 * Billing.
 *
 * Every function is gated on a `billing.*` permission that only `admin` and `receptionist`
 * hold — a clinician is refused here, by the same guard that refuses a receptionist a
 * clinical note. That exclusion is the shipping matrix, and it is deliberate: knowing what
 * a patient owes is not an input to treating them.
 *
 * Every read and write is audited with the patient as subject, because an invoice is PHI:
 * it ties an identifiable person to services on a date. "Who looked at my account" is the
 * same question as "who looked at my chart", asked of a different table.
 *
 * MONEY IS INTEGER CENTS THROUGHOUT. Nothing here produces a float, and totals are summed
 * in SQL rather than in JavaScript so a large ledger cannot drift through repeated
 * floating-point addition.
 */

export type InvoiceTotals = {
  /** Sum of the lines. */
  totalCents: number;
  /** Sum of payments received. */
  paidCents: number;
  /** What remains. Never negative — an overpayment is a credit, not a negative balance. */
  outstandingCents: number;
};

export type InvoiceSummary = InvoiceTotals & {
  id: string;
  number: number;
  patientId: string;
  patientName: string;
  mrn: string;
  status: string;
  currency: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  createdAt: Date;
};

/*
 * Totals as correlated subqueries, so a list needs one round trip rather than N.
 *
 * WRITTEN WITH AN EXPLICIT INNER ALIAS AND A QUALIFIED OUTER REFERENCE, and that is not
 * stylistic. Interpolating Drizzle column objects here produced unqualified identifiers —
 * `where "invoice_id" = "id"` — and inside the subquery BOTH names resolve against the
 * inner table, so the correlation silently became `invoice_line.invoice_id =
 * invoice_line.id`. That is never true, the sum is NULL, and coalesce turns it into a
 * perfectly plausible 0.
 *
 * It only behaved in the queries that join `patient`, because a second table makes Drizzle
 * qualify names. The un-joined ones — issuing and recording a payment — read every invoice
 * as costing nothing, which made the first part-payment settle the bill in full.
 *
 * An alias the outer query cannot shadow removes the ambiguity entirely.
 */
const totalExpr = sql<number>`coalesce((
  select sum(line.amount_cents)::int
    from invoice_line line
   where line.invoice_id = "invoice"."id"
), 0)`;

const paidExpr = sql<number>`coalesce((
  select sum(pay.amount_cents)::int
    from payment pay
   where pay.invoice_id = "invoice"."id"
), 0)`;

/**
 * The billing worklist.
 *
 * Defaults to what is owed rather than everything: the front desk's question is "who owes
 * us money", and a list of every invoice ever raised answers a different one.
 */
export async function listInvoices(
  scope: 'outstanding' | 'all' = 'outstanding',
): Promise<InvoiceSummary[]> {
  return auditedSearch(
    {
      permission: 'billing.read',
      action: 'invoice.search',
      entityType: 'invoice',
      metadata: { scope },
    },
    async (tx, session) => {
      const rows = await tx
        .select({
          id: invoice.id,
          number: invoice.number,
          patientId: invoice.patientId,
          legalFirstName: patient.legalFirstName,
          legalLastName: patient.legalLastName,
          preferredName: patient.preferredName,
          mrn: patient.mrn,
          status: invoice.status,
          currency: invoice.currency,
          issuedAt: invoice.issuedAt,
          dueAt: invoice.dueAt,
          createdAt: invoice.createdAt,
          totalCents: totalExpr,
          paidCents: paidExpr,
        })
        .from(invoice)
        .innerJoin(patient, eq(patient.id, invoice.patientId))
        .where(
          and(
            eq(invoice.clinicId, session.clinicId),
            isNull(invoice.archivedAt),
            scope === 'outstanding' ? eq(invoice.status, 'issued') : undefined,
          ),
        )
        .orderBy(desc(invoice.createdAt))
        .limit(200);

      return rows.map((r) => ({
        id: r.id,
        number: r.number,
        patientId: r.patientId,
        patientName: `${r.legalLastName}, ${r.preferredName ?? r.legalFirstName}`,
        mrn: r.mrn,
        status: r.status,
        currency: r.currency,
        issuedAt: r.issuedAt,
        dueAt: r.dueAt,
        createdAt: r.createdAt,
        totalCents: r.totalCents,
        paidCents: r.paidCents,
        outstandingCents: Math.max(0, r.totalCents - r.paidCents),
      }));
    },
    (rows) => ({
      resultCount: rows.length,
      resultIds: rows.map((r) => r.id),
      /* Non-PHI and low-cardinality: lets a reviewer tell a routine worklist check from a
         full-ledger read without re-running the query. Never an amount for one patient. */
      labels: { scope },
    }),
  );
}

export type InvoiceDetail = InvoiceSummary & {
  memo: string | null;
  voidReason: string | null;
  lines: {
    id: string;
    code: string | null;
    description: string;
    quantity: number;
    unitAmountCents: number;
    amountCents: number;
  }[];
  payments: {
    id: string;
    amountCents: number;
    method: string;
    reference: string | null;
    receivedAt: Date;
  }[];
};

export async function getInvoice(invoiceId: string): Promise<InvoiceDetail | null> {
  return auditedRead<InvoiceDetail | null>(
    {
      permission: 'billing.read',
      action: 'invoice.read',
      entityType: 'invoice',
      entityId: invoiceId,
    },
    async (tx, session) => {
      const [row] = await tx
        .select({
          id: invoice.id,
          number: invoice.number,
          patientId: invoice.patientId,
          legalFirstName: patient.legalFirstName,
          legalLastName: patient.legalLastName,
          preferredName: patient.preferredName,
          mrn: patient.mrn,
          status: invoice.status,
          currency: invoice.currency,
          issuedAt: invoice.issuedAt,
          dueAt: invoice.dueAt,
          createdAt: invoice.createdAt,
          memo: invoice.memo,
          voidReason: invoice.voidReason,
          totalCents: totalExpr,
          paidCents: paidExpr,
        })
        .from(invoice)
        .innerJoin(patient, eq(patient.id, invoice.patientId))
        .where(
          and(
            eq(invoice.id, invoiceId),
            eq(invoice.clinicId, session.clinicId),
            isNull(invoice.archivedAt),
          ),
        )
        .limit(1);

      if (!row) return null;

      const lines = await tx
        .select({
          id: invoiceLine.id,
          code: invoiceLine.code,
          description: invoiceLine.description,
          quantity: invoiceLine.quantity,
          unitAmountCents: invoiceLine.unitAmountCents,
          amountCents: invoiceLine.amountCents,
        })
        .from(invoiceLine)
        .where(eq(invoiceLine.invoiceId, invoiceId))
        .orderBy(asc(invoiceLine.createdAt));

      const payments = await tx
        .select({
          id: payment.id,
          amountCents: payment.amountCents,
          method: payment.method,
          reference: payment.reference,
          receivedAt: payment.receivedAt,
        })
        .from(payment)
        .where(eq(payment.invoiceId, invoiceId))
        .orderBy(asc(payment.receivedAt));

      return {
        id: row.id,
        number: row.number,
        patientId: row.patientId,
        patientName: `${row.legalLastName}, ${row.preferredName ?? row.legalFirstName}`,
        mrn: row.mrn,
        status: row.status,
        currency: row.currency,
        issuedAt: row.issuedAt,
        dueAt: row.dueAt,
        createdAt: row.createdAt,
        memo: row.memo,
        voidReason: row.voidReason,
        totalCents: row.totalCents,
        paidCents: row.paidCents,
        outstandingCents: Math.max(0, row.totalCents - row.paidCents),
        lines: lines.map((l) => ({ ...l, amountCents: l.amountCents ?? 0 })),
        payments,
      };
    },
    (result) => result?.patientId ?? '',
  );
}

export type BillingFailure = {
  ok: false;
  reason: 'not_found' | 'not_draft' | 'not_issued' | 'no_lines';
};

export type BillingResult = { ok: true } | BillingFailure;
export type CreateInvoiceResult = { ok: true; invoiceId: string } | BillingFailure;
export type RecordPaymentResult = { ok: true; settled: boolean } | BillingFailure;

export type NewInvoiceLine = {
  code?: string | undefined;
  description: string;
  quantity: number;
  unitAmountCents: number;
};

/**
 * Create a draft invoice with its lines, in one transaction.
 *
 * Draft, always — issuing is a separate, separately-audited act. Creating something
 * already issued would mean the document existed before anyone decided to send it.
 *
 * The currency is copied from the clinic here rather than joined at read time, so a later
 * change to the clinic's currency cannot re-denominate this document.
 */
export async function createInvoice(input: {
  patientId: string;
  appointmentId?: string | undefined;
  memo?: string | undefined;
  lines: NewInvoiceLine[];
}): Promise<CreateInvoiceResult> {
  return auditedWrite<CreateInvoiceResult>(
    {
      permission: 'billing.create',
      action: 'invoice.create',
      entityType: 'invoice',
      subjectPatientId: input.patientId,
      metadata: { lineCount: input.lines.length },
    },
    async (tx, session) => {
      if (input.lines.length === 0) return { ok: false, reason: 'no_lines' };

      const [known] = await tx
        .select({ id: patient.id })
        .from(patient)
        .where(
          and(
            eq(patient.id, input.patientId),
            eq(patient.clinicId, session.clinicId),
            isNull(patient.archivedAt),
          ),
        )
        .limit(1);
      if (!known) return { ok: false, reason: 'not_found' };

      const clinicRows = await tx
        .select({ currency: clinic.currency })
        .from(clinic)
        .where(eq(clinic.id, session.clinicId))
        .limit(1);
      const currency = clinicRows[0]?.currency;
      /* The session names a clinic that must exist; if it does not, the session is the
         broken thing and inventing a currency would hide it. */
      if (!currency) return { ok: false, reason: 'not_found' };

      const [created] = await tx
        .insert(invoice)
        .values({
          clinicId: session.clinicId,
          patientId: input.patientId,
          appointmentId: input.appointmentId ?? null,
          currency,
          memo: input.memo ?? null,
          createdBy: session.userId,
        })
        .returning({ id: invoice.id });

      await tx.insert(invoiceLine).values(
        input.lines.map((line) => ({
          invoiceId: created!.id,
          code: line.code ?? null,
          description: line.description,
          quantity: line.quantity,
          unitAmountCents: line.unitAmountCents,
        })),
      );

      return { ok: true, invoiceId: created!.id };
    },
  );
}

/**
 * Issue a draft.
 *
 * The moment the document becomes real: the lines freeze at the database level from here,
 * and the only correction afterwards is a void plus a replacement. Refuses an empty
 * invoice, because an invoice for nothing is a demand nobody can act on.
 */
export async function issueInvoice(
  invoiceId: string,
  patientId: string,
  dueAt: Date | null,
): Promise<BillingResult> {
  return auditedWrite<BillingResult>(
    {
      permission: 'billing.create',
      action: 'invoice.issue',
      entityType: 'invoice',
      entityId: invoiceId,
      subjectPatientId: patientId,
    },
    async (tx, session) => {
      const [existing] = await tx
        .select({ status: invoice.status, total: totalExpr })
        .from(invoice)
        .where(
          and(
            eq(invoice.id, invoiceId),
            eq(invoice.patientId, patientId),
            eq(invoice.clinicId, session.clinicId),
            isNull(invoice.archivedAt),
          ),
        )
        .limit(1);

      if (!existing) return { ok: false, reason: 'not_found' };
      if (existing.status !== 'draft') return { ok: false, reason: 'not_draft' };

      const lineCount = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(invoiceLine)
        .where(eq(invoiceLine.invoiceId, invoiceId));
      if ((lineCount[0]?.n ?? 0) === 0) return { ok: false, reason: 'no_lines' };

      await tx
        .update(invoice)
        .set({
          status: 'issued',
          issuedAt: new Date(),
          dueAt,
          version: sql`${invoice.version} + 1`,
        })
        .where(eq(invoice.id, invoiceId));

      return { ok: true };
    },
  );
}

/**
 * Record a payment, and close the invoice when it is covered.
 *
 * The status transition happens HERE, in the same transaction as the payment, rather than
 * being derived at read time. Two reasons: a receptionist needs the list to agree with what
 * they just did, and the state somebody acted on should be the state the row records.
 */
export async function recordPayment(input: {
  invoiceId: string;
  patientId: string;
  amountCents: number;
  method: 'cash' | 'card' | 'bank_transfer' | 'insurance' | 'other';
  reference?: string | undefined;
}): Promise<RecordPaymentResult> {
  return auditedWrite<RecordPaymentResult>(
    {
      permission: 'payment.record',
      action: 'payment.record',
      entityType: 'invoice',
      entityId: input.invoiceId,
      subjectPatientId: input.patientId,
      metadata: { method: input.method },
    },
    async (tx, session) => {
      const [existing] = await tx
        .select({ status: invoice.status, total: totalExpr, paid: paidExpr })
        .from(invoice)
        .where(
          and(
            eq(invoice.id, input.invoiceId),
            eq(invoice.patientId, input.patientId),
            eq(invoice.clinicId, session.clinicId),
            isNull(invoice.archivedAt),
          ),
        )
        .limit(1);

      if (!existing) return { ok: false, reason: 'not_found' };
      /* Paying a draft means somebody took money for a document never sent; paying a void
         one means taking money against a reversal. Both are process errors, not payments. */
      if (existing.status !== 'issued') return { ok: false, reason: 'not_issued' };

      await tx.insert(payment).values({
        clinicId: session.clinicId,
        invoiceId: input.invoiceId,
        amountCents: input.amountCents,
        method: input.method,
        reference: input.reference ?? null,
        recordedBy: session.userId,
      });

      const settled = existing.paid + input.amountCents >= existing.total;
      if (settled) {
        await tx
          .update(invoice)
          .set({ status: 'paid', paidAt: new Date(), version: sql`${invoice.version} + 1` })
          .where(eq(invoice.id, input.invoiceId));
      }

      return { ok: true, settled };
    },
  );
}

/**
 * Void an issued invoice, with a reason.
 *
 * `admin` only. Nothing is deleted and no amount changes: the document stays in the ledger
 * marked reversed, which is what makes the reversal auditable. The reason is enforced by a
 * CHECK constraint as well as here, so an invoice cannot become void without one by any
 * route.
 */
export async function voidInvoice(
  invoiceId: string,
  patientId: string,
  reason: string,
): Promise<BillingResult> {
  return auditedWrite<BillingResult>(
    {
      permission: 'billing.void',
      action: 'invoice.void',
      entityType: 'invoice',
      entityId: invoiceId,
      subjectPatientId: patientId,
      /* The reason belongs in `purpose`, which is the audit column for exactly this —
         why an action was taken, not what the record contains. */
      purpose: reason,
    },
    async (tx, session) => {
      const updated = await tx
        .update(invoice)
        .set({
          status: 'void',
          voidedAt: new Date(),
          voidedBy: session.userId,
          voidReason: reason,
          version: sql`${invoice.version} + 1`,
        })
        .where(
          and(
            eq(invoice.id, invoiceId),
            eq(invoice.patientId, patientId),
            eq(invoice.clinicId, session.clinicId),
            eq(invoice.status, 'issued'),
            isNull(invoice.archivedAt),
          ),
        )
        .returning({ id: invoice.id });

      return updated.length > 0 ? { ok: true } : { ok: false, reason: 'not_issued' };
    },
  );
}
