import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { clinic, patient, patientAccount, patientIdentity } from '@/db/schema';
import type { PatientSelfSignupInput } from '@/lib/patient-schemas';
import { describeError } from '@/lib/pg-errors';
import { writeAuditEvent } from '@/server/audit/log';
import { UNUSABLE_PASSWORD } from '@/server/auth/password';
import type { PendingSignup } from '@/server/auth/pending-signup';
import { allocateMrn } from '@/server/data-access/patients';

import { createPatientSession } from './session';

/**
 * A patient registering themselves online.
 *
 * ==========================================================================
 * ALWAYS A NEW RECORD. NEVER A MATCH.
 * ==========================================================================
 *
 * This never looks for an existing patient: no search by name, date of birth, phone, or
 * email. Anything a sign-up form collects, a stranger can know about someone else, and a
 * portal that attaches a visitor to an existing chart because the name and birthday line up
 * hands that visitor the other person's appointments. That is the classic way patient
 * portals leak records.
 *
 * So the worst case here is two records for one person, which is untidy and safe. The new
 * record is marked `self_registered_at`, and staff confirm the person's identity in person
 * before merging it with an older chart or trusting it with anything clinical. Until then it
 * holds only what the patient typed, plus appointments they book themselves.
 *
 * ==========================================================================
 * THE EMAIL COMES FROM GOOGLE, NOT FROM THE FORM
 * ==========================================================================
 *
 * Read from the signed pending token, which only the callback can issue, and only after
 * Google has verified the address. A visitor cannot register an address they do not control,
 * and so cannot squat on a real patient's email before that patient arrives.
 */

export type PatientSignupResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false };

export async function createSelfRegisteredPatient(
  pending: PendingSignup,
  fields: PatientSelfSignupInput,
  clinicId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<PatientSignupResult> {
  if (pending.aud !== 'portal') return { ok: false };

  const db = getDb();
  const now = new Date();

  try {
    return await db.transaction(async (tx): Promise<PatientSignupResult> => {
      const [target] = await tx
        .select({ id: clinic.id })
        .from(clinic)
        .where(eq(clinic.id, clinicId))
        .limit(1);
      if (!target) return { ok: false };

      /*
       * The only lookups, and neither is by anything a stranger could know: the verified
       * address, and Google's subject. If either already has a portal account, this person is
       * not new — the callback would normally have signed them straight in, so reaching here
       * means a race, and the answer is the ordinary generic refusal.
       */
      const [accountTaken] = await tx
        .select({ id: patientAccount.id })
        .from(patientAccount)
        .where(
          and(eq(patientAccount.email, pending.email), isNull(patientAccount.archivedAt)),
        )
        .limit(1);
      const [subjectTaken] = await tx
        .select({ id: patientIdentity.id })
        .from(patientIdentity)
        .where(
          and(
            eq(patientIdentity.provider, 'google'),
            eq(patientIdentity.subject, pending.sub),
            isNull(patientIdentity.revokedAt),
          ),
        )
        .limit(1);
      if (accountTaken || subjectTaken) return { ok: false };

      const mrn = await allocateMrn(tx, clinicId);

      const [record] = await tx
        .insert(patient)
        .values({
          clinicId,
          mrn,
          legalFirstName: fields.legalFirstName,
          legalLastName: fields.legalLastName,
          dateOfBirth: fields.dateOfBirth,
          phonePrimary: fields.phonePrimary ?? null,
          email: pending.email,
          /* No member of staff registered this record; that is exactly what the next
             column records instead. */
          registeredBy: null,
          selfRegisteredAt: now,
        })
        .returning({ id: patient.id });
      const patientId = record!.id;

      const [account] = await tx
        .insert(patientAccount)
        .values({
          clinicId,
          patientId,
          email: pending.email,
          /* Reachable only through the Google identity below. */
          passwordHash: UNUSABLE_PASSWORD,
          status: 'active',
          createdBy: null,
          lastLoginAt: now,
        })
        .returning({ id: patientAccount.id });
      const patientAccountId = account!.id;

      /*
       * The link doubles as the record of the patient's authorization to use Google here,
       * exactly as for a patient who connected Google to an account the clinic issued. They
       * read the same notice on the sign-in page before the redirect that made it.
       */
      await tx.insert(patientIdentity).values({
        patientAccountId,
        provider: 'google',
        subject: pending.sub,
        emailAtLink: pending.email,
        linkedIp: ip,
        lastUsedAt: now,
      });

      const actor = {
        clinicId,
        actorPatientAccountId: patientAccountId,
        actorIp: ip,
        actorUserAgent: userAgent,
        subjectPatientId: patientId,
      };

      /* Field NAMES, never their values — the audit log is not a second copy of the chart. */
      await writeAuditEvent(tx, {
        ...actor,
        action: 'patient.create',
        outcome: 'allowed',
        entityType: 'patient',
        entityId: patientId,
        metadata: {
          via: 'self_signup',
          fields: Object.keys(fields).filter(
            (key) => fields[key as keyof PatientSelfSignupInput] !== undefined,
          ),
        },
      });

      await writeAuditEvent(tx, {
        ...actor,
        action: 'identity.link',
        outcome: 'allowed',
        entityType: 'patient_identity',
        entityId: patientAccountId,
        metadata: { provider: 'google', via: 'self_signup' },
      });

      const session = await createPatientSession(tx, patientAccountId, userAgent);

      await writeAuditEvent(tx, {
        ...actor,
        sessionId: session.id,
        action: 'auth.login',
        outcome: 'allowed',
        metadata: { via: 'portal_google', firstSignIn: true },
      });

      return { ok: true, token: session.token, expiresAt: session.absoluteExpiresAt };
    });
  } catch (error) {
    /* A race on the unique indexes, or an outage. A code, never a message: this path's
       parameters are a new patient's name and date of birth. */
    console.error('[signup] patient self-registration failed:', describeError(error));
    return { ok: false };
  }
}
