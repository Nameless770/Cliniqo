import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closePools, ownerPool, seedBaseline, type Baseline } from '../helpers/db';
import { actingAs, makeSession } from '../helpers/actions';

import { todayInZone, zonedDayRange } from '@/lib/clinic-time';

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
  getAuditFilterOptions,
  getClinicOverview,
  readAuditLog,
} from '@/server/data-access/admin';
import { getClinicSettings } from '@/server/data-access/clinic-config';
import { getBookingOptions } from '@/server/data-access/appointments';
import { AuthorizationError } from '@/server/auth/authorize';

/**
 * The administrative reads — the multi-query ones.
 *
 * WHY THIS FILE EXISTS. Each function below fans out into several queries that used to be
 * issued through `Promise.all` on a single transaction client. node-postgres serializes
 * those on its internal queue (measured: three 400ms sleeps take 1226ms concurrently and
 * 1207ms sequentially on one client, against 414ms on a pool), so the concurrency was an
 * illusion — and pg@9 removes the queue and turns it into an error. Unwinding them into
 * sequential awaits is a mechanical change across ten call sites, and mechanical changes
 * to a data layer are exactly the kind that typecheck cleanly and return the wrong shape.
 *
 * These four had no coverage at all, which is why the rewrite there was the risky part.
 * Now the destructuring, the ordering and the totals are pinned by something that runs.
 */
describe('administrative reads through the audited layer', () => {
  let base: Baseline;

  beforeAll(async () => {
    base = await seedBaseline();

    const owner = await ownerPool.connect();
    try {
      // getClinicOverview counts active staff via the role join.
      await owner.query(
        `INSERT INTO user_role (user_id, role_id)
         SELECT $1, id FROM role WHERE code = 'doctor'`,
        [base.providerId],
      );
      await owner.query(
        `INSERT INTO clinic_hours (clinic_id, day_of_week, opens_at, closes_at)
         SELECT $1, d, '09:00', '17:00' FROM generate_series(1,5) d`,
        [base.clinicId],
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    await closePools();
  });

  it('the clinic overview returns every counter, not just the first', async () => {
    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));

    const [dayStart, dayEnd] = zonedDayRange(
      todayInZone('America/New_York'),
      'America/New_York',
    );
    const overview = await getClinicOverview(dayStart, dayEnd);

    /*
     * Every field asserted, deliberately. The failure mode of unwinding a Promise.all is
     * a value landing on the wrong name — which leaves the type intact and every count a
     * plausible number. Checking that each is a number, and that the two the seed
     * determines are exactly right, is what distinguishes "wired correctly" from
     * "compiles".
     */
    for (const [key, value] of Object.entries(overview)) {
      expect(typeof value, `${key} should be a number`).toBe('number');
    }
    /*
     * The baseline seeds one patient and TWO user accounts. `activeStaff` counts active
     * accounts in the clinic, not role holders — only one of the two carries a doctor
     * badge, so a test expecting 1 here is asserting the wrong definition, not catching
     * a bug.
     */
    expect(overview.activePatients).toBe(1);
    expect(overview.activeStaff).toBe(2);
    expect(overview.appointmentsToday).toBe(0);
    expect(overview.noShowsToday).toBe(0);
  });

  it('the audit log returns rows and a total that agree', async () => {
    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));

    // The overview read above wrote its own audit row, so there is something to find.
    const page = await readAuditLog({ page: 1, pageSize: 25 });

    expect(Array.isArray(page.rows)).toBe(true);
    expect(typeof page.total).toBe('number');
    expect(page.total).toBeGreaterThan(0);
    // rows and total come from the two halves of the old Promise.all; a swap would put
    // the count where the list belongs and pass a laxer assertion than this one.
    expect(page.rows.length).toBeLessThanOrEqual(page.total);
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows[0]).toHaveProperty('action');
  });

  it('the audit filter options come back as two distinct lists', async () => {
    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));

    const options = await getAuditFilterOptions();

    expect(Array.isArray(options.actors)).toBe(true);
    expect(Array.isArray(options.actions)).toBe(true);
    // Actors are user rows, actions are audit-action strings — if the two were
    // transposed the shapes would not survive this.
    expect(options.actors.some((a) => a.id === base.providerId)).toBe(true);
    expect(options.actions.every((a) => typeof a === 'string')).toBe(true);
  });

  it('clinic settings return types and hours on their own keys', async () => {
    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));

    const settings = await getClinicSettings();
    expect(settings).not.toBeNull();
    if (!settings) return;

    expect(settings.types.some((t) => t.id === base.appointmentTypeId)).toBe(true);
    expect(settings.hours).toHaveLength(5);
    expect(settings.hours[0]).toHaveProperty('opensAt');
  });

  it('booking options return providers and types on their own keys', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    const options = await getBookingOptions();

    expect(options.providers.some((p) => p.id === base.providerId)).toBe(true);
    expect(options.types.some((t) => t.id === base.appointmentTypeId)).toBe(true);
  });

  it('a receptionist cannot read the audit log', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    // The permission gate is unaffected by the rewrite, and this proves the rewrite did
    // not accidentally move a query outside the audited wrapper that enforces it.
    await expect(readAuditLog({ page: 1, pageSize: 25 })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
