import 'server-only';

import { and, asc, eq, isNull } from 'drizzle-orm';

import { patientAllergy, patientFlag, userAccount } from '@/db/schema';
import type { AllergyInput, FlagInput } from '@/lib/clinical-fact-schemas';

import { auditedRead, auditedWrite } from './audited';

/**
 * Allergies and medical flags — recording them, not just displaying them.
 *
 * These tables have been read since Phase 4: the chart surfaces allergies before anything
 * else, and the prescribing screen shows a red allergy banner. Nothing could write to
 * them, so that banner was guaranteed to be empty on every patient. The safety control
 * existed; the data it depended on had no way in. That is the gap this closes.
 *
 * WRITES REQUIRE `patient.update.clinical` — clinician only. An allergy is a clinical
 * assertion with dosing consequences, not a demographic detail, so the front desk cannot
 * record one and neither can an administrator.
 *
 * NOTHING IS EVER DELETED. A mistaken allergy is marked `entered_in_error`, which is how
 * clinical systems retract data: the row stays, visibly retracted, because "this was
 * recorded and later withdrawn" is itself part of the record. A clinician who sees an
 * allergy disappear has no way to know whether it was wrong or whether they misremembered.
 */

export type AllergyRecord = {
  id: string;
  allergenType: string;
  allergenName: string;
  reaction: string | null;
  severity: string | null;
  onsetDate: string | null;
  status: 'active' | 'inactive' | 'entered_in_error';
  recordedByName: string | null;
  recordedAt: Date;
};

export type FlagRecord = {
  id: string;
  flagType: string;
  label: string;
  detail: string | null;
  severity: string;
  validFrom: string | null;
  validTo: string | null;
  createdByName: string | null;
};

export type ClinicalFactResult =
  { ok: true; id: string } | { ok: false; reason: 'not_found' };

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every allergy on record, including retracted ones.
 *
 * Deliberately not filtered to active. The management screen must show what was withdrawn
 * and by implication that somebody withdrew it — the chart view filters to active for
 * clinical display, which is a different question from "what is on this record".
 */
export async function listAllergies(patientId: string): Promise<AllergyRecord[]> {
  return auditedRead(
    {
      permission: 'patient.read.clinical',
      action: 'allergy.read',
      entityType: 'patient_allergy',
      subjectPatientId: patientId,
      metadata: { scope: 'allergy_management' },
    },
    async (tx, session) => {
      const rows = await tx
        .select({
          id: patientAllergy.id,
          allergenType: patientAllergy.allergenType,
          allergenName: patientAllergy.allergenName,
          reaction: patientAllergy.reaction,
          severity: patientAllergy.severity,
          onsetDate: patientAllergy.onsetDate,
          status: patientAllergy.status,
          recordedByName: userAccount.fullName,
          recordedAt: patientAllergy.recordedAt,
        })
        .from(patientAllergy)
        .leftJoin(userAccount, eq(userAccount.id, patientAllergy.recordedBy))
        .where(
          and(
            eq(patientAllergy.patientId, patientId),
            eq(patientAllergy.clinicId, session.clinicId),
            isNull(patientAllergy.archivedAt),
          ),
        )
        .orderBy(asc(patientAllergy.recordedAt));

      return rows as AllergyRecord[];
    },
  );
}

