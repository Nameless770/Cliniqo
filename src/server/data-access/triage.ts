import 'server-only';

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import { patient, triageConversation, triageMessage } from '@/db/schema';
import type { TriageUrgency } from '@/server/triage';

import { auditedRead, auditedSearch, auditedWrite } from './audited';

/**
 * Symptom triage, staff side.
 *
 * ==========================================================================
 * TWO PERMISSIONS, BECAUSE THERE ARE TWO KINDS OF INFORMATION HERE
 * ==========================================================================
 *
 * A triage conversation contains both a scheduling fact and a clinical one, and the roles
 * that need them are different:
 *
 *   - WHO needs seeing, HOW SOON, and BY WHICH SERVICE is scheduling information. The
 *     front desk cannot book correctly without it, so the queue is gated on
 *     `appointment.read`, which every role holds.
 *
 *   - WHAT THE PATIENT WROTE is clinical content — unmediated, self-reported, and capable
 *     of containing anything. It is gated on `patient.read.clinical`, which receptionists
 *     do not hold.
 *
 * This is §164.502(b) applied literally, and it is enforced by the QUERY rather than the
 * template: `listTriageQueue` cannot return a message body because it never selects one.
 * A receptionist's page is not a page with the symptoms hidden — it is a page the symptoms
 * never reached.
 *
 * ADMIN HOLDS `patient.read.clinical` in the shipping matrix, so an administrator can read
 * symptom text. That follows the existing treatment of clinical notes rather than
 * inventing a narrower rule here, and their reads are audited like everyone else's — but
 * it is worth a deliberate decision, since this text is less mediated than a note. See the
 * note in CLAUDE.md about administrators browsing charts.
 */

export type TriageQueueRow = {
  id: string;
  patientId: string;
  patientName: string;
  mrn: string;
  urgency: TriageUrgency | null;
  recommendedSpecialty: string | null;
  createdAt: Date;
  messageCount: number;
};

/**
 * The open queue, most urgent first.
 *
 * NO MESSAGE BODIES. Not filtered out downstream — never selected. The ordering puts
 * emergencies at the top by the urgency enum's own declaration order, which is defined
 * fastest-first precisely so a sort like this needs no lookup table.
 */
export async function listTriageQueue(limit = 100): Promise<TriageQueueRow[]> {
  return auditedSearch(
    {
      permission: 'appointment.read',
      action: 'triage.search',
      entityType: 'triage_conversation',
      metadata: { scope: 'open_queue' },
    },
    async (tx, session) => {
      const rows = await tx
        .select({
          id: triageConversation.id,
          patientId: triageConversation.patientId,
          legalFirstName: patient.legalFirstName,
          legalLastName: patient.legalLastName,
          preferredName: patient.preferredName,
          mrn: patient.mrn,
          urgency: triageConversation.urgency,
          recommendedSpecialty: triageConversation.recommendedSpecialty,
          createdAt: triageConversation.createdAt,
          messageCount: sql<number>`(
            select count(*)::int from ${triageMessage}
             where ${triageMessage.conversationId} = ${triageConversation.id}
          )`,
        })
        .from(triageConversation)
        .innerJoin(patient, eq(patient.id, triageConversation.patientId))
        .where(
          and(
            eq(triageConversation.clinicId, session.clinicId),
            eq(triageConversation.status, 'open'),
            isNull(triageConversation.archivedAt),
            isNull(patient.archivedAt),
          ),
        )
        /* Enum order is emergency, urgent, routine, self_care — so the cast sorts by
           clinical priority without a CASE expression to keep in step with the enum. */
        .orderBy(asc(triageConversation.urgency), desc(triageConversation.createdAt))
        .limit(limit);

      return rows.map((r) => ({
        id: r.id,
        patientId: r.patientId,
        patientName: `${r.legalLastName}, ${r.preferredName ?? r.legalFirstName}`,
        mrn: r.mrn,
        urgency: r.urgency as TriageUrgency | null,
        recommendedSpecialty: r.recommendedSpecialty,
        createdAt: r.createdAt,
        messageCount: r.messageCount,
      }));
    },
    (rows) => ({
      resultCount: rows.length,
      resultIds: rows.map((r) => r.id),
      /* Low-cardinality and non-PHI: lets a reviewer tell a routine queue check from one
         that surfaced an emergency, without re-running the query against today's data. */
      labels: { emergencies: rows.filter((r) => r.urgency === 'emergency').length },
    }),
  );
}

