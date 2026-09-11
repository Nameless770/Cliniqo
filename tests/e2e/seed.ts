import { randomUUID } from 'node:crypto';

import { hashPassword } from '@/server/auth/password';

import { ownerPool } from '../helpers/db';

/**
 * The cast for the journeys.
 *
 * Passwords are hashed with the APPLICATION's own `hashPassword`, not a fixture string.
 * That matters: it means sign-in in these tests exercises the real scrypt verification
 * path, so a change to the encoding or the parameters breaks the journey instead of
 * passing against a hash the test invented.
 */

export const PASSWORD = 'e2e-journey-passphrase-2026';

export type Cast = {
  clinicId: string;
  adminEmail: string;
  receptionEmail: string;
  doctorId: string;
  patientId: string;
  patientEmail: string;
  otherPatientEmail: string;
  appointmentTypeId: string;
};

export async function seedCast(): Promise<Cast> {
  const client = await ownerPool.connect();
  const tag = randomUUID().slice(0, 8);
  const hash = await hashPassword(PASSWORD);

  try {
    await client.query('BEGIN');

    const clinic = await client.query<{ id: string }>(
      `INSERT INTO clinic (name, timezone, mrn_prefix)
       VALUES ($1, 'America/New_York', 'E2E') RETURNING id`,
      [`E2E Practice ${tag}`],
    );
    const clinicId = clinic.rows[0]!.id;

    const staff = async (label: string, role: string) => {
      const row = await client.query<{ id: string; email: string }>(
        `INSERT INTO user_account (clinic_id, email, password_hash, full_name, status,
                                   must_change_password, password_changed_at)
         VALUES ($1, $2, $3, $4, 'active', false, now()) RETURNING id, email`,
        [clinicId, `${label}-${tag}@e2e.local`, hash, `E2E ${label}`],
      );
      await client.query(
        `INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE code = $2`,
        [row.rows[0]!.id, role],
      );
      return row.rows[0]!;
    };

    const admin = await staff('admin', 'admin');
    const reception = await staff('reception', 'receptionist');
    const doctor = await staff('doctor', 'doctor');

    const makePatient = async (first: string, mrnSuffix: string) => {
      const row = await client.query<{ id: string; email: string }>(
        `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name,
                              date_of_birth, email)
         VALUES ($1, $2, $3, 'Tester', '1990-01-01', $4) RETURNING id, email`,
        [clinicId, `E2E-${tag}-${mrnSuffix}`, first, `${first.toLowerCase()}-${tag}@e2e.local`],
      );
      await client.query(
        `INSERT INTO patient_account (clinic_id, patient_id, email, password_hash,
                                      password_changed_at)
         VALUES ($1, $2, $3, $4, now())`,
        [clinicId, row.rows[0]!.id, row.rows[0]!.email, hash],
      );
      return row.rows[0]!;
    };

    const patient = await makePatient('Ada', '001');
    const other = await makePatient('Grace', '002');

    const type = await client.query<{ id: string }>(
      `INSERT INTO appointment_type (clinic_id, code, display_name, default_duration_minutes)
       VALUES ($1, $2, 'Consultation', 30) RETURNING id`,
      [clinicId, `E2E_${tag.toUpperCase()}`],
    );

    // Wide opening hours every weekday, so slot generation has something to offer.
    await client.query(
      `INSERT INTO clinic_hours (clinic_id, day_of_week, opens_at, closes_at)
       SELECT $1, d, '00:00', '23:59' FROM generate_series(0,6) d`,
      [clinicId],
    );

    await client.query('COMMIT');

    return {
      clinicId,
      adminEmail: admin.email,
      receptionEmail: reception.email,
      doctorId: doctor.id,
      patientId: patient.id,
      patientEmail: patient.email,
      otherPatientEmail: other.email,
      appointmentTypeId: type.rows[0]!.id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