export async function listFlags(patientId: string): Promise<FlagRecord[]> {
  return auditedRead(
    {
      permission: 'patient.read.clinical',
      action: 'flag.read',
      entityType: 'patient_flag',
      subjectPatientId: patientId,
      metadata: { scope: 'flag_management' },
    },
    async (tx, session) => {
      const rows = await tx
        .select({
          id: patientFlag.id,
          flagType: patientFlag.flagType,
          label: patientFlag.label,
          detail: patientFlag.detail,
          severity: patientFlag.severity,
          validFrom: patientFlag.validFrom,
          validTo: patientFlag.validTo,
          createdByName: userAccount.fullName,
        })
        .from(patientFlag)
        .leftJoin(userAccount, eq(userAccount.id, patientFlag.createdBy))
        .where(
          and(
            eq(patientFlag.patientId, patientId),
            eq(patientFlag.clinicId, session.clinicId),
            isNull(patientFlag.archivedAt),
          ),
        )
        .orderBy(asc(patientFlag.createdAt));

      return rows as FlagRecord[];
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

export async function addAllergy(
  patientId: string,
  input: AllergyInput,
): Promise<ClinicalFactResult> {
  return auditedWrite(
    {
      permission: 'patient.update.clinical',
      action: 'allergy.create',
      entityType: 'patient_allergy',
      subjectPatientId: patientId,
      // Severity is recorded because it drives the display; the allergen itself is not,
      // because an allergen name in the audit log is a diagnosis in the audit log.
      metadata: { severity: input.severity, allergenType: input.allergenType },
    },
    async (tx, session): Promise<ClinicalFactResult> => {
      const [row] = await tx
        .insert(patientAllergy)
        .values({
          clinicId: session.clinicId,
          patientId,
          allergenType: input.allergenType,
          allergenName: input.allergenName,
          reaction: input.reaction ?? null,
          severity: input.severity,
          onsetDate: input.onsetDate ?? null,
          status: 'active',
          recordedBy: session.userId,
        })
        .returning({ id: patientAllergy.id });

      return { ok: true, id: row!.id };
    },
  );
}

/**
 * Retract or deactivate an allergy.
 *
 * `entered_in_error` means it was never true. `inactive` means it was true and no longer
 * applies — a resolved sensitivity. They are different clinical claims and collapsing
 * them would lose information a later clinician needs.
 */
export async function setAllergyStatus(
  allergyId: string,
  patientId: string,
  status: 'active' | 'inactive' | 'entered_in_error',
  reason: string,
): Promise<ClinicalFactResult> {
  return auditedWrite(
    {
      permission: 'patient.update.clinical',
      action: 'allergy.update',
      entityType: 'patient_allergy',
      entityId: allergyId,
      subjectPatientId: patientId,
      purpose: reason,
      metadata: { toStatus: status },
    },
    async (tx, session): Promise<ClinicalFactResult> => {
      const updated = await tx
        .update(patientAllergy)
        .set({ status })
        .where(
          and(
            eq(patientAllergy.id, allergyId),
            eq(patientAllergy.patientId, patientId),
            eq(patientAllergy.clinicId, session.clinicId),
            isNull(patientAllergy.archivedAt),
          ),
        )
        .returning({ id: patientAllergy.id });

      return updated.length > 0
        ? { ok: true, id: allergyId }
        : { ok: false, reason: 'not_found' };
    },
  );
}

export async function addFlag(
  patientId: string,
  input: FlagInput,
): Promise<ClinicalFactResult> {
  return auditedWrite(
    {
      permission: 'patient.update.clinical',
      action: 'flag.create',
      entityType: 'patient_flag',
      subjectPatientId: patientId,
      metadata: { flagType: input.flagType, severity: input.severity },
    },
    async (tx, session): Promise<ClinicalFactResult> => {
      const [row] = await tx
        .insert(patientFlag)
        .values({
          clinicId: session.clinicId,
          patientId,
          flagType: input.flagType,
          label: input.label,
          detail: input.detail ?? null,
          severity: input.severity,
          validFrom: input.validFrom ?? null,
          validTo: input.validTo ?? null,
          createdBy: session.userId,
        })
        .returning({ id: patientFlag.id });

      return { ok: true, id: row!.id };
    },
  );
}

/** End a flag's validity. Not a delete — the flag stays with an end date. */
export async function endFlag(
  flagId: string,
  patientId: string,
  reason: string,
): Promise<ClinicalFactResult> {
  return auditedWrite(
    {
      permission: 'patient.update.clinical',
      action: 'flag.update',
      entityType: 'patient_flag',
      entityId: flagId,
      subjectPatientId: patientId,
      purpose: reason,
      metadata: { operation: 'end_validity' },
    },
    async (tx, session): Promise<ClinicalFactResult> => {
      const updated = await tx
        .update(patientFlag)
        .set({ validTo: new Date().toISOString().slice(0, 10) })
        .where(
          and(
            eq(patientFlag.id, flagId),
            eq(patientFlag.patientId, patientId),
            eq(patientFlag.clinicId, session.clinicId),
            isNull(patientFlag.archivedAt),
          ),
        )
        .returning({ id: patientFlag.id });

      return updated.length > 0
        ? { ok: true, id: flagId }
        : { ok: false, reason: 'not_found' };
    },
  );
}
