import 'server-only';

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import {
  appointment,
  invoice,
  patient,
  patientAccount,
  patientAllergy,
  patientFlag,
  patientMerge,
  patientSetupToken,
  prescription,
  triageConversation,
  visitNote,
} from '@/db/schema';
import { writeAuditEvent } from '@/server/audit/log';

import { auditedRead, auditedWrite } from './audited';

/**
 * Folding a duplicate chart into the one that survives.
 *
 * ==========================================================================
 * WHY THIS IS A SAFETY FEATURE, NOT HOUSEKEEPING
 * ==========================================================================
 *
 * An allergy recorded on chart A is invisible to a clinician reading chart B. This system
 * creates duplicates on purpose in two places — a front-desk search that misses, and
 * patient self-registration, which never matches an existing record because nothing a
 * sign-up form collects proves identity. Both are the right call. Both are only safe
 * because of what is in this file.
 *
 * ==========================================================================
 * THE ROWS MOVE
 * ==========================================================================
 *
 * `patient.merged_into_patient_id` marks the duplicate, but a merge that only set that
 * pointer would require every query in the system to remember to follow it — and the one
 * that forgot would hide an allergy, which is the exact failure a merge exists to fix. So
 * the child rows are repointed and the pointer is kept for provenance and redirection.
 *
 * Verified against the live schema before this was written: of the tables carrying
 * `patient_id`, only the two portal tables have a patient-scoped unique index, so the
 * clinical ones move with a plain UPDATE and cannot collide. The portal pair is handled
 * explicitly below.
 *
 * ==========================================================================
 * WHAT NEVER MOVES
 * ==========================================================================
 *
 * `audit_event.subject_patient_id` stays on the duplicate. A §164.528 accounting for the
 * old MRN must still answer "who read this chart", and "nobody, it was merged" is not an
 * answer. The application role holds no UPDATE on `audit_event`, so this is guaranteed by
 * privilege rather than by remembering. `break_glass_grant` stays for the same reason: it
 * records that someone took emergency access to THAT chart, which stays true.
 */

/* -------------------------------------------------------------------------- */

/**
 * The tables whose rows follow the patient, and the manifest keys they are recorded under.
 *
 * Table-driven rather than seven near-identical blocks, so adding a patient-scoped table
 * later is one line here instead of an edit that is easy to half-finish. A new table with
 * a patient-scoped unique index would need explicit handling, like the portal pair.
 */
const MOVABLE = [
  { key: 'appointment', table: appointment, column: appointment.patientId },
  { key: 'visit_note', table: visitNote, column: visitNote.patientId },
  { key: 'prescription', table: prescription, column: prescription.patientId },
  { key: 'patient_allergy', table: patientAllergy, column: patientAllergy.patientId },
  { key: 'patient_flag', table: patientFlag, column: patientFlag.patientId },
  { key: 'invoice', table: invoice, column: invoice.patientId },
  {
    key: 'triage_conversation',
    table: triageConversation,
    column: triageConversation.patientId,
  },
] as const;

/*
 * No `different_clinic`: the lookup is scoped to the session's clinic, so a chart from
 * another practice is simply not found — and must look identical from outside, or the
 * refusal becomes an oracle for which ids are patients elsewhere.
 */
export type MergeRefusal =
  | 'not_found'
  | 'same_patient'
  | 'already_merged'
  | 'survivor_merged'
  | 'survivor_archived';

export type MergeResult =
  | { ok: true; mergeId: string; moved: Record<string, number> }
  | { ok: false; reason: MergeRefusal };

/* -------------------------------------------------------------------------- */

/**
 * Charts that might be the same person as this one.
 *
 * Surname and date of birth, which is the pairing that actually produces duplicates:
 * self-registration asks for both, and a front-desk typo in a first name does not change
 * either. Deliberately NOT fuzzy — a candidate list that is mostly wrong trains staff to
 * confirm without reading, and confirming without reading is how two people's records end
 * up merged.
 *
 * Reads with `patient.read.identifying`, which the front desk holds: they are usually who
 * notices. Committing the merge needs `patient.merge`, which they do not hold.
 */
export type MergeCandidate = {
  id: string;
  mrn: string;
  name: string;
  dateOfBirth: string;
  selfRegistered: boolean;
  identityVerified: boolean;
  archived: boolean;
};

