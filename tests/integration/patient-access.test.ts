import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { appPool, closePools, seedBaseline, type Baseline } from '../helpers/db';
import { actingAs, makeSession } from '../helpers/actions';

/*
 * Stand in for the two seams, and only those — see tests/helpers/actions.ts. Everything
 * below this runs the REAL audited data-access layer against the REAL test database.
 */
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

// vitest hoists vi.mock above these imports, so the code under test sees the seams.
import { createPatient, getPatient } from '@/server/data-access/patients';
import { listAllergies } from '@/server/data-access/clinical-facts';
import { AuthorizationError } from '@/server/auth/authorize';

/**
 * Integration coverage for the audited patient path.
 *
 * These are the checks that would have caught this session's bugs before a browser did:
 * a creation that failed to name its subject, and a role boundary that only the UI
 * enforced.
 */
describe('patient access through the audited layer', () => {
  let base: Baseline;

  beforeAll(async () => {
    base = await seedBaseline();
  });

  afterAll(async () => {
    await closePools();
  });

  it('a receptionist registers a patient, and the audit row names the new patient', async () => {
    actingAs(makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }));

    const created = await createPatient({
      legalFirstName: 'Integration',
      legalLastName: 'Created',
      dateOfBirth: '1991-04-05',
      confirmedNotDuplicate: true,
    });

    expect(created.id).toBeTruthy();
    expect(created.mrn).toMatch(/^TST-/); // seeded clinic's prefix

    // The row must exist AND be attributable — the subjectFrom fix. Before it, this event
    // threw "Audit misuse" and no patient was ever created through the app.
    const audit = await appPool.query(
      `SELECT subject_patient_id, entity_id, metadata
         FROM audit_event
        WHERE action = 'patient.create' AND subject_patient_id = $1`,
      [created.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].entity_id).toBe(created.id);
    // Field NAMES only — never a value. A name in the metadata would be PHI in the log.
    const meta = audit.rows[0].metadata as { fields: string[] };
    expect(meta.fields).toContain('legalFirstName');
    expect(JSON.stringify(meta)).not.toContain('Integration');
  });

  it('a receptionist is refused the clinical view, and the denial is audited', async () => {
    actingAs(makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }));

    // getPatient returns a narrowed 'identifying' scope for a receptionist rather than
    // throwing — that boundary is covered elsewhere. Here we assert the hard refusal:
    // a receptionist has no clinical read grant at all, so a clinical-only read throws.
    await expect(listAllergies(base.patientId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    const denial = await appPool.query(
      `SELECT outcome, metadata
         FROM audit_event
        WHERE action = 'authz.denied' AND actor_user_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [base.providerId],
    );
    expect(denial.rowCount).toBe(1);
    expect(denial.rows[0].outcome).toBe('denied');
    expect(denial.rows[0].metadata.permission).toBe('patient.read.clinical');
  });

  it('a doctor CAN read the clinical view of a patient', async () => {
    actingAs(makeSession('doctor', { userId: base.providerId, clinicId: base.clinicId }));

    const view = await getPatient(base.patientId);
    expect(view).not.toBeNull();
    expect(view!.scope).toBe('full');
  });
});
