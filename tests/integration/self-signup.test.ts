import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closePools, ownerPool, seedBaseline, type Baseline } from '../helpers/db';
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

import type { PendingSignup } from '@/server/auth/pending-signup';
import { createSelfRegisteredStaff } from '@/server/auth/staff-signup';
import { markIdentityVerified } from '@/server/data-access/patients';
import { createSelfRegisteredPatient } from '@/server/portal/signup';

/**
 * Self-registration, against the real database.
 *
 * The two properties that make it safe to let strangers create accounts on a system holding
 * patient records, asserted on the rows rather than the code:
 *
 *   - a staff member who signs themselves up gets NO access;
 *   - a patient who signs themselves up gets a NEW record, even when an existing patient has
 *     exactly the same name and date of birth.
 *
 * Every identity here is fabricated (§164.514).
 */

const pendingFor = (aud: 'staff' | 'portal', email: string): PendingSignup => ({
  aud,
  sub: `google-${randomUUID()}`,
  email,
  name: 'Synthetic Person',
  givenName: 'Synthetic',
  familyName: 'Person',
  exp: Date.now() + 60_000,
});

let base: Baseline;

beforeAll(async () => {
  base = await seedBaseline();
});

afterAll(async () => {
  await closePools();
});

/* ============================================================ staff */

