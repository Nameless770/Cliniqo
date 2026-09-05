import 'server-only';

import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import { medication, prescription, prescriptionItem, userAccount } from '@/db/schema';
import type {
  CreatePrescriptionInput,
  PrescriptionItemInput,
} from '@/lib/prescription-schemas';
import type { Tx } from '@/server/audit/log';

import { auditedRead, auditedWrite } from './audited';

/**
 * Prescription data access.
 *
 * ==========================================================================
 * IMMUTABILITY, AND HOW CORRECTIONS ARE MODELLED
 * ==========================================================================
 *
 * A prescription is ISSUED, not drafted. `createPrescription` inserts the header with
 * status 'signed' and its line in the SAME transaction — there is no window in which a
 * half-written prescription exists. A draft prescription lying around is a hazard: it
 * looks like an instruction and is not one.
 *
 * Once issued it is never edited. That is enforced in three places:
 *
 *   1. NO UPDATE PATH EXISTS in this file. There is no `updatePrescription`. The only
 *      writes are create, correct, and cancel.
 *
 *   2. A DATABASE TRIGGER refuses it anyway. `prescription_item_frozen_guard` (migration
 *      0001) raises on any UPDATE or DELETE of a line whose parent is not 'draft' —
 *      catching the schema owner, a psql session, and any future code that forgets.
 *
 *   3. `prescription_item` HAS NO SOFT-DELETE COLUMNS. There is nowhere to record a
 *      retraction on the line itself, because retraction happens at the header.
 *
 * A CORRECTION IS A NEW PRESCRIPTION. `correctPrescription` does two things in one
 * transaction:
 *
 *      cancel the original   (status 'cancelled', who, when, and WHY)
 *      insert a replacement  (supersedes_prescription_id -> the original)
 *
 * Both rows stay in the record forever. The history therefore shows what was prescribed,
 * that it was withdrawn, the stated reason, and what replaced it — in order. That is how
 * paper prescribing works, and it is the only version that survives the question a
 * pharmacist or a lawyer actually asks: "what was this patient told to take, on which
 * day, and who decided?"
 *
 * Editing in place would answer that question wrongly and leave no trace that it had
 * ever answered differently.
 *
 * CONTROLLED SUBSTANCES are refused by a database trigger, not by this code. Cliniqo
 * implements no DEA EPCS identity proofing, so prescribing one is out of scope and the
 * database enforces it.
 */

export type PrescriptionLine = {
  medicationName: string;
  medicationStrength: string | null;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  durationDays: number | null;
  quantity: string | null;
  quantityUnit: string | null;
  refills: number;
  instructions: string | null;
  indication: string | null;
};

export type PrescriptionRecord = {
  id: string;
  status: 'draft' | 'signed' | 'printed' | 'cancelled';
  prescriberName: string;
  signedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  supersedesPrescriptionId: string | null;
  visitNoteId: string | null;
  lines: PrescriptionLine[];
};

export type PrescriptionWriteResult =
  | { ok: true; prescriptionId: string }
  | { ok: false; reason: 'not_found' | 'already_cancelled' | 'controlled_substance' };

/** PostgreSQL raises this for the controlled-substance and frozen-item guards. */
function isGuardViolation(error: unknown, fragment: string): boolean {
  return (
    error instanceof Error &&
    typeof error.message === 'string' &&
    error.message.includes(fragment)
  );
}

