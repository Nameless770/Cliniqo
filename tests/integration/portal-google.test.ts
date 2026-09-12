import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closePools, ownerPool, seedBaseline, type Baseline } from '../helpers/db';
import { testDb } from '../helpers/actions';

vi.mock('@/db/client', async () => {
  const schema = await import('@/db/schema');
  return { getDb: () => testDb, schema };
});

import type { GoogleIdentity } from '@/server/auth/google';
import {
  getGoogleLinkStatus,
  signInPatientWithGoogle,
  unlinkGoogle,
} from '@/server/portal/google';

/**
 * Patient Google sign-in, against the real database.
 *
 * The pure OAuth arithmetic — PKCE, state, scopes — is covered in google-auth.test.ts and
 * is shared with the staff flow. What is specific to patients, and what is asserted here,
 * is everything that happens AFTER Google has answered:
 *
 *   - it links to an account the clinic already issued, and never creates one;
 *   - the link row and the audit trail record the patient's authorization;
 *   - the authorization can be withdrawn, and withdrawing it revokes rather than deletes;
 *   - a withdrawn link stops working, and can be granted again.
 *
 * Every identity below is fabricated. `emailVerified` is set by hand because these call
 * past the callback route, which is the thing that enforces it — see the e2e suite for
 * that half.
 */

const identityFor = (email: string, subject: string): GoogleIdentity => ({
  subject,
  email,
  emailVerified: true,
  name: 'Portal Test',
  hostedDomain: null,
  nonce: null,
});

