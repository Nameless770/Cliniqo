import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { clinic, patient, patientAccount } from '@/db/schema';
import type { PatientPasswordSignupInput } from '@/lib/patient-schemas';
import { describeError } from '@/lib/pg-errors';
import { writeAuditEvent } from '@/server/audit/log';
import { hashPassword } from '@/server/auth/password';
import { allocateMrn } from '@/server/data-access/patients';

/**
 * A patient creating a portal account with an email address and a password.
 *
 * ==========================================================================
 * WHAT IT PROTECTS, AND WHAT IT CANNOT
 * ==========================================================================
 *
 * ALWAYS A NEW RECORD. It never looks for an existing patient by name, date of birth or
 * anything else a stranger could know — attaching a visitor to someone's chart on a matching
 * birthday is how portals leak records. Staff confirm identity at the first visit.
 *
 * NEVER SIGNS IN, and answers identically whether or not the address was free: the caller
 * shows the same page either way, and the password is hashed before the address is looked up
 * so the response time does not tell either.
 *
 * NEVER OVERWRITES. A taken address changes nothing; above all it never replaces the existing
 * account's password.
 *
 * NEVER LINKED TO GOOGLE BY EMAIL. The record is marked self-registered, and the portal
 * Google sign-in refuses to attach itself to such a record by address — otherwise someone
 * could register a real patient's address and share their account once they used Google.
 *
 * What it CANNOT do without sending email: stop someone who registers an address, then fails
 * to sign in with the password they chose, from concluding the address already had an
 * account — that is, that its owner is a patient here. Sign-in rate limits and lockout slow
 * that down. Only a confirmation email closes it, and email needs a BAA-covered vendor.
 */

export async function registerPatientWithPassword(
  input: PatientPasswordSignupInput,
  clinicId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<{ created: boolean }> {
  /* First, unconditionally. See the header. */
  const passwordHash = await hashPassword(input.password);

  try {
    return await getDb().transaction(async (tx) => {
      const [target] = await tx
        .select({ id: clinic.id })
        .from(clinic)
        .where(eq(clinic.id, clinicId))
        .limit(1);
      if (!target) return { created: false };

      /* The only lookup: whether this address already has a portal account. Never a patient search. */
      const [taken] = await tx
        .select({ id: patientAccount.id })
        .from(patientAccount)
        .where(
          and(eq(patientAccount.email, input.email), isNull(patientAccount.archivedAt)),
        )
        .limit(1);
      if (taken) return { created: false };

      const now = new Date();
      const mrn = await allocateMrn(tx, clinicId);

      const [record] = await tx
        .insert(patient)
        .values({
          clinicId,
          mrn,
          legalFirstName: input.legalFirstName,
          legalLastName: input.legalLastName,
          dateOfBirth: input.dateOfBirth,
          phonePrimary: input.phonePrimary ?? null,
          email: input.email,
          registeredBy: null,
          selfRegisteredAt: now,
        })
        .returning({ id: patient.id });

      const [account] = await tx
        .insert(patientAccount)
        .values({
          clinicId,
          patientId: record!.id,
          email: input.email,
          passwordHash,
          passwordChangedAt: now,
          status: 'active',
          createdBy: null,
        })
        .returning({ id: patientAccount.id });

      /* Field NAMES, never values: the audit log is not a second copy of the record. */
      await writeAuditEvent(tx, {
        clinicId,
        actorPatientAccountId: account!.id,
        actorIp: ip,
        actorUserAgent: userAgent,
        subjectPatientId: record!.id,
        action: 'patient.create',
        outcome: 'allowed',
        entityType: 'patient',
        entityId: record!.id,
        metadata: {
          via: 'self_signup_password',
          emailConfirmed: false,
          fields: ['legalFirstName', 'legalLastName', 'dateOfBirth'].concat(
            input.phonePrimary ? ['phonePrimary'] : [],
          ),
        },
      });

      return { created: true };
    });
  } catch (error) {
    /* A race on the unique address index lands here. A code, never a message: the parameters
       are a new patient's name and date of birth. */
    console.error('[signup] patient password registration failed:', describeError(error));
    return { created: false };
  }
}
