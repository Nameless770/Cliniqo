import 'server-only';

import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm';

import {
  appointment,
  appointmentType,
  auditEvent,
  medication,
  patient,
  patientAllergy,
  patientFlag,
  prescription,
  prescriptionItem,
  userAccount,
  visitNote,
  visitNoteVersion,
} from '@/db/schema';

import { auditedRead } from './audited';

/**
 * Patient rights — security review findings F8 and F9.
 *
 * Two obligations that both read a patient's data and both produce something that LEAVES
 * the system, which is why each gets its own audit action rather than passing as an
 * ordinary read:
 *
 *   §164.524 right of access      — the record itself, within 30 days
 *   §164.528 accounting of
 *     disclosures                 — who accessed it, six years back
 */

/* -------------------------------------------------------------------------- */
/* F9 — Accounting of disclosures (§164.528)                                   */
/* -------------------------------------------------------------------------- */

export type DisclosureEntry = {
  occurredAt: Date;
  action: string;
  actorName: string | null;
  actorRoles: string[] | null;
  purpose: string | null;
  viaBreakGlass: boolean;
};

export type DisclosureAccounting = {
  patientMrn: string;
  patientName: string;
  from: Date;
  to: Date;
  entries: DisclosureEntry[];
  truncated: boolean;
};

/** Six years, the statutory look-back. */
export const ACCOUNTING_YEARS = 6;

/**
 * Who accessed this patient's record, and when.
 *
 * This is the report the audit schema was shaped for. `subject_patient_id` was made a
 * real indexed foreign key — and populated on EVERY PHI event regardless of which object
 * was actually read — specifically so this is one index range scan rather than a walk
 * across every entity type resolving each back to a patient.
 *
 * Gated on `audit.read`, so administrators only. The person who answers "who looked at my
 * record" should be the one with oversight of the log, not everyone who can open the
 * chart — otherwise the answer is produced by someone who may be in it.
 *
 * Excludes nothing. A denied attempt and a break-glass access are exactly what a patient
 * asking this question wants to know about.
 */
