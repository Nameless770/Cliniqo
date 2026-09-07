import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { appPool, closePools, ownerPool, seedBaseline, type Baseline } from '../helpers/db';
import { testDb } from '../helpers/actions';

vi.mock('@/db/client', async () => {
  const schema = await import('@/db/schema');
  return { getDb: () => testDb, schema };
});

// Only requestMeta/safeInet are used from the staff session module (by auditAsPatient).
vi.mock('@/server/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth/session')>();
  return {
    ...actual,
    requestMeta: () => Promise.resolve({ ip: null, userAgent: 'integration-test' }),
  };
});

// The portal session is the seam here: a patient is whatever `setPatient` last bound.
let current: import('@/server/portal/session').PatientSession | null = null;
vi.mock('@/server/portal/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/portal/session')>();
  return {
    ...actual,
    getPatientSession: () => Promise.resolve(current),
    requirePatientSession: () => {
      if (!current) throw new Error('PORTAL_UNAUTHENTICATED');
      return Promise.resolve(current);
    },
  };
});

import { bookMyAppointment, listMyAppointments } from '@/server/portal/data';

/**
 * Patient portal, through the real audited path.
 *
 * The two properties that make a patient-facing surface safe: a patient acts only on their
 * OWN record, and every action they take is audited as the patient. Both are asserted here
 * against the real database, so a regression fails the build rather than reaching a patient.
 */
describe('patient portal booking and scoping', () => {
  let base: Baseline;
  let accountId: string;

  beforeAll(async () => {
    base = await seedBaseline();

    const owner = await ownerPool.connect();
    try {
      // The provider must be a real doctor for booking's provider check.
      await owner.query(
        `INSERT INTO user_role (user_id, role_id)
         SELECT $1, id FROM role WHERE code = 'doctor'`,
        [base.providerId],
      );
      // Opening hours every day, wide open, so any weekday slot is valid.
      await owner.query(
        `INSERT INTO clinic_hours (clinic_id, day_of_week, opens_at, closes_at)
         SELECT $1, d, '00:00', '23:59' FROM generate_series(0,6) d`,
        [base.clinicId],
      );
      // A portal account for the seeded patient — the audit actor FK needs a real row.
      const acc = await owner.query<{ id: string }>(
        `INSERT INTO patient_account (clinic_id, patient_id, email, password_hash)
         VALUES ($1, $2, $3, '!') RETURNING id`,
        [base.clinicId, base.patientId, `portal-${Date.now()}@test.local`],
      );
      accountId = acc.rows[0]!.id;
    } finally {
      owner.release();
    }

    current = {
      sessionId: crypto.randomUUID(),
      patientAccountId: accountId,
      patientId: base.patientId,
      clinicId: base.clinicId,
      clinicName: 'Test Clinic',
      clinicTimeZone: 'America/New_York',
      email: 'portal@test.local',
      fullName: 'Test Patient',
    };
  });

  afterAll(async () => {
    await closePools();
  });

  it('a patient books their own appointment, audited as the patient', async () => {
    const result = await bookMyAppointment({
      providerUserId: base.providerId,
      appointmentTypeId: base.appointmentTypeId,
      startsAt: '2031-05-14T10:00', // a Wednesday, wide-open hours
    });

    expect(result.ok).toBe(true);
    const appointmentId = result.ok ? result.appointmentId : '';

    const appt = await appPool.query(
      `SELECT patient_id, created_by, booking_note FROM appointment WHERE id = $1`,
      [appointmentId],
    );
    expect(appt.rows[0].patient_id).toBe(base.patientId);
    // Booked by the patient — no staff creator.
    expect(appt.rows[0].created_by).toBeNull();

    const audit = await appPool.query(
      `SELECT actor_user_id, actor_patient_account_id, subject_patient_id
         FROM audit_event
        WHERE action = 'appointment.create' AND entity_id = $1`,
      [appointmentId],
    );
    expect(audit.rowCount).toBe(1);
    // The distinguishing property: patient actor, no staff actor, correct subject.
    expect(audit.rows[0].actor_user_id).toBeNull();
    expect(audit.rows[0].actor_patient_account_id).toBe(accountId);
    expect(audit.rows[0].subject_patient_id).toBe(base.patientId);
  });

  it('a patient sees ONLY their own appointments', async () => {
    // A second patient with an appointment that must never appear in the first's list.
    const owner = await ownerPool.connect();
    let otherApptId = '';
    try {
      const other = await owner.query<{ id: string }>(
        `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
         VALUES ($1, $2, 'Someone', 'Else', '1975-05-05') RETURNING id`,
        [base.clinicId, `TST-ELSE-${Date.now()}`],
      );
      const appt = await owner.query<{ id: string }>(
        `INSERT INTO appointment (clinic_id, patient_id, provider_user_id, appointment_type_id, during)
         VALUES ($1, $2, $3, $4, tstzrange('2031-06-02 14:00+00','2031-06-02 14:30+00')) RETURNING id`,
        [base.clinicId, other.rows[0]!.id, base.providerId, base.appointmentTypeId],
      );
      otherApptId = appt.rows[0]!.id;
    } finally {
      owner.release();
    }

    const { upcoming, past } = await listMyAppointments();
    const allIds = [...upcoming, ...past].map((a) => a.id);

    // The first patient's own booking is present; the other patient's is not.
    expect(allIds.length).toBeGreaterThanOrEqual(1);
    expect(allIds).not.toContain(otherApptId);
  });
});
