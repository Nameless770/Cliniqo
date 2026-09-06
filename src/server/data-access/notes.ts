import 'server-only';

import { createHash } from 'node:crypto';

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import { patient, userAccount, visitNote, visitNoteVersion } from '@/db/schema';
import type { NoteContentInput } from '@/lib/note-schemas';
import type { Tx } from '@/server/audit/log';

import { auditedRead, auditedSearch, auditedWrite } from './audited';

/**
 * Visit note data access.
 *
 * ==========================================================================
 * HOW RECEPTIONIST ACCESS IS PREVENTED AT THE DATA LAYER
 * ==========================================================================
 *
 * This is a DIFFERENT shape of restriction from the patient record, and the difference
 * is the point.
 *
 * For a patient, a receptionist gets a NARROWER ROW — name and phone, no diagnosis — so
 * the data layer picks a smaller SQL projection. There is a legitimate front-desk view of
 * a patient.
 *
 * For a visit note there is NO narrower view. Every content column is clinical: chief
 * complaint, subjective, objective, assessment, plan. A "note without clinical content"
 * is not a note. So the answer is not a projection, it is REFUSAL:
 *
 *   1. NO GRANT EXISTS. `receptionist` holds no `note.*` permission at all — not read,
 *      not create, not sign, not amend. Every function in this file opens with
 *      `requirePermission('note.…')`, which throws AuthorizationError and writes an
 *      `authz.denied` audit row. There is no code path that returns note content to a
 *      caller without the grant, because the permission check precedes the query.
 *
 *   2. NO QUERY IS ISSUED. The refusal happens before the transaction opens, so the
 *      SELECT never reaches PostgreSQL. Note text never enters server memory on a
 *      receptionist's request, and therefore cannot reach the RSC payload, the HTML, or
 *      a screenshot.
 *
 *   3. THE TABLES ARE UNREACHABLE ELSEWHERE. ESLint forbids importing `visitNote` or
 *      `visitNoteVersion` outside `src/server/data-access/`, so a future service or route
 *      cannot query around this file.
 *
 *   4. NO API SURFACE. There are no note route handlers. Every entry point is a server
 *      action that delegates here, and the check is in here — not in the action, and not
 *      in the page.
 *
 * ==========================================================================
 * THE VERSIONING MODEL
 * ==========================================================================
 *
 * `visit_note` is a stable container: which patient, which appointment, who authored it,
 * what state it is in, and a pointer to the current version. `visit_note_version` holds
 * the content, one row per version, numbered from 1.
 *
 *   CREATE   -> container (status 'draft') + version 1 (kind 'draft', frozen_at NULL)
 *   SAVE     -> UPDATE version 1 IN PLACE. An unsigned draft is a working document, not
 *               part of the legal record. Writing a row per autosave would produce
 *               hundreds of near-identical rows and a large volume of discoverable
 *               half-formed clinical impressions — a liability, not an asset.
 *   SIGN     -> set frozen_at + content_hash, kind 'signed'. From this instant the row is
 *               never updated again: a database trigger refuses it (migration 0001),
 *               independently of this code.
 *   AMEND    -> INSERT version N+1, kind 'addendum', supersedes_version_id -> previous.
 *               The original stays fully readable. This is §164.526 right-to-amend:
 *               corrections append, they do not overwrite.
 *
 * Nothing is ever deleted, and `visit_note_version` deliberately has no soft-delete
 * columns — preserving versions is the entire purpose of the table.
 */

/* -------------------------------------------------------------------------- */

export type NoteVersionRow = {
  id: string;
  versionNumber: number;
  kind: 'draft' | 'signed' | 'addendum';
  chiefComplaint: string | null;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  authoredByName: string;
  authoredAt: Date;
  frozenAt: Date | null;
  contentHash: string | null;
};

export type NoteWithVersions = {
  id: string;
  patientId: string;
  appointmentId: string | null;
  status: 'draft' | 'signed' | 'amended';
  authorName: string;
  signedAt: Date | null;
  rowVersion: number;
  versions: NoteVersionRow[];
};

/**
 * Content hash, chained to the previous version.
 *
 * Includes the prior version's hash, so the chain per note is tamper-evident: a silent
 * edit at the database level breaks every hash after it. Turns "signed on the 3rd" into
 * something verifiable rather than merely asserted.
 */
function contentHash(content: NoteContentInput, previousHash: string | null): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        chiefComplaint: content.chiefComplaint ?? null,
        subjective: content.subjective ?? null,
        objective: content.objective ?? null,
        assessment: content.assessment ?? null,
        plan: content.plan ?? null,
        previousHash,
      }),
    )
    .digest('hex');
}

