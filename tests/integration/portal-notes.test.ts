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

// The patient is whatever `patientSession` last bound.
let patientSession: import('@/server/portal/session').PatientSession | null = null;
vi.mock('@/server/portal/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/portal/session')>();
  return {
    ...actual,
    getPatientSession: () => Promise.resolve(patientSession),
    requirePatientSession: () => {
      if (!patientSession) throw new Error('PORTAL_UNAUTHENTICATED');
      return Promise.resolve(patientSession);
    },
  };
});

import { AuthorizationError } from '@/server/auth/authorize';
import { setNotePortalVisibility } from '@/server/data-access/notes';
import { listMyVisitSummaries } from '@/server/portal/notes';

/**
 * A patient reading their own visit notes, against the real database.
 *
 * Asserted on what the patient actually receives, because that is where each rule has to
 * hold: signed notes only, their own only, a withheld note's text never, and every read in
 * the audit log with the patient as the actor. Every note below is synthetic (§164.514),
 * and each carries a distinctive phrase so a leak is detectable by searching for it.
 */

type Version = {
  kind: 'draft' | 'signed' | 'addendum';
  frozen: boolean;
  chiefComplaint?: string;
  plan?: string;
};

let base: Baseline;
let accountId: string;
let otherPatientId: string;

async function insertNote(
  patientId: string,
  status: 'draft' | 'signed' | 'amended',
  versions: Version[],
): Promise<string> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    const note = await client.query<{ id: string }>(
      `INSERT INTO visit_note (clinic_id, patient_id, author_user_id, status, signed_at, signed_by)
       VALUES ($1, $2, $3::uuid, $4::visit_note_status,
               CASE WHEN $4::text = 'draft' THEN NULL ELSE now() END,
               CASE WHEN $4::text = 'draft' THEN NULL ELSE $3::uuid END)
       RETURNING id`,
      [base.clinicId, patientId, base.providerId, status],
    );
    const noteId = note.rows[0]!.id;

    let lastVersionId = '';
    for (const [index, v] of versions.entries()) {
      const row = await client.query<{ id: string }>(
        `INSERT INTO visit_note_version
           (clinic_id, visit_note_id, version_number, kind, chief_complaint, plan,
            authored_by_user_id, frozen_at)
         VALUES ($1, $2, $3, $4::visit_note_version_kind, $5, $6, $7,
                 CASE WHEN $8::boolean THEN now() ELSE NULL END)
         RETURNING id`,
        [
          base.clinicId,
          noteId,
          index + 1,
          v.kind,
          v.chiefComplaint ?? null,
          v.plan ?? null,
          base.providerId,
          v.frozen,
        ],
      );
      lastVersionId = row.rows[0]!.id;
    }

    await client.query(`UPDATE visit_note SET current_version_id = $1 WHERE id = $2`, [
      lastVersionId,
      noteId,
    ]);
    await client.query('COMMIT');
    return noteId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

let signedNoteId: string;
let draftNoteId: string;
let heldNoteId: string;

beforeAll(async () => {
  base = await seedBaseline();

  const owner = await ownerPool.connect();
  try {
    await owner.query(
      `INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE code = 'doctor'`,
      [base.providerId],
    );
    const account = await owner.query<{ id: string }>(
      `INSERT INTO patient_account (clinic_id, patient_id, email, password_hash)
       VALUES ($1, $2, $3, '!') RETURNING id`,
      [base.clinicId, base.patientId, `notes-${randomUUID()}@test.local`],
    );
    accountId = account.rows[0]!.id;

    const other = await owner.query<{ id: string }>(
      `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
       VALUES ($1, $2, 'Other', 'Person', '1980-05-05') RETURNING id`,
      [base.clinicId, `OTH-${randomUUID().slice(0, 8)}`],
    );
    otherPatientId = other.rows[0]!.id;
  } finally {
    owner.release();
  }

  signedNoteId = await insertNote(base.patientId, 'amended', [
    { kind: 'signed', frozen: true, chiefComplaint: 'Sore throat PHRASE-SIGNED' },
    { kind: 'addendum', frozen: true, plan: 'Correction PHRASE-ADDENDUM' },
  ]);
  draftNoteId = await insertNote(base.patientId, 'draft', [
    { kind: 'draft', frozen: false, chiefComplaint: 'Unfinished PHRASE-DRAFT' },
  ]);
  heldNoteId = await insertNote(base.patientId, 'signed', [
    { kind: 'signed', frozen: true, chiefComplaint: 'Difficult news PHRASE-WITHHELD' },
  ]);
  await insertNote(otherPatientId, 'signed', [
    { kind: 'signed', frozen: true, chiefComplaint: 'Someone else PHRASE-OTHER' },
  ]);

  patientSession = {
    sessionId: randomUUID(),
    patientAccountId: accountId,
    patientId: base.patientId,
    clinicId: base.clinicId,
    clinicName: 'Test Clinic',
    clinicTimeZone: 'America/New_York',
    email: 'notes@test.local',
    fullName: 'Test Patient',
  };
});

