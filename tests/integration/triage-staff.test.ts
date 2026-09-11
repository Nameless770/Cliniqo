import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { appPool, closePools, ownerPool, seedBaseline, type Baseline } from '../helpers/db';
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
  closeTriageConversation,
  getTriageConversation,
  listTriageQueue,
} from '@/server/data-access/triage';
import { AuthorizationError } from '@/server/auth/authorize';

/**
 * The staff triage queue.
 *
 * The property under test is the SPLIT. A triage conversation carries two different kinds
 * of information — a scheduling fact the front desk needs, and the patient's own words
 * about their body — and they are gated on different permissions. Getting that wrong in
 * either direction is a real failure: too tight and the receptionist cannot book the right
 * appointment; too loose and every front-desk login can read what a patient wrote about
 * their symptoms.
 *
 * So the receptionist is tested from both sides: that she CAN see the queue, and that she
 * CANNOT open a conversation.
 */
describe('the staff triage queue', () => {
  let base: Baseline;
  let conversationId: string;
  const SYMPTOM = 'a distinctive private symptom description';

  beforeAll(async () => {
    base = await seedBaseline();

    const owner = await ownerPool.connect();
    try {
      const convo = await owner.query<{ id: string }>(
        `INSERT INTO triage_conversation
           (clinic_id, patient_id, engine, urgency, recommended_specialty)
         VALUES ($1, $2, 'local', 'urgent', 'Dermatology') RETURNING id`,
        [base.clinicId, base.patientId],
      );
      conversationId = convo.rows[0]!.id;

      await owner.query(
        `INSERT INTO triage_message (conversation_id, role, body) VALUES ($1, 'patient', $2)`,
        [conversationId, SYMPTOM],
      );
      await owner.query(
        `INSERT INTO triage_message (conversation_id, role, body) VALUES ($1, 'assistant', $2)`,
        [conversationId, 'Our dermatology service is the right place to start.'],
      );
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    await closePools();
  });

  /* ------------------------------------------------------------ the scheduling half */

  it('shows a receptionist who needs seeing and how soon', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    const queue = await listTriageQueue();
    const row = queue.find((r) => r.id === conversationId);

    expect(row).toBeDefined();
    expect(row!.urgency).toBe('urgent');
    expect(row!.recommendedSpecialty).toBe('Dermatology');
    expect(row!.messageCount).toBe(2);
  });

  it('never puts symptom text in the queue, for any role', async () => {
    /*
     * The load-bearing assertion. The queue is not "the conversation with the clinical
     * part hidden" — the query never selects a message body, so there is nothing for a
     * template mistake or a future `JSON.stringify` to leak. Checked as a DOCTOR, who is
     * allowed to read the text elsewhere, so this proves the shape of the queue rather
     * than the caller's permissions.
     */
    actingAs(makeSession('doctor', { userId: base.providerId, clinicId: base.clinicId }));

    const queue = await listTriageQueue();
    expect(JSON.stringify(queue)).not.toContain(SYMPTOM);
    expect(JSON.stringify(queue)).not.toContain('dermatology service is the right place');
  });

  /* -------------------------------------------------------------- the clinical half */

  it('refuses a receptionist the conversation itself', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    await expect(getTriageConversation(conversationId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('lets a clinician read it, audited against the right patient', async () => {
    actingAs(makeSession('doctor', { userId: base.providerId, clinicId: base.clinicId }));

    const detail = await getTriageConversation(conversationId);
    expect(detail).not.toBeNull();
    expect(detail!.messages.map((m) => m.body)).toContain(SYMPTOM);

    const audit = await appPool.query<{ subject_patient_id: string; entity_id: string }>(
      `SELECT subject_patient_id, entity_id FROM audit_event
        WHERE action = 'triage.read' AND entity_id = $1`,
      [conversationId],
    );
    expect(audit.rowCount).toBe(1);
    /*
     * Resolved from the row, not from the caller — "who read my symptoms" has to name the
     * patient whose record was actually read, not the one the caller believed it was.
     */
    expect(audit.rows[0]!.subject_patient_id).toBe(base.patientId);
  });

  it('records the queue read as one collection event, without the text', async () => {
    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));
    await listTriageQueue();

    const audit = await appPool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_event
        WHERE action = 'triage.search' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit.rowCount).toBe(1);
    const meta = JSON.stringify(audit.rows[0]!.metadata);
    expect(meta).not.toContain(SYMPTOM);
    expect(meta).toContain('resultCount');
  });

  /* -------------------------------------------------------------------- clearing it */

  it('lets any role clear an item, and it leaves the queue', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );

    expect(await closeTriageConversation(conversationId, base.patientId)).toEqual({
      ok: true,
    });

    const queue = await listTriageQueue();
    expect(queue.find((r) => r.id === conversationId)).toBeUndefined();

    // Closed, not deleted: still readable in the record and in any §164.528 accounting.
    const row = await appPool.query<{ status: string }>(
      `SELECT status FROM triage_conversation WHERE id = $1`,
      [conversationId],
    );
    expect(row.rows[0]!.status).toBe('closed');
  });

  it('refuses to close it twice', async () => {
    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));

    expect(await closeTriageConversation(conversationId, base.patientId)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('refuses a close whose claimed patient does not match the row', async () => {
    /*
     * The audit row asserts a subject before the work runs. If the caller could name any
     * patient, the log would record a disclosure against someone whose record was never
     * touched — so the patient is verified inside the query, and a mismatch changes
     * nothing.
     */
    const owner = await ownerPool.connect();
    let otherPatient = '';
    let openConversation = '';
    try {
      const other = await owner.query<{ id: string }>(
        `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
         VALUES ($1, $2, 'Not', 'Mine', '1980-02-02') RETURNING id`,
        [base.clinicId, `TST-TRQ-${Date.now()}`],
      );
      otherPatient = other.rows[0]!.id;

      const convo = await owner.query<{ id: string }>(
        `INSERT INTO triage_conversation (clinic_id, patient_id, engine, urgency)
         VALUES ($1, $2, 'local', 'routine') RETURNING id`,
        [base.clinicId, base.patientId],
      );
      openConversation = convo.rows[0]!.id;
    } finally {
      owner.release();
    }

    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));

    expect(await closeTriageConversation(openConversation, otherPatient)).toEqual({
      ok: false,
      reason: 'not_found',
    });

    const row = await appPool.query<{ status: string }>(
      `SELECT status FROM triage_conversation WHERE id = $1`,
      [openConversation],
    );
    expect(row.rows[0]!.status).toBe('open');
  });
});
