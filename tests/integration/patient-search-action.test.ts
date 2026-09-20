import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { appPool, closePools, seedBaseline, type Baseline } from '../helpers/db';
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

import { emptyPatientSearch, type PatientSearchState } from '@/lib/patient-search';
import { searchPatientsAction } from '@/server/actions/patient-search';

/**
 * Patient search as a server action.
 *
 * The page this replaces performed the search itself, inside a route already gated by
 * `guardPage`. Moving it into an action moves it to a different trust level: an action is
 * a POST endpoint that anyone who can reach the origin can call, with no page render in
 * front of it. So the properties worth pinning are not about the results — they are about
 * what happens when the caller is not entitled to them.
 */
describe('patient search action', () => {
  let base: Baseline;

  const form = (fields: Record<string, string>): FormData => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  const run = (fields: Record<string, string>): Promise<PatientSearchState> =>
    searchPatientsAction(emptyPatientSearch, form(fields));

  beforeAll(async () => {
    base = await seedBaseline();
  });

  afterAll(async () => {
    await closePools();
  });

  it('refuses an unauthenticated caller instead of searching', async () => {
    actingAs(null);

    const result = await run({ q: 'a' });

    expect(result.rows).toEqual([]);
    expect(result.message).toMatch(/sign in again/i);
  });

  it('refuses a caller without the permission, and records the attempt', async () => {
    /*
     * The action does not trust the page that rendered the box.
     *
     * Every role holds `patient.read.identifying` — the front desk cannot book without it
     * — so there is no role to borrow for this. The session is built with the permission
     * stripped, which is the state an actor is in mid-revocation.
     */
    actingAs({
      ...makeSession('receptionist', {
        userId: base.providerId,
        clinicId: base.clinicId,
      }),
      permissions: new Set(),
    });

    const result = await run({ q: 'test' });

    expect(result.rows).toEqual([]);
    expect(result.message).toMatch(/permission/i);

    const denied = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_event
        WHERE action = 'authz.denied' AND actor_user_id = $1
          AND occurred_at > now() - interval '1 minute'`,
      [base.providerId],
    );
    expect(Number(denied.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('audits the search without writing the query text', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    /*
     * A query that would be a disclosure if it were ever stored. Deliberately not a short
     * word: an earlier version of this test searched for 'hiv' and failed, because
     * `includeArchived` contains those three letters. The assertion was naive, not the
     * code — but a substring check against structured metadata needs a token that cannot
     * collide with a key name.
     */
    const token = 'melanoma-q7x';
    await run({ q: token });

    const rows = await appPool.query<{ metadata: string }>(
      `SELECT metadata::text AS metadata FROM audit_event
        WHERE action = 'patient.search' AND actor_user_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [base.providerId],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.metadata).not.toContain(token);
    /* It records THAT a query was used, which is what an investigation needs. */
    expect(rows.rows[0]!.metadata).toContain('hasQuery');
  });

  it('returns only the fields the table renders', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    const result = await run({ q: '' });
    expect(result.rows.length).toBeGreaterThan(0);

    /*
     * This value is serialised into the document, so its shape is a disclosure boundary
     * rather than a convenience. A clinical field arriving here would ship to the browser
     * whether or not anything rendered it.
     */
    expect(Object.keys(result.rows[0]!).sort()).toEqual([
      'archivedAt',
      'dateOfBirth',
      'id',
      'legalFirstName',
      'legalLastName',
      'mrn',
      'phonePrimary',
      'preferredName',
    ]);
  });

  it('charges exactly one read-budget event per call', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    const before = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_event
        WHERE action = 'patient.search' AND actor_user_id = $1`,
      [base.providerId],
    );

    await run({ q: 'ab' });

    const after = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_event
        WHERE action = 'patient.search' AND actor_user_id = $1`,
      [base.providerId],
    );

    /*
     * The number that makes search-as-you-type safe. `patient.search` counts against the
     * PHI read ceiling, so one call must cost one event — the client's debounce is what
     * keeps a typed name to one or two calls, and that only works if the cost per call is
     * fixed and known.
     */
    expect(Number(after.rows[0]!.n) - Number(before.rows[0]!.n)).toBe(1);
  });

  it('answers a malformed page number rather than throwing', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    /* A hand-posted form is not a browser. It must not produce a 500. */
    const result = await run({ q: 'a', page: 'not-a-number' });
    expect(result.rows).toEqual([]);
  });
});