export async function listMergeCandidates(patientId: string): Promise<MergeCandidate[]> {
  return auditedRead(
    {
      permission: 'patient.read.identifying',
      action: 'patient.search',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      metadata: { scope: 'merge_candidates' },
    },
    async (tx, session) => {
      const [subject] = await tx
        .select({
          lastName: patient.legalLastName,
          dateOfBirth: patient.dateOfBirth,
        })
        .from(patient)
        .where(and(eq(patient.id, patientId), eq(patient.clinicId, session.clinicId)))
        .limit(1);

      if (!subject) return [];

      const rows = await tx
        .select({
          id: patient.id,
          mrn: patient.mrn,
          legalFirstName: patient.legalFirstName,
          legalLastName: patient.legalLastName,
          preferredName: patient.preferredName,
          dateOfBirth: patient.dateOfBirth,
          selfRegisteredAt: patient.selfRegisteredAt,
          identityVerifiedAt: patient.identityVerifiedAt,
          archivedAt: patient.archivedAt,
        })
        .from(patient)
        .where(
          and(
            eq(patient.clinicId, session.clinicId),
            eq(patient.legalLastName, subject.lastName),
            eq(patient.dateOfBirth, subject.dateOfBirth),
            ne(patient.id, patientId),
            /* A chart already folded away is not a candidate: it is not a separate
               person any more, and offering it invites a chain the database refuses. */
            isNull(patient.mergedIntoPatientId),
          ),
        )
        .limit(25);

      return rows.map((r) => ({
        id: r.id,
        mrn: r.mrn,
        name: `${r.legalLastName}, ${r.preferredName ?? r.legalFirstName}`,
        dateOfBirth: r.dateOfBirth,
        selfRegistered: r.selfRegisteredAt !== null,
        identityVerified: r.identityVerifiedAt !== null,
        archived: r.archivedAt !== null,
      }));
    },
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Fold `duplicatePatientId` into `survivingPatientId`.
 *
 * Both charts are locked FOR UPDATE before anything is read about them. Without that,
 * two administrators merging A into B and B into C at the same moment would each see the
 * other's chart as un-merged and both would commit, producing the chain the database
 * trigger and the reversal logic are built to exclude. Locking both rows serialises any
 * pair of merges that share a chart.
 */
export async function mergePatients(
  survivingPatientId: string,
  duplicatePatientId: string,
  reason: string,
): Promise<MergeResult> {
  if (survivingPatientId === duplicatePatientId) {
    return { ok: false, reason: 'same_patient' };
  }

  return auditedWrite<MergeResult>(
    {
      permission: 'patient.merge',
      action: 'patient.merge',
      entityType: 'patient_merge',
      /*
       * The surviving chart is the subject of the primary row, because it is the record
       * that continues and the one a later question will be asked about. A second row
       * naming the duplicate is written below, so the folded-away MRN's own §164.528
       * accounting shows the merge too. Both share this request's correlation id.
       */
      subjectPatientId: survivingPatientId,
      /* Staff's administrative justification — not clinical content about the patient. */
      purpose: reason,
      metadata: { operation: 'merge' },
    },
    async (tx, session): Promise<MergeResult> => {
      const charts = await tx
        .select({
          id: patient.id,
          clinicId: patient.clinicId,
          mergedIntoPatientId: patient.mergedIntoPatientId,
          archivedAt: patient.archivedAt,
        })
        .from(patient)
        .where(
          and(
            eq(patient.clinicId, session.clinicId),
            sql`${patient.id} in (${survivingPatientId}::uuid, ${duplicatePatientId}::uuid)`,
          ),
        )
        .for('update');

      const survivor = charts.find((c) => c.id === survivingPatientId);
      const duplicate = charts.find((c) => c.id === duplicatePatientId);

      /* One generic refusal for "not in this clinic" and "does not exist": telling them
         apart would let a caller probe which record ids are patients here. */
      if (!survivor || !duplicate) return { ok: false, reason: 'not_found' };
      if (duplicate.mergedIntoPatientId) return { ok: false, reason: 'already_merged' };
      if (survivor.mergedIntoPatientId) return { ok: false, reason: 'survivor_merged' };
      /* Merging live clinical data into an archived chart would hide it. */
      if (survivor.archivedAt) return { ok: false, reason: 'survivor_archived' };

      const manifest: Record<string, string[]> = {};

      for (const { key, table, column } of MOVABLE) {
        const moved = await tx
          .update(table)
          .set({ patientId: survivingPatientId })
          .where(eq(column, duplicatePatientId))
          .returning({ id: table.id });

        if (moved.length > 0) manifest[key] = moved.map((r) => r.id);
      }

      /*
       * The portal login. One live account per patient is a unique index, so this cannot
       * be a blind move.
       *
       * If the survivor already has a login, the duplicate's is ARCHIVED rather than
       * moved: the person keeps the account attached to the chart that continues, and two
       * credentials for one record is not a state worth creating. If the survivor has
       * none, the account moves, so a patient who registered online does not lose the way
       * they log in just because staff reconciled their chart.
       */
      const [duplicateAccount] = await tx
        .select({ id: patientAccount.id })
        .from(patientAccount)
        .where(
          and(
            eq(patientAccount.patientId, duplicatePatientId),
            isNull(patientAccount.archivedAt),
          ),
        )
        .limit(1);

      if (duplicateAccount) {
        const [survivorAccount] = await tx
          .select({ id: patientAccount.id })
          .from(patientAccount)
          .where(
            and(
              eq(patientAccount.patientId, survivingPatientId),
              isNull(patientAccount.archivedAt),
            ),
          )
          .limit(1);

        if (survivorAccount) {
          await tx
            .update(patientAccount)
            .set({
              archivedAt: new Date(),
              archivedBy: session.userId,
              archiveReason: 'Chart merged into another record',
            })
            .where(eq(patientAccount.id, duplicateAccount.id));
          manifest['patient_account_archived'] = [duplicateAccount.id];
        } else {
          await tx
            .update(patientAccount)
            .set({ patientId: survivingPatientId })
            .where(eq(patientAccount.id, duplicateAccount.id));
          manifest['patient_account_moved'] = [duplicateAccount.id];
        }
      }

      /*
       * Outstanding portal invitations are REVOKED, never moved.
       *
       * A setup token is a bearer credential addressed to one chart. Silently retargeting
       * it at a different record is how someone follows an old email and lands in another
       * person's chart. Staff re-invite from the surviving record, which is one click and
       * unambiguous. Reversal deliberately does not un-revoke them.
       */
      const revoked = await tx
        .update(patientSetupToken)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(patientSetupToken.patientId, duplicatePatientId),
            isNull(patientSetupToken.usedAt),
            isNull(patientSetupToken.revokedAt),
          ),
        )
        .returning({ id: patientSetupToken.id });

      if (revoked.length > 0) {
        manifest['patient_setup_token_revoked'] = revoked.map((r) => r.id);
      }

      /*
       * The merge record goes in BEFORE the pointer is set, and the order is load-bearing.
       *
       * `cliniqo_patient_merge_no_chains_trg` fires BEFORE INSERT and refuses when either
       * chart is already merged away. Setting `merged_into_patient_id` first would mean
       * this transaction's own update is what the trigger sees, so every merge would be
       * refused as a chain — which is exactly what happened the first time this ran, and
       * is why it is written down here rather than discovered twice.
       */
      const [created] = await tx
        .insert(patientMerge)
        .values({
          clinicId: session.clinicId,
          survivingPatientId,
          duplicatePatientId,
          reason,
          manifest,
          performedBy: session.userId,
        })
        .returning({ id: patientMerge.id });

      /*
       * Mark and archive the duplicate.
       *
       * Archived so it leaves search and the roster — a chart that still appears in a
       * lookup is a chart somebody documents into. It stays reachable by direct reference,
       * keeps its MRN forever (`patient_clinic_mrn_idx` is deliberately not partial), and
       * the page redirects to the survivor.
       */
      await tx
        .update(patient)
        .set({
          mergedIntoPatientId: survivingPatientId,
          archivedAt: duplicate.archivedAt ?? new Date(),
          archivedBy: session.userId,
          archiveReason: 'Merged into another chart',
        })
        .where(eq(patient.id, duplicatePatientId));

      /*
       * The second audit row, naming the folded-away chart as its subject. Without it, an
       * accounting for the old MRN would end abruptly with no record of where the data
       * went — which is the one question that chart's accounting exists to answer.
       */
      await writeAuditEvent(tx, {
        clinicId: session.clinicId,
        actorUserId: session.userId,
        actorRoleCodes: session.roles,
        sessionId: session.sessionId,
        action: 'patient.merge',
        outcome: 'allowed',
        subjectPatientId: duplicatePatientId,
        entityType: 'patient_merge',
        entityId: created!.id,
        purpose: reason,
        metadata: {
          operation: 'merge',
          role: 'duplicate',
          movedInto: survivingPatientId,
          moved: Object.fromEntries(
            Object.entries(manifest).map(([k, v]) => [k, v.length]),
          ),
        },
      });

      return {
        ok: true,
        mergeId: created!.id,
        moved: Object.fromEntries(
          Object.entries(manifest).map(([k, v]) => [k, v.length]),
        ),
      };
    },
  );
}

