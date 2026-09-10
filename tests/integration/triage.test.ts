import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { appPool, closePools, ownerPool, seedBaseline, type Baseline } from '../helpers/db';
import { testDb } from '../helpers/actions';

vi.mock('@/db/client', async () => {
  const schema = await import('@/db/schema');
  return { getDb: () => testDb, schema };
});

vi.mock('@/server/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth/session')>();
  return {
    ...actual,
    requestMeta: () => Promise.resolve({ ip: null, userAgent: 'integration-test' }),
  };
});

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

import { getMyLatestTriage, sendTriageMessage } from '@/server/portal/triage';
import { __setTriageEngine, detectRedFlag, type TriageEngine } from '@/server/triage';

/**
 * Symptom triage.
 *
 * The property under test is not "the assistant gives good answers" — it cannot, and this
 * suite does not pretend otherwise. It is that the DANGEROUS paths are closed: an
 * emergency is caught without consulting any model, a patient cannot read or extend
 * somebody else's conversation, symptom text never reaches the audit log, and a model
 * outage cannot swallow what the patient typed.
 */
describe('symptom triage', () => {
  let base: Baseline;
  let accountId: string;

  beforeAll(async () => {
    base = await seedBaseline();

    const owner = await ownerPool.connect();
    try {
      const acc = await owner.query<{ id: string }>(
        `INSERT INTO patient_account (clinic_id, patient_id, email, password_hash)
         VALUES ($1, $2, $3, '!') RETURNING id`,
        [base.clinicId, base.patientId, `triage-${Date.now()}@test.local`],
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
      email: 'triage@test.local',
      fullName: 'Test Patient',
    };
  });

  beforeEach(() => {
    __setTriageEngine(null); // back to the configured (local) engine
  });

  afterAll(async () => {
    __setTriageEngine(null);
    await closePools();
  });

  /* ------------------------------------------------------------------ safety */

  it('catches an emergency WITHOUT consulting the engine', async () => {
    /*
     * The core safety claim, and the only way to test it is to make the engine fail
     * loudly: if the red-flag path ever stopped short-circuiting, this throws instead of
     * returning, and the test fails rather than quietly downgrading someone's heart
     * attack to a dermatology referral.
     */
    let engineWasCalled = false;
    const exploding: TriageEngine = {
      name: 'must-not-run',
      assess: () => {
        engineWasCalled = true;
        throw new Error('the engine must not be consulted for a red flag');
      },
    };
    __setTriageEngine(exploding);

    const result = await sendTriageMessage(
      null,
      'I have really bad chest pain and my left arm hurts',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(engineWasCalled).toBe(false);
    expect(result.urgency).toBe('emergency');
    expect(result.redFlagCode).toBe('cardiac');
    expect(result.reply).toMatch(/emergency number/i);
  });

  it('routes a person in crisis to a crisis line, never to a booking queue', async () => {
    const flag = detectRedFlag('i want to kill myself');
    expect(flag?.code).toBe('self_harm');
    expect(flag?.message).toMatch(/crisis line|emergency number/i);
  });

  it('does not fire on a negated mention', async () => {
    // "no chest pain" is someone ruling things out. Crying wolf here is how a real
    // banner gets ignored later.
    expect(detectRedFlag('I have a cough but no chest pain')).toBeNull();
    expect(detectRedFlag('headache, denies shortness of breath')).toBeNull();
    // The positive case still fires, so the guard has not simply disabled the rule.
    expect(detectRedFlag('I have chest pain')?.code).toBe('cardiac');
  });

  /* ------------------------------------------------------------------ scoping */

  it("a patient cannot append to another patient's conversation", async () => {
    const owner = await ownerPool.connect();
    let foreignId = '';
    try {
      const other = await owner.query<{ id: string }>(
        `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
         VALUES ($1, $2, 'Not', 'Mine', '1980-02-02') RETURNING id`,
        [base.clinicId, `TST-TRI-${Date.now()}`],
      );
      const convo = await owner.query<{ id: string }>(
        `INSERT INTO triage_conversation (clinic_id, patient_id, engine)
         VALUES ($1, $2, 'local') RETURNING id`,
        [base.clinicId, other.rows[0]!.id],
      );
      foreignId = convo.rows[0]!.id;
    } finally {
      owner.release();
    }

    expect(await sendTriageMessage(foreignId, 'my knee hurts')).toEqual({
      ok: false,
      reason: 'not_found',
    });

    const turns = await appPool.query(
      `SELECT count(*)::int AS n FROM triage_message WHERE conversation_id = $1`,
      [foreignId],
    );
    expect(turns.rows[0].n).toBe(0);
  });

  it('a patient sees only their own conversation', async () => {
    await sendTriageMessage(null, 'I have had a sore throat for four days');
    const view = await getMyLatestTriage();

    expect(view).not.toBeNull();
    const rows = await appPool.query(
      `SELECT patient_id FROM triage_conversation WHERE id = $1`,
      [view!.id],
    );
    expect(rows.rows[0].patient_id).toBe(base.patientId);
  });

  /* ------------------------------------------------------------- durability */

  it("keeps the patient's message when the engine fails", async () => {
    /*
     * The reason the write is split across two transactions. An outage costs a reply, not
     * the words somebody typed while feeling unwell — they retry against a thread that
     * still has their history.
     */
    __setTriageEngine({
      name: 'broken',
      assess: () => Promise.reject(new Error('upstream is down')),
    });

    const result = await sendTriageMessage(null, 'my elbow has been aching for a week');
    expect(result).toEqual({ ok: false, reason: 'upstream' });

    const saved = await appPool.query(
      `SELECT m.body, m.role FROM triage_message m
         JOIN triage_conversation c ON c.id = m.conversation_id
        WHERE c.patient_id = $1 AND m.body LIKE '%elbow%'`,
      [base.patientId],
    );
    expect(saved.rowCount).toBe(1);
    expect(saved.rows[0].role).toBe('patient');
  });

  /* ------------------------------------------------------------------- audit */

  it('audits every turn as the patient, and never records the symptom text', async () => {
    const before = await appPool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE action = 'triage.message'`,
    );

    const phrase = 'peculiarsymptomphrase';
    const result = await sendTriageMessage(null, `I have a rash and ${phrase}`);
    expect(result.ok).toBe(true);

    const after = await appPool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE action = 'triage.message'`,
    );
    // Two turns: what the patient said, and what came back.
    expect(after.rows[0].n - before.rows[0].n).toBe(2);

    const rows = await appPool.query(
      `SELECT actor_user_id, actor_patient_account_id, subject_patient_id, metadata
         FROM audit_event
        WHERE action IN ('triage.start','triage.message')
        ORDER BY occurred_at DESC LIMIT 3`,
    );
    for (const row of rows.rows) {
      expect(row.actor_user_id).toBeNull();
      expect(row.actor_patient_account_id).toBe(accountId);
      expect(row.subject_patient_id).toBe(base.patientId);
      /*
       * The load-bearing assertion. An audit log carrying symptom text is a second copy
       * of the chart with six-year retention and weaker access controls than the record
       * it describes.
       */
      expect(JSON.stringify(row.metadata)).not.toContain(phrase);
    }
  });

  it('records which engine answered, so a stored recommendation stays interpretable', async () => {
    const result = await sendTriageMessage(null, 'I have a painful rash on my arm');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await appPool.query(
      `SELECT engine, recommended_specialty, urgency FROM triage_conversation WHERE id = $1`,
      [result.conversationId],
    );
    expect(row.rows[0].engine).toBe('local');
    expect(row.rows[0].recommended_specialty).toBe('Dermatology');
    expect(row.rows[0].urgency).toBe('routine');
  });
});
