import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appPool, closePools, errorCode, ownerPool, seedBaseline } from '../helpers/db';

/**
 * HIPAA §164.312(b) audit controls, §164.316(b)(2)(i) six-year retention.
 *
 * The audit log is only evidence if it cannot be rewritten by the thing it audits. The
 * application connects as `cliniqo_app`, which is granted SELECT and INSERT on
 * `audit_event` and had UPDATE, DELETE and TRUNCATE revoked in migration 0001.
 *
 * Every assertion here runs on the APP pool. Proving the owner cannot edit the log would
 * prove nothing — the owner is the account that runs migrations and by definition can.
 * The claim being tested is narrower and more useful: a bug, an injected statement, or a
 * malicious administrator acting THROUGH THE APPLICATION cannot alter the record.
 */
describe('audit log is append-only for the application role', () => {
  let clinicId: string;
  let auditId: string;

  beforeAll(async () => {
    ({ clinicId } = await seedBaseline());

    // Insert as the app role: writing the log is exactly what it must be able to do.
    const inserted = await appPool.query<{ id: string }>(
      `INSERT INTO audit_event (id, clinic_id, action, outcome, occurred_at)
       VALUES (gen_random_uuid(), $1, 'patient.read', 'allowed', now())
       RETURNING id`,
      [clinicId],
    );
    auditId = inserted.rows[0]!.id;
  });

  afterAll(closePools);

  it('lets the application append', () => {
    expect(auditId).toBeTruthy();
  });

  it('refuses UPDATE', async () => {
    await expect(
      appPool.query(`UPDATE audit_event SET outcome = 'denied' WHERE id = $1`, [auditId]),
    ).rejects.toSatisfy(
      (e: unknown) => errorCode(e) === '42501',
      'expected 42501 insufficient_privilege',
    );
  });

  it('refuses DELETE', async () => {
    await expect(
      appPool.query(`DELETE FROM audit_event WHERE id = $1`, [auditId]),
    ).rejects.toSatisfy(
      (e: unknown) => errorCode(e) === '42501',
      'expected 42501 insufficient_privilege',
    );
  });

  it('refuses TRUNCATE', async () => {
    await expect(appPool.query(`TRUNCATE audit_event`)).rejects.toSatisfy(
      (e: unknown) => errorCode(e) === '42501',
      'expected 42501 insufficient_privilege',
    );
  });

  it('the row is still there and unchanged after all three attempts', async () => {
    const { rows } = await appPool.query<{ outcome: string }>(
      `SELECT outcome FROM audit_event WHERE id = $1`,
      [auditId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('allowed');
  });

  /*
   * The partitions are the part that quietly breaks.
   *
   * `audit_event` is range-partitioned by month, and a REVOKE on the parent does not
   * propagate to partitions created later — migration 0001 installs an event trigger to
   * re-apply the grants on each new one. If that ever stops firing, the log stays
   * append-only on the parent while being freely editable on the partition that actually
   * holds this month's rows, which is the worst possible failure: invisible, and exactly
   * where the evidence lives.
   */
  it('every partition carries the same revocations, not just the parent', async () => {
    const { rows } = await ownerPool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
        WHERE i.inhparent = 'audit_event'::regclass`,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const { relname } of rows) {
      const priv = await ownerPool.query<{ upd: boolean; del: boolean }>(
        `SELECT has_table_privilege('cliniqo_app', $1, 'UPDATE') AS upd,
                has_table_privilege('cliniqo_app', $1, 'DELETE') AS del`,
        [relname],
      );
      expect(priv.rows[0], `partition ${relname}`).toMatchObject({
        upd: false,
        del: false,
      });
    }
  });
});
