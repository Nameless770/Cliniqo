import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isSlotContention, SLOT_CONTENTION_CODES } from '@/lib/pg-errors';

import {
  appPool,
  closePools,
  errorCode,
  seedBaseline,
  type Baseline,
} from '../helpers/db';

/**
 * Concurrency-safe double-booking prevention.
 *
 * The guarantee: a provider cannot hold two overlapping appointments, and that holds
 * under simultaneous requests — not merely when two bookings arrive politely apart.
 *
 * WHY A CHECK-THEN-INSERT WOULD NOT DO. "SELECT any overlapping rows, and INSERT if none"
 * is correct in a single-threaded test and wrong in production: under READ COMMITTED both
 * transactions read a clear slot before either writes, and both succeed. That is the
 * classic write-skew, and it is invisible in every test that does not actually run the
 * requests at once. The defence is a GiST exclusion constraint, which PostgreSQL enforces
 * at write time regardless of interleaving:
 *
 *   EXCLUDE USING gist (provider_user_id WITH =, during WITH &&)
 *     WHERE (status NOT IN ('cancelled','no_show') AND archived_at IS NULL)
 *
 * So this test fires genuinely concurrent inserts and asserts exactly one survives.
 */
describe('overlapping appointments are impossible under concurrency', () => {
  let base: Baseline;
  const slot = "tstzrange('2027-03-01 09:00+00','2027-03-01 09:30+00')";

  beforeAll(async () => {
    base = await seedBaseline();
  });

  afterAll(closePools);

  const book = (during: string, providerId: string, status = 'scheduled') =>
    appPool.query(
      `INSERT INTO appointment (clinic_id, patient_id, provider_user_id, appointment_type_id, during, status)
       VALUES ($1, $2, $3, $4, ${during}, $5::appointment_status)`,
      [base.clinicId, base.patientId, providerId, base.appointmentTypeId, status],
    );

  it('admits exactly one of 20 simultaneous bookings for the same slot', async () => {
    const attempts = Array.from({ length: 20 }, () =>
      book(slot, base.providerId).then(
        () => ({ ok: true, code: undefined as string | undefined, handled: true }),
        (e: unknown) => ({ ok: false, code: errorCode(e), handled: isSlotContention(e) }),
      ),
    );

    const results = await Promise.all(attempts);
    const committed = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);

    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(19);

    /*
     * Asserted through the APPLICATION'S OWN predicate, not a literal code.
     *
     * The first version of this test asserted `code === '23P01'` and failed: at this
     * concurrency PostgreSQL sometimes kills transactions as deadlock victims (40P01)
     * instead. SOMETIMES is the word that matters — reruns of this exact test alternate
     * between all-23P01 (~50ms) and a mix including 40P01 (~19s, the extra time being
     * deadlock_timeout). That non-determinism is why the bug survived a manual check: the
     * one-off verification happened to hit the fast path, saw 19 clean exclusion
     * violations, and concluded the handling was complete.
     * One appointment was still created, so the safety guarantee held — but the booking
     * code recognised only 23P01 and would have rethrown, showing a server error instead
     * of "that slot just went". That was a real bug, and fixing the test to accept 40P01
     * without fixing the application would have hidden it.
     *
     * So: every rejection must be one the shipped classifier treats as slot contention.
     * If someone narrows that predicate, this goes red.
     */
    for (const r of rejected) {
      expect(SLOT_CONTENTION_CODES.has(r.code!), `unexpected SQLSTATE ${r.code}`).toBe(
        true,
      );
      expect(r.handled, `code ${r.code} not handled as slot contention`).toBe(true);
    }

    const { rows } = await appPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointment
        WHERE provider_user_id = $1 AND during && ${slot}
          AND status NOT IN ('cancelled','no_show') AND archived_at IS NULL`,
      [base.providerId],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('allows the same slot for a DIFFERENT provider', async () => {
    // The constraint is per provider; two clinicians working at once is normal, and a
    // constraint that blocked it would be a bug rather than a safeguard.
    await expect(book(slot, base.otherProviderId)).resolves.toBeDefined();
  });

  it('allows an adjacent, non-overlapping slot', async () => {
    // Ranges are half-open, so 09:30-10:00 touches but does not overlap 09:00-09:30.
    // If this failed, the clinic could book only every other slot.
    await expect(
      book("tstzrange('2027-03-01 09:30+00','2027-03-01 10:00+00')", base.providerId),
    ).resolves.toBeDefined();
  });

  it('lets a cancelled appointment free its slot for rebooking', async () => {
    const during = "tstzrange('2027-04-01 09:00+00','2027-04-01 09:30+00')";
    await book(during, base.providerId);

    await appPool.query(
      `UPDATE appointment SET status = 'cancelled'
        WHERE provider_user_id = $1 AND during && ${during}`,
      [base.providerId],
    );

    // The constraint's WHERE clause excludes cancelled rows, so the slot is free again
    // while the cancelled appointment remains on the record rather than being deleted.
    await expect(book(during, base.providerId)).resolves.toBeDefined();
  });
});
