import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  appPool,
  closePools,
  ownerPool,
  seedBaseline,
  type Baseline,
} from '../helpers/db';
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

import { AuthorizationError } from '@/server/auth/authorize';
import {
  getMergeProvenance,
  listMergeCandidates,
  mergePatients,
  reverseMerge,
} from '@/server/data-access/patient-merge';

/**
 * Patient merge, against the real database.
 *
 * The property under test is not "a row was written" — it is that clinical data which was
 * invisible on one chart is visible on the other afterwards, and that the audit trail of
 * the folded-away chart survives intact. Those are the two things a merge exists to do and
 * must never stop doing.
 */
describe('merging a duplicate chart', () => {
  let base: Baseline;

  const admin = () =>
    actingAs(makeSession('admin', { userId: base.providerId, clinicId: base.clinicId }));

  /** A second chart for the same person, as self-registration would create it. */
  async function makeDuplicate(lastName = 'Merge', dob = '1980-02-03') {
    const t = randomUUID().slice(0, 8);
    const row = await ownerPool.query<{ id: string }>(
      `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name,
                            date_of_birth, self_registered_at)
       VALUES ($1, $2, 'Dup', $3, $4, now()) RETURNING id`,
      [base.clinicId, `TST-${t}`, lastName, dob],
    );
    return row.rows[0]!.id;
  }

  async function makeSurvivor(lastName = 'Merge', dob = '1980-02-03') {
    const t = randomUUID().slice(0, 8);
    const row = await ownerPool.query<{ id: string }>(
      `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
       VALUES ($1, $2, 'Keep', $3, $4) RETURNING id`,
      [base.clinicId, `TST-${t}`, lastName, dob],
    );
    return row.rows[0]!.id;
  }

  /** The allergy that is the whole point: recorded on A, invisible to a reader of B. */
  async function addAllergy(patientId: string, name: string) {
    const row = await ownerPool.query<{ id: string }>(
      `INSERT INTO patient_allergy (clinic_id, patient_id, allergen_type, allergen_name)
       VALUES ($1, $2, 'drug', $3) RETURNING id`,
      [base.clinicId, patientId, name],
    );
    return row.rows[0]!.id;
  }

  beforeAll(async () => {
    base = await seedBaseline();
  });

  afterAll(async () => {
    await closePools();
  });

  it('moves the clinical rows, so an allergy on the duplicate is visible on the survivor', async () => {
    admin();
    const survivor = await makeSurvivor();
    const duplicate = await makeDuplicate();
    const allergyId = await addAllergy(duplicate, 'Penicillin');

    const result = await mergePatients(
      survivor,
      duplicate,
      'Checked photo ID at the desk',
    );

    expect(result.ok).toBe(true);

    const moved = await appPool.query<{ patient_id: string }>(
      `SELECT patient_id FROM patient_allergy WHERE id = $1`,
      [allergyId],
    );
    expect(moved.rows[0]!.patient_id).toBe(survivor);
  });

  it('marks and archives the duplicate, and points it at the survivor', async () => {
    admin();
    const survivor = await makeSurvivor();
    const duplicate = await makeDuplicate();

    await mergePatients(survivor, duplicate, 'Same person, confirmed at reception');

    const row = await appPool.query<{
      merged_into_patient_id: string;
      archived_at: Date | null;
      mrn: string;
    }>(`SELECT merged_into_patient_id, archived_at, mrn FROM patient WHERE id = $1`, [
      duplicate,
    ]);

    expect(row.rows[0]!.merged_into_patient_id).toBe(survivor);
    /* Archived so it leaves search — a chart still in a lookup is one somebody
       documents into. */
    expect(row.rows[0]!.archived_at).not.toBeNull();
    /* The MRN is kept forever: it identifies a record that still exists, and an old
       reference to it must still resolve. */
    expect(row.rows[0]!.mrn).toBeTruthy();
  });

  it('leaves the folded-away chart its own audit trail', async () => {
    admin();
    const survivor = await makeSurvivor();
    const duplicate = await makeDuplicate();

    /* A read BEFORE the merge: the disclosure that a §164.528 accounting for the old MRN
       must still be able to report afterwards. */
    await listMergeCandidates(duplicate);
    await mergePatients(survivor, duplicate, 'Duplicate created by online sign-up');

    const trail = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_event WHERE subject_patient_id = $1`,
      [duplicate],
    );
    expect(Number(trail.rows[0]!.n)).toBeGreaterThan(0);

    /* And the merge itself is recorded against BOTH charts, so neither accounting ends
       abruptly with no explanation of where the data went. */
    const merges = await appPool.query<{ subject_patient_id: string }>(
      `SELECT subject_patient_id FROM audit_event
        WHERE action = 'patient.merge' AND subject_patient_id IN ($1, $2)`,
      [survivor, duplicate],
    );
    const subjects = new Set(merges.rows.map((r) => r.subject_patient_id));
    expect(subjects.has(survivor)).toBe(true);
    expect(subjects.has(duplicate)).toBe(true);
  });

  it('refuses a receptionist, and records the refusal', async () => {
    actingAs(
      makeSession('receptionist', { userId: base.providerId, clinicId: base.clinicId }),
    );
    const survivor = await makeSurvivor();
    const duplicate = await makeDuplicate();

    await expect(
      mergePatients(survivor, duplicate, 'Front desk trying to merge charts'),
    ).rejects.toBeInstanceOf(AuthorizationError);

    /* Refusals are logged as the fixed action `authz.denied`, with the permission in
       metadata — never as the action that was refused, which would produce an unbounded
       set of action names. */
    const denied = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_event
        WHERE action = 'authz.denied' AND outcome = 'denied'
          AND metadata->>'permission' = 'patient.merge'`,
    );
    expect(Number(denied.rows[0]!.n)).toBeGreaterThan(0);

    /* Nothing moved. */
    const row = await appPool.query<{ merged_into_patient_id: string | null }>(
      `SELECT merged_into_patient_id FROM patient WHERE id = $1`,
      [duplicate],
    );
    expect(row.rows[0]!.merged_into_patient_id).toBeNull();
  });

  it('refuses a doctor: reconciling records is not a clinical act', async () => {
    actingAs(makeSession('doctor', { userId: base.providerId, clinicId: base.clinicId }));
    await expect(
      mergePatients(await makeSurvivor(), await makeDuplicate(), 'Clinician merging'),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('refuses to merge a chart into itself', async () => {
    admin();
    const one = await makeSurvivor();
    const result = await mergePatients(one, one, 'Nonsense but reachable by hand');
    expect(result).toEqual({ ok: false, reason: 'same_patient' });
  });

  it('refuses to merge a chart that was already merged away', async () => {
    admin();
    const survivor = await makeSurvivor();
    const duplicate = await makeDuplicate();
    await mergePatients(survivor, duplicate, 'First merge, correct');

    const second = await mergePatients(await makeSurvivor(), duplicate, 'Second attempt');
    expect(second).toEqual({ ok: false, reason: 'already_merged' });
  });

  it('refuses to build a chain by merging into a chart already merged away', async () => {
    admin();
    const finalChart = await makeSurvivor();
    const middle = await makeSurvivor();
    const first = await makeDuplicate();

    await mergePatients(finalChart, middle, 'Middle folded into the final chart');

    const chained = await mergePatients(middle, first, 'Would make a chain');
    expect(chained).toEqual({ ok: false, reason: 'survivor_merged' });
  });

  it('refuses a chart from another clinic without saying it exists', async () => {
    admin();
    const other = await ownerPool.query<{ id: string }>(
      `INSERT INTO clinic (name, timezone, mrn_prefix) VALUES ($1,'UTC','OTH') RETURNING id`,
      [`Other Clinic ${randomUUID().slice(0, 8)}`],
    );
    const foreign = await ownerPool.query<{ id: string }>(
      `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
       VALUES ($1, $2, 'Foreign', 'Patient', '1980-02-03') RETURNING id`,
      [other.rows[0]!.id, `OTH-${randomUUID().slice(0, 8)}`],
    );

    const result = await mergePatients(
      await makeSurvivor(),
      foreign.rows[0]!.id,
      'Cross-tenant attempt',
    );
    /* The same message as a genuinely missing record: telling them apart would confirm
       which ids are patients at another clinic. */
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('undoes a merge using the manifest, without taking rows the survivor already had', async () => {
    admin();
    const survivor = await makeSurvivor();
    const duplicate = await makeDuplicate();

    const survivorOwn = await addAllergy(survivor, 'Latex');
    const movedAllergy = await addAllergy(duplicate, 'Aspirin');

    const merged = await mergePatients(survivor, duplicate, 'Merged, later disputed');
    expect(merged.ok).toBe(true);

    const mergeRow = await appPool.query<{ id: string }>(
      `SELECT id FROM patient_merge WHERE duplicate_patient_id = $1 AND reversed_at IS NULL`,
      [duplicate],
    );

    const reversed = await reverseMerge(
      mergeRow.rows[0]!.id,
      'They turned out to be siblings',
    );
    expect(reversed.ok).toBe(true);

    const after = await appPool.query<{ id: string; patient_id: string }>(
      `SELECT id, patient_id FROM patient_allergy WHERE id = ANY($1::uuid[])`,
      [[survivorOwn, movedAllergy]],
    );
    const byId = new Map(after.rows.map((r) => [r.id, r.patient_id]));

    /* The moved row goes back... */
    expect(byId.get(movedAllergy)).toBe(duplicate);
    /* ...and the survivor's own row stays put. This is why the manifest exists: "move
       back everything attached to the survivor" would have taken this one too. */
    expect(byId.get(survivorOwn)).toBe(survivor);

    const cleared = await appPool.query<{ merged_into_patient_id: string | null }>(
      `SELECT merged_into_patient_id FROM patient WHERE id = $1`,
      [duplicate],
    );
    expect(cleared.rows[0]!.merged_into_patient_id).toBeNull();
  });

  it('refuses to undo the same merge twice', async () => {
    admin();
    const survivor = await makeSurvivor();
    const duplicate = await makeDuplicate();
    await mergePatients(survivor, duplicate, 'To be undone twice');

    const row = await appPool.query<{ id: string }>(
      `SELECT id FROM patient_merge WHERE duplicate_patient_id = $1 AND reversed_at IS NULL`,
      [duplicate],
    );
    await reverseMerge(row.rows[0]!.id, 'First undo, legitimate');

    const again = await reverseMerge(row.rows[0]!.id, 'Second undo attempt');
    expect(again).toEqual({ ok: false, reason: 'already_reversed' });
  });

  it('shows the survivor what it absorbed, and the duplicate where it went', async () => {
    admin();
    const survivor = await makeSurvivor('Provenance');
    const duplicate = await makeDuplicate('Provenance');
    await mergePatients(survivor, duplicate, 'Confirmed by insurance card');

    const fromDuplicate = await getMergeProvenance(duplicate);
    expect(fromDuplicate.mergedInto?.patientId).toBe(survivor);

    const fromSurvivor = await getMergeProvenance(survivor);
    expect(fromSurvivor.absorbed.map((a) => a.patientId)).toContain(duplicate);
  });

  it('offers candidates that share a surname and birthday, never the chart itself', async () => {
    admin();
    const lastName = `Candidate${randomUUID().slice(0, 6)}`;
    const survivor = await makeSurvivor(lastName, '1975-06-07');
    const duplicate = await makeDuplicate(lastName, '1975-06-07');

    const candidates = await listMergeCandidates(survivor);
    const ids = candidates.map((c) => c.id);

    expect(ids).toContain(duplicate);
    expect(ids).not.toContain(survivor);
  });

  it('stops offering a chart once it has been merged away', async () => {
    admin();
    const lastName = `Gone${randomUUID().slice(0, 6)}`;
    const survivor = await makeSurvivor(lastName, '1966-03-04');
    const duplicate = await makeDuplicate(lastName, '1966-03-04');

    await mergePatients(survivor, duplicate, 'Folded away already');

    const candidates = await listMergeCandidates(survivor);
    expect(candidates.map((c) => c.id)).not.toContain(duplicate);
  });
});