describe('a staff member signing themselves up', () => {
  it('gets an account with no roles, no password, and a Google link', async () => {
    const pending = pendingFor('staff', `self-staff-${randomUUID()}@example.invalid`);
    const result = await createSelfRegisteredStaff(
      pending,
      'Synthetic Newcomer',
      base.clinicId,
      '198.51.100.7',
      'integration-test',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const account = await ownerPool.query<{
      clinic_id: string;
      password_hash: string;
      self_registered_at: Date | null;
      status: string;
    }>(
      `SELECT clinic_id, password_hash, self_registered_at, status
         FROM user_account WHERE id = $1`,
      [result.userId],
    );
    expect(account.rows[0]!.clinic_id).toBe(base.clinicId);
    expect(account.rows[0]!.password_hash).toBe('!');
    expect(account.rows[0]!.self_registered_at).not.toBeNull();
    expect(account.rows[0]!.status).toBe('active');

    /* THE property. No role means no permission, on every page and every action. */
    const roles = await ownerPool.query(
      `SELECT 1 FROM user_role WHERE user_id = $1 AND revoked_at IS NULL`,
      [result.userId],
    );
    expect(roles.rowCount).toBe(0);

    const link = await ownerPool.query<{ subject: string }>(
      `SELECT subject FROM user_identity WHERE user_id = $1`,
      [result.userId],
    );
    expect(link.rows[0]!.subject).toBe(pending.sub);
  });

  it('is audited with the new person as the actor, and no access granted', async () => {
    const pending = pendingFor('staff', `self-audit-${randomUUID()}@example.invalid`);
    const result = await createSelfRegisteredStaff(
      pending,
      'Audit Case',
      base.clinicId,
      null,
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await ownerPool.query<{
      action: string;
      actor_user_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, actor_user_id, metadata FROM audit_event
        WHERE entity_id = $1 OR (actor_user_id = $1 AND action = 'auth.login')
        ORDER BY occurred_at`,
      [result.userId],
    );
    expect(rows.rows.map((r) => r.action).sort()).toEqual(
      ['auth.login', 'identity.link', 'staff.create'].sort(),
    );
    for (const row of rows.rows) expect(row.actor_user_id).toBe(result.userId);

    const created = rows.rows.find((r) => r.action === 'staff.create')!;
    expect(created.metadata['via']).toBe('self_signup');
    expect(created.metadata['rolesGranted']).toEqual([]);
  });

  it('refuses an address that already has a staff account', async () => {
    const email = `self-dupe-${randomUUID()}@example.invalid`;
    const first = await createSelfRegisteredStaff(
      pendingFor('staff', email),
      'First',
      base.clinicId,
      null,
      null,
    );
    const second = await createSelfRegisteredStaff(
      pendingFor('staff', email),
      'Second',
      base.clinicId,
      null,
      null,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);

    const count = await ownerPool.query(`SELECT 1 FROM user_account WHERE email = $1`, [
      email,
    ]);
    expect(count.rowCount).toBe(1);
  });

  it('refuses a patient sign-up token', async () => {
    const email = `wrong-audience-${randomUUID()}@example.invalid`;
    const result = await createSelfRegisteredStaff(
      pendingFor('portal', email),
      'Nope',
      base.clinicId,
      null,
      null,
    );
    expect(result.ok).toBe(false);
    const count = await ownerPool.query(`SELECT 1 FROM user_account WHERE email = $1`, [
      email,
    ]);
    expect(count.rowCount).toBe(0);
  });

  it('fails closed when the configured clinic does not exist', async () => {
    const email = `no-clinic-${randomUUID()}@example.invalid`;
    const result = await createSelfRegisteredStaff(
      pendingFor('staff', email),
      'Nope',
      randomUUID(),
      null,
      null,
    );
    expect(result.ok).toBe(false);
    const count = await ownerPool.query(`SELECT 1 FROM user_account WHERE email = $1`, [
      email,
    ]);
    expect(count.rowCount).toBe(0);
  });
});

/* ============================================================ patients */

describe('a patient signing themselves up', () => {
  it('gets a NEW record even when an existing patient has the same name and birthday', async () => {
    /*
     * The case that matters most. The baseline clinic already holds "Test Patient", born
     * 1990-01-01. A stranger typing exactly that must not be connected to that chart — they
     * get a record of their own, and the existing patient's account and links are untouched.
     */
    const before = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient WHERE clinic_id = $1`,
      [base.clinicId],
    );

    const pending = pendingFor('portal', `self-patient-${randomUUID()}@example.invalid`);
    const result = await createSelfRegisteredPatient(
      pending,
      { legalFirstName: 'Test', legalLastName: 'Patient', dateOfBirth: '1990-01-01' },
      base.clinicId,
      '198.51.100.8',
      'integration-test',
    );
    expect(result.ok).toBe(true);

    const after = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient WHERE clinic_id = $1`,
      [base.clinicId],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);

    const created = await ownerPool.query<{ id: string }>(
      `SELECT pa.patient_id AS id FROM patient_account pa WHERE pa.email = $1`,
      [pending.email],
    );
    expect(created.rows[0]!.id).not.toBe(base.patientId);

    const existingAccounts = await ownerPool.query(
      `SELECT 1 FROM patient_account WHERE patient_id = $1 AND email = $2`,
      [base.patientId, pending.email],
    );
    expect(existingAccounts.rowCount).toBe(0);
  });

  it('marks the record self-registered and unverified, with the Google address and an MRN', async () => {
    const pending = pendingFor('portal', `self-record-${randomUUID()}@example.invalid`);
    const result = await createSelfRegisteredPatient(
      pending,
      {
        legalFirstName: 'Grace',
        legalLastName: 'Hopper',
        dateOfBirth: '1985-12-09',
        phonePrimary: '555-0100',
      },
      base.clinicId,
      null,
      null,
    );
    expect(result.ok).toBe(true);

    const row = await ownerPool.query<{
      mrn: string;
      email: string;
      self_registered_at: Date | null;
      identity_verified_at: Date | null;
      registered_by: string | null;
      password_hash: string;
    }>(
      `SELECT p.mrn, p.email, p.self_registered_at, p.identity_verified_at, p.registered_by,
              pa.password_hash
         FROM patient p JOIN patient_account pa ON pa.patient_id = p.id
        WHERE pa.email = $1`,
      [pending.email],
    );
    const r = row.rows[0]!;
    expect(r.mrn).toMatch(/^TST-\d{6}$/);
    expect(r.email).toBe(pending.email);
    expect(r.self_registered_at).not.toBeNull();
    expect(r.identity_verified_at).toBeNull();
    expect(r.registered_by).toBeNull();
    expect(r.password_hash).toBe('!');
  });

  it('audits field names, never the values the patient typed', async () => {
    const pending = pendingFor('portal', `self-audit-p-${randomUUID()}@example.invalid`);
    await createSelfRegisteredPatient(
      pending,
      {
        legalFirstName: 'Unmistakable',
        legalLastName: 'Surname',
        dateOfBirth: '1977-07-07',
      },
      base.clinicId,
      null,
      null,
    );

    const audit = await ownerPool.query<{
      metadata: Record<string, unknown>;
      subject_patient_id: string;
    }>(
      `SELECT ae.metadata, ae.subject_patient_id FROM audit_event ae
         JOIN patient_account pa ON pa.id = ae.actor_patient_account_id
        WHERE pa.email = $1 AND ae.action = 'patient.create'`,
      [pending.email],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.subject_patient_id).toBeTruthy();

    const logged = JSON.stringify(audit.rows[0]!.metadata);
    expect(logged).toContain('legalFirstName');
    expect(logged).not.toContain('Unmistakable');
    expect(logged).not.toContain('1977-07-07');
  });

  it('refuses an address that already has a portal account, and a staff token', async () => {
    const email = `self-p-dupe-${randomUUID()}@example.invalid`;
    const fields = { legalFirstName: 'A', legalLastName: 'B', dateOfBirth: '1990-02-02' };

    expect(
      (
        await createSelfRegisteredPatient(
          pendingFor('portal', email),
          fields,
          base.clinicId,
          null,
          null,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await createSelfRegisteredPatient(
          pendingFor('portal', email),
          fields,
          base.clinicId,
          null,
          null,
        )
      ).ok,
    ).toBe(false);

    const other = `self-p-aud-${randomUUID()}@example.invalid`;
    expect(
      (
        await createSelfRegisteredPatient(
          pendingFor('staff', other),
          fields,
          base.clinicId,
          null,
          null,
        )
      ).ok,
    ).toBe(false);
    const created = await ownerPool.query(
      `SELECT 1 FROM patient_account WHERE email = $1`,
      [other],
    );
    expect(created.rowCount).toBe(0);
  });
});

/* ============================================================ identity check */

describe('staff confirming a self-registered patient', () => {
  it('marks the record once, and only a self-registered one', async () => {
    const pending = pendingFor('portal', `verify-${randomUUID()}@example.invalid`);
    await createSelfRegisteredPatient(
      pending,
      { legalFirstName: 'Verify', legalLastName: 'Me', dateOfBirth: '1991-03-03' },
      base.clinicId,
      null,
      null,
    );
    const { rows } = await ownerPool.query<{ id: string }>(
      `SELECT patient_id AS id FROM patient_account WHERE email = $1`,
      [pending.email],
    );
    const patientId = rows[0]!.id;

    /* The front desk's permission, patient.update. A real user id, for the audit foreign key. */
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    expect((await markIdentityVerified(patientId)).verified).toBe(true);
    // Once. A second mark would overwrite who checked, and when.
    expect((await markIdentityVerified(patientId)).verified).toBe(false);
    // A record staff created was never in doubt, so there is nothing to mark.
    expect((await markIdentityVerified(base.patientId)).verified).toBe(false);

    const row = await ownerPool.query<{ identity_verified_by: string }>(
      `SELECT identity_verified_by FROM patient WHERE id = $1`,
      [patientId],
    );
    expect(row.rows[0]!.identity_verified_by).toBe(base.providerId);

    actingAs(null);
  });
});
