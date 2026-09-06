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

import {
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
} from '@/server/data-access/appointments';

/**
 * The appointment-mutation surface, end to end.
 *
 * Every function here shipped broken: each built its audit spec with no subject, and
 * `appointment.update`/`cancel` are PHI actions, so each threw "Audit misuse" on the first
 * click. Zero appointment mutations had ever been audited. These tests are the guard: they
 * fail the moment a mutation stops naming its patient, or parses a time in the wrong zone.
 */
describe('appointment mutations through the audited layer', () => {
  let base: Baseline;

  beforeAll(async () => {
    base = await seedBaseline();
  });

  afterAll(async () => {
    await closePools();
  });

  const reception = () =>
    actingAs(makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }));

  it('books at the clinic wall-clock time, not the server timezone', async () => {
    reception();

    const result = await bookAppointment({
      patientId: base.patientId,
      providerUserId: base.providerId,
      appointmentTypeId: base.appointmentTypeId,
      startsAt: '2030-06-17T09:00', // wall-clock, clinic is America/New_York
      durationMinutes: 30,
    });

    expect(result.ok).toBe(true);

    // June in New York is EDT (UTC-4), so 09:00 local is 13:00Z. A server-timezone parse
    // (the bug) would store something else entirely.
    const row = await appPool.query(
      `SELECT to_char(starts_at, 'YYYY-MM-DD HH24:MI') AS utc,
              to_char(starts_at AT TIME ZONE 'America/New_York', 'HH24:MI') AS clinic
         FROM appointment
        WHERE patient_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [base.patientId],
    );
    expect(row.rows[0].utc).toBe('2030-06-17 13:00');
    expect(row.rows[0].clinic).toBe('09:00');

    const audit = await appPool.query(
      `SELECT subject_patient_id FROM audit_event
        WHERE action = 'appointment.create' AND subject_patient_id = $1`,
      [base.patientId],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('reschedule and cancel each write an audit row NAMING the patient', async () => {
    reception();

    const booked = await bookAppointment({
      patientId: base.patientId,
      providerUserId: base.providerId,
      appointmentTypeId: base.appointmentTypeId,
      startsAt: '2030-07-02T10:00',
      durationMinutes: 20,
    });
    expect(booked.ok).toBe(true);
    const appointmentId = booked.ok ? booked.appointmentId : '';

    // Reschedule — the exact call that threw "Audit misuse" before the fix.
    reception();
    const moved = await rescheduleAppointment(
      appointmentId,
      base.patientId,
      '2030-07-02T14:30',
      45,
    );
    expect(moved.ok).toBe(true);

    const updateAudit = await appPool.query(
      `SELECT subject_patient_id, metadata FROM audit_event
        WHERE action = 'appointment.update' AND entity_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [appointmentId],
    );
    expect(updateAudit.rowCount).toBe(1);
    // The bug was a NULL subject. This is the assertion that fails if it regresses.
    expect(updateAudit.rows[0].subject_patient_id).toBe(base.patientId);

    // Cancel with a reason.
    reception();
    const cancelled = await cancelAppointment(
      appointmentId,
      base.patientId,
      'Patient requested',
    );
    expect(cancelled.ok).toBe(true);

    const cancelAudit = await appPool.query(
      `SELECT subject_patient_id, purpose FROM audit_event
        WHERE action = 'appointment.cancel' AND entity_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [appointmentId],
    );
    expect(cancelAudit.rowCount).toBe(1);
    expect(cancelAudit.rows[0].subject_patient_id).toBe(base.patientId);
    expect(cancelAudit.rows[0].purpose).toBe('Patient requested');

    const status = await appPool.query(
      `SELECT status FROM appointment WHERE id = $1`,
      [appointmentId],
    );
    expect(status.rows[0].status).toBe('cancelled');
  });

  it('claiming a DIFFERENT patient cannot move another patient appointment', async () => {
    reception();

    const booked = await bookAppointment({
      patientId: base.patientId,
      providerUserId: base.providerId,
      appointmentTypeId: base.appointmentTypeId,
      startsAt: '2030-08-01T09:00',
      durationMinutes: 20,
    });
    const appointmentId = booked.ok ? booked.appointmentId : '';

    // A second, real patient. The reschedule verifies the subject in-query, so an
    // appointment belonging to `base.patientId` must not move when patient B is claimed —
    // this is the check that also makes the audit subject trustworthy.
    const other = await appPool.query<{ id: string }>(
      `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
       VALUES ($1, $2, 'Other', 'Patient', '1980-02-02') RETURNING id`,
      [base.clinicId, `TST-OTHER-${Date.now()}`],
    );
    const otherPatientId = other.rows[0]!.id;

    reception();
    const moved = await rescheduleAppointment(
      appointmentId,
      otherPatientId,
      '2030-08-01T11:00',
      20,
    );
    expect(moved.ok).toBe(false);

    // And the original appointment is untouched — still 09:00 local, still scheduled.
    const row = await appPool.query(
      `SELECT status, to_char(starts_at AT TIME ZONE 'America/New_York', 'HH24:MI') AS clinic
         FROM appointment WHERE id = $1`,
      [appointmentId],
    );
    expect(row.rows[0].status).toBe('scheduled');
    expect(row.rows[0].clinic).toBe('09:00');
  });
});
