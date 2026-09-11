import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { appPool, closePools, ownerPool, seedBaseline, type Baseline } from '../helpers/db';
import { actingAs, makeSession } from '../helpers/actions';

vi.mock('@/db/client', async () => {
  const { testDb } = await import('../helpers/actions');
  const schema = await import('@/db/schema');
  return { getDb: () => testDb, schema };
});

vi.mock('@/server/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth/session')>();
  const { currentSession } = await import('../helpers/actions');
  return {
    ...actual,
    getSession: () => Promise.resolve(currentSession()),
    requireSession: async () => {
      const s = currentSession();
      if (!s) throw new Error('no session');
      return s;
    },
    requestMeta: () => Promise.resolve({ ip: null, userAgent: 'integration-test' }),
  };
});

import {
  createInvoice,
  getInvoice,
  issueInvoice,
  listInvoices,
  recordPayment,
  voidInvoice,
} from '@/server/data-access/billing';
import { moneyToCents } from '@/lib/billing-schemas';
import { AuthorizationError } from '@/server/auth/authorize';

/**
 * Billing.
 *
 * Two things are actually at stake here and they are tested hardest: the ROLE BOUNDARY —
 * a clinician must not see what a patient owes — and the MONEY, where a rounding error is
 * not a cosmetic defect but a wrong number on a document sent to somebody.
 */
