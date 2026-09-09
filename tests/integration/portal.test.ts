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

import {
  bookMyAppointment,
  cancelMyAppointment,
  listMyAppointments,
  rescheduleMyAppointment,
} from '@/server/portal/data';

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

  it('a patient cancels their own appointment; the row names no staff canceller', async () => {
    const booked = await bookMyAppointment({
      providerUserId: base.providerId,
      appointmentTypeId: base.appointmentTypeId,
      startsAt: '2031-07-09T09:00',
    });
    expect(booked.ok).toBe(true);
    const id = booked.ok ? booked.appointmentId : '';

    expect(await cancelMyAppointment(id)).toEqual({ ok: true });

    const row = await appPool.query(
      `SELECT status, cancelled_by, cancelled_at FROM appointment WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe('cancelled');
    expect(row.rows[0].cancelled_at).not.toBeNull();
    // The point of the assertion: no staff member is credited with a patient's action.
    expect(row.rows[0].cancelled_by).toBeNull();

    const audit = await appPool.query(
      `SELECT actor_user_id, actor_patient_account_id, outcome
         FROM audit_event
        WHERE action = 'appointment.cancel' AND entity_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].outcome).toBe('allowed');
    expect(audit.rows[0].actor_user_id).toBeNull();
    expect(audit.rows[0].actor_patient_account_id).toBe(accountId);
  });

  it("a patient cannot cancel someone else's appointment, and the refusal is audited", async () => {
    const owner = await ownerPool.connect();
    let foreignId = '';
    try {
      const other = await owner.query<{ id: string }>(
        `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
         VALUES ($1, $2, 'Not', 'Mine', '1980-02-02') RETURNING id`,
        [base.clinicId, `TST-MINE-${Date.now()}`],
      );
      const appt = await owner.query<{ id: string }>(
        `INSERT INTO appointment (clinic_id, patient_id, provider_user_id, appointment_type_id, during)
         VALUES ($1, $2, $3, $4, tstzrange('2031-08-04 14:00+00','2031-08-04 14:30+00'))
         RETURNING id`,
        [base.clinicId, other.rows[0]!.id, base.providerId, base.appointmentTypeId],
      );
      foreignId = appt.rows[0]!.id;
    } finally {
      owner.release();
    }

    expect(await cancelMyAppointment(foreignId)).toEqual({ ok: false, reason: 'not_found' });

    const still = await appPool.query(`SELECT status FROM appointment WHERE id = $1`, [
      foreignId,
    ]);
    expect(still.rows[0].status).toBe('scheduled');

    // The attempt itself is recorded — §164.312(b) is about who tried, not only who succeeded.
    const audit = await appPool.query(
      `SELECT outcome, actor_patient_account_id FROM audit_event
        WHERE action = 'appointment.cancel' AND entity_id = $1`,
      [foreignId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].outcome).toBe('denied');
    expect(audit.rows[0].actor_patient_account_id).toBe(accountId);
  });

  it('a patient moves their own appointment, converted in the clinic timezone', async () => {
    const booked = await bookMyAppointment({
      providerUserId: base.providerId,
      appointmentTypeId: base.appointmentTypeId,
      startsAt: '2031-09-10T09:00',
    });
    expect(booked.ok).toBe(true);
    const id = booked.ok ? booked.appointmentId : '';

    expect(await rescheduleMyAppointment(id, '2031-09-11T11:00')).toEqual({ ok: true });

    const row = await appPool.query<{ starts: Date }>(
      `SELECT lower(during) AS starts FROM appointment WHERE id = $1`,
      [id],
    );
    // 11:00 in America/New_York on 2031-09-11 is EDT (UTC-4) — 15:00Z, not 11:00Z.
    expect(new Date(row.rows[0]!.starts).toISOString()).toBe('2031-09-11T15:00:00.000Z');

    const audit = await appPool.query(
      `SELECT actor_patient_account_id, metadata FROM audit_event
        WHERE action = 'appointment.update' AND entity_id = $1 AND outcome = 'allowed'`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_patient_account_id).toBe(accountId);
    expect(audit.rows[0].metadata.operation).toBe('reschedule');
  });

  /*
   * The reason booking and rescheduling share one gate. A reschedule that skipped the
   * closure check would be a way to put an appointment somewhere a fresh booking is
   * refused — the same slot, reached by a different verb.
   */
  it('a reschedule cannot move an appointment into a clinic closure', async () => {
    const booked = await bookMyAppointment({
      providerUserId: base.providerId,
      appointmentTypeId: base.appointmentTypeId,
      startsAt: '2031-10-08T09:00',
    });
    expect(booked.ok).toBe(true);
    const id = booked.ok ? booked.appointmentId : '';

    const owner = await ownerPool.connect();
    try {
      await owner.query(
        `INSERT INTO schedule_exception (clinic_id, during, kind, reason)
         VALUES ($1, tstzrange('2031-10-09 00:00+00','2031-10-10 00:00+00'), 'closure', 'Test holiday')`,
        [base.clinicId],
      );
    } finally {
      owner.release();
    }

    expect(await rescheduleMyAppointment(id, '2031-10-09T11:00')).toEqual({
      ok: false,
      reason: 'unavailable',
    });

    // Refused means unchanged, not half-moved. 09:00 EDT on the 8th is 13:00Z.
    const row = await appPool.query<{ starts: Date }>(
      `SELECT lower(during) AS starts FROM appointment WHERE id = $1`,
      [id],
    );
    expect(new Date(row.rows[0]!.starts).toISOString()).toBe('2031-10-08T13:00:00.000Z');
  });
});
