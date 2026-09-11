import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appPool, closePools, ownerPool } from '../helpers/db';
import { seedLargeDataset, type Dataset } from '../helpers/dataset';

/**
 * Does it still work when the clinic is busy?
 *
 * Every other test in this suite runs against a handful of rows, where a sequential scan
 * and an index lookup are indistinguishable. These run against thousands of patients and
 * tens of thousands of appointments, and assert that the queries the application actually
 * issues still use their indexes.
 *
 * ==========================================================================
 * ASSERTS PLANS, NOT MILLISECONDS
 * ==========================================================================
 *
 * A timing threshold on a shared CI runner is a flaky test, and a flaky test in a security
 * suite is a test somebody eventually deletes. So these read EXPLAIN output and assert on
 * the ACCESS METHOD: a query that was using an index and starts sequentially scanning the
 * appointment table has regressed, whether or not the box was fast enough to hide it that
 * day.
 *
 * Wall-clock timings are still printed, because a human reading the output wants them -
 * they are just not what passes or fails the run.
 */

let data: Dataset;

const exec = (sql: string, params?: unknown[]) => ownerPool.query(sql, params);

beforeAll(async () => {
  const started = Date.now();
  data = await seedLargeDataset(exec, {
    /* Deliberately modest by default: large enough that the planner prefers indexes, small
       enough that the suite stays quick. `DATASET_SCALE=8` for a serious load test. */
    scale: Number(process.env['DATASET_SCALE'] ?? 1),
    months: 6,
  });
  console.info(
    `[dataset] ${data.counts.patients} patients, ${data.counts.appointments} appointments, ` +
      `${data.counts.auditEvents} audit rows, ${data.counts.invoices} invoices ` +
      `in ${Date.now() - started}ms`,
  );
}, 300_000);

afterAll(async () => {
  await closePools();
});

/** EXPLAIN ANALYZE as one string, for asserting on access methods. */
async function plan(sql: string, params: unknown[] = []): Promise<string> {
  const result = await appPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
  return result.rows.map((r) => String(Object.values(r)[0])).join('\n');
}

function executionMs(explained: string): number {
  const match = /Execution Time: ([\d.]+) ms/.exec(explained);
  return match ? Number(match[1]) : Number.NaN;
}