/* -------------------------------------------------------------------------- */

export type ReverseRefusal = 'not_found' | 'already_reversed';
export type ReverseResult =
  | { ok: true; duplicatePatientId: string; restored: Record<string, number> }
  | { ok: false; reason: ReverseRefusal };

/**
 * Undo a merge, using the manifest written when it happened.
 *
 * The manifest is why this is possible at all: by now the surviving chart may have
 * acquired rows of its own, and "move back everything attached to it" would take those
 * too — handing one person another person's appointments, which is the failure this is
 * meant to correct rather than repeat.
 *
 * WHAT REVERSAL DOES NOT DO. It leaves the duplicate ARCHIVED, and it does not un-revoke
 * portal invitations. Restoring a chart to active status is `patient.archive`'s job and
 * already has a screen; re-issuing a credential should be a deliberate act, not a side
 * effect. Reversal restores the data relationship and stops there, which keeps it a
 * straight inverse of the manifest rather than a guess at prior state.
 */
export async function reverseMerge(
  mergeId: string,
  reason: string,
): Promise<ReverseResult> {
  return auditedWrite<ReverseResult>(
    {
      permission: 'patient.merge',
      action: 'patient.unmerge',
      entityType: 'patient_merge',
      entityId: mergeId,
      purpose: reason,
      metadata: { operation: 'unmerge' },
    },
    async (tx, session): Promise<ReverseResult> => {
      const [record] = await tx
        .select({
          id: patientMerge.id,
          survivingPatientId: patientMerge.survivingPatientId,
          duplicatePatientId: patientMerge.duplicatePatientId,
          manifest: patientMerge.manifest,
          reversedAt: patientMerge.reversedAt,
        })
        .from(patientMerge)
        .where(
          and(eq(patientMerge.id, mergeId), eq(patientMerge.clinicId, session.clinicId)),
        )
        .limit(1)
        .for('update');

      if (!record) return { ok: false, reason: 'not_found' };
      if (record.reversedAt) return { ok: false, reason: 'already_reversed' };

      const manifest = record.manifest;
      const restored: Record<string, number> = {};

      for (const { key, table, column } of MOVABLE) {
        const ids = manifest[key];
        if (!ids || ids.length === 0) continue;

        const moved = await tx
          .update(table)
          .set({ patientId: record.duplicatePatientId })
          .where(and(eq(column, record.survivingPatientId), inArray(table.id, ids)))
          .returning({ id: table.id });

        if (moved.length > 0) restored[key] = moved.length;
      }

      const movedAccount = manifest['patient_account_moved']?.[0];
      if (movedAccount) {
        await tx
          .update(patientAccount)
          .set({ patientId: record.duplicatePatientId })
          .where(eq(patientAccount.id, movedAccount));
        restored['patient_account'] = 1;
      }

      const archivedAccount = manifest['patient_account_archived']?.[0];
      if (archivedAccount) {
        await tx
          .update(patientAccount)
          .set({ archivedAt: null, archivedBy: null, archiveReason: null })
          .where(eq(patientAccount.id, archivedAccount));
        restored['patient_account'] = 1;
      }

      /* Clearing the pointer is what makes the chart a separate record again. It stays
         archived — see the note above. */
      await tx
        .update(patient)
        .set({ mergedIntoPatientId: null })
        .where(eq(patient.id, record.duplicatePatientId));

      await tx
        .update(patientMerge)
        .set({
          reversedAt: new Date(),
          reversedBy: session.userId,
          reversalReason: reason,
        })
        .where(eq(patientMerge.id, mergeId));

      await writeAuditEvent(tx, {
        clinicId: session.clinicId,
        actorUserId: session.userId,
        actorRoleCodes: session.roles,
        sessionId: session.sessionId,
        action: 'patient.unmerge',
        outcome: 'allowed',
        subjectPatientId: record.survivingPatientId,
        entityType: 'patient_merge',
        entityId: mergeId,
        purpose: reason,
        metadata: { operation: 'unmerge', role: 'survivor', restored },
      });

      return { ok: true, duplicatePatientId: record.duplicatePatientId, restored };
    },
    /* The audited layer's subject is resolved from the result, because which patient this
       concerns is only known once the merge record has been read. */
    (result) => (result.ok ? result.duplicatePatientId : ''),
  );
}