export type TriageConversationDetail = {
  id: string;
  patientId: string;
  patientName: string;
  status: string;
  urgency: TriageUrgency | null;
  recommendedSpecialty: string | null;
  engine: string;
  createdAt: Date;
  messages: { id: string; role: string; body: string; createdAt: Date }[];
};

/**
 * One conversation, with what the patient actually wrote.
 *
 * The clinical read. Gated on `patient.read.clinical` and audited against the patient as
 * subject, so "who read my symptoms" is answerable per record — which is the question
 * §164.528 asks and the reason the queue above is a separate function rather than this one
 * with a flag.
 */
export async function getTriageConversation(
  conversationId: string,
): Promise<TriageConversationDetail | null> {
  return auditedRead<TriageConversationDetail | null>(
    {
      permission: 'patient.read.clinical',
      action: 'triage.read',
      entityType: 'triage_conversation',
      entityId: conversationId,
    },
    async (tx, session) => {
      const [row] = await tx
        .select({
          id: triageConversation.id,
          patientId: triageConversation.patientId,
          legalFirstName: patient.legalFirstName,
          legalLastName: patient.legalLastName,
          preferredName: patient.preferredName,
          status: triageConversation.status,
          urgency: triageConversation.urgency,
          recommendedSpecialty: triageConversation.recommendedSpecialty,
          engine: triageConversation.engine,
          createdAt: triageConversation.createdAt,
        })
        .from(triageConversation)
        .innerJoin(patient, eq(patient.id, triageConversation.patientId))
        .where(
          and(
            eq(triageConversation.id, conversationId),
            eq(triageConversation.clinicId, session.clinicId),
            isNull(triageConversation.archivedAt),
          ),
        )
        .limit(1);

      if (!row) return null;

      const messages = await tx
        .select({
          id: triageMessage.id,
          role: triageMessage.role,
          body: triageMessage.body,
          createdAt: triageMessage.createdAt,
        })
        .from(triageMessage)
        .where(eq(triageMessage.conversationId, conversationId))
        .orderBy(asc(triageMessage.createdAt));

      return {
        id: row.id,
        patientId: row.patientId,
        patientName: `${row.legalLastName}, ${row.preferredName ?? row.legalFirstName}`,
        status: row.status,
        urgency: row.urgency as TriageUrgency | null,
        recommendedSpecialty: row.recommendedSpecialty,
        engine: row.engine,
        createdAt: row.createdAt,
        messages,
      };
    },
    /* The subject is resolved from the row, not passed in: a caller that could name the
       patient could name the wrong one, and the audit row must say whose record was read. */
    (result) => result?.patientId ?? '',
  );
}

export type CloseResult = { ok: true } | { ok: false; reason: 'not_found' | 'already_closed' };

/**
 * Mark a conversation dealt with.
 *
 * Gated on `appointment.status` — the permission every role holds for moving work through
 * its states. Whoever actions the item can clear it; a queue only one role can empty is a
 * queue that fills up.
 *
 * Nothing is deleted. `closed` is a status, so the conversation stays readable in the
 * patient's record and in any §164.528 accounting.
 */
export async function closeTriageConversation(
  conversationId: string,
  patientId: string,
): Promise<CloseResult> {
  return auditedWrite<CloseResult>(
    {
      permission: 'appointment.status',
      action: 'triage.close',
      entityType: 'triage_conversation',
      entityId: conversationId,
      subjectPatientId: patientId,
    },
    async (tx, session): Promise<CloseResult> => {
      const updated = await tx
        .update(triageConversation)
        .set({ status: 'closed' })
        .where(
          and(
            eq(triageConversation.id, conversationId),
            /* The patient is verified in-query rather than trusted from the caller: the
               audit row above already claims this subject, and the two must agree. */
            eq(triageConversation.patientId, patientId),
            eq(triageConversation.clinicId, session.clinicId),
            eq(triageConversation.status, 'open'),
            isNull(triageConversation.archivedAt),
          ),
        )
        .returning({ id: triageConversation.id });

      return updated.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
    },
  );
}
