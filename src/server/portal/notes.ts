import 'server-only';

import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { getDb } from '@/db/client';
import {
  appointment,
  appointmentType,
  userAccount,
  visitNote,
  visitNoteVersion,
} from '@/db/schema';
import { parseTstzRange } from '@/lib/clinic-time';

import { auditAsPatient } from './data';
import { requirePatientSession } from './session';

/**
 * A patient reading their own visit notes — the right of access, §164.524.
 *
 * ==========================================================================
 * WHAT A PATIENT SEES, AND WHAT THEY NEVER DO
 * ==========================================================================
 *
 * SIGNED notes only. A draft is a clinician's unfinished thinking and not yet part of the
 * record; it is filtered out in SQL, not hidden in the page. Within a signed note, only
 * FROZEN versions — the signed original and any addenda — so a correction appears alongside
 * what it corrects, exactly as §164.526 keeps it for staff.
 *
 * Their own notes only. The patient comes from the portal session, never from a parameter;
 * there is no id this function accepts that could point at somebody else.
 *
 * Not a withheld note's content. A clinician may hold one note back because reading it
 * online now is reasonably likely to endanger the patient (§164.524(a)(3)(i)). The CONTENT
 * query below is never issued for such a note: its ids are excluded before the versions are
 * fetched, so the text cannot reach this process's memory, let alone the page. What the
 * patient does get is that a note exists and was held back, because a denial of access
 * the patient is never told about is not a reviewable one.
 *
 * Psychotherapy notes are excluded from the right of access (§164.524(a)(1)(i)). This
 * system has one kind of visit note and no psychotherapy-note type; if one is ever added,
 * it must be kept out of this query by type.
 */

export type VisitSummaryVersion = {
  kind: 'signed' | 'addendum';
  authoredByName: string;
  authoredAt: Date;
  chiefComplaint: string | null;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
};

export type VisitSummary = {
  /** When the visit happened: the appointment's start, or the signing time for a walk-in. */
  visitAt: Date;
  visitType: string | null;
  clinicianName: string;
  versions: VisitSummaryVersion[];
};

export type WithheldVisit = { visitAt: Date; clinicianName: string };

export type MyVisitSummaries = { summaries: VisitSummary[]; withheld: WithheldVisit[] };

export async function listMyVisitSummaries(): Promise<MyVisitSummaries> {
  const session = await requirePatientSession();
  const db = getDb();

  return db.transaction(async (tx) => {
    const notes = await tx
      .select({
        id: visitNote.id,
        signedAt: visitNote.signedAt,
        withheldAt: visitNote.portalWithheldAt,
        clinicianName: userAccount.fullName,
        during: appointment.during,
        visitType: appointmentType.displayName,
      })
      .from(visitNote)
      .innerJoin(userAccount, eq(userAccount.id, visitNote.authorUserId))
      .leftJoin(appointment, eq(appointment.id, visitNote.appointmentId))
      .leftJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
      .where(
        and(
          eq(visitNote.patientId, session.patientId),
          eq(visitNote.clinicId, session.clinicId),
          isNull(visitNote.archivedAt),
          inArray(visitNote.status, ['signed', 'amended']),
        ),
      )
      .orderBy(desc(visitNote.signedAt));

    const visitAt = (note: (typeof notes)[number]): Date => {
      if (note.during) return parseTstzRange(note.during as unknown as string)[0];
      return note.signedAt ?? new Date(0);
    };

    const visible = notes.filter((note) => note.withheldAt === null);
    const withheld = notes.filter((note) => note.withheldAt !== null);

    /* Content for VISIBLE notes only. See the header: a withheld note's text is never read. */
    const versions =
      visible.length === 0
        ? []
        : await tx
            .select({
              visitNoteId: visitNoteVersion.visitNoteId,
              kind: visitNoteVersion.kind,
              authoredByName: userAccount.fullName,
              authoredAt: visitNoteVersion.authoredAt,
              chiefComplaint: visitNoteVersion.chiefComplaint,
              subjective: visitNoteVersion.subjective,
              objective: visitNoteVersion.objective,
              assessment: visitNoteVersion.assessment,
              plan: visitNoteVersion.plan,
            })
            .from(visitNoteVersion)
            .innerJoin(userAccount, eq(userAccount.id, visitNoteVersion.authoredByUserId))
            .where(
              and(
                inArray(
                  visitNoteVersion.visitNoteId,
                  visible.map((note) => note.id),
                ),
                eq(visitNoteVersion.clinicId, session.clinicId),
                isNotNull(visitNoteVersion.frozenAt),
              ),
            )
            .orderBy(asc(visitNoteVersion.versionNumber));

    /*
     * One audit row for the page: which patient, how many notes shown and how many held back.
     * Counts, never content — the audit log must not become a second copy of the notes.
     */
    await auditAsPatient(tx, session, {
      action: 'note.read',
      outcome: 'allowed',
      subjectPatientId: session.patientId,
      entityType: 'visit_note',
      metadata: {
        scope: 'portal_visit_summaries',
        resultCount: visible.length,
        withheldCount: withheld.length,
      },
    });

    return {
      summaries: visible.map((note) => ({
        visitAt: visitAt(note),
        visitType: note.visitType,
        clinicianName: note.clinicianName,
        versions: versions
          .filter((v) => v.visitNoteId === note.id)
          .map(({ visitNoteId: _id, ...v }) => ({
            ...v,
            kind: v.kind === 'addendum' ? ('addendum' as const) : ('signed' as const),
          })),
      })),
      withheld: withheld.map((note) => ({
        visitAt: visitAt(note),
        clinicianName: note.clinicianName,
      })),
    };
  });
}