/* -------------------------------------------------------------------------- */

export type MergeProvenance = {
  /** Set when THIS chart was folded into another — the page redirects on it. */
  mergedInto: { patientId: string; mrn: string; name: string; mergeId: string } | null;
  /** Charts folded into this one. */
  absorbed: {
    mergeId: string;
    patientId: string;
    mrn: string;
    name: string;
    reason: string;
    performedAt: Date;
  }[];
};

/**
 * Where this chart sits in any merge, in both directions.
 *
 * Read on every chart open, and narrow. The redirect it drives is not cosmetic: a merged
 * chart that still renders as an ordinary empty record is a chart somebody writes a note
 * into, and that note is then invisible on the record the clinician actually reads.
 *
 * KNOWN COST, recorded rather than hidden: this is a second audited read alongside
 * `getPatient`, so opening a chart writes two `patient.read` rows and spends two units of
 * the F1 read budget instead of one — on the highest-insert table in the system, for a
 * condition that applies to a small minority of charts. The budget is sized far above real
 * clinical use so this does not bite, and the alternative (folding provenance into
 * `getPatient`) would make every caller of that function pay for two extra selects it does
 * not need. Worth revisiting if chart-open volume ever becomes the constraint.
 */
export async function getMergeProvenance(patientId: string): Promise<MergeProvenance> {
  return auditedRead(
    {
      permission: 'patient.read.identifying',
      action: 'patient.read',
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      metadata: { fields: ['mergedIntoPatientId', 'absorbed'] },
    },
    async (tx, session) => {
      const [self] = await tx
        .select({
          mergedIntoPatientId: patient.mergedIntoPatientId,
        })
        .from(patient)
        .where(and(eq(patient.id, patientId), eq(patient.clinicId, session.clinicId)))
        .limit(1);

      let mergedInto: MergeProvenance['mergedInto'] = null;

      if (self?.mergedIntoPatientId) {
        const [target] = await tx
          .select({
            id: patient.id,
            mrn: patient.mrn,
            legalFirstName: patient.legalFirstName,
            legalLastName: patient.legalLastName,
            preferredName: patient.preferredName,
          })
          .from(patient)
          .where(eq(patient.id, self.mergedIntoPatientId))
          .limit(1);

        const [record] = await tx
          .select({ id: patientMerge.id })
          .from(patientMerge)
          .where(
            and(
              eq(patientMerge.duplicatePatientId, patientId),
              isNull(patientMerge.reversedAt),
            ),
          )
          .limit(1);

        if (target) {
          mergedInto = {
            patientId: target.id,
            mrn: target.mrn,
            name: `${target.legalLastName}, ${target.preferredName ?? target.legalFirstName}`,
            mergeId: record?.id ?? '',
          };
        }
      }

      const absorbed = await tx
        .select({
          mergeId: patientMerge.id,
          patientId: patient.id,
          mrn: patient.mrn,
          legalFirstName: patient.legalFirstName,
          legalLastName: patient.legalLastName,
          preferredName: patient.preferredName,
          reason: patientMerge.reason,
          performedAt: patientMerge.performedAt,
        })
        .from(patientMerge)
        .innerJoin(patient, eq(patient.id, patientMerge.duplicatePatientId))
        .where(
          and(
            eq(patientMerge.survivingPatientId, patientId),
            eq(patientMerge.clinicId, session.clinicId),
            isNull(patientMerge.reversedAt),
          ),
        );

      return {
        mergedInto,
        absorbed: absorbed.map((a) => ({
          mergeId: a.mergeId,
          patientId: a.patientId,
          mrn: a.mrn,
          name: `${a.legalLastName}, ${a.preferredName ?? a.legalFirstName}`,
          reason: a.reason,
          performedAt: a.performedAt,
        })),
      };
    },
  );
}