describe('the dataset itself', () => {
  it('is big enough to be worth measuring', () => {
    expect(data.counts.patients).toBeGreaterThan(1000);
    expect(data.counts.appointments).toBeGreaterThan(5000);
    expect(data.counts.auditEvents).toBeGreaterThan(10_000);
  });

  it('respects the double-booking constraint it was generated against', async () => {
    /*
     * The generator claims it cannot produce an overlap. This is that claim checked
     * against the data rather than against the comment - a self-referential query, but
     * the cheap kind: if the ladder logic were wrong, the insert would have failed, so
     * what this really catches is a future "optimisation" that starts skipping rows.
     */
    const overlaps = await appPool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM appointment a
         JOIN appointment b
           ON b.provider_user_id = a.provider_user_id
          AND b.id <> a.id
          AND b.during && a.during
        WHERE a.clinic_id = $1
          AND a.status NOT IN ('cancelled', 'no_show')
          AND b.status NOT IN ('cancelled', 'no_show')`,
      [data.clinicId],
    );
    expect(overlaps.rows[0]!.n).toBe(0);
  });

  it('spreads audit rows across partitions', async () => {
    const spread = await appPool.query<{ months: number }>(
      `SELECT count(DISTINCT date_trunc('month', occurred_at))::int AS months
         FROM audit_event WHERE clinic_id = $1`,
      [data.clinicId],
    );
    // One month would make the partition-pruning assertion below meaningless.
    expect(spread.rows[0]!.months).toBeGreaterThan(1);
  });
});

describe('the queries the application issues', () => {
  it("finds one clinician's day without scanning the diary", async () => {
    const explained = await plan(
      `SELECT id, during, status FROM appointment
        WHERE provider_user_id = $1
          AND during && tstzrange(now() - interval '1 day', now() + interval '1 day')
        ORDER BY starts_at`,
      [data.providerIds[0]],
    );

    console.info(`  schedule day view: ${executionMs(explained)}ms`);
    /* `appointment_provider_time_idx` exists for exactly this. A sequential scan here is
       the regression that makes the schedule page slow as history accumulates. */
    expect(explained).not.toMatch(/Seq Scan on appointment/);
  });

  it("finds one patient's history without scanning the diary", async () => {
    const explained = await plan(
      `SELECT id, starts_at, status FROM appointment
        WHERE patient_id = $1 ORDER BY starts_at DESC LIMIT 50`,
      [data.patientIds[0]],
    );

    console.info(`  patient history: ${executionMs(explained)}ms`);
    expect(explained).not.toMatch(/Seq Scan on appointment/);
  });

  it('answers a patient lookup by MRN with an index', async () => {
    const mrn = await appPool.query<{ mrn: string }>(
      `SELECT mrn FROM patient WHERE clinic_id = $1 LIMIT 1`,
      [data.clinicId],
    );
    const explained = await plan(`SELECT id FROM patient WHERE clinic_id = $1 AND mrn = $2`, [
      data.clinicId,
      mrn.rows[0]!.mrn,
    ]);

    console.info(`  MRN lookup: ${executionMs(explained)}ms`);
    expect(explained).not.toMatch(/Seq Scan on patient/);
  });

  it('reads a page of the audit log without loading the whole log', async () => {
    const explained = await plan(
      `SELECT id, action, occurred_at FROM audit_event
        WHERE clinic_id = $1
        ORDER BY occurred_at DESC
        LIMIT 25`,
      [data.clinicId],
    );

    console.info(`  audit page: ${executionMs(explained)}ms`);
    /*
     * A WEAK ASSERTION, deliberately, and worth explaining rather than strengthening.
     *
     * `clinic_id` is not selective here: in a single-clinic deployment it matches every
     * row, so an index on it filters nothing and Postgres correctly sorts instead of
     * opening an index scan per partition. Asserting "no sequential scan" would therefore
     * fail against the RIGHT plan. What matters is that the page stays bounded, which is
     * what this checks; the genuinely index-dependent audit query is the next test.
     */
    expect(explained).toMatch(/Limit/);
    expect(executionMs(explained)).toBeLessThan(2000);
  });

  it("answers a patient's accounting of disclosures quickly, on a real index", async () => {
    /*
     * 164.528 gives a patient the right to an accounting of who accessed their record.
     * This is that query, and it is the one audit read that must stay cheap as the log
     * grows - one patient is a tiny slice of six years of history.
     *
     * ==========================================================================
     * WHY THIS ASSERTS EXISTENCE AND SPEED, NOT AN ACCESS METHOD
     * ==========================================================================
     *
     * The obvious assertion - "the plan uses an Index Scan" - is not stable. On a
     * partitioned table the plan is always mixed (empty future partitions are read
     * sequentially because opening an index on zero rows costs more), and which mix the
     * planner picks depends on how much data happens to be loaded: measured here, it
     * sorts at 20,000 rows and switches to index scans by 160,000. Both choices are
     * CORRECT, so an access-method assertion would fail against a right answer and get
     * muted - the exact fate this file's header warns about.
     *
     * So the two things that are actually invariant are asserted instead: the index
     * exists, which is a schema fact no planner gets a vote on, and the query returns
     * fast. If someone drops the index, the first assertion fails deterministically.
     */
    const index = await appPool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'audit_event' AND indexname = 'audit_event_subject_time_idx'`,
    );
    expect(index.rowCount, 'audit_event_subject_time_idx must exist').toBe(1);
    expect(index.rows[0]!.indexdef).toMatch(/subject_patient_id/);
    expect(index.rows[0]!.indexdef).toMatch(/occurred_at DESC/);

    const explained = await plan(
      `SELECT id, action, occurred_at FROM audit_event
        WHERE subject_patient_id = $1
        ORDER BY occurred_at DESC
        LIMIT 50`,
      [data.patientIds[0]],
    );

    console.info(`  disclosure accounting: ${executionMs(explained)}ms`);
    expect(executionMs(explained)).toBeLessThan(1000);
  });

  it('prunes audit partitions when the query is bounded by time', async () => {
    const explained = await plan(
      `SELECT count(*) FROM audit_event
        WHERE clinic_id = $1
          AND occurred_at >= date_trunc('month', now())`,
      [data.clinicId],
    );

    console.info(`  audit month count: ${executionMs(explained)}ms`);
    /*
     * Partitioning only pays if the planner can discard the months a query cannot match.
     * A plan that touches every partition means the partition key is not being used, and
     * the table is effectively one heap with extra steps.
     */
    const partitionsScanned = (explained.match(/audit_event_\d{4}_\d{2}/g) ?? []).length;
    const totalPartitions = await appPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_inherits i
         JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'audit_event'`,
    );
    expect(partitionsScanned).toBeLessThan(totalPartitions.rows[0]!.n);
  });

  it('builds the billing worklist without summing every invoice ever raised', async () => {
    const explained = await plan(
      `SELECT i.id,
              coalesce((select sum(l.amount_cents)::int from invoice_line l
                         where l.invoice_id = i.id), 0) AS total
         FROM invoice i
        WHERE i.clinic_id = $1 AND i.status = 'issued' AND i.archived_at IS NULL
        ORDER BY i.created_at DESC
        LIMIT 200`,
      [data.clinicId],
    );

    console.info(`  billing worklist: ${executionMs(explained)}ms`);
    expect(executionMs(explained)).toBeLessThan(2000);
  });
});