afterAll(async () => {
  await closePools();
});

const doctor = () =>
  makeSession('doctor', { userId: base.providerId, clinicId: base.clinicId });
const receptionist = () =>
  makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId });

describe('a patient reading their visit notes', () => {
  it('sees their signed notes, with each addendum after the original', async () => {
    const { summaries } = await listMyVisitSummaries();
    const text = JSON.stringify(summaries);

    expect(text).toContain('PHRASE-SIGNED');
    expect(text).toContain('PHRASE-ADDENDUM');

    const amended = summaries.find((s) =>
      s.versions.some((v) => v.chiefComplaint?.includes('PHRASE-SIGNED')),
    )!;
    expect(amended.versions.map((v) => v.kind)).toEqual(['signed', 'addendum']);
  });

  it('never sees a draft, or anyone else’s notes', async () => {
    const text = JSON.stringify(await listMyVisitSummaries());
    expect(text).not.toContain('PHRASE-DRAFT');
    expect(text).not.toContain('PHRASE-OTHER');
  });

  it('records the read with the patient as the actor, and no note content in the log', async () => {
    const audit = await ownerPool.query<{
      subject_patient_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT subject_patient_id, metadata FROM audit_event
        WHERE action = 'note.read' AND actor_patient_account_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [accountId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.subject_patient_id).toBe(base.patientId);
    expect(audit.rows[0]!.metadata['scope']).toBe('portal_visit_summaries');
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain('PHRASE');
  });
});

describe('a clinician holding a note back', () => {
  it('is refused to anyone who cannot sign notes', async () => {
    actingAs(receptionist());
    await expect(
      setNotePortalVisibility(heldNoteId, base.patientId, {
        withhold: true,
        reason: 'A receptionist has no business deciding this',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    actingAs(null);
  });

  it('cannot be done without a reason — the database refuses it too', async () => {
    /*
     * The form rejects a short reason. This goes around the form, straight to the data
     * layer with a blank one, to prove the CHECK constraint holds on its own.
     */
    actingAs(doctor());
    await expect(
      setNotePortalVisibility(heldNoteId, base.patientId, {
        withhold: true,
        reason: '   ',
      }),
    ).rejects.toThrow();
    actingAs(null);
  });

  it('hides the content from the patient but tells them a note exists', async () => {
    actingAs(doctor());
    const result = await setNotePortalVisibility(heldNoteId, base.patientId, {
      withhold: true,
      reason: 'Discuss the result in person first',
    });
    expect(result.ok).toBe(true);
    actingAs(null);

    const { summaries, withheld } = await listMyVisitSummaries();
    expect(JSON.stringify(summaries)).not.toContain('PHRASE-WITHHELD');
    expect(JSON.stringify(withheld)).not.toContain('PHRASE-WITHHELD');
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!.clinicianName).toBeTruthy();

    const audit = await ownerPool.query<{ purpose: string }>(
      /* `allowed` only, newest first. The blank-reason attempt above was refused by the
         database and is in the log too, as an `error` row: every attempt is kept. */
      `SELECT purpose FROM audit_event
        WHERE action = 'note.withhold' AND entity_id = $1 AND outcome = 'allowed'
        ORDER BY occurred_at DESC LIMIT 1`,
      [heldNoteId],
    );
    expect(audit.rows[0]!.purpose).toBe('Discuss the result in person first');
  });

  it('releases it again, and the patient can read it', async () => {
    actingAs(doctor());
    expect(
      (await setNotePortalVisibility(heldNoteId, base.patientId, { withhold: false })).ok,
    ).toBe(true);
    // Nothing to release twice.
    const again = await setNotePortalVisibility(heldNoteId, base.patientId, {
      withhold: false,
    });
    expect(again.ok).toBe(false);
    actingAs(null);

    const { summaries, withheld } = await listMyVisitSummaries();
    expect(JSON.stringify(summaries)).toContain('PHRASE-WITHHELD');
    expect(withheld).toHaveLength(0);

    /* At least one: the second, no-op attempt is recorded as an attempt as well. */
    const released = await ownerPool.query(
      `SELECT 1 FROM audit_event
        WHERE action = 'note.release' AND entity_id = $1 AND outcome = 'allowed'`,
      [heldNoteId],
    );
    expect(released.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('has nothing to withhold on a draft', async () => {
    actingAs(doctor());
    const result = await setNotePortalVisibility(draftNoteId, base.patientId, {
      withhold: true,
      reason: 'Drafts are never visible anyway',
    });
    expect(result).toEqual({ ok: false, reason: 'not_signed' });
    actingAs(null);
  });

  it('refuses a patient id that is not the note’s patient', async () => {
    /* The claimed patient must match, or the audit row would name the wrong person. */
    actingAs(doctor());
    const result = await setNotePortalVisibility(signedNoteId, otherPatientId, {
      withhold: true,
      reason: 'Wrong patient on purpose',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    actingAs(null);
  });
});
