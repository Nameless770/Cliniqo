import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  appPool,
  closePools,
  errorCode,
  ownerPool,
  seedBaseline,
  type Baseline,
} from '../helpers/db';
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

import { AuthorizationError } from '@/server/auth/authorize';
import {
  buildReviewDigest,
  listReviews,
  recordReview,
} from '@/server/data-access/compliance-review';

/**
 * The recorded review of system activity — §164.308(a)(1)(ii)(D), finding F17.
 *
 * Two properties carry the feature. The digest has to SURFACE the access that no
 * permission check can catch, and the recorded review has to be evidence — which means the
 * person filing it cannot choose what it says happened, and cannot edit it afterwards.
 */
describe('activity review', () => {
  let base: Baseline;
  const period = {
    start: new Date('2026-03-02T00:00:00Z'),
    end: new Date('2026-03-09T00:00:00Z'),
  };
  const inPeriod = new Date('2026-03-04T10:00:00Z');

  const admin = () =>
    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));

  /** An audit row written directly, so a period can be staged deterministically. */
  async function stageEvent(opts: {
    actorUserId: string;
    subjectPatientId?: string;
    action: string;
    outcome?: string;
    roles?: string[];
    breakGlass?: boolean;
    occurredAt?: Date;
  }) {
    let grantId: string | null = null;
    if (opts.breakGlass) {
      const g = await ownerPool.query<{ id: string }>(
        `INSERT INTO break_glass_grant (clinic_id, user_id, patient_id, reason, expires_at)
         VALUES ($1,$2,$3,'Staged for review test', now() + interval '1 hour') RETURNING id`,
        [base.clinicId, opts.actorUserId, opts.subjectPatientId],
      );
      grantId = g.rows[0]!.id;
    }

    await ownerPool.query(
      `INSERT INTO audit_event
         (id, occurred_at, clinic_id, actor_user_id, actor_role_codes, action, outcome,
          subject_patient_id, break_glass_grant_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        opts.occurredAt ?? inPeriod,
        base.clinicId,
        opts.actorUserId,
        opts.roles ?? ['admin'],
        opts.action,
        opts.outcome ?? 'allowed',
        opts.subjectPatientId ?? null,
        grantId,
      ],
    );
  }

  /** A patient whose surname matches the seeded staff member's name. */
  async function patientNamed(lastName: string) {
    const t = randomUUID().slice(0, 8);
    const row = await ownerPool.query<{ id: string }>(
      `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
       VALUES ($1, $2, 'Test', $3, '1985-05-05') RETURNING id`,
      [base.clinicId, `TST-${t}`, lastName],
    );
    return row.rows[0]!.id;
  }

  beforeAll(async () => {
    base = await seedBaseline();
  });

  afterAll(async () => {
    await closePools();
  });

  it('flags a staff member reading a chart that shares their surname', async () => {
    admin();
    /* seedBaseline names the provider "Test provider", so a patient surnamed "provider"
       shares a word with it — the shape the heuristic looks for. */
    const relative = await patientNamed('provider');
    await stageEvent({
      actorUserId: base.providerId,
      subjectPatientId: relative,
      action: 'patient.read',
    });

    const digest = await buildReviewDigest(period.start, period.end);

    expect(digest.sameSurname.map((r) => r.patientId)).toContain(relative);
    /* The point of the flag: this read was fully authorized, so nothing else catches it. */
    expect(digest.counts['sameSurname']).toBeGreaterThan(0);
  });

  it('does not flag an ordinary read of an unrelated patient', async () => {
    admin();
    const stranger = await patientNamed('Unrelatedsurname');
    await stageEvent({
      actorUserId: base.providerId,
      subjectPatientId: stranger,
      action: 'patient.read',
    });

    const digest = await buildReviewDigest(period.start, period.end);
    expect(digest.sameSurname.map((r) => r.patientId)).not.toContain(stranger);
  });

  it('surfaces emergency access and clinical reads by an administrator', async () => {
    admin();
    const p = await patientNamed('Emergencycase');
    await stageEvent({
      actorUserId: base.providerId,
      subjectPatientId: p,
      action: 'note.read',
      breakGlass: true,
    });

    const digest = await buildReviewDigest(period.start, period.end);

    expect(digest.breakGlass.map((r) => r.patientId)).toContain(p);
    /* Staged with actor_role_codes ['admin'], which is F17's concern exactly. */
    expect(digest.adminClinicalReads.map((r) => r.patientId)).toContain(p);
  });

  it('counts refusals and record exports for the period', async () => {
    admin();
    const p = await patientNamed('Countable');
    await stageEvent({
      actorUserId: base.providerId,
      subjectPatientId: p,
      action: 'authz.denied',
      outcome: 'denied',
    });
    await stageEvent({
      actorUserId: base.providerId,
      subjectPatientId: p,
      action: 'patient.export',
    });

    const digest = await buildReviewDigest(period.start, period.end);
    expect(digest.counts['denied']).toBeGreaterThan(0);
    expect(digest.counts['exports']).toBeGreaterThan(0);
  });

  it('ignores activity outside the window', async () => {
    admin();
    const p = await patientNamed('provider');
    await stageEvent({
      actorUserId: base.providerId,
      subjectPatientId: p,
      action: 'patient.read',
      occurredAt: new Date('2026-02-01T10:00:00Z'),
    });

    const digest = await buildReviewDigest(period.start, period.end);
    expect(digest.sameSurname.map((r) => r.patientId)).not.toContain(p);
  });

  it('records the review with counts the SERVER computed, not ones it was handed', async () => {
    admin();
    const relative = await patientNamed('provider');
    await stageEvent({
      actorUserId: base.providerId,
      subjectPatientId: relative,
      action: 'patient.read',
    });

    await recordReview(
      period.start,
      period.end,
      'Checked the same-surname reads; front desk looking up their own appointment.',
    );

    const stored = await appPool.query<{ findings: Record<string, number> }>(
      `SELECT findings FROM audit_review
        WHERE clinic_id = $1 AND period_start = $2
        ORDER BY reviewed_at DESC LIMIT 1`,
      [base.clinicId, period.start],
    );

    /*
     * The security property: `recordReview` takes no findings argument at all, so whoever
     * files a review cannot report "nothing flagged" over a week that flagged something.
     * The row is the artifact an auditor is shown, so it has to be the system's account of
     * the period rather than the reviewer's.
     */
    expect(stored.rows[0]!.findings['sameSurname']).toBeGreaterThan(0);
  });

  it('refuses to let the application edit or delete a filed review', async () => {
    admin();
    await recordReview(
      period.start,
      period.end,
      'A review that will be tampered with, for the purposes of this test.',
    );

    const row = await appPool.query<{ id: string }>(
      `SELECT id FROM audit_review WHERE clinic_id = $1 ORDER BY reviewed_at DESC LIMIT 1`,
      [base.clinicId],
    );
    const id = row.rows[0]!.id;

    /* Must be the APP role being refused — an owner connection would prove nothing. */
    const update = await appPool
      .query(`UPDATE audit_review SET notes = 'nothing to see' WHERE id = $1`, [id])
      .then(() => null)
      .catch((e: unknown) => errorCode(e));
    const remove = await appPool
      .query(`DELETE FROM audit_review WHERE id = $1`, [id])
      .then(() => null)
      .catch((e: unknown) => errorCode(e));

    /* 42501 = insufficient_privilege. An attestation you can edit afterwards is not one. */
    expect(update).toBe('42501');
    expect(remove).toBe('42501');
  });

  it('refuses a doctor and a receptionist, and records the refusal', async () => {
    for (const role of ['doctor', 'receptionist'] as const) {
      actingAs(makeSession(role, { userId: base.providerId, clinicId: base.clinicId }));
      await expect(buildReviewDigest(period.start, period.end)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(
        recordReview(period.start, period.end, 'Should never be written to the table.'),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }

    const denied = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_event
        WHERE action = 'authz.denied'
          AND metadata->>'permission' IN ('audit.read','audit.review')`,
    );
    expect(Number(denied.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('shows a filed review in the history, and on the period it covers', async () => {
    admin();
    await recordReview(
      period.start,
      period.end,
      'Reviewed the week; nothing that needed escalating beyond a word with R.',
    );

    const history = await listReviews(50);
    expect(history.some((r) => r.periodStart.getTime() === period.start.getTime())).toBe(
      true,
    );

    /* And the digest for that window knows it has been reviewed. */
    const digest = await buildReviewDigest(period.start, period.end);
    expect(digest.alreadyReviewed.length).toBeGreaterThan(0);
    expect(digest.alreadyReviewed[0]!.notes).toBeTruthy();
  });
});