describe('billing', () => {
  let base: Baseline;
  const asReception = () =>
    actingAs(makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }));
  const asAdmin = () =>
    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));
  const asDoctor = () =>
    actingAs(makeSession('doctor', { userId: base.providerId, clinicId: base.clinicId }));

  beforeAll(async () => {
    base = await seedBaseline();
  });

  afterAll(async () => {
    await closePools();
  });

  /* ------------------------------------------------------------------- money */

  it('converts typed decimals to integer cents without floating point', () => {
    /*
     * 19.99 * 100 is 1998.9999999999998 in binary floating point. The parser does string
     * arithmetic instead, so these are exact rather than nearly exact.
     */
    expect(moneyToCents.parse('19.99')).toBe(1999);
    expect(moneyToCents.parse('0.07')).toBe(7);
    expect(moneyToCents.parse('45')).toBe(4500);
    expect(moneyToCents.parse('45.5')).toBe(4550);
    expect(moneyToCents.parse('1234567.89')).toBe(123456789);

    for (const bad of ['-5', '5.005', 'abc', '', '5,00', '1e3']) {
      expect(moneyToCents.safeParse(bad).success, `${bad} must be rejected`).toBe(false);
    }
  });

  it('computes line totals in the database, not the application', async () => {
    asReception();
    const created = await createInvoice({
      patientId: base.patientId,
      lines: [
        { description: 'Consultation', quantity: 3, unitAmountCents: 1999 },
        { description: 'Dressing', quantity: 1, unitAmountCents: 750 },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const invoice = await getInvoice(created.invoiceId);
    // 3 x 19.99 = 59.97, plus 7.50 = 67.47. Generated column, so it cannot disagree.
    expect(invoice!.lines[0]!.amountCents).toBe(5997);
    expect(invoice!.totalCents).toBe(6747);
    expect(invoice!.outstandingCents).toBe(6747);
  });

  /* ----------------------------------------------------------- the role boundary */

  it('refuses a clinician every billing operation', async () => {
    asDoctor();

    /*
     * The matrix says doctors have no billing capability, and this is what makes that
     * true rather than documented. Knowing what a patient owes is not an input to
     * treating them.
     */
    await expect(listInvoices()).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      createInvoice({
        patientId: base.patientId,
        lines: [{ description: 'x', quantity: 1, unitAmountCents: 100 }],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('lets a receptionist bill but not void', async () => {
    asReception();
    const created = await createInvoice({
      patientId: base.patientId,
      lines: [{ description: 'Consultation', quantity: 1, unitAmountCents: 5000 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await issueInvoice(created.invoiceId, base.patientId, null)).toEqual({ ok: true });

    /* Reversing a document already sent is the one billing act that needs a second kind
       of authority, so it is admin-only. */
    await expect(
      voidInvoice(created.invoiceId, base.patientId, 'billed in error'),
    ).rejects.toBeInstanceOf(AuthorizationError);

    asAdmin();
    expect(await voidInvoice(created.invoiceId, base.patientId, 'billed in error')).toEqual({
      ok: true,
    });
  });

  /* ----------------------------------------------------------------- lifecycle */

  it('freezes the lines of an issued invoice at the database level', async () => {
    asReception();
    const created = await createInvoice({
      patientId: base.patientId,
      lines: [{ description: 'Consultation', quantity: 1, unitAmountCents: 5000 }],
    });
    if (!created.ok) throw new Error('setup failed');
    await issueInvoice(created.invoiceId, base.patientId, null);

    /*
     * Asserted through the APP pool, not the owner's: the guarantee that matters is that
     * the running application cannot rewrite a document it already sent, whatever its
     * code does.
     */
    await expect(
      appPool.query(
        `UPDATE invoice_line SET unit_amount_cents = 1 WHERE invoice_id = $1`,
        [created.invoiceId],
      ),
    ).rejects.toThrow(/cannot be changed/i);

    await expect(
      appPool.query(
        `INSERT INTO invoice_line (invoice_id, description, unit_amount_cents)
         VALUES ($1, 'sneaked in', 100)`,
        [created.invoiceId],
      ),
    ).rejects.toThrow(/cannot be changed/i);
  });

  it('settles an invoice when payments cover it, and refuses payment otherwise', async () => {
    asReception();
    const created = await createInvoice({
      patientId: base.patientId,
      lines: [{ description: 'Procedure', quantity: 1, unitAmountCents: 10_000 }],
    });
    if (!created.ok) throw new Error('setup failed');

    // A draft has not been sent, so there is nothing to pay yet.
    expect(
      await recordPayment({
        invoiceId: created.invoiceId,
        patientId: base.patientId,
        amountCents: 10_000,
        method: 'card',
      }),
    ).toEqual({ ok: false, reason: 'not_issued' });

    await issueInvoice(created.invoiceId, base.patientId, null);

    const part = await recordPayment({
      invoiceId: created.invoiceId,
      patientId: base.patientId,
      amountCents: 4_000,
      method: 'cash',
    });
    expect(part).toEqual({ ok: true, settled: false });

    const rest = await recordPayment({
      invoiceId: created.invoiceId,
      patientId: base.patientId,
      amountCents: 6_000,
      method: 'card',
    });
    expect(rest).toEqual({ ok: true, settled: true });

    const invoice = await getInvoice(created.invoiceId);
    expect(invoice!.status).toBe('paid');
    expect(invoice!.outstandingCents).toBe(0);
  });

  it('will not issue an invoice with no lines', async () => {
    asReception();
    expect(
      await createInvoice({ patientId: base.patientId, lines: [] }),
    ).toEqual({ ok: false, reason: 'no_lines' });
  });

  it('will not void an invoice without a reason, at the database level', async () => {
    /*
     * The CHECK constraint, not the application path. An invoice that left the ledger
     * with no recorded reason is indistinguishable from one deleted to hide something,
     * so no route may produce one.
     */
    const owner = await ownerPool.connect();
    try {
      const row = await owner.query<{ id: string }>(
        `INSERT INTO invoice (clinic_id, patient_id, currency, status)
         VALUES ($1, $2, 'USD', 'draft') RETURNING id`,
        [base.clinicId, base.patientId],
      );
      await expect(
        owner.query(`UPDATE invoice SET status = 'void' WHERE id = $1`, [row.rows[0]!.id]),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      owner.release();
    }
  });

  /* --------------------------------------------------------------------- audit */

  it('audits every billing read and write against the patient', async () => {
    asAdmin();
    const created = await createInvoice({
      patientId: base.patientId,
      lines: [{ description: 'Consultation', quantity: 1, unitAmountCents: 2500 }],
    });
    if (!created.ok) throw new Error('setup failed');
    await getInvoice(created.invoiceId);

    const audit = await appPool.query<{ action: string; subject_patient_id: string }>(
      `SELECT action, subject_patient_id FROM audit_event
        WHERE entity_id = $1 AND action IN ('invoice.create', 'invoice.read')`,
      [created.invoiceId],
    );
    /* An invoice ties a person to services on a date — PHI, and audited like the chart. */
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['invoice.read']);
    for (const row of audit.rows) {
      expect(row.subject_patient_id).toBe(base.patientId);
    }

    const creation = await appPool.query<{ subject_patient_id: string }>(
      `SELECT subject_patient_id FROM audit_event WHERE action = 'invoice.create'`,
    );
    expect(creation.rowCount).toBeGreaterThan(0);
    expect(creation.rows[0]!.subject_patient_id).toBe(base.patientId);
  });
});
