import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appPool, closePools, errorCode, seedBaseline, type Baseline } from '../helpers/db';

/**
 * The legal record cannot be altered after it is signed.
 *
 * HIPAA §164.526 gives a patient the right to AMEND a record — which is not the right to
 * overwrite one. A correction appends; the superseded text stays readable. That is what
 * makes "signed on the 3rd" a verifiable claim rather than an assertion about whatever
 * the row happens to say today.
 *
 * These guards live in migration 0001 as database triggers, not only in the write path,
 * and that is the point being tested here. The application has no UPDATE statement for a
 * signed note — but "no code path does this" is a property of today's code, while a
 * trigger is a property of the data. Anything that reaches this database, including a
 * migration, an admin console, or a bug in a future feature, meets the same refusal.
 *
 * All three triggers raise with ERRCODE 'raise_exception', which surfaces as P0001.
 */
const RAISE_EXCEPTION = 'P0001';

/* Pools are module-level and shared by every describe below, so they are closed ONCE for
   the file. Closing them in a per-suite afterAll ends them for the suites that follow. */
afterAll(closePools);

describe('signed clinical records are frozen at the database level', () => {
  let base: Baseline;
  let noteId: string;
  let draftVersionId: string;
  let signedVersionId: string;

  beforeAll(async () => {
    base = await seedBaseline();

    const note = await appPool.query<{ id: string }>(
      `INSERT INTO visit_note (clinic_id, patient_id, author_user_id, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [base.clinicId, base.patientId, base.providerId],
    );
    noteId = note.rows[0]!.id;

    const mkVersion = async (n: number, kind: string, frozen: boolean) => {
      const row = await appPool.query<{ id: string }>(
        `INSERT INTO visit_note_version
           (visit_note_id, version_number, kind, assessment, authored_by_user_id, clinic_id, frozen_at)
         VALUES ($1, $2, $3::visit_note_version_kind, $4, $5, $6, ${frozen ? 'now()' : 'NULL'})
         RETURNING id`,
        [noteId, n, kind, `assessment v${n}`, base.providerId, base.clinicId],
      );
      return row.rows[0]!.id;
    };

    draftVersionId = await mkVersion(1, 'draft', false);
    signedVersionId = await mkVersion(2, 'signed', true);
  });

  it('allows an UNSIGNED draft to be edited in place', async () => {
    // A draft is a working document, not part of the record. If this failed, autosave
    // would be impossible and every keystroke would need a new version row.
    await expect(
      appPool.query(`UPDATE visit_note_version SET assessment = $1 WHERE id = $2`, [
        'revised while still a draft',
        draftVersionId,
      ]),
    ).resolves.toBeDefined();
  });

  it('refuses to UPDATE a signed version', async () => {
    await expect(
      appPool.query(`UPDATE visit_note_version SET assessment = $1 WHERE id = $2`, [
        'quietly rewritten after signing',
        signedVersionId,
      ]),
    ).rejects.toSatisfy((e: unknown) => errorCode(e) === RAISE_EXCEPTION);
  });

  it('refuses to DELETE a signed version', async () => {
    await expect(
      appPool.query(`DELETE FROM visit_note_version WHERE id = $1`, [signedVersionId]),
    ).rejects.toSatisfy((e: unknown) => errorCode(e) === RAISE_EXCEPTION);
  });

  it('leaves the signed text exactly as it was', async () => {
    const { rows } = await appPool.query<{ assessment: string }>(
      `SELECT assessment FROM visit_note_version WHERE id = $1`,
      [signedVersionId],
    );
    expect(rows[0]!.assessment).toBe('assessment v2');
  });

  it('still allows an addendum to be APPENDED', async () => {
    // Freezing must not mean the note is closed to correction — that would defeat
    // 164.526. Amendment appends a new version; it does not touch the old one.
    await expect(
      appPool.query(
        `INSERT INTO visit_note_version
           (visit_note_id, version_number, kind, assessment, authored_by_user_id, clinic_id, supersedes_version_id)
         VALUES ($1, 3, 'addendum', 'correction appended', $2, $3, $4)`,
        [noteId, base.providerId, base.clinicId, signedVersionId],
      ),
    ).resolves.toBeDefined();
  });
});

describe('issued prescriptions are frozen at the database level', () => {
  let base: Baseline;
  let draftRxId: string;
  let signedRxId: string;
  let signedItemId: string;

  beforeAll(async () => {
    base = await seedBaseline();

    const mkRx = async (status: string) => {
      const row = await appPool.query<{ id: string }>(
        `INSERT INTO prescription (clinic_id, patient_id, prescriber_user_id, status)
         VALUES ($1, $2, $3, $4::prescription_status) RETURNING id`,
        [base.clinicId, base.patientId, base.providerId, status],
      );
      return row.rows[0]!.id;
    };

    draftRxId = await mkRx('draft');
    signedRxId = await mkRx('draft'); // items are added while it is still a draft

    const item = await appPool.query<{ id: string }>(
      `INSERT INTO prescription_item (prescription_id, medication_id, dose, sequence)
       VALUES ($1, $2, '5 mg', 1) RETURNING id`,
      [signedRxId, base.medicationId],
    );
    signedItemId = item.rows[0]!.id;

    // Sign it. From here the trigger reads the parent's status on every item write.
    await appPool.query(
      `UPDATE prescription SET status = 'signed', signed_at = now() WHERE id = $1`,
      [signedRxId],
    );
  });

  it('allows items on a DRAFT prescription to be changed', async () => {
    const item = await appPool.query<{ id: string }>(
      `INSERT INTO prescription_item (prescription_id, medication_id, dose, sequence)
       VALUES ($1, $2, '10 mg', 1) RETURNING id`,
      [draftRxId, base.medicationId],
    );
    await expect(
      appPool.query(`UPDATE prescription_item SET dose = '20 mg' WHERE id = $1`, [
        item.rows[0]!.id,
      ]),
    ).resolves.toBeDefined();
  });

  it('refuses to change an item once the prescription is signed', async () => {
    // The dangerous edit: silently changing a dose on a prescription already dispensed.
    await expect(
      appPool.query(`UPDATE prescription_item SET dose = '500 mg' WHERE id = $1`, [
        signedItemId,
      ]),
    ).rejects.toSatisfy((e: unknown) => errorCode(e) === RAISE_EXCEPTION);
  });

  it('refuses to DELETE an item once the prescription is signed', async () => {
    await expect(
      appPool.query(`DELETE FROM prescription_item WHERE id = $1`, [signedItemId]),
    ).rejects.toSatisfy((e: unknown) => errorCode(e) === RAISE_EXCEPTION);
  });

  it('leaves the dispensed dose exactly as issued', async () => {
    const { rows } = await appPool.query<{ dose: string }>(
      `SELECT dose FROM prescription_item WHERE id = $1`,
      [signedItemId],
    );
    expect(rows[0]!.dose).toBe('5 mg');
  });
});

describe('controlled substances are refused', () => {
  let base: Baseline;
  let controlledMedId: string;

  beforeAll(async () => {
    base = await seedBaseline();
    const med = await appPool.query<{ id: string }>(
      `INSERT INTO medication (name, strength, is_controlled, dea_schedule)
       VALUES ($1, '5mg', true, 'II') RETURNING id`,
      [`Controlledazole ${Date.now()}`],
    );
    controlledMedId = med.rows[0]!.id;
  });

  /*
   * Cliniqo does not implement DEA EPCS, so it must not be capable of transmitting a
   * controlled-substance prescription at all. This is a refusal by design, not a missing
   * feature: a system that quietly allows one is a compliance problem, and a UI that
   * merely hides the option is not a control.
   */
  it('blocks a controlled medication even on a draft prescription', async () => {
    const rx = await appPool.query<{ id: string }>(
      `INSERT INTO prescription (clinic_id, patient_id, prescriber_user_id, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [base.clinicId, base.patientId, base.providerId],
    );

    await expect(
      appPool.query(
        `INSERT INTO prescription_item (prescription_id, medication_id, dose, sequence)
         VALUES ($1, $2, '5 mg', 1)`,
        [rx.rows[0]!.id, controlledMedId],
      ),
    ).rejects.toSatisfy((e: unknown) => errorCode(e) === RAISE_EXCEPTION);
  });
});