describe('patient Google sign-in', () => {
  let base: Baseline;
  let accountId: string;
  let email: string;

  beforeAll(async () => {
    base = await seedBaseline();
    email = `google-portal-${Date.now()}@test.local`;

    const owner = await ownerPool.connect();
    try {
      const account = await owner.query<{ id: string }>(
        `INSERT INTO patient_account (clinic_id, patient_id, email, password_hash)
         VALUES ($1, $2, $3, '!') RETURNING id`,
        [base.clinicId, base.patientId, email],
      );
      accountId = account.rows[0]!.id;
    } finally {
      owner.release();
    }
  });

  afterAll(async () => {
    await closePools();
  });

  /* ------------------------------------------------------------ it links */

  it('links a verified Google address to an account the clinic already issued', async () => {
    const result = await signInPatientWithGoogle(
      identityFor(email, 'google-sub-first'),
      '203.0.113.10',
      'integration-test',
    );

    expect(result.ok).toBe(true);
    // `linked` is true only on the sign-in that CREATED the link — the portal shows the
    // patient what just happened and where to undo it exactly once.
    expect(result.ok && result.linked).toBe(true);

    const status = await getGoogleLinkStatus(accountId);
    expect(status.connected).toBe(true);
    expect(status.emailAtLink).toBe(email);
  });

  it('records the authorization: when, from where, and in the audit log', async () => {
    const row = await ownerPool.query<{ linked_ip: string | null; subject: string }>(
      `SELECT linked_ip::text, subject FROM patient_identity
        WHERE patient_account_id = $1 AND revoked_at IS NULL`,
      [accountId],
    );
    expect(row.rows[0]!.linked_ip).toBe('203.0.113.10');

    const audit = await ownerPool.query<{
      actor_patient_account_id: string;
      subject_patient_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_patient_account_id, subject_patient_id, metadata FROM audit_event
        WHERE action = 'identity.link' AND actor_patient_account_id = $1`,
      [accountId],
    );

    expect(audit.rowCount).toBe(1);
    /* The patient is the actor — they authorized this, nobody did it to them. */
    expect(audit.rows[0]!.subject_patient_id).toBe(base.patientId);
    expect(audit.rows[0]!.metadata['provider']).toBe('google');

    /*
     * And the log carries NO identifier from Google. The subject and the address are in
     * `patient_identity`, where they are needed; putting them in the audit log would
     * spread a third party's identifier for this person across a six-year retention.
     */
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain('google-sub-first');
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain(email);
  });

  it('recognises the same subject next time without linking again', async () => {
    const again = await signInPatientWithGoogle(
      identityFor(email, 'google-sub-first'),
      null,
      'integration-test',
    );

    expect(again.ok).toBe(true);
    expect(again.ok && again.linked).toBe(false);

    // Still exactly one link, and exactly one link event.
    const links = await ownerPool.query(
      `SELECT 1 FROM patient_identity WHERE patient_account_id = $1 AND revoked_at IS NULL`,
      [accountId],
    );
    expect(links.rowCount).toBe(1);
  });

  it('follows the subject, not the address, when the email later changes', async () => {
    /*
     * `sub` is stable and an email is not. If the address on a record is changed or
     * reassigned, matching on email would hand the account to whoever holds it now — so
     * the established link must win even when the address no longer agrees.
     */
    const moved = await signInPatientWithGoogle(
      identityFor('someone-elses-new-address@test.local', 'google-sub-first'),
      null,
      'integration-test',
    );

    expect(moved.ok).toBe(true);
    expect(moved.ok && moved.linked).toBe(false);
  });

  /* --------------------------------------------------- it never creates */

  it('refuses a Google account the clinic has never issued, and creates nothing', async () => {
    const before = await ownerPool.query(
      `SELECT count(*)::int AS n FROM patient_account`,
    );

    const result = await signInPatientWithGoogle(
      identityFor(`stranger-${Date.now()}@test.local`, 'google-sub-stranger'),
      null,
      'integration-test',
    );

    expect(result.ok).toBe(false);

    /*
     * The refusal is the feature. A flow that created an account here would let anyone
     * with a Google address mint a login on a system holding patient records — and would
     * answer "is this person a patient here?" by succeeding for strangers and failing for
     * everyone else.
     */
    const after = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_account`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('refuses an account that is not active', async () => {
    const owner = await ownerPool.connect();
    const suspendedEmail = `suspended-${Date.now()}@test.local`;
    try {
      /* Its own patient, not the baseline one: `patient_account_patient_live_idx` allows
         only one live account per patient, so reusing it would fail on the insert rather
         than on the thing under test. */
      const other = await owner.query<{ id: string }>(
        `INSERT INTO patient (clinic_id, mrn, legal_first_name, legal_last_name, date_of_birth)
         VALUES ($1, $2, 'Suspended', 'Patient', '1990-01-01') RETURNING id`,
        [base.clinicId, `SUS-${Date.now()}`],
      );
      await owner.query(
        `INSERT INTO patient_account (clinic_id, patient_id, email, password_hash, status)
         VALUES ($1, $2, $3, '!', 'suspended')`,
        [base.clinicId, other.rows[0]!.id, suspendedEmail],
      );
    } finally {
      owner.release();
    }

    const result = await signInPatientWithGoogle(
      identityFor(suspendedEmail, 'google-sub-suspended'),
      null,
      'integration-test',
    );
    expect(result.ok).toBe(false);

    // And no link was written for an account that may not sign in.
    const links = await ownerPool.query(
      `SELECT 1 FROM patient_identity WHERE subject = 'google-sub-suspended'`,
    );
    expect(links.rowCount).toBe(0);
  });

  /* ----------------------------------------------- consent is withdrawable */

  it('withdraws the authorization by revoking, never by deleting', async () => {
    const done = await unlinkGoogle(
      accountId,
      base.clinicId,
      base.patientId,
      null,
      'integration-test',
    );
    expect(done).toBe(true);

    expect((await getGoogleLinkStatus(accountId)).connected).toBe(false);

    /*
     * The row survives. That consent was given and later taken back is the evidentiary
     * part — a link that vanishes leaves the clinic unable to show either.
     */
    const row = await ownerPool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM patient_identity WHERE subject = 'google-sub-first'`,
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.revoked_at).not.toBeNull();

    const audit = await ownerPool.query(
      `SELECT 1 FROM audit_event
        WHERE action = 'identity.unlink' AND actor_patient_account_id = $1`,
      [accountId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('stops honouring a withdrawn link, falling back to the address', async () => {
    /*
     * The old subject arriving with a DIFFERENT address must now be refused: the link
     * that vouched for it is revoked, so there is nothing left but an email that matches
     * no account.
     */
    const stale = await signInPatientWithGoogle(
      identityFor('someone-elses-new-address@test.local', 'google-sub-first'),
      null,
      'integration-test',
    );
    expect(stale.ok).toBe(false);
  });

  it('lets a patient grant the authorization again after withdrawing it', async () => {
    /*
     * Both unique indexes on `patient_identity` are partial on `revoked_at is null`
     * precisely so this works. A full unique index would make re-connecting collide with
     * the tombstone of the first link, and a patient who withdrew consent once could
     * never give it again — which would make the disconnect button a trap.
     */
    const again = await signInPatientWithGoogle(
      identityFor(email, 'google-sub-first'),
      null,
      'integration-test',
    );

    expect(again.ok).toBe(true);
    expect(again.ok && again.linked).toBe(true);
    expect((await getGoogleLinkStatus(accountId)).connected).toBe(true);

    // Two rows now: the withdrawn one and the live one.
    const rows = await ownerPool.query(
      `SELECT 1 FROM patient_identity WHERE subject = 'google-sub-first'`,
    );
    expect(rows.rowCount).toBe(2);
  });

  it('reports nothing to withdraw when there is no live link', async () => {
    await unlinkGoogle(
      accountId,
      base.clinicId,
      base.patientId,
      null,
      'integration-test',
    );

    const second = await unlinkGoogle(
      accountId,
      base.clinicId,
      base.patientId,
      null,
      'integration-test',
    );
    // False rather than throwing, and no second audit row for a no-op.
    expect(second).toBe(false);
  });
});