async function loadLines(tx: Tx, prescriptionId: string): Promise<PrescriptionLine[]> {
  const rows = await tx
    .select({
      medicationName: medication.name,
      medicationStrength: medication.strength,
      dose: prescriptionItem.dose,
      route: prescriptionItem.route,
      frequency: prescriptionItem.frequency,
      durationDays: prescriptionItem.durationDays,
      quantity: prescriptionItem.quantity,
      quantityUnit: prescriptionItem.quantityUnit,
      refills: prescriptionItem.refills,
      instructions: prescriptionItem.instructions,
      indication: prescriptionItem.indication,
    })
    .from(prescriptionItem)
    .innerJoin(medication, eq(medication.id, prescriptionItem.medicationId))
    .where(eq(prescriptionItem.prescriptionId, prescriptionId))
    .orderBy(asc(prescriptionItem.sequence));

  return rows as PrescriptionLine[];
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A patient's prescription history, newest first.
 *
 * Includes cancelled and superseded entries. Hiding them would defeat the model — the
 * point of never editing is that the withdrawn instruction remains visible alongside what
 * replaced it.
 */
export async function getPatientPrescriptions(
  patientId: string,
): Promise<PrescriptionRecord[]> {
  return auditedRead(
    {
      permission: 'prescription.read',
      action: 'prescription.read',
      entityType: 'prescription',
      subjectPatientId: patientId,
      metadata: { scope: 'patient_prescription_history' },
    },
    async (tx, session) => {
      const rows = await tx
        .select({
          id: prescription.id,
          status: prescription.status,
          prescriberName: userAccount.fullName,
          signedAt: prescription.signedAt,
          cancelledAt: prescription.cancelledAt,
          cancellationReason: prescription.cancellationReason,
          supersedesPrescriptionId: prescription.supersedesPrescriptionId,
          visitNoteId: prescription.visitNoteId,
        })
        .from(prescription)
        .innerJoin(userAccount, eq(userAccount.id, prescription.prescriberUserId))
        .where(
          and(
            eq(prescription.patientId, patientId),
            eq(prescription.clinicId, session.clinicId),
            isNull(prescription.archivedAt),
          ),
        )
        .orderBy(desc(prescription.createdAt));

      const records: PrescriptionRecord[] = [];
      for (const row of rows) {
        records.push({
          ...row,
          status: row.status as PrescriptionRecord['status'],
          lines: await loadLines(tx, row.id),
        });
      }
      return records;
    },
  );
}

/** The formulary, for the prescribing form. Reference data, not PHI. */
export async function getFormulary(): Promise<
  { id: string; name: string; strength: string | null; isControlled: boolean }[]
> {
  return auditedRead(
    {
      permission: 'prescription.create',
      action: 'reference.read',
      entityType: 'clinic',
      metadata: { scope: 'formulary' },
    },
    async (tx) =>
      tx
        .select({
          id: medication.id,
          name: medication.name,
          strength: medication.strength,
          isControlled: medication.isControlled,
        })
        .from(medication)
        .where(eq(medication.isActive, true))
        .orderBy(asc(medication.name)),
  );
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

/** Insert a header (already signed) plus its line. Shared by create and correct. */
async function issue(
  tx: Tx,
  session: { clinicId: string; userId: string },
  patientId: string,
  visitNoteId: string | null,
  line: PrescriptionItemInput,
  supersedes: string | null,
): Promise<string> {
  const [header] = await tx
    .insert(prescription)
    .values({
      clinicId: session.clinicId,
      patientId,
      visitNoteId,
      prescriberUserId: session.userId,
      // Issued, not drafted. There is no moment at which this row is editable.
      status: 'signed',
      signedAt: new Date(),
      supersedesPrescriptionId: supersedes,
    })
    .returning({ id: prescription.id });

  await tx.insert(prescriptionItem).values({
    prescriptionId: header!.id,
    medicationId: line.medicationId,
    sequence: 1,
    dose: line.dose,
    route: line.route,
    frequency: line.frequency,
    durationDays: line.durationDays,
    quantity: String(line.quantity),
    quantityUnit: line.quantityUnit,
    refills: line.refills,
    instructions: line.instructions ?? null,
    indication: line.indication ?? null,
  });

  return header!.id;
}

export async function createPrescription(
  input: CreatePrescriptionInput,
): Promise<PrescriptionWriteResult> {
  const { patientId, visitNoteId, ...line } = input;

  try {
    return await auditedWrite(
      {
        permission: 'prescription.create',
        action: 'prescription.create',
        entityType: 'prescription',
        subjectPatientId: patientId,
        // Field names and the duration, never the indication text.
        metadata: { durationDays: line.durationDays, refills: line.refills },
      },
      async (tx, session): Promise<PrescriptionWriteResult> => ({
        ok: true,
        prescriptionId: await issue(
          tx,
          session,
          patientId,
          visitNoteId ?? null,
          line,
          null,
        ),
      }),
    );
  } catch (error) {
    if (isGuardViolation(error, 'controlled substances require DEA EPCS')) {
      return { ok: false, reason: 'controlled_substance' };
    }
    throw error;
  }
}

/**
 * Correct an issued prescription.
 *
 * Cancel-and-replace, atomically. The original is never touched beyond being marked
 * cancelled with its reason; the replacement points back at it.
 */
export async function correctPrescription(
  originalId: string,
  patientId: string,
  reason: string,
  line: PrescriptionItemInput,
): Promise<PrescriptionWriteResult> {
  try {
    return await auditedWrite(
      {
        permission: 'prescription.create',
        action: 'prescription.create',
        entityType: 'prescription',
        entityId: originalId,
        subjectPatientId: patientId,
        purpose: reason,
        metadata: { operation: 'correction', supersedes: originalId },
      },
      async (tx, session): Promise<PrescriptionWriteResult> => {
        const [original] = await tx
          .select({ status: prescription.status, visitNoteId: prescription.visitNoteId })
          .from(prescription)
          .where(
            and(
              eq(prescription.id, originalId),
              eq(prescription.patientId, patientId),
              eq(prescription.clinicId, session.clinicId),
              isNull(prescription.archivedAt),
            ),
          )
          .limit(1);

        if (!original) return { ok: false, reason: 'not_found' };
        if (original.status === 'cancelled') {
          return { ok: false, reason: 'already_cancelled' };
        }

        await tx
          .update(prescription)
          .set({
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelledBy: session.userId,
            cancellationReason: reason,
          })
          .where(eq(prescription.id, originalId));

        return {
          ok: true,
          prescriptionId: await issue(
            tx,
            session,
            patientId,
            original.visitNoteId,
            line,
            originalId,
          ),
        };
      },
    );
  } catch (error) {
    if (isGuardViolation(error, 'controlled substances require DEA EPCS')) {
      return { ok: false, reason: 'controlled_substance' };
    }
    throw error;
  }
}

/**
 * Withdraw a prescription without replacing it.
 *
 * Still not a delete — the row stays, marked cancelled, with who and why. "This was
 * prescribed and then stopped" is clinically meaningful information.
 */
export async function cancelPrescription(
  prescriptionId: string,
  patientId: string,
  reason: string,
): Promise<PrescriptionWriteResult> {
  return auditedWrite(
    {
      permission: 'prescription.cancel',
      action: 'prescription.cancel',
      entityType: 'prescription',
      entityId: prescriptionId,
      subjectPatientId: patientId,
      purpose: reason,
    },
    async (tx, session): Promise<PrescriptionWriteResult> => {
      const updated = await tx
        .update(prescription)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: session.userId,
          cancellationReason: reason,
        })
        .where(
          and(
            eq(prescription.id, prescriptionId),
            eq(prescription.patientId, patientId),
            eq(prescription.clinicId, session.clinicId),
            isNull(prescription.archivedAt),
          ),
        )
        .returning({ id: prescription.id });

      return updated.length > 0
        ? { ok: true, prescriptionId }
        : { ok: false, reason: 'not_found' };
    },
  );
}
