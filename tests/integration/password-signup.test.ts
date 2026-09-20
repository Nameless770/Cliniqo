import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closePools, ownerPool, seedBaseline, type Baseline } from '../helpers/db';

vi.mock('@/db/client', async () => {
  const { testDb } = await import('../helpers/actions');
  const schema = await import('@/db/schema');
  return { getDb: () => testDb, schema };
});

import { verifyPassword } from '@/server/auth/password';
import { requestStaffAccessWithPassword } from '@/server/auth/staff-password-signup';
import { signInPatientWithGoogle } from '@/server/portal/google';
import { registerPatientWithPassword } from '@/server/portal/password-signup';

/**
 * Email-and-password sign-up, against the real database.
 *
 * Nothing proves the address, so what is asserted is that an unproven account is harmless:
 * no access, no session, never a match to an existing record, never an overwrite of an
 * existing account, and never a door for Google sign-in to walk through. Every identity here
 * is synthetic (§164.514).
 */

let base: Baseline;

beforeAll(async () => {
  base = await seedBaseline();
});

afterAll(async () => {
  await closePools();
});

const PASSWORD = 'a synthetic passphrase for tests';

describe('a staff member signing up with a password', () => {
  it('gets an account with no roles, a working password, and no session', async () => {
    const email = `pw-staff-${randomUUID()}@example.invalid`;
    const result = await requestStaffAccessWithPassword(
      { email, fullName: 'Synthetic Applicant', password: PASSWORD },
      base.clinicId,
      null,
      'integration-test',
    );
    expect(result.created).toBe(true);

    const row = await ownerPool.query<{
      id: string;
      password_hash: string;
      self_registered_at: Date | null;
    }>(
      `SELECT id, password_hash, self_registered_at FROM user_account WHERE email = $1`,
      [email],
    );
    const account = row.rows[0]!;
    expect(account.self_registered_at).not.toBeNull();
    expect(await verifyPassword(PASSWORD, account.password_hash)).toBe(true);

    const roles = await ownerPool.query(
      `SELECT 1 FROM user_role WHERE user_id = $1 AND revoked_at IS NULL`,
      [account.id],
    );
    expect(roles.rowCount).toBe(0);

    /* Signing in is a separate step, through the ordinary checks. */
    const sessions = await ownerPool.query(`SELECT 1 FROM session WHERE user_id = $1`, [
      account.id,
    ]);
    expect(sessions.rowCount).toBe(0);
  });

  it('changes nothing when the address is taken — above all, not the password', async () => {
    const email = `pw-staff-taken-${randomUUID()}@example.invalid`;
    await requestStaffAccessWithPassword(
      { email, fullName: 'Original Owner', password: PASSWORD },
      base.clinicId,
      null,
      null,
    );
    const before = await ownerPool.query<{ password_hash: string; full_name: string }>(
      `SELECT password_hash, full_name FROM user_account WHERE email = $1`,
      [email],
    );

    const second = await requestStaffAccessWithPassword(
      { email, fullName: 'Someone Else', password: 'an attacker chosen passphrase' },
      base.clinicId,
      null,
      null,
    );
    expect(second.created).toBe(false);

    const after = await ownerPool.query<{ password_hash: string; full_name: string }>(
      `SELECT password_hash, full_name FROM user_account WHERE email = $1`,
      [email],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe('a patient signing up with a password', () => {
  it('gets a NEW record even with the same name and birthday as an existing patient', async () => {
    const before = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient WHERE clinic_id = $1`,
      [base.clinicId],
    );

    const email = `pw-patient-${randomUUID()}@example.invalid`;
    const result = await registerPatientWithPassword(
      {
        email,
        password: PASSWORD,
        confirm: PASSWORD,
        legalFirstName: 'Test',
        legalLastName: 'Patient',
        dateOfBirth: '1990-01-01',
      },
      base.clinicId,
      null,
      'integration-test',
    );
    expect(result.created).toBe(true);

    const after = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient WHERE clinic_id = $1`,
      [base.clinicId],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);

    const account = await ownerPool.query<{
      id: string;
      patient_id: string;
      password_hash: string;
    }>(`SELECT id, patient_id, password_hash FROM patient_account WHERE email = $1`, [
      email,
    ]);
    expect(account.rows[0]!.patient_id).not.toBe(base.patientId);
    expect(await verifyPassword(PASSWORD, account.rows[0]!.password_hash)).toBe(true);

    const sessions = await ownerPool.query(
      `SELECT 1 FROM patient_session WHERE patient_account_id = $1`,
      [account.rows[0]!.id],
    );
    expect(sessions.rowCount).toBe(0);
  });

  it('changes nothing when the address already has an account', async () => {
    const email = `pw-patient-taken-${randomUUID()}@example.invalid`;
    const fields = {
      password: PASSWORD,
      confirm: PASSWORD,
      legalFirstName: 'First',
      legalLastName: 'Owner',
      dateOfBirth: '1985-06-06',
    };
    await registerPatientWithPassword({ email, ...fields }, base.clinicId, null, null);

    const before = await ownerPool.query<{ password_hash: string; n: number }>(
      `SELECT password_hash, (SELECT count(*)::int FROM patient WHERE clinic_id = $2) AS n
         FROM patient_account WHERE email = $1`,
      [email, base.clinicId],
    );

    const second = await registerPatientWithPassword(
      {
        email,
        ...fields,
        password: 'an attacker chosen passphrase',
        confirm: 'an attacker chosen passphrase',
        legalFirstName: 'Somebody',
      },
      base.clinicId,
      null,
      null,
    );
    expect(second.created).toBe(false);

    const after = await ownerPool.query<{ password_hash: string; n: number }>(
      `SELECT password_hash, (SELECT count(*)::int FROM patient WHERE clinic_id = $2) AS n
         FROM patient_account WHERE email = $1`,
      [email, base.clinicId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('is never linked to a Google sign-in by email', async () => {
    /*
     * The attack this blocks: register a real patient's address with a password you know,
     * then wait for them to "Continue with Google". Linking by address would put both of you
     * in one account.
     */
    const email = `pw-prehijack-${randomUUID()}@example.invalid`;
    await registerPatientWithPassword(
      {
        email,
        password: PASSWORD,
        confirm: PASSWORD,
        legalFirstName: 'Squatted',
        legalLastName: 'Address',
        dateOfBirth: '1970-01-01',
      },
      base.clinicId,
      null,
      null,
    );

    const result = await signInPatientWithGoogle(
      {
        subject: `google-${randomUUID()}`,
        email,
        emailVerified: true,
        name: 'Real Owner',
        givenName: 'Real',
        familyName: 'Owner',
        hostedDomain: null,
        nonce: null,
      },
      null,
      'integration-test',
    );

    expect(result).toEqual({ ok: false, reason: 'refused' });
    const links = await ownerPool.query(
      `SELECT 1 FROM patient_identity pi
         JOIN patient_account pa ON pa.id = pi.patient_account_id
        WHERE pa.email = $1`,
      [email],
    );
    expect(links.rowCount).toBe(0);
  });
});