const VERSION_COLUMNS = {
  id: visitNoteVersion.id,
  versionNumber: visitNoteVersion.versionNumber,
  kind: visitNoteVersion.kind,
  chiefComplaint: visitNoteVersion.chiefComplaint,
  subjective: visitNoteVersion.subjective,
  objective: visitNoteVersion.objective,
  assessment: visitNoteVersion.assessment,
  plan: visitNoteVersion.plan,
  authoredAt: visitNoteVersion.authoredAt,
  frozenAt: visitNoteVersion.frozenAt,
  contentHash: visitNoteVersion.contentHash,
} as const;

async function loadVersions(
  tx: Tx,
  noteId: string,
  clinicId: string,
): Promise<NoteVersionRow[]> {
  const rows = await tx
    .select({ ...VERSION_COLUMNS, authoredByName: userAccount.fullName })
    .from(visitNoteVersion)
    .innerJoin(userAccount, eq(userAccount.id, visitNoteVersion.authoredByUserId))
    .where(
      and(
        eq(visitNoteVersion.visitNoteId, noteId),
        eq(visitNoteVersion.clinicId, clinicId),
      ),
    )
    .orderBy(asc(visitNoteVersion.versionNumber));

  return rows as NoteVersionRow[];
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/** One note with its full version history. */
export async function getNote(
  noteId: string,
  patientId: string,
): Promise<NoteWithVersions | null> {
  return auditedRead(
    {
      permission: 'note.read',
      action: 'note.read',
      entityType: 'visit_note',
      entityId: noteId,
      subjectPatientId: patientId,
      metadata: { scope: 'single_note_with_history' },
    },
    async (tx, session) => {
      const [note] = await tx
        .select({
          id: visitNote.id,
          patientId: visitNote.patientId,
          appointmentId: visitNote.appointmentId,
          status: visitNote.status,
          signedAt: visitNote.signedAt,
          rowVersion: visitNote.version,
          authorName: userAccount.fullName,
        })
        .from(visitNote)
        .innerJoin(userAccount, eq(userAccount.id, visitNote.authorUserId))
        .where(
          and(
            eq(visitNote.id, noteId),
            // The claimed patient must be the note's actual patient, or the audit row
            // would name the wrong person.
            eq(visitNote.patientId, patientId),
            eq(visitNote.clinicId, session.clinicId),
            isNull(visitNote.archivedAt),
          ),
        )
        .limit(1);

      if (!note) return null;

      return {
        ...note,
        status: note.status as NoteWithVersions['status'],
        versions: await loadVersions(tx, noteId, session.clinicId),
      } as NoteWithVersions;
    },
  );
}

/**
 * Every write takes the patient id EXPLICITLY, rather than looking it up from the note.
 *
 * An earlier draft resolved it with a helper query outside the audited wrapper. That was
 * wrong twice over: the query ran before `requirePermission` could throw, so an
 * unauthorised caller still executed it, and it was itself an unaudited read of a patient
 * table — precisely what this layer exists to make impossible.
 *
 * Callers always know the patient, because they navigated from a chart or an appointment.
 * The id is then VERIFIED against the note inside the transaction (below), so a caller
 * passing the wrong one cannot mis-attribute the audit row.
 */
function subjectMismatch(): NoteWriteResult {
  return { ok: false, reason: 'not_found' };
}

/** Every note for a patient, newest first, each with its versions. */
export async function getPatientNotes(patientId: string): Promise<NoteWithVersions[]> {
  return auditedRead(
    {
      permission: 'note.read',
      action: 'note.read',
      entityType: 'visit_note',
      subjectPatientId: patientId,
      metadata: { scope: 'patient_note_history' },
    },
    async (tx, session) => {
      const notes = await tx
        .select({
          id: visitNote.id,
          patientId: visitNote.patientId,
          appointmentId: visitNote.appointmentId,
          status: visitNote.status,
          signedAt: visitNote.signedAt,
          rowVersion: visitNote.version,
          authorName: userAccount.fullName,
        })
        .from(visitNote)
        .innerJoin(userAccount, eq(userAccount.id, visitNote.authorUserId))
        .where(
          and(
            eq(visitNote.patientId, patientId),
            eq(visitNote.clinicId, session.clinicId),
            isNull(visitNote.archivedAt),
          ),
        )
        .orderBy(desc(visitNote.createdAt));

      const withVersions: NoteWithVersions[] = [];
      for (const note of notes) {
        withVersions.push({
          ...note,
          status: note.status as NoteWithVersions['status'],
          versions: await loadVersions(tx, note.id, session.clinicId),
        } as NoteWithVersions);
      }
      return withVersions;
    },
  );
}

/** The note attached to an appointment, if one has been started. */
export async function getNoteForAppointment(
  appointmentId: string,
  patientId: string,
): Promise<NoteWithVersions | null> {
  return auditedRead(
    {
      permission: 'note.read',
      action: 'note.read',
      entityType: 'visit_note',
      subjectPatientId: patientId,
      metadata: { scope: 'appointment_note' },
    },
    async (tx, session) => {
      const [note] = await tx
        .select({
          id: visitNote.id,
          patientId: visitNote.patientId,
          appointmentId: visitNote.appointmentId,
          status: visitNote.status,
          signedAt: visitNote.signedAt,
          rowVersion: visitNote.version,
          authorName: userAccount.fullName,
        })
        .from(visitNote)
        .innerJoin(userAccount, eq(userAccount.id, visitNote.authorUserId))
        .where(
          and(
            eq(visitNote.appointmentId, appointmentId),
            eq(visitNote.clinicId, session.clinicId),
            isNull(visitNote.archivedAt),
          ),
        )
        .limit(1);

      if (!note) return null;

      return {
        ...note,
        status: note.status as NoteWithVersions['status'],
        versions: await loadVersions(tx, note.id, session.clinicId),
      } as NoteWithVersions;
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

export type NoteWriteResult =
  | { ok: true; noteId: string }
  | {
      ok: false;
      reason:
        'not_found' | 'already_exists' | 'conflict' | 'already_signed' | 'not_signed';
    };

/**
 * Start a note for a visit.
 *
 * Creates the container and version 1 in ONE transaction, then points
 * `current_version_id` at it. The pointer and the row it references commit together or
 * not at all — a container with a dangling pointer would be a note that renders as empty.
 */
export async function createNote(
  patientId: string,
  appointmentId: string | null,
): Promise<NoteWriteResult> {
  return auditedWrite(
    {
      permission: 'note.create',
      action: 'note.create',
      entityType: 'visit_note',
      subjectPatientId: patientId,
    },
    async (tx, session): Promise<NoteWriteResult> => {
      if (appointmentId) {
        const [existing] = await tx
          .select({ id: visitNote.id })
          .from(visitNote)
          .where(
            and(eq(visitNote.appointmentId, appointmentId), isNull(visitNote.archivedAt)),
          )
          .limit(1);

        if (existing) return { ok: false, reason: 'already_exists' };
      }

      const [note] = await tx
        .insert(visitNote)
        .values({
          clinicId: session.clinicId,
          patientId,
          appointmentId,
          authorUserId: session.userId,
          status: 'draft',
        })
        .returning({ id: visitNote.id });

      const [version] = await tx
        .insert(visitNoteVersion)
        .values({
          clinicId: session.clinicId,
          visitNoteId: note!.id,
          versionNumber: 1,
          kind: 'draft',
          authoredByUserId: session.userId,
        })
        .returning({ id: visitNoteVersion.id });

      await tx
        .update(visitNote)
        .set({ currentVersionId: version!.id })
        .where(eq(visitNote.id, note!.id));

      return { ok: true, noteId: note!.id };
    },
  );
}

/**
 * Save the working draft.
 *
 * Updates the draft version IN PLACE. `expectedVersion` is optimistic concurrency on the
 * container: two clinicians with the same note open both save, and the second is told
 * their copy is stale rather than silently erasing the first author's work.
 *
 * A signed version cannot reach this path — the status check refuses it, and the database
 * trigger refuses it again if the status check is ever wrong.
 */
export async function saveDraft(
  noteId: string,
  patientId: string,
  content: NoteContentInput,
  expectedVersion: number,
): Promise<NoteWriteResult> {
  return auditedWrite(
    {
      permission: 'note.create',
      action: 'note.update',
      entityType: 'visit_note',
      entityId: noteId,
      subjectPatientId: patientId,
      metadata: { fields: Object.keys(content) },
    },
    async (tx, session): Promise<NoteWriteResult> => {
      const [note] = await tx
        .select({
          status: visitNote.status,
          currentVersionId: visitNote.currentVersionId,
        })
        .from(visitNote)
        .where(
          and(
            eq(visitNote.id, noteId),
            eq(visitNote.patientId, patientId),
            eq(visitNote.clinicId, session.clinicId),
            isNull(visitNote.archivedAt),
          ),
        )
        .limit(1);

      if (!note?.currentVersionId) return subjectMismatch();
      if (note.status !== 'draft') return { ok: false, reason: 'already_signed' };

      const bumped = await tx
        .update(visitNote)
        .set({ version: expectedVersion + 1 })
        .where(and(eq(visitNote.id, noteId), eq(visitNote.version, expectedVersion)))
        .returning({ id: visitNote.id });

      if (bumped.length === 0) return { ok: false, reason: 'conflict' };

      await tx
        .update(visitNoteVersion)
        .set({ ...content, authoredByUserId: session.userId })
        .where(eq(visitNoteVersion.id, note.currentVersionId));

      return { ok: true, noteId };
    },
  );
}

/**
 * Sign a note into the legal record.
 *
 * Separate permission from writing (`note.sign`), because signing is an attestation, not
 * an edit — the signer is asserting the content is accurate. After this, the version row
 * is immutable, enforced by trigger regardless of what any future code does.
 */
export async function signNote(
  noteId: string,
  patientId: string,
  expectedVersion: number,
): Promise<NoteWriteResult> {
  return auditedWrite(
    {
      permission: 'note.sign',
      action: 'note.sign',
      entityType: 'visit_note',
      entityId: noteId,
      subjectPatientId: patientId,
    },
    async (tx, session): Promise<NoteWriteResult> => {
      const [note] = await tx
        .select({
          status: visitNote.status,
          currentVersionId: visitNote.currentVersionId,
        })
        .from(visitNote)
        .where(
          and(
            eq(visitNote.id, noteId),
            eq(visitNote.patientId, patientId),
            eq(visitNote.clinicId, session.clinicId),
            isNull(visitNote.archivedAt),
          ),
        )
        .limit(1);

      if (!note?.currentVersionId) return subjectMismatch();
      if (note.status !== 'draft') return { ok: false, reason: 'already_signed' };

      const [current] = await tx
        .select(VERSION_COLUMNS)
        .from(visitNoteVersion)
        .where(eq(visitNoteVersion.id, note.currentVersionId))
        .limit(1);

      const bumped = await tx
        .update(visitNote)
        .set({
          status: 'signed',
          signedAt: new Date(),
          signedBy: session.userId,
          version: expectedVersion + 1,
        })
        .where(and(eq(visitNote.id, noteId), eq(visitNote.version, expectedVersion)))
        .returning({ id: visitNote.id });

      if (bumped.length === 0) return { ok: false, reason: 'conflict' };

      await tx
        .update(visitNoteVersion)
        .set({
          kind: 'signed',
          frozenAt: new Date(),
          contentHash: contentHash(
            {
              chiefComplaint: current?.chiefComplaint ?? undefined,
              subjective: current?.subjective ?? undefined,
              objective: current?.objective ?? undefined,
              assessment: current?.assessment ?? undefined,
              plan: current?.plan ?? undefined,
            },
            null,
          ),
        })
        .where(eq(visitNoteVersion.id, note.currentVersionId));

      return { ok: true, noteId };
    },
  );
}

/**
 * Append an addendum to a signed note.
 *
 * §164.526. The original version is untouched and stays readable; the correction is a new
 * version pointing back at what it supersedes. Frozen on insert, because an addendum to a
 * legal record is written and attested in one act.
 */
export async function addAddendum(
  noteId: string,
  patientId: string,
  content: NoteContentInput,
): Promise<NoteWriteResult> {
  return auditedWrite(
    {
      permission: 'note.amend',
      action: 'note.amend',
      entityType: 'visit_note',
      entityId: noteId,
      subjectPatientId: patientId,
      metadata: { fields: Object.keys(content) },
    },
    async (tx, session): Promise<NoteWriteResult> => {
      const [note] = await tx
        .select({ status: visitNote.status })
        .from(visitNote)
        .where(
          and(
            eq(visitNote.id, noteId),
            eq(visitNote.patientId, patientId),
            eq(visitNote.clinicId, session.clinicId),
            isNull(visitNote.archivedAt),
          ),
        )
        .limit(1);

      if (!note) return subjectMismatch();
      // An unsigned draft is edited, not amended. Amending it would create a version
      // chain on a document that is not yet part of the record.
      if (note.status === 'draft') return { ok: false, reason: 'not_signed' };

      const [previous] = await tx
        .select({
          id: visitNoteVersion.id,
          versionNumber: visitNoteVersion.versionNumber,
          contentHash: visitNoteVersion.contentHash,
        })
        .from(visitNoteVersion)
        .where(eq(visitNoteVersion.visitNoteId, noteId))
        .orderBy(desc(visitNoteVersion.versionNumber))
        .limit(1);

      const [inserted] = await tx
        .insert(visitNoteVersion)
        .values({
          clinicId: session.clinicId,
          visitNoteId: noteId,
          versionNumber: (previous?.versionNumber ?? 0) + 1,
          kind: 'addendum',
          ...content,
          authoredByUserId: session.userId,
          frozenAt: new Date(),
          supersedesVersionId: previous?.id ?? null,
          contentHash: contentHash(content, previous?.contentHash ?? null),
        })
        .returning({ id: visitNoteVersion.id });

      await tx
        .update(visitNote)
        .set({
          status: 'amended',
          currentVersionId: inserted!.id,
          version: sql`${visitNote.version} + 1`,
        })
        .where(eq(visitNote.id, noteId));

      return { ok: true, noteId };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Cross-patient work queue                                                   */
/* -------------------------------------------------------------------------- */

export type UnsignedNoteRow = {
  id: string;
  patientId: string;
  patientName: string;
  mrn: string;
  authorName: string;
  authoredByMe: boolean;
  startedAt: Date;
  lastTouchedAt: Date;
};

export type UnsignedNoteQueue = {
  rows: UnsignedNoteRow[];
  /** Which slice the server decided to return — see the scoping note below. */
  scope: 'mine' | 'clinic';
};

/**
 * Unsigned drafts, across patients. Backed by `visit_note_author_draft_idx`.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * A draft is not in the record. It is invisible to the next clinician, absent from an
 * export, and unbillable. Every other view is patient-first, so a note left unsigned is
 * only found by opening the chart it belongs to — which nobody does for a patient they
 * have stopped thinking about. The dashboard counts these; this answers "which ones".
 *
 * SCOPE IS DECIDED HERE, NOT BY THE CALLER
 * ----------------------------------------
 * A doctor sees only their own drafts. CLAUDE.md scopes doctors to their own patients,
 * and a clinic-wide list would disclose to Dr A that patient X was seen by Dr B — a
 * disclosure with no bearing on Dr A's work, so minimum necessary (164.502(b)) rules it
 * out. Nobody else can sign their note anyway, so a wider list would not even be useful.
 *
 * An administrator holding `audit.read` sees the clinic. That is the oversight role, it
 * is not patient-scoped, and chasing unsigned notes is the job. The read is audited like
 * any other, with the scope recorded, so "an office manager listed every open chart"
 * remains a visible, reviewable event rather than an invisible one.
 *
 * Content is never selected — no chief complaint, no assessment. This is a worklist of
 * WHICH notes are open, not a way to read them without opening each one, which would
 * turn one broad query into an untraceable bulk disclosure.
 */
export async function listUnsignedNotes(): Promise<UnsignedNoteQueue> {
  return auditedSearch(
    {
      permission: 'note.read',
      action: 'note.search',
      entityType: 'visit_note',
      // No subjectPatientId: this spans patients. Registered in COLLECTION_ACTIONS.
    },
    async (tx, session): Promise<UnsignedNoteQueue> => {
      const clinicWide = session.permissions.has('audit.read');

      const rows = await tx
        .select({
          id: visitNote.id,
          patientId: visitNote.patientId,
          legalFirstName: patient.legalFirstName,
          legalLastName: patient.legalLastName,
          mrn: patient.mrn,
          authorId: visitNote.authorUserId,
          authorName: userAccount.fullName,
          startedAt: visitNote.createdAt,
          lastTouchedAt: visitNote.updatedAt,
        })
        .from(visitNote)
        .innerJoin(userAccount, eq(userAccount.id, visitNote.authorUserId))
        .innerJoin(patient, eq(patient.id, visitNote.patientId))
        .where(
          and(
            eq(visitNote.clinicId, session.clinicId),
            eq(visitNote.status, 'draft'),
            isNull(visitNote.archivedAt),
            // The scoping decision, expressed in SQL rather than filtered afterwards:
            // an unauthorised row is never read, not read and then discarded.
            clinicWide ? undefined : eq(visitNote.authorUserId, session.userId),
          ),
        )
        .orderBy(asc(visitNote.createdAt));

      return {
        scope: clinicWide ? 'clinic' : 'mine',
        rows: rows.map((r) => ({
          id: r.id,
          patientId: r.patientId,
          patientName: `${r.legalLastName}, ${r.legalFirstName}`,
          mrn: r.mrn,
          authorName: r.authorName,
          authoredByMe: r.authorId === session.userId,
          startedAt: r.startedAt,
          lastTouchedAt: r.lastTouchedAt,
        })),
      };
    },
    (result) => ({ resultCount: result.rows.length, labels: { scope: result.scope } }),
  );
}