export async function getDisclosureAccounting(
  patientId: string,
  from: Date,
  to: Date,
): Promise<DisclosureAccounting | null> {
  const LIMIT = 5000;

  return auditedRead(
    {
      permission: 'audit.read',
      action: 'disclosure.accounting',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      metadata: {
        windowFrom: from.toISOString(),
        windowTo: to.toISOString(),
      },
    },
    async (tx, session) => {
      const [subject] = await tx
        .select({
          mrn: patient.mrn,
          first: patient.legalFirstName,
          last: patient.legalLastName,
        })
        .from(patient)
        .where(and(eq(patient.id, patientId), eq(patient.clinicId, session.clinicId)))
        .limit(1);

      if (!subject) return null;

      const rows = await tx
        .select({
          occurredAt: auditEvent.occurredAt,
          action: auditEvent.action,
          actorName: userAccount.fullName,
          actorRoles: auditEvent.actorRoleCodes,
          purpose: auditEvent.purpose,
          breakGlassGrantId: auditEvent.breakGlassGrantId,
        })
        .from(auditEvent)
        // LEFT join: an entry must survive the actor's account being archived.
        .leftJoin(userAccount, eq(userAccount.id, auditEvent.actorUserId))
        .where(
          and(
            eq(auditEvent.subjectPatientId, patientId),
            gte(auditEvent.occurredAt, from),
            lte(auditEvent.occurredAt, to),
          ),
        )
        .orderBy(desc(auditEvent.occurredAt))
        .limit(LIMIT + 1);

      const truncated = rows.length > LIMIT;

      return {
        patientMrn: subject.mrn,
        patientName: `${subject.last}, ${subject.first}`,
        from,
        to,
        entries: rows.slice(0, LIMIT).map((r) => ({
          occurredAt: r.occurredAt,
          action: r.action,
          actorName: r.actorName,
          actorRoles: r.actorRoles,
          purpose: r.purpose,
          viaBreakGlass: r.breakGlassGrantId !== null,
        })),
        truncated,
      };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* F8 — Record export (§164.524)                                               */
/* -------------------------------------------------------------------------- */

export type PatientExport = {
  generatedAt: Date;
  clinic: string;
  demographics: Record<string, string | null>;
  allergies: { allergen: string; reaction: string | null; severity: string | null }[];
  flags: { label: string; detail: string | null; severity: string }[];
  appointments: { when: Date | null; type: string; clinician: string; status: string }[];
  notes: {
    signedAt: Date | null;
    author: string;
    versions: {
      version: number;
      kind: string;
      authoredAt: Date;
      chiefComplaint: string | null;
      subjective: string | null;
      objective: string | null;
      assessment: string | null;
      plan: string | null;
    }[];
  }[];
  prescriptions: {
    issuedAt: Date | null;
    prescriber: string;
    status: string;
    medication: string;
    dose: string | null;
    frequency: string | null;
    instructions: string | null;
  }[];
};

/**
 * A patient's complete record, for disclosure to them.
 *
 * ONE audited operation, not six. A right-of-access export is a single disclosure event —
 * logging it as separate patient/note/prescription reads would scatter one legally
 * significant act across the log and make it invisible as what it was. The action is
 * `patient.export` precisely so "who took a full copy of this chart" is a single query.
 *
 * Includes every note version, not just the current one: the record is what was written
 * and when it changed, and an export showing only the latest text would misrepresent an
 * amended note as though it had always said that.
 *
 * Excludes internal machinery — row versions, soft-delete columns, audit rows. The patient
 * is entitled to their record, not to the database's bookkeeping.
 */
export async function exportPatientRecord(
  patientId: string,
): Promise<PatientExport | null> {
  return auditedRead(
    {
      permission: 'patient.export',
      action: 'patient.export',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      metadata: { scope: 'full_record_disclosure' },
    },
    async (tx, session) => {
      const [p] = await tx
        .select()
        .from(patient)
        .where(and(eq(patient.id, patientId), eq(patient.clinicId, session.clinicId)))
        .limit(1);

      if (!p) return null;

      const allergies = await tx
        .select({
          allergen: patientAllergy.allergenName,
          reaction: patientAllergy.reaction,
          severity: patientAllergy.severity,
        })
        .from(patientAllergy)
        .where(
          and(eq(patientAllergy.patientId, patientId), isNull(patientAllergy.archivedAt)),
        );
      const flags = await tx
        .select({
          label: patientFlag.label,
          detail: patientFlag.detail,
          severity: patientFlag.severity,
        })
        .from(patientFlag)
        .where(and(eq(patientFlag.patientId, patientId), isNull(patientFlag.archivedAt)));
      const appts = await tx
        .select({
          when: appointment.startsAt,
          type: appointmentType.displayName,
          clinician: userAccount.fullName,
          status: appointment.status,
        })
        .from(appointment)
        .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
        .innerJoin(userAccount, eq(userAccount.id, appointment.providerUserId))
        .where(and(eq(appointment.patientId, patientId), isNull(appointment.archivedAt)))
        .orderBy(desc(appointment.startsAt));
      const notes = await tx
        .select({
          noteId: visitNote.id,
          signedAt: visitNote.signedAt,
          author: userAccount.fullName,
        })
        .from(visitNote)
        .innerJoin(userAccount, eq(userAccount.id, visitNote.authorUserId))
        .where(and(eq(visitNote.patientId, patientId), isNull(visitNote.archivedAt)))
        .orderBy(desc(visitNote.createdAt));
      const scripts = await tx
        .select({
          issuedAt: prescription.signedAt,
          prescriber: userAccount.fullName,
          status: prescription.status,
          medication: medication.name,
          dose: prescriptionItem.dose,
          frequency: prescriptionItem.frequency,
          instructions: prescriptionItem.instructions,
        })
        .from(prescription)
        .innerJoin(userAccount, eq(userAccount.id, prescription.prescriberUserId))
        .innerJoin(prescriptionItem, eq(prescriptionItem.prescriptionId, prescription.id))
        .innerJoin(medication, eq(medication.id, prescriptionItem.medicationId))
        .where(
          and(eq(prescription.patientId, patientId), isNull(prescription.archivedAt)),
        )
        .orderBy(desc(prescription.signedAt));

      const notesWithVersions = [];
      for (const note of notes) {
        const versions = await tx
          .select({
            version: visitNoteVersion.versionNumber,
            kind: visitNoteVersion.kind,
            authoredAt: visitNoteVersion.authoredAt,
            chiefComplaint: visitNoteVersion.chiefComplaint,
            subjective: visitNoteVersion.subjective,
            objective: visitNoteVersion.objective,
            assessment: visitNoteVersion.assessment,
            plan: visitNoteVersion.plan,
          })
          .from(visitNoteVersion)
          .where(eq(visitNoteVersion.visitNoteId, note.noteId))
          .orderBy(asc(visitNoteVersion.versionNumber));

        notesWithVersions.push({
          signedAt: note.signedAt,
          author: note.author,
          versions,
        });
      }

      return {
        generatedAt: new Date(),
        clinic: session.clinicName,
        demographics: {
          'Medical record number': p.mrn,
          'Legal name': [p.legalFirstName, p.legalMiddleName, p.legalLastName]
            .filter(Boolean)
            .join(' '),
          'Preferred name': p.preferredName,
          Pronouns: p.pronouns,
          'Date of birth': p.dateOfBirth,
          'Sex assigned at birth': p.sexAssignedAtBirth,
          'Gender identity': p.genderIdentity,
          Phone: p.phonePrimary,
          'Alternate phone': p.phoneSecondary,
          Email: p.email,
          Address: [p.addressLine1, p.addressLine2, p.city, p.state, p.postalCode]
            .filter(Boolean)
            .join(', '),
          'Preferred language': p.preferredLanguage,
          'Emergency contact': p.emergencyContactName,
          'Emergency contact phone': p.emergencyContactPhone,
          'Privacy notice acknowledged': p.nppAcknowledgedAt
            ? p.nppAcknowledgedAt.toISOString().slice(0, 10)
            : null,
        },
        allergies,
        flags,
        appointments: appts,
        notes: notesWithVersions,
        prescriptions: scripts,
      } as PatientExport;
    },
  );
}
